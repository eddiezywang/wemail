import type {
  AiResultMetadata,
  AiTokenUsage,
  IntelligenceJob,
  ReplyDraftResult,
  ReplyDraftVariant,
  SummaryResult,
  ReplyDecisionResult,
} from "../../../../shared/wemail/intelligence.js";
import type { WritingStyle } from "../../../../shared/wemail/settings.js";
import { LlmClientError, type LlmClient } from "../../ai/LlmClient.js";
import {
  REPLY_DRAFT_JSON_SCHEMA,
  REPLY_DRAFT_SYSTEM_PROMPT,
  buildReplyDraftUserMessage,
} from "../../ai/prompts/replyDraftPrompt.js";
import { applyCustomInstructions } from "../../personalization/applyCustomInstructions.js";
import type { AiUsageRepository } from "../../settings/AiUsageRepository.js";
import type { IntelligenceResultRepository } from "../IntelligenceResultRepository.js";
import type {
  MailIntelligenceProcessor,
  ProcessorContext,
} from "../MailIntelligenceProcessor.js";

/**
 * `max_attempts = 2` for replyDraft jobs (Handoff §6 parity with the
 * summary / tag lanes). Enforcement lives in QueueRunner/JobRepository.
 */
export const REPLY_DRAFT_MAX_ATTEMPTS = 2;

/**
 * Default per-request LLM timeout. Kept strictly below QueueRunner's 60s
 * lease so a hang aborts before the outer race fires.
 */
export const REPLY_DRAFT_LLM_TIMEOUT_MS = 25_000;

export interface ReplyDraftProcessorDeps {
  llmClient: LlmClient;
  model: string;
  /** LLM provider / model source (e.g. "openai", "anthropic"). */
  provider?: string;
  resultRepo?: IntelligenceResultRepository;
  /** Writing style lookup. When a styleId is in the job payload, this is consulted. */
  styleLookup?: (styleId: string) => WritingStyle | null;
  /** Compose language from AI profile settings. */
  composeLanguage?: string;
  logger?: (event: string, fields: Record<string, string | number>) => void;
  usage?: AiUsageRepository;
  now?: () => number;
  timeoutMs?: number;
  /** upstream-parity F4: per-call lookup of user's free-form custom instructions. */
  getCustomInstructions?: () => string | undefined;
}

/**
 * Processor-owned failure. `retryable` is honored by QueueRunner — when
 * `false`, the runner short-circuits to `status='failed'` without
 * consuming further attempts. Mirrors `SummaryProcessorError` /
 * `TagProcessorError`.
 */
export class ReplyDraftProcessorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "ReplyDraftProcessorError";
    this.code = code;
    this.retryable = retryable;
  }
}

function looksFenced(text: string): boolean {
  return text.trim().startsWith("```");
}

/**
 * Validate that the draft does not contain forbidden patterns:
 * subject lines, mail headers, or fake signatures.
 * Reply drafts MUST only contain proposed reply content.
 */
function validateDraftFormat(draftMarkdown: string): string | null {
  // Check for subject line patterns (Subject:, Re:, Fwd: at start of line)
  const subjectPattern = /^(Subject:\s*|Re:\s*|Fwd:\s*)/im;
  if (subjectPattern.test(draftMarkdown)) {
    return "subject-line-in-draft";
  }

  // Check for mail header patterns (From:, To:, Cc:, Date: at start of line)
  const headerPattern = /^(From:\s*|To:\s*|Cc:\s*|Date:\s*|Sent:\s*)/im;
  if (headerPattern.test(draftMarkdown)) {
    return "mail-header-in-draft";
  }

  // Check for fabricated signature patterns (common sign-offs with fake names)
  // Matches patterns like "Best regards,\nJohn Doe" or "Cheers,\nJane"
  // where the name after the sign-off looks like a fabricated signature
  const signaturePattern = /(?:Best regards|Cheers|Warm regards|Kind regards|Sincerely|Yours truly|Regards),?\s*\n\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/;
  if (signaturePattern.test(draftMarkdown)) {
    return "fabricated-signature-in-draft";
  }

  return null;
}

interface DraftParseResult {
  type: "replyDraft";
  draftMarkdown: string;
  language?: string;
  styleId?: string;
  variants?: ReplyDraftVariant[];
}

/**
 * Coerce a single raw `variants[]` entry into a `ReplyDraftVariant`.
 * Returns null when the shape is wrong or the body fails the format
 * validator (subject lines / headers / fabricated signatures). Bad
 * variants are dropped silently — at minimum the primary `draftMarkdown`
 * still wraps as a fallback variant downstream.
 */
function parseVariant(raw: unknown): ReplyDraftVariant | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.draftMarkdown !== "string" || r.draftMarkdown.trim().length === 0) {
    return null;
  }
  if (validateDraftFormat(r.draftMarkdown)) return null;
  const tone =
    typeof r.tone === "string" && r.tone.length > 0 ? r.tone : "neutral";
  const length =
    typeof r.length === "string" && r.length.length > 0 ? r.length : "medium";
  return {
    tone,
    length,
    draftMarkdown: r.draftMarkdown,
  };
}

function validateReplyDraft(parsed: unknown): DraftParseResult {
  if (typeof parsed !== "object" || parsed === null) {
    throw new ReplyDraftProcessorError("invalid-shape", "response-not-object");
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.draftMarkdown !== "string" || obj.draftMarkdown.trim().length === 0) {
    throw new ReplyDraftProcessorError(
      "invalid-draftMarkdown",
      "draftMarkdown-missing-or-empty",
    );
  }

  // Validate draft format: no subject lines, headers, or fake signatures
  const formatViolation = validateDraftFormat(obj.draftMarkdown);
  if (formatViolation) {
    throw new ReplyDraftProcessorError(
      formatViolation,
      formatViolation,
      false,
    );
  }

  const rawLanguage = typeof obj.language === "string" && obj.language.length > 0 ? obj.language : undefined;
  const styleId = typeof obj.styleId === "string" ? obj.styleId : undefined;

  // Quick Reply variants (upstream F2). Backward compatible: when the LLM
  // omits the field we wrap the primary draftMarkdown as a single
  // "neutral / medium" variant so the renderer can still display chips.
  let variants: ReplyDraftVariant[] | undefined;
  if (Array.isArray(obj.variants)) {
    const parsedVariants = obj.variants
      .map((v) => parseVariant(v))
      .filter((v): v is ReplyDraftVariant => v !== null)
      .slice(0, 3);
    if (parsedVariants.length > 0) {
      variants = parsedVariants;
    }
  }
  if (!variants || variants.length === 0) {
    variants = [
      { tone: "neutral", length: "medium", draftMarkdown: obj.draftMarkdown },
    ];
  }

  return {
    type: "replyDraft",
    draftMarkdown: obj.draftMarkdown,
    language: rawLanguage,
    styleId,
    variants,
  };
}

/**
 * `MailIntelligenceProcessor` for the `replyDraft` job kind.
 *
 * This processor ONLY generates a reply draft. The reply-decision logic
 * (shouldReply + rationale) is handled by `ReplyDecisionProcessor`.
 *
 * Flow:
 *   1. Load mail via `ctx.getMessage` (missing row -> terminal).
 *   2. Optionally fetch ReplyDecisionResult from resultRepo for context.
 *   3. Optionally fetch SummaryResult from resultRepo for context.
 *   4. Resolve writing style if styleId is provided in job payload.
 *   5. Call `LlmClient` with the locked reply-draft prompt + schema.
 *   6. Parse + validate (fenced / truncated / non-JSON -> terminal).
 *   7. Validate format: no subject lines, headers, or fake signatures.
 *   8. Return `ReplyDraftResult` — the processor is intentionally
 *      decoupled from the send pathway; send is strictly a
 *      user-initiated action in the renderer.
 */
export class ReplyDraftProcessor implements MailIntelligenceProcessor {
  readonly type = "replyDraft" as const;
  private readonly llmClient: LlmClient;
  private readonly model: string;
  private readonly provider?: string;
  private readonly resultRepo: IntelligenceResultRepository | undefined;
  private readonly styleLookup: ((styleId: string) => WritingStyle | null) | undefined;
  private readonly composeLanguage: string;
  private readonly logger: (
    event: string,
    fields: Record<string, string | number>,
  ) => void;
  private readonly usage?: AiUsageRepository;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly getCustomInstructions?: () => string | undefined;

  constructor(deps: ReplyDraftProcessorDeps) {
    this.llmClient = deps.llmClient;
    this.model = deps.model;
    this.provider = deps.provider;
    this.resultRepo = deps.resultRepo;
    this.styleLookup = deps.styleLookup;
    this.composeLanguage = deps.composeLanguage ?? "en";
    this.logger = deps.logger ?? (() => {});
    this.usage = deps.usage;
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? REPLY_DRAFT_LLM_TIMEOUT_MS;
    this.getCustomInstructions = deps.getCustomInstructions;
  }

  async handle(
    job: IntelligenceJob,
    ctx: ProcessorContext,
  ): Promise<ReplyDraftResult> {
    const started = this.now();
    const mail = ctx.getMessage(job.emailId);
    if (!mail) {
      throw new ReplyDraftProcessorError(
        "mail-missing",
        "mail-missing",
        false,
      );
    }

    // Resolve writing style from job payload
    const styleId = typeof job.payload?.styleId === "string"
      ? job.payload.styleId as string
      : undefined;
    let style: WritingStyle | null = null;
    let styleInstructions = "";
    if (styleId && this.styleLookup) {
      style = this.styleLookup(styleId);
      if (!style) {
        throw new ReplyDraftProcessorError(
          "invalid-style",
          `style-not-found:${styleId}`,
          false,
        );
      }
      styleInstructions = style.instructions;
    }

    // Fetch reply decision result for context (optional enrichment)
    let decisionContext = "";
    if (this.resultRepo) {
      const results = this.resultRepo.findByEmailId(job.emailId);
      if (results.replyDecision && "reason" in results.replyDecision) {
        const decision = results.replyDecision as { reason?: string };
        decisionContext = decision.reason ?? "";
      }

      // Fetch summary for additional context
      if (results.summary && "bullets" in results.summary) {
        const summary = results.summary as SummaryResult;
        if (summary.bullets.length > 0) {
          // Summary context is available but we don't pass it to the LLM
          // prompt directly — we log its presence for observability.
        }
      }
    }

    const userMessage = buildReplyDraftUserMessage(
      {
        subject: mail.subject,
        from: mail.from,
        to: mail.to,
        cc: mail.cc,
        snippet: mail.snippet,
        bodyText: mail.bodyText,
        bodyHtml: mail.bodyHtml,
      },
      ctx.workspace,
    );

    // Build system prompt with optional style instructions
    const systemPrompt = this.buildSystemPrompt(styleInstructions);

    let response;
    try {
      response = await this.llmClient.generate({
        model: this.model,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        jsonSchema: REPLY_DRAFT_JSON_SCHEMA,
        temperature: 0.2,
        maxTokens: 1024,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      const duration = this.now() - started;
      const code =
        error instanceof LlmClientError
          ? (error.code ?? `http-${error.status ?? 0}`)
          : "unknown";
      this.logger("replyDraft-llm-error", {
        emailId: job.emailId,
        type: "replyDraft",
        durationMs: duration,
        model: this.model,
        code,
      });
      throw error;
    }

    if (response.finishReason === "length") {
      this.logger("replyDraft-truncated", {
        emailId: job.emailId,
        type: "replyDraft",
        model: this.model,
      });
      throw new ReplyDraftProcessorError(
        "truncated",
        "truncated response",
        false,
      );
    }

    if (looksFenced(response.text)) {
      this.logger("replyDraft-fenced", {
        emailId: job.emailId,
        type: "replyDraft",
        model: this.model,
      });
      throw new ReplyDraftProcessorError(
        "fenced-output",
        "fenced output from structured endpoint",
        false,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      const duration = this.now() - started;
      this.logger("replyDraft-parse-error", {
        emailId: job.emailId,
        type: "replyDraft",
        durationMs: duration,
        model: this.model,
      });
      throw new ReplyDraftProcessorError(
        "invalid-json",
        "response-not-json",
        false,
      );
    }

    const result = validateReplyDraft(parsed);
    const duration = this.now() - started;

    // Attach metadata
    const metadata: AiResultMetadata = {
      processor: "replyDraft",
      version: 2,
      model: this.model,
      contextRefs: [
        "header",
        "body-text",
        ...(decisionContext ? ["reply-decision"] : []),
        ...(styleId ? [`style:${styleId}`] : []),
      ],
      createdAt: new Date(this.now()).toISOString(),
      durationMs: duration,
      tokenUsage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      },
    };

    const finalResult: ReplyDraftResult = {
      type: "replyDraft",
      draftMarkdown: result.draftMarkdown,
      language: result.language ?? this.composeLanguage ?? "en",
      styleId: styleId ?? result.styleId,
      variants: result.variants,
      _metadata: metadata,
    };

    // Body-free: log metadata, never the draft text or the source body.
    this.logger("replyDraft-ok", {
      emailId: job.emailId,
      type: "replyDraft",
      durationMs: duration,
      model: this.model,
      hasDecisionContext: decisionContext ? 1 : 0,
      hasStyle: styleId ? 1 : 0,
      language: finalResult.language,
      variantCount: finalResult.variants?.length ?? 0,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    });
    this.usage?.record({
      accountId: mail.accountId,
      category: "compose",
      processor: "replyDraft",
      emailId: job.emailId,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      model: this.model,
      provider: this.provider,
      durationMs: duration,
    });
    return finalResult;
  }

  /**
   * Build the system prompt with optional style instructions, then layer
   * the user's custom instructions (F4) at the end.
   */
  private buildSystemPrompt(styleInstructions: string): string {
    let prompt = REPLY_DRAFT_SYSTEM_PROMPT;
    if (styleInstructions) {
      prompt += ` Style guidance: ${styleInstructions}`;
    }
    return applyCustomInstructions(prompt, this.getCustomInstructions?.());
  }
}
