import {
  SYSTEM_CATEGORY_SET,
  type AiResultMetadata,
  type ClassificationSignal,
  type ClassificationResult,
  type ContentTopicTag,
  type IntelligenceJob,
  type SummaryResult,
  type SystemClassificationResult,
  type TagResult,
} from "../../../../shared/wemail/intelligence.js";
import { LlmClientError, type LlmClient } from "../../ai/LlmClient.js";
import { ContextBuilder } from "../../ai/context/ContextBuilder.js";
import {
  BUILTIN_TAGS,
  PROHIBITED_CONTENT_TOPIC_NAMES,
  TAG_JSON_SCHEMA,
  TAG_SYSTEM_PROMPT,
} from "../../ai/prompts/tagPrompt.js";
import {
  buildSmartTagDefinitions,
  smartTagDefinitionFingerprint,
  type SmartTagDefinition,
} from "../../ai/prompts/smartTagDefinitions.js";
import { formatWorkspaceContext } from "../../ai/prompts/workspaceFormatting.js";
import type { TagFeedbackRuleRepository } from "../../feedback/TagFeedbackRuleRepository.js";
import type { UserTag } from "../UserTagRepository.js";
import { applyCustomInstructions } from "../../personalization/applyCustomInstructions.js";
import type { AiUsageRecorder } from "../../../../shared/wemail/usage.js";
import type {
  MailIntelligenceProcessor,
  ProcessorContext,
} from "../MailIntelligenceProcessor.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import { looksFenced, stripJsonFence } from "./SharedProcessorUtils.js";

/**
 * `max_attempts = 2` for tag jobs (Handoff §6 — tags inherit the summary
 * cap). Surfaced here as a module constant for clarity; actual
 * enforcement lives in QueueRunner/JobRepository.
 */
export const TAG_MAX_ATTEMPTS = 2;

/**
 * Leave room for structured responses from slower models while staying
 * below the canonical worker's lease and the summary timeout.
 */
export const TAG_LLM_TIMEOUT_MS = 45_000;
export const USER_SMART_TAG_MIN_CONFIDENCE = 0.8;

export interface TagProcessorDeps {
  llmClient: LlmClient;
  model: string;
  /** LLM provider / model source (e.g. "openai", "anthropic"). */
  provider?: string;
  feedbackRules: TagFeedbackRuleRepository;
  /** Body-free structured logger. Receives `{event, ...fields}` payloads. */
  logger?: (event: string, fields: Record<string, string | number>) => void;
  usage?: AiUsageRecorder;
  now?: () => number;
  timeoutMs?: number;
  /** upstream-parity F4: per-call lookup of user's free-form custom instructions. */
  getCustomInstructions?: () => string | undefined;
  /**
   * Per-account lookup of user-defined smart tags. When present, the
   * processor merges these into the candidate-tag enum and appends each
   * tag's prompt to the system message so the LLM has the context to
   * recognize matches. (Feature 4 — "AI 自己去学习".)
   */
  getUserTags?: (accountId: string) => UserTag[] | Promise<UserTag[]>;
  /** Learning evaluation uses the production classifier without post-hoc rules. */
  feedbackMode?: "apply" | "bypass";
  /** Production defaults to 0.1; batch A/B evaluation pins this to 0. */
  temperature?: number;
  /** Persist recurring content topics after a successful classification. */
  onContentTags?: (
    mail: MailMessage,
    tags: readonly ContentTopicTag[],
  ) => readonly ContentTopicTag[] | void;
  /**
   * Optional accessor for the already-computed summary result. When the
   * summary pass finished first, its intent/attention classification is
   * injected as a hint so the tag pass does not re-derive it from scratch.
   */
  getStoredSummary?: () => SummaryResult | undefined;
}

/**
 * Processor-owned failure. Mirrors `SummaryProcessorError` so QueueRunner
 * treats retryable/terminal the same across lanes.
 */
export class TagProcessorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "TagProcessorError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Derive the confidence tier for a tag suggestion.
 * Built-in tags with high confidence are "auto" (auto-applied);
 * everything else is "suggested" (requires user confirmation).
 */
function deriveTier(tag: { name: string; confidence: number; source: string }): "auto" | "suggested" {
  if (BUILTIN_TAGS.includes(tag.name) && tag.confidence >= 0.85) return "auto";
  return "suggested";
}

/**
 * Derive a system category classification from the tag result.
 * Picks the highest-confidence system category tag as the classification.
 * If no system category tag is present, defaults to "other".
 * Also checks for suppressed categories via the feedback rules.
 */
function deriveClassification(
  tags: TagResult,
  suppressedCategories: Set<string>,
): ClassificationResult | undefined {
  // Find the highest-confidence system category tag
  const systemTags = tags.tags
    .filter((t) => SYSTEM_CATEGORY_SET.has(t.name))
    .sort((a, b) => b.confidence - a.confidence);

  for (const tag of systemTags) {
    if (!suppressedCategories.has(tag.name)) {
      return {
        categoryId: tag.name as ClassificationResult["categoryId"],
        reason: `Classified as ${tag.name} with confidence ${(tag.confidence * 100).toFixed(0)}%`,
        confidence: tag.confidence,
      };
    }
  }

  // No unsuppressed system category found — default to "other" with low confidence
  return {
    categoryId: "other",
    reason: "No matching system category; defaulted to other",
    confidence: 0.3,
  };
}

type RawTag = { name: unknown; confidence: unknown; source: unknown };

interface RawValidationResult {
  tags: TagResult;
  system?: SystemClassificationResult;
  contentTags: ContentTopicTag[];
  /**
   * Classification parsed directly from the model output. `undefined`
   * means the model didn't include a usable classification block — the
   * caller falls back to `deriveClassification` from the tag list.
   */
  modelClassification?: ClassificationResult;
}

function unmatchedSignal(reason: string): ClassificationSignal {
  return { matched: false, confidence: 0.5, reason, source: "ai" };
}

function systemFromLegacyClassification(
  classification: ClassificationResult | undefined,
): SystemClassificationResult {
  const important = unmatchedSignal("Legacy result did not mark this mail important");
  const actionRequired = unmatchedSignal("Legacy result did not require an action");
  const invoice = unmatchedSignal("Legacy receipt results require reclassification");
  if (classification?.categoryId === "important") {
    Object.assign(important, {
      matched: true,
      confidence: classification.confidence,
      reason: classification.reason,
    });
  }
  if (classification?.categoryId === "action_required") {
    Object.assign(actionRequired, {
      matched: true,
      confidence: classification.confidence,
      reason: classification.reason,
    });
  }
  return { important, actionRequired, invoice };
}

function legacyClassificationProjection(
  system: SystemClassificationResult,
): ClassificationResult {
  if (system.important.matched) {
    return {
      categoryId: "important",
      reason: system.important.reason,
      confidence: system.important.confidence,
    };
  }
  if (system.actionRequired.matched) {
    return {
      categoryId: "action_required",
      reason: system.actionRequired.reason,
      confidence: system.actionRequired.confidence,
    };
  }
  // This projection exists only for legacy consumers. New invoice filters read
  // the independent invoice signal and do not reinterpret historical receipts.
  if (system.invoice.matched) {
    return {
      categoryId: "receipt",
      reason: system.invoice.reason,
      confidence: system.invoice.confidence,
    };
  }
  return {
    categoryId: "other",
    reason: "No user-visible system classification matched",
    confidence: 0.5,
  };
}

function parseConfidence(value: unknown): number | null {
  const confidence = typeof value === "number" ? value : Number(value);
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    ? confidence
    : null;
}

function parseSignal(value: unknown): ClassificationSignal | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const confidence = parseConfidence(record.confidence);
  if (
    typeof record.matched !== "boolean" ||
    confidence === null ||
    typeof record.reason !== "string" ||
    !record.reason.trim()
  ) {
    return null;
  }
  return {
    matched: record.matched,
    confidence,
    reason: record.reason.trim(),
    source: record.source === "user" || record.source === "rule" ? record.source : "ai",
  };
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function parseSystem(value: unknown): SystemClassificationResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const important = parseSignal(record.important);
  const actionRequired = parseSignal(record.actionRequired);
  const invoice = parseSignal(record.invoice);
  if (!important || !actionRequired || !invoice) return undefined;
  return {
    important,
    actionRequired: {
      ...actionRequired,
      actions: parseStringList(
        (record.actionRequired as Record<string, unknown>).actions,
      ),
    },
    invoice: {
      ...invoice,
      evidence: parseStringList(
        (record.invoice as Record<string, unknown>).evidence,
      ),
    },
  };
}

const PROHIBITED_TOPIC_SET = new Set<string>(PROHIBITED_CONTENT_TOPIC_NAMES);

function parseContentTags(value: unknown): ContentTopicTag[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: ContentTopicTag[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const confidence = parseConfidence(record.confidence);
    if (
      name.length < 2 ||
      name.length > 24 ||
      confidence === null ||
      PROHIBITED_TOPIC_SET.has(name) ||
      seen.has(name)
    ) {
      continue;
    }
    seen.add(name);
    out.push({
      name,
      confidence,
      source: record.source === "user" ? "user" : "ai",
      tier: confidence >= 0.85 ? "auto" : "suggested",
    });
    if (out.length >= 3) break;
  }
  return out;
}

function validateTagResult(parsed: unknown): RawValidationResult {
  if (typeof parsed !== "object" || parsed === null) {
    throw new TagProcessorError("invalid-shape", "response-not-object");
  }
  const obj = parsed as {
    tags?: unknown;
    classification?: unknown;
    system?: unknown;
    contentTags?: unknown;
  };
  if (!Array.isArray(obj.tags)) {
    throw new TagProcessorError("invalid-tags", "tags-not-array");
  }
  const normalized: TagResult["tags"] = [];
  for (const raw of obj.tags as RawTag[]) {
    if (typeof raw !== "object" || raw === null) {
      throw new TagProcessorError("invalid-tags", "tag-not-object");
    }
    if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
      throw new TagProcessorError("invalid-tags", "tag-name-missing");
    }
    const conf =
      typeof raw.confidence === "number"
        ? raw.confidence
        : Number(raw.confidence);
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
      throw new TagProcessorError("invalid-tags", "tag-confidence-out-of-range");
    }
    const source = raw.source === "ai" ? "ai" : "ai";
    normalized.push({ name: raw.name, confidence: conf, source, tier: "suggested" });
  }

  // Route C / WP C: parse classification directly from the model. We
  // tolerate missing or malformed classification objects so a strict-
  // schema regression doesn't take the whole job down — the processor
  // falls back to deriveClassification(tags, ...) in that case.
  let modelClassification: ClassificationResult | undefined;
  const c = obj.classification;
  if (
    c &&
    typeof c === "object" &&
    typeof (c as Record<string, unknown>).categoryId === "string" &&
    typeof (c as Record<string, unknown>).reason === "string"
  ) {
    const categoryId = (c as { categoryId: string }).categoryId;
    if (SYSTEM_CATEGORY_SET.has(categoryId)) {
      const rawConf = (c as { confidence?: unknown }).confidence;
      const conf =
        typeof rawConf === "number"
          ? rawConf
          : typeof rawConf === "string"
            ? Number(rawConf)
            : NaN;
      if (Number.isFinite(conf) && conf >= 0 && conf <= 1) {
        modelClassification = {
          categoryId: categoryId as ClassificationResult["categoryId"],
          reason: (c as { reason: string }).reason,
          confidence: conf,
        };
      }
    }
  }

  return {
    tags: { type: "tags", tags: normalized },
    system: parseSystem(obj.system),
    contentTags: parseContentTags(obj.contentTags),
    modelClassification,
  };
}

/**
 * Processor version for AiResultMetadata. Incremented on breaking changes
 * to the output schema or processing logic.
 *
 * Route C / WP C: bumped to 2 when the prompt + schema started requiring
 * the model to emit a `classification` block alongside the tag list.
 */
export const TAG_PROCESSOR_VERSION = 3;

/**
 * `MailIntelligenceProcessor` for the `tags` job kind.
 *
 * Flow:
 *   1. Load mail via `ctx.getMessage` (missing row → terminal).
 *   2. Build context using ContextBuilder for bounded, log-safe context.
 *   3. Call `LlmClient` with the locked tag prompt + schema.
 *   4. Normalize a provider-added JSON fence, then parse + validate.
 *   5. Apply feedback rules: off-vocabulary and sender/subject-scoped
 *      reject rules drop suggestions BEFORE the result is persisted.
 */
export class TagProcessor implements MailIntelligenceProcessor {
  readonly type = "tags" as const;
  private readonly llmClient: LlmClient;
  private readonly model: string;
  private readonly provider?: string;
  private readonly feedbackRules: TagFeedbackRuleRepository;
  private readonly logger: (
    event: string,
    fields: Record<string, string | number>,
  ) => void;
  private readonly usage?: AiUsageRecorder;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly getCustomInstructions?: () => string | undefined;
  private readonly getUserTags?: TagProcessorDeps["getUserTags"];
  private readonly getStoredSummary?: () => SummaryResult | undefined;
  private readonly feedbackMode: "apply" | "bypass";
  private readonly temperature: number;
  private readonly onContentTags?: TagProcessorDeps["onContentTags"];

  constructor(deps: TagProcessorDeps) {
    this.llmClient = deps.llmClient;
    this.model = deps.model;
    this.provider = deps.provider;
    this.feedbackRules = deps.feedbackRules;
    this.logger = deps.logger ?? (() => {});
    this.usage = deps.usage;
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? TAG_LLM_TIMEOUT_MS;
    this.getCustomInstructions = deps.getCustomInstructions;
    this.getUserTags = deps.getUserTags;
    this.getStoredSummary = deps.getStoredSummary;
    this.feedbackMode = deps.feedbackMode ?? "apply";
    this.temperature = deps.temperature ?? 0.1;
    this.onContentTags = deps.onContentTags;
  }

  async handle(
    job: IntelligenceJob,
    ctx: ProcessorContext,
  ): Promise<TagResult> {
    const started = this.now();
    const mail = ctx.getMessage(job.emailId);
    if (!mail) {
      throw new TagProcessorError("mail-missing", "mail-missing", false);
    }

    // Build context using ContextBuilder for bounded, log-safe context
    const degradedRecovery = job.payload?.strategy === "degraded";
    const contextBuilder = new ContextBuilder({ feature: "tags" });
    const contextResult = contextBuilder.build({
      subject: mail.subject,
      from: mail.from.name
        ? `${mail.from.name} <${mail.from.email}>`
        : mail.from.email,
      snippet: mail.snippet,
      bodyText: degradedRecovery
        ? mail.bodyText?.slice(0, 4_000)
        : mail.bodyText,
      bodyHtml: degradedRecovery ? undefined : mail.bodyHtml,
    });

    // Log context metadata (body-free)
    this.logger("tags-context-built", {
      emailId: job.emailId,
      contextRefs: contextResult.contextRefs.join(","),
      totalTokenEstimate: contextResult.totalTokenEstimate,
      truncated: contextResult.truncated ? 1 : 0,
    });

    const userMessage =
      contextResult.promptText + formatWorkspaceContext(ctx.workspace);

    // Reuse the summary pass's intent/attention classification as a hint
    // instead of re-deriving it from scratch (token optimization).
    const storedSummary = this.getStoredSummary?.();
    const summaryHint = storedSummary?.intent || storedSummary?.attention
      ? [
          "Prior classification from the summary pass (use as a hint, do not treat as ground truth):",
          `intent=${storedSummary?.intent ?? "unknown"}; attention=${storedSummary?.attention ?? "unknown"}`,
        ].join("\n")
      : undefined;
    const hintedUserMessage = summaryHint
      ? `${summaryHint}\n\n${userMessage}`
      : userMessage;

    const tagDefinitions = buildSmartTagDefinitions(
      await this.getUserTags?.(mail.accountId) ?? [],
    );
    const tagDefinitionFingerprint = smartTagDefinitionFingerprint(tagDefinitions);
    const { system: systemPrompt, schema } = augmentForTagDefinitions(tagDefinitions);

    let response;
    try {
      response = await this.llmClient.generate({
        model: this.model,
        system: applyCustomInstructions(systemPrompt, this.getCustomInstructions?.()),
        messages: [{ role: "user", content: hintedUserMessage }],
        jsonSchema: schema,
        temperature: this.temperature,
        maxTokens: 4096,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      const duration = this.now() - started;
      const code =
        error instanceof LlmClientError
          ? (error.code ?? `http-${error.status ?? 0}`)
          : "unknown";
      if (
        error instanceof LlmClientError &&
        error.code === "STRUCTURED_OUTPUT_SCHEMA_MISMATCH" &&
        typeof error.rawText === "string" &&
        error.rawText.trim()
      ) {
        // Tolerate schema violations: keep the raw text so the lenient
        // validateTagResult/parseSystem path can salvage the response
        // instead of failing the whole background job (see validateTagResult).
        this.logger("tags-schema-fallback", {
          emailId: job.emailId,
          type: "tags",
          durationMs: duration,
          model: this.model,
          code,
        });
        response = { text: error.rawText, finishReason: "stop" as const };
      } else {
        this.logger("tags-llm-error", {
          emailId: job.emailId,
          type: "tags",
          durationMs: duration,
          model: this.model,
          code,
        });
        throw error;
      }
    }

    if (response.finishReason === "length") {
      this.logger("tags-truncated", {
        emailId: job.emailId,
        type: "tags",
        model: this.model,
      });
      throw new TagProcessorError("truncated", "truncated response", false);
    }

    const responseText = stripJsonFence(response.text);
    if (looksFenced(response.text)) {
      this.logger("tags-fenced", {
        emailId: job.emailId,
        type: "tags",
        model: this.model,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      const duration = this.now() - started;
      this.logger("tags-parse-error", {
        emailId: job.emailId,
        type: "tags",
        durationMs: duration,
        model: this.model,
      });
      throw new TagProcessorError("invalid-json", "response-not-json", false);
    }

    const raw = validateTagResult(parsed);
    const allowedNames = new Set(tagDefinitions.map((definition) => definition.name));
    const filteredWithoutRules: TagResult = {
      type: "tags",
      tags: raw.tags.tags.filter(
        (tag) => allowedNames.has(tag.name)
          && tag.confidence >= USER_SMART_TAG_MIN_CONFIDENCE,
      ),
    };
    const applied = this.feedbackMode === "apply"
      ? this.feedbackRules.applyRules(filteredWithoutRules, mail, [...allowedNames])
      : {
          result: filteredWithoutRules,
          droppedByRules: raw.tags.tags.length - filteredWithoutRules.tags.length,
          dynamicTags: filteredWithoutRules.tags.filter(
            (tag) => !BUILTIN_TAGS.includes(tag.name),
          ).length,
        };
    const { result, droppedByRules, dynamicTags } = applied;

    // Apply confidence tiers to each surviving tag.
    const tiered: TagResult = {
      type: "tags",
      tags: result.tags.map((t) => ({ ...t, tier: deriveTier(t) })),
    };

    // Derive suppressed categories from feedback rules (sender+subject scoped).
    const rules = this.feedbackMode === "apply"
      ? this.feedbackRules.findRulesForMail(mail)
      : [];
    const suppressedCategories = new Set(
      rules
        .filter((r) => r.action === "reject" && SYSTEM_CATEGORY_SET.has(r.tag))
        .map((r) => r.tag),
    );

    const fallbackClassification =
      raw.modelClassification &&
      !suppressedCategories.has(raw.modelClassification.categoryId)
        ? raw.modelClassification
        : deriveClassification(raw.tags, suppressedCategories);
    const system = raw.system ?? systemFromLegacyClassification(fallbackClassification);
    if (mail.subject.includes("发票")) {
      system.invoice = {
        matched: true, confidence: 1, source: "rule",
        reason: "邮件主题包含发票", evidence: ["邮件主题包含发票"],
      };
    }
    if (suppressedCategories.has("important")) system.important.matched = false;
    if (suppressedCategories.has("action_required")) {
      system.actionRequired.matched = false;
    }
    const classification = legacyClassificationProjection(system);
    const legacyContentTags = parseContentTags(
      raw.tags.tags
        .filter((tag) => BUILTIN_TAGS.includes(tag.name))
        .map((tag) => ({ ...tag, source: "ai" })),
    );
    let contentTags = raw.contentTags.length > 0
      ? raw.contentTags
      : legacyContentTags;

    const duration = this.now() - started;

    // Build AI quality metadata
    const metadata: AiResultMetadata = {
      processor: "tags",
      version: TAG_PROCESSOR_VERSION,
      model: this.model,
      contextRefs: contextResult.contextRefs,
      createdAt: new Date(started).toISOString(),
      durationMs: duration,
      tokenUsage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      },
      tagDefinitionFingerprint,
    };

    this.logger("tags-ok", {
      emailId: job.emailId,
      type: "tags",
      durationMs: duration,
      model: this.model,
      suggested: raw.tags.tags.length,
      kept: tiered.tags.length,
      droppedByRules,
      dynamicTags,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      version: TAG_PROCESSOR_VERSION,
      contextRefs: contextResult.contextRefs.join(","),
    });
    await this.usage?.record({
      accountId: mail.accountId,
      category: "other",
      processor: "tags",
      emailId: job.emailId,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      model: this.model,
      provider: this.provider,
      durationMs: duration,
    });
    try {
      const recorded = this.onContentTags?.(mail, contentTags);
      if (recorded) contentTags = [...recorded];
    } catch (error) {
      this.logger("content-topic-record-failed", {
        emailId: job.emailId,
        code: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      ...tiered,
      schemaVersion: 3,
      system,
      contentTags,
      classification,
      _metadata: metadata,
    };
  }
}

/**
 * Per-call extension of TAG_SYSTEM_PROMPT + TAG_JSON_SCHEMA with the
 * user's hand-defined tags. We deliberately do NOT mutate the frozen
 * baselines — augmentation is layered into a fresh prompt and a fresh
 * schema object whose enum is the union of built-ins + user tag names.
 */
function augmentForTagDefinitions(definitions: readonly SmartTagDefinition[]): {
  system: string;
  schema: Record<string, unknown>;
} {
  if (definitions.every((definition) => definition.source === "builtin")) {
    return { system: TAG_SYSTEM_PROMPT, schema: TAG_JSON_SCHEMA };
  }
  const seen = new Set<string>();
  const extras: string[] = [];
  const userDefinitionLines: string[] = [];
  for (const tagDefinition of definitions) {
    if (tagDefinition.source !== "user") continue;
    const name = tagDefinition.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    extras.push(name);
    userDefinitionLines.push(
      tagDefinition.prompt.trim()
        ? `- ${name}: ${tagDefinition.prompt.trim()}`
        : `- ${name}: (no description)`,
    );
  }
  if (extras.length === 0) {
    return { system: TAG_SYSTEM_PROMPT, schema: TAG_JSON_SCHEMA };
  }
  const system = [
    TAG_SYSTEM_PROMPT,
    "",
    "User-defined categories (apply when an email matches the description):",
    ...userDefinitionLines,
  ].join("\n");
  const schema: Record<string, unknown> = JSON.parse(
    JSON.stringify(TAG_JSON_SCHEMA),
  );
  const properties = (schema as { properties?: Record<string, unknown> })
    .properties as { tags?: { items?: { properties?: { name?: { enum?: string[] } } } } };
  if (properties.tags?.items?.properties?.name) {
    properties.tags.items.properties.name.enum = extras;
    const tagSchema = properties.tags as unknown as { maxItems?: number };
    delete tagSchema.maxItems;
  }
  return { system, schema };
}
