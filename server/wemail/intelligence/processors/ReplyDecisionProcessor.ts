import type {
  AiResultMetadata,
  IntelligenceJob,
  ReplyDecisionResult,
} from "../../../../shared/wemail/intelligence.js";
import { LlmClientError, type LlmClient } from "../../ai/LlmClient.js";
import {
  REPLY_DECISION_JSON_SCHEMA,
  REPLY_DECISION_SYSTEM_PROMPT,
  buildReplyDecisionUserMessage,
} from "../../ai/prompts/replyDecisionPrompt.js";
import type {
  MailIntelligenceProcessor,
  ProcessorContext,
} from "../MailIntelligenceProcessor.js";
import type { IntelligenceResultRepository } from "../IntelligenceResultRepository.js";
import type { JobRepository } from "../../queue/JobRepository.js";
import { applyCustomInstructions } from "../../personalization/applyCustomInstructions.js";
import type { AiUsageRecorder } from "../../../../shared/wemail/usage.js";
import {
  computePriorityScore,
  deriveLevel,
  deriveReplyRequired,
  extractDeadlineDate,
  extractSignals,
  type SignalExtractionInput,
} from "./SignalExtractor.js";

/**
 * `max_attempts = 3` for reply decisions. Surfaced here as a
 * module constant for clarity — actual enforcement lives in Package C's
 * QueueRunner/JobRepository, which this processor does not bypass.
 */
export const REPLY_DECISION_MAX_ATTEMPTS = 3;

/**
 * Processor version for determinism and reproducibility. Incremented on
 * breaking changes to signal extraction, scoring, or prompt structure.
 * Same stored inputs + same version = same result.
 */
export const REPLY_DECISION_PROCESSOR_VERSION = 2;

/**
 * Default per-request LLM timeout for reply-decision jobs. Kept strictly below
 * QueueRunner's 60s job-lease so an LLM hang aborts before the runner's
 * outer race fires (prevents double-dispatch via lease expiry).
 * Shorter than summary/draft since output is small.
 */
export const REPLY_DECISION_LLM_TIMEOUT_MS = 20_000;

export interface ReplyDecisionProcessorDeps {
  llmClient: LlmClient;
  model: string;
  /** LLM provider / model source (e.g. "openai", "anthropic"). */
  provider?: string;
  resultRepo: IntelligenceResultRepository;
  jobRepo: JobRepository;
  accountId: string;
  /** Body-free structured logger. Receives `{event, ...fields}` payloads. */
  logger?: (event: string, fields: Record<string, string | number>) => void;
  usage?: AiUsageRecorder;
  /** Clock injection for duration logging. */
  now?: () => number;
  /**
   * Per-request LLM timeout (ms). Defaults to {@link REPLY_DECISION_LLM_TIMEOUT_MS}.
   * Kept below QueueRunner's 60s lease budget.
   */
  timeoutMs?: number;
  /** upstream-parity F4: per-call lookup of user's free-form custom instructions. */
  getCustomInstructions?: () => string | undefined;
}

/**
 * Processor-owned failure. `retryable` is honored by QueueRunner: when
 * `false`, the runner short-circuits to `status='failed'` instead of
 * rolling the row back to `pending` for another attempt.
 */
export class ReplyDecisionProcessorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "ReplyDecisionProcessorError";
    this.code = code;
    this.retryable = retryable;
  }
}

function looksFenced(text: string): boolean {
  return text.trim().startsWith("```");
}

function validateReplyDecision(parsed: unknown): {
  shouldReply: boolean;
  reason: string;
  confidence: number;
} {
  if (typeof parsed !== "object" || parsed === null) {
    throw new ReplyDecisionProcessorError("invalid-shape", "response-not-object");
  }
  const obj = parsed as Record<string, unknown>;
  const shouldReply = obj.shouldReply;
  const reason = obj.reason;
  const confidence = obj.confidence;

  if (typeof shouldReply !== "boolean") {
    throw new ReplyDecisionProcessorError("invalid-shouldReply", "shouldReply-not-boolean");
  }

  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new ReplyDecisionProcessorError("invalid-reason", "reason-not-string");
  }

  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    throw new ReplyDecisionProcessorError("invalid-confidence", "confidence-out-of-range");
  }

  return {
    shouldReply,
    reason,
    confidence,
  };
}

/**
 * `MailIntelligenceProcessor` for the `replyDecision` job kind. Dependencies
 * are injected — no singletons — so tests can stub the LLM client and
 * clock cleanly.
 */
export class ReplyDecisionProcessor implements MailIntelligenceProcessor {
  readonly type = "replyDecision" as const;
  private readonly llmClient: LlmClient;
  private readonly model: string;
  private readonly provider?: string;
  private readonly resultRepo: IntelligenceResultRepository;
  private readonly jobRepo: JobRepository;
  private readonly accountId: string;
  private readonly logger: (
    event: string,
    fields: Record<string, string | number>,
  ) => void;
  private readonly usage?: AiUsageRecorder;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly getCustomInstructions?: () => string | undefined;

  constructor(deps: ReplyDecisionProcessorDeps) {
    this.llmClient = deps.llmClient;
    this.model = deps.model;
    this.provider = deps.provider;
    this.resultRepo = deps.resultRepo;
    this.jobRepo = deps.jobRepo;
    this.accountId = deps.accountId;
    this.logger = deps.logger ?? (() => {});
    this.usage = deps.usage;
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? REPLY_DECISION_LLM_TIMEOUT_MS;
    this.getCustomInstructions = deps.getCustomInstructions;
  }

  async handle(
    job: IntelligenceJob,
    ctx: ProcessorContext,
  ): Promise<ReplyDecisionResult> {
    const started = this.now();
    const mail = ctx.getMessage(job.emailId);
    if (!mail) {
      // Row deleted between enqueue and dispatch. Non-retryable: the
      // message is gone, so another attempt cannot succeed.
      throw new ReplyDecisionProcessorError("mail-missing", "mail-missing", false);
    }

    // ── Signal extraction (deterministic, no LLM) ──────────────────

    // Try to fetch tags from result repository for category signal
    let tagNames: string[] | undefined;
    let classificationCategoryId: string | undefined;
    try {
      const results = this.resultRepo.findByEmailId(job.emailId);
      if (results.tags && results.tags.type === "tags") {
        tagNames = results.tags.tags.map((t) => t.name);
        // Extract classification category if present
        const tagResult = results.tags as any;
        if (tagResult.classification?.categoryId) {
          classificationCategoryId = tagResult.classification.categoryId;
        }
      }
    } catch {
      // Tags not available or fetch failed — proceed without them
    }

    const signalInput: SignalExtractionInput = {
      subject: mail.subject,
      from: mail.from,
      to: mail.to,
      cc: mail.cc,
      snippet: mail.snippet,
      bodyText: mail.bodyText,
      bodyHtml: mail.bodyHtml,
      tags: tagNames,
      classificationCategoryId: classificationCategoryId as any,
    };

    const signals = extractSignals(signalInput);
    const priorityScore = computePriorityScore(signals);
    const level = deriveLevel(priorityScore);
    const deadline = extractDeadlineDate(signalInput);

    // ── LLM call for shouldReply/reason/confidence ─────────────────

    // Try to fetch summary from result repository for enrichment
    let summaryText: string | undefined;
    try {
      const results = this.resultRepo.findByEmailId(job.emailId);
      if (results.summary && results.summary.type === "summary") {
        summaryText = results.summary.bullets.join(" ");
      }
    } catch {
      // Summary not available or fetch failed — proceed without it
      summaryText = undefined;
    }

    const userMessage = buildReplyDecisionUserMessage({
      subject: mail.subject,
      from: mail.from,
      to: mail.to,
      cc: mail.cc,
      snippet: mail.snippet,
      // Retry pass: shrink the re-sent body — the first attempt already
      // covered the content; retries are for malformed output.
      bodyText:
        job.payload?.strategy === "degraded"
          ? mail.bodyText?.slice(0, 3_000)
          : mail.bodyText,
      bodyHtml: job.payload?.strategy === "degraded" ? undefined : mail.bodyHtml,
      summaryText,
    });

    let response;
    try {
      response = await this.llmClient.generate({
        model: this.model,
        system: applyCustomInstructions(REPLY_DECISION_SYSTEM_PROMPT, this.getCustomInstructions?.()),
        messages: [{ role: "user", content: userMessage }],
        jsonSchema: REPLY_DECISION_JSON_SCHEMA,
        temperature: 0.2,
        maxTokens: 2048,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      const duration = this.now() - started;
      const code =
        error instanceof LlmClientError
          ? (error.code ?? `http-${error.status ?? 0}`)
          : "unknown";
      // Body-free: emailId + type + duration + model + error code only.
      this.logger("reply-decision-llm-error", {
        emailId: job.emailId,
        type: "replyDecision",
        durationMs: duration,
        model: this.model,
        code,
      });
      throw error;
    }

    // Truncated output is unrecoverable at this payload size — the
    // prompt + schema are fixed, so retrying burns budget. Mark terminal.
    if (response.finishReason === "length") {
      this.logger("reply-decision-truncated", {
        emailId: job.emailId,
        type: "replyDecision",
        model: this.model,
      });
      throw new ReplyDecisionProcessorError(
        "truncated",
        "truncated response",
        false,
      );
    }

    // Structured endpoints (both adapters) return pure JSON. If we see
    // code fences here, the upstream ignored `response_format` /
    // forced-tool-use — not something a retry fixes.
    if (looksFenced(response.text)) {
      this.logger("reply-decision-fenced", {
        emailId: job.emailId,
        type: "replyDecision",
        model: this.model,
      });
      throw new ReplyDecisionProcessorError(
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
      this.logger("reply-decision-parse-error", {
        emailId: job.emailId,
        type: "replyDecision",
        durationMs: duration,
        model: this.model,
      });
      // Parse failures on a schema-constrained endpoint are terminal.
      throw new ReplyDecisionProcessorError(
        "invalid-json",
        "response-not-json",
        false,
      );
    }

    const llmResult = validateReplyDecision(parsed);

    // ── Combine LLM result with signal-derived priority ────────────

    const replyRequired = deriveReplyRequired(
      llmResult.shouldReply,
      level,
      signals,
    );

    const result: ReplyDecisionResult = {
      type: "replyDecision",
      shouldReply: llmResult.shouldReply,
      reason: llmResult.reason,
      confidence: llmResult.confidence,
      priorityScore,
      level,
      replyRequired,
      deadline,
      signals: signals.map((s) => ({ name: s.name, value: s.value, weight: s.weight })),
      _metadata: {
        processor: "replyDecision",
        version: REPLY_DECISION_PROCESSOR_VERSION,
        model: this.model,
        confidence: llmResult.confidence,
        contextRefs: [],
        createdAt: new Date(started).toISOString(),
        durationMs: this.now() - started,
        tokenUsage: {
          inputTokens: response.usage?.inputTokens ?? 0,
          outputTokens: response.usage?.outputTokens ?? 0,
        },
      },
    };

    const duration = this.now() - started;
    this.logger("reply-decision-ok", {
      emailId: job.emailId,
      type: "replyDecision",
      durationMs: duration,
      model: this.model,
      shouldReply: result.shouldReply ? 1 : 0,
      priorityScore: Math.round(result.priorityScore * 100) / 100,
      level: result.level,
      replyRequired: result.replyRequired ? 1 : 0,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    });
    await this.usage?.record({
      accountId: mail.accountId,
      category: "compose",
      processor: "replyDecision",
      emailId: job.emailId,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      model: this.model,
      provider: this.provider,
      durationMs: duration,
    });

    // When shouldReply=true, enqueue a replyDraft job
    // (unchanged behavior: priority does not gate draft creation)
    if (result.shouldReply) {
      this.jobRepo.enqueueJob({
        emailId: job.emailId,
        type: "replyDraft",
        accountId: this.accountId,
        maxAttempts: 3,
      });
    }

    return result;
  }
}
