import type {
  AiResultMetadata,
  IntelligenceJob,
  SummaryAttention,
  SummaryActionObligation,
  SummaryDataInsight,
  SummaryDisplayMode,
  SummaryIntent,
  SummaryMode,
  SummaryResult,
  SummaryThreadResult,
  ThreadMessageInput,
} from "../../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import { Allow, parse as parsePartialJson } from "partial-json";
import { LlmClientError, type LlmClient, type LlmResponse, type LlmUsage } from "../../ai/LlmClient.js";
import { stripStructuredJsonFence as stripJsonFence } from "../../ai/StructuredJsonText.js";
import { ContextBuilder, stripHtml } from "../../ai/context/ContextBuilder.js";
import {
  SUMMARY_JSON_SCHEMA,
  SUMMARY_SYSTEM_PROMPT,
  THREAD_SUMMARY_JSON_SCHEMA,
  THREAD_SUMMARY_SYSTEM_PROMPT,
  buildThreadSummaryUserMessage,
} from "../../ai/prompts/summaryPrompt.js";
import { estimateTokens } from "../../ai/context/ContextBuilder.js";
import { formatWorkspaceContext } from "../../ai/prompts/workspaceFormatting.js";
import { applyCustomInstructions } from "../../personalization/applyCustomInstructions.js";
import type { AiUsageRecorder } from "../../../../shared/wemail/usage.js";
import type { MailIntelligenceProcessor, ProcessorContext } from "../MailIntelligenceProcessor.js";
import {
  hasSummarizableBody,
  isImageOnlyBody,
  hasMonitoringDataCandidate,
  summaryClaimsEmptyBody,
  summaryContentFingerprint,
} from "../SummaryContentFingerprint.js";
import {
  extractSummaryCtaCandidates,
  formatSummaryCtaCandidates,
  restoreSelectedCtas,
  type SummaryCtaCandidate,
} from "./SummaryCtaCandidates.js";

/**
 * `max_attempts = 2` for summaries (Handoff §6). Surfaced here as a
 * module constant for clarity — actual enforcement lives in Package C's
 * QueueRunner/JobRepository, which this processor does not bypass.
 */
export const SUMMARY_MAX_ATTEMPTS = 2;
export const SUMMARY_BULLETS_MAX_CHARS = 320;
const SUMMARY_INTENTS = new Set([
  "invoice",
  "receipt",
  "system_notice",
  "marketing",
  "request",
  "approval",
  "meeting",
  "risk",
  "thread",
  "other",
]);
const SUMMARY_ATTENTIONS = new Set([
  "ignore",
  "know",
  "verify",
  "reply",
  "act",
  "follow_up",
]);
const SUMMARY_DISPLAY_MODES = new Set([
  "one_line",
  "brief",
  "actionable",
  "thread",
]);
const LOW_ATTENTION_INTENTS = new Set([
  "invoice",
  "receipt",
  "system_notice",
  "marketing",
]);

/**
 * Default per-request LLM timeout for summary jobs. MUST stay below the
 * CanonicalAiWorker job-lease (see `claimJob` leaseMs in
 * canonical-ai-worker.ts) with room for getSnapshot + completeJob overhead,
 * so a slow-but-progressing LLM call aborts before the lease expires and
 * the job is double-dispatched to another worker.
 */
export const SUMMARY_LLM_TIMEOUT_MS = 75_000;

/**
 * Focused directive appended on the single monitoring-retry pass. Used
 * only when the body was deterministically detected as a monitoring /
 * operations report (see `hasMonitoringDataCandidate`) but the model
 * omitted `dataInsight` — common with internal run-report mail that the
 * model labels `system_notice`. Keeps genuine monitoring mail from
 * losing its data insight and the "生成数据洞察报告" action.
 */
const MONITORING_RETRY_DIRECTIVE = Object.freeze(
  "The body of THIS email has been deterministically detected as a monitoring or operations report containing a structured data table with numeric metrics (监控/报表). You MUST populate dataInsight: kind='monitoring_report'; extract up to 4 metrics whose value strings appear verbatim in the body; record up to 3 body-supported findings; set evidenceLevel='time_series' only when the body contains multiple time points, otherwise 'snapshot' with no trend claim; and set chartRecommended=true because a real data table is present. Do not invent numbers, dates, or causes.",
) as string;

export interface SummaryProcessorDeps {
  llmClient: LlmClient;
  model: string;
  /** LLM provider / model source (e.g. "openai", "anthropic"). */
  provider?: string;
  /** Body-free structured logger. Receives `{event, ...fields}` payloads. */
  logger?: (event: string, fields: Record<string, string | number>) => void;
  usage?: AiUsageRecorder;
  /** Clock injection for duration logging. */
  now?: () => number;
  /**
   * Per-request LLM timeout (ms). Defaults to {@link SUMMARY_LLM_TIMEOUT_MS}.
   * Kept below the canonical worker's lease budget.
   */
  timeoutMs?: number;
  /**
   * Summary mode: "email" (default, single-message) or "thread".
   * Thread mode builds ordered context from oldest to newest.
   */
  mode?: SummaryMode;
  /**
   * Language for the summary output. When set, the processor instructs
   * the LLM to produce output in this language. Sourced from
   * `AiProfileSettings.summaryLanguage`.
   */
  summaryLanguage?: string;
  /**
   * Thread messages for thread-mode summaries. When mode is "thread",
   * this array provides the chronological messages to summarize.
   */
  threadMessages?: ThreadMessageInput[];
  /**
   * upstream-parity F4: returns the user's free-form custom instructions
   * (from `AiProfileSettings.customInstructions`). Called fresh per LLM
   * request so live edits in Settings take effect on the next call
   * without reconstructing the processor.
   */
  getCustomInstructions?: () => string | undefined;
}

/**
 * Processor-owned failure. `retryable` is honored by QueueRunner: when
 * `false`, the runner short-circuits to `status='failed'` instead of
 * rolling the row back to `pending` for another attempt.
 */
export class SummaryProcessorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "SummaryProcessorError";
    this.code = code;
    this.retryable = retryable;
  }
}

function looksFenced(text: string): boolean {
  return text.trim().startsWith("```");
}

function trimToChars(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  if (maxChars <= 1) return trimmed.slice(0, maxChars);
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

function compactSummaryBullets(bullets: string[]): string[] {
  const normalized = bullets.map((bullet) => bullet.trim()).filter((bullet) => bullet.length > 0);
  if (normalized.join("").length <= SUMMARY_BULLETS_MAX_CHARS) return normalized;

  const perBulletLimit = Math.max(1, Math.floor(SUMMARY_BULLETS_MAX_CHARS / normalized.length));
  const compacted = normalized.map((bullet) => trimToChars(bullet, perBulletLimit));
  let total = compacted.join("").length;
  for (let i = compacted.length - 1; i >= 0 && total > SUMMARY_BULLETS_MAX_CHARS; i -= 1) {
    const over = total - SUMMARY_BULLETS_MAX_CHARS;
    const nextMax = Math.max(1, compacted[i].length - over);
    compacted[i] = trimToChars(compacted[i], nextMax);
    total = compacted.join("").length;
  }
  return compacted.filter((bullet) => bullet.length > 0);
}

function sanitizeStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, maxItems);
}

/**
 * Normalize bare-string values for the summary's maxItems:1 array fields into
 * single-element arrays. On a non-strict structured-output fallback path the
 * model often writes `details`/`actions`/`actionItems` as a single string
 * instead of a one-element array; this coerces such strings (and drops empty
 * ones to []) so validateSummary accepts the salvaged payload. Mutates in
 * place; non-object payloads are left untouched.
 */
function coerceSummarySingletonArrays(parsed: unknown): void {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const obj = parsed as Record<string, unknown>;
  for (const key of ["details", "actions", "actionItems"] as const) {
    const value = obj[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      obj[key] = trimmed ? [trimmed] : [];
    }
  }
}

function isExplicitActionContext(intent: string, attention: string): boolean {
  return attention === "reply" ||
    attention === "act" ||
    attention === "verify" ||
    intent === "request" ||
    intent === "approval" ||
    intent === "meeting" ||
    intent === "risk";
}

function validateDataInsight(value: unknown): SummaryDataInsight | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (source.kind !== "monitoring_report") return undefined;
  const metrics = Array.isArray(source.metrics)
    ? source.metrics.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const metric = item as Record<string, unknown>;
        const label = typeof metric.label === "string" ? metric.label.trim() : "";
        const metricValue = typeof metric.value === "string" ? metric.value.trim() : "";
        if (!label || !metricValue) return [];
        const context = typeof metric.context === "string" ? metric.context.trim() : "";
        return [{ label, value: metricValue, ...(context ? { context } : {}) }];
      }).slice(0, 4)
    : [];
  const evidenceLevel = source.evidenceLevel === "time_series"
    ? "time_series"
    : "snapshot";
  const findings = Array.isArray(source.findings)
    ? source.findings.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const finding = item as Record<string, unknown>;
        const kind: SummaryDataInsight["findings"][number]["kind"] =
          finding.kind === "anomaly" || finding.kind === "trend"
          ? finding.kind
          : "fact";
        const text = typeof finding.text === "string" ? finding.text.trim() : "";
        if (!text || (evidenceLevel === "snapshot" && kind === "trend")) return [];
        return [{ kind, text }];
      }).slice(0, 3)
    : [];
  const chartReason = typeof source.chartReason === "string"
    ? source.chartReason.trim()
    : "";
  return {
    kind: "monitoring_report",
    metrics,
    findings,
    evidenceLevel,
    chartRecommended: source.chartRecommended === true,
    ...(chartReason ? { chartReason } : {}),
  };
}

function validateSummaryV2(
  obj: Record<string, unknown>,
  ctaCandidates: SummaryCtaCandidate[] = [],
): SummaryResult {
  const legacyBullets = sanitizeStringArray(obj.bullets, 4);
  const fallbackHeadline = legacyBullets[0] ?? "";
  const headline =
    typeof obj.headline === "string" && obj.headline.trim().length > 0
      ? trimToChars(obj.headline, 90)
      : trimToChars(fallbackHeadline, 90);

  if (headline.length === 0) {
    throw new SummaryProcessorError("invalid-headline", "headline-missing");
  }

  const intent = SUMMARY_INTENTS.has(obj.intent as string)
    ? obj.intent as SummaryIntent
    : "other";
  const attention = SUMMARY_ATTENTIONS.has(obj.attention as string)
    ? obj.attention as SummaryAttention
    : "know";
  let displayMode = SUMMARY_DISPLAY_MODES.has(obj.displayMode as string)
    ? obj.displayMode as SummaryDisplayMode
    : "brief";
  let details = sanitizeStringArray(obj.details, 1);
  let actions = sanitizeStringArray(obj.actions, 1);
  const actionObligation: SummaryActionObligation =
    obj.actionObligation === "required" ||
    obj.actionObligation === "recommended" ||
    obj.actionObligation === "optional"
      ? obj.actionObligation
      : obj.actionObligation === "none"
        ? "none"
        : actions.length > 0 && obj.urgency !== "low"
          ? "required"
          : "none";
  let urgency: SummaryResult["urgency"] =
    obj.urgency === "high" || obj.urgency === "medium" ? obj.urgency : "low";

  const lowAttention = LOW_ATTENTION_INTENTS.has(intent);
  const explicitAction = isExplicitActionContext(intent, attention);

  const hasRequiredAction =
    explicitAction && actionObligation === "required" && actions.length > 0;

  if (hasRequiredAction && displayMode === "one_line") {
    displayMode = "actionable";
  } else if (!hasRequiredAction && (urgency === "low" || lowAttention)) {
    displayMode = "one_line";
  }
  if (displayMode === "one_line") {
    details = [];
  } else if (lowAttention) {
    details = details.slice(0, 1);
  }
  if (!hasRequiredAction) {
    actions = [];
  }
  if (lowAttention) {
    urgency = "low";
  }

  const dataInsight = validateDataInsight(obj.dataInsight);
  const ctas = restoreSelectedCtas(obj.ctas, ctaCandidates);
  const hasCtaDecision = Array.isArray(obj.ctas);
  return {
    type: "summary",
    schemaVersion: obj.schemaVersion === 3 ? 3 : 2,
    intent,
    attention,
    displayMode,
    headline,
    details,
    actions,
    actionObligation: hasRequiredAction ? "required" : "none",
    bullets: compactSummaryBullets([headline, ...details]),
    actionItems: actions,
    urgency,
    ...(dataInsight ? { dataInsight } : {}),
    ...(hasCtaDecision ? { ctas } : {}),
  };
}

function groundDataInsight(
  summary: SummaryResult,
  mail: Pick<MailMessage, "subject" | "bodyText" | "bodyHtml">,
): SummaryResult {
  if (!summary.dataInsight) return summary;
  const body = (
    mail.bodyText?.trim() ||
    stripHtml(mail.bodyHtml ?? "")
  ).replace(/\s+/g, " ");
  const metrics = summary.dataInsight.metrics.filter((metric) =>
    body.includes(metric.value),
  );
  if (!hasMonitoringDataCandidate(mail)) {
    const { dataInsight: _ignored, ...ordinary } = summary;
    return ordinary;
  }
  return {
    ...summary,
    dataInsight: {
      ...summary.dataInsight,
      metrics,
      chartRecommended:
        summary.dataInsight.chartRecommended &&
        (metrics.length >= 2 || /<table[\s>]/i.test(mail.bodyHtml ?? "")),
    },
  };
}

function validateSummary(
  parsed: unknown,
  ctaCandidates: SummaryCtaCandidate[] = [],
): SummaryResult {
  if (typeof parsed !== "object" || parsed === null) {
    throw new SummaryProcessorError("invalid-shape", "response-not-object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion === 2 || obj.headline !== undefined || obj.intent !== undefined) {
    return validateSummaryV2(obj, ctaCandidates);
  }
  const bullets = obj.bullets;
  const actionItems = obj.actionItems;
  const urgency = obj.urgency;

  if (!Array.isArray(bullets) || bullets.length < 1 || bullets.length > 4) {
    throw new SummaryProcessorError("invalid-bullets", "bullets-out-of-range");
  }
  for (const b of bullets) {
    if (typeof b !== "string" || b.trim().length === 0) {
      throw new SummaryProcessorError("invalid-bullets", "bullet-not-string");
    }
  }
  const compactedBullets = compactSummaryBullets(bullets as string[]);
  if (compactedBullets.length === 0) {
    throw new SummaryProcessorError("invalid-bullets", "bullet-not-string");
  }

  if (!Array.isArray(actionItems) || actionItems.length > 3) {
    throw new SummaryProcessorError(
      "invalid-actionItems",
      Array.isArray(actionItems) ? "actionItems-out-of-range" : "actionItems-not-array",
    );
  }
  for (const a of actionItems) {
    if (typeof a !== "string") {
      throw new SummaryProcessorError(
        "invalid-actionItems",
        "actionItem-not-string",
      );
    }
  }

  if (urgency !== "low" && urgency !== "medium" && urgency !== "high") {
    throw new SummaryProcessorError("invalid-urgency", "urgency-not-enum");
  }

  return {
    type: "summary",
    bullets: compactedBullets,
    actionItems: actionItems as string[],
    urgency,
  };
}

/**
 * Validate a thread-mode summary response with structured action items,
 * evidence references, and optional risks/openQuestions.
 */
function validateThreadSummary(parsed: unknown): SummaryThreadResult {
  if (typeof parsed !== "object" || parsed === null) {
    throw new SummaryProcessorError("invalid-shape", "response-not-object");
  }
  const obj = parsed as Record<string, unknown>;
  const bullets = obj.bullets;
  const actionItems = obj.actionItems;
  const urgency = obj.urgency;
  const evidenceRefs = obj.evidenceRefs;

  if (!Array.isArray(bullets) || bullets.length < 1 || bullets.length > 4) {
    throw new SummaryProcessorError("invalid-bullets", "bullets-out-of-range");
  }
  for (const b of bullets) {
    if (typeof b !== "string" || b.trim().length === 0) {
      throw new SummaryProcessorError("invalid-bullets", "bullet-not-string");
    }
  }
  const compactedBullets = compactSummaryBullets(bullets as string[]);
  if (compactedBullets.length === 0) {
    throw new SummaryProcessorError("invalid-bullets", "bullet-not-string");
  }

  if (!Array.isArray(actionItems) || actionItems.length > 3) {
    throw new SummaryProcessorError(
      "invalid-actionItems",
      Array.isArray(actionItems) ? "actionItems-out-of-range" : "actionItems-not-array",
    );
  }
  for (const a of actionItems) {
    if (typeof a !== "object" || a === null) {
      throw new SummaryProcessorError(
        "invalid-actionItems",
        "actionItem-not-object",
      );
    }
    const item = a as Record<string, unknown>;
    if (typeof item.text !== "string" || item.text.trim().length === 0) {
      throw new SummaryProcessorError(
        "invalid-actionItems",
        "actionItem-text-missing",
      );
    }
    if (!Array.isArray(item.evidenceRefs)) {
      throw new SummaryProcessorError(
        "invalid-actionItems",
        "actionItem-evidenceRefs-not-array",
      );
    }
  }

  if (urgency !== "low" && urgency !== "medium" && urgency !== "high") {
    throw new SummaryProcessorError("invalid-urgency", "urgency-not-enum");
  }

  if (!Array.isArray(evidenceRefs)) {
    throw new SummaryProcessorError(
      "invalid-evidenceRefs",
      "evidenceRefs-not-array",
    );
  }
  for (const ref of evidenceRefs) {
    if (typeof ref !== "string" || ref.trim().length === 0) {
      throw new SummaryProcessorError(
        "invalid-evidenceRefs",
        "evidenceRef-not-string",
      );
    }
  }

  // Optional fields
  const risks = obj.risks;
  if (risks !== undefined) {
    if (!Array.isArray(risks)) {
      throw new SummaryProcessorError("invalid-risks", "risks-not-array");
    }
    for (const r of risks) {
      if (typeof r !== "string" || r.trim().length === 0) {
        throw new SummaryProcessorError("invalid-risks", "risk-not-string");
      }
    }
  }

  const openQuestions = obj.openQuestions;
  if (openQuestions !== undefined) {
    if (!Array.isArray(openQuestions)) {
      throw new SummaryProcessorError(
        "invalid-openQuestions",
        "openQuestions-not-array",
      );
    }
    for (const q of openQuestions) {
      if (typeof q !== "string" || q.trim().length === 0) {
        throw new SummaryProcessorError(
          "invalid-openQuestions",
          "openQuestion-not-string",
        );
      }
    }
  }

  const result: SummaryThreadResult = {
    type: "summary",
    mode: obj.mode === "thread" ? "thread" : "email",
    bullets: compactedBullets,
    actionItems: actionItems as SummaryThreadResult["actionItems"],
    urgency,
    evidenceRefs: evidenceRefs as string[],
  };
  if (risks !== undefined) result.risks = risks as string[];
  if (openQuestions !== undefined) result.openQuestions = openQuestions as string[];

  return result;
}

/**
 * Processor version for AiResultMetadata. Incremented on breaking changes
 * to the output schema or processing logic.
 */
export const SUMMARY_PROCESSOR_VERSION = 6;

/**
 * `MailIntelligenceProcessor` for the `summary` job kind. Dependencies
 * are injected — no singletons — so tests can stub the LLM client and
 * clock cleanly.
 *
 * Supports two modes:
 *   - "email" (default): single-message summary with plain-string actionItems
 *   - "thread": thread-level summary with structured actionItems, evidenceRefs,
 *     risks, and openQuestions
 */
export class SummaryProcessor implements MailIntelligenceProcessor {
  readonly type = "summary" as const;
  private readonly llmClient: LlmClient;
  private readonly model: string;
  private readonly provider?: string;
  private readonly logger: (
    event: string,
    fields: Record<string, string | number>,
  ) => void;
  private readonly usage?: AiUsageRecorder;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly mode: SummaryMode;
  private readonly summaryLanguage?: string;
  private readonly threadMessages?: ThreadMessageInput[];
  private readonly getCustomInstructions?: () => string | undefined;

  constructor(deps: SummaryProcessorDeps) {
    this.llmClient = deps.llmClient;
    this.model = deps.model;
    this.provider = deps.provider;
    this.logger = deps.logger ?? (() => {});
    this.usage = deps.usage;
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? SUMMARY_LLM_TIMEOUT_MS;
    this.mode = deps.mode ?? "email";
    this.summaryLanguage = normalizeSummaryLanguage(deps.summaryLanguage);
    this.threadMessages = deps.threadMessages;
    this.getCustomInstructions = deps.getCustomInstructions;
  }

  async handle(
    job: IntelligenceJob,
    ctx: ProcessorContext,
  ): Promise<SummaryResult | SummaryThreadResult> {
    const started = this.now();

    if (this.mode === "thread") {
      return this.handleThread(job, ctx, started);
    }

    return this.handleEmail(job, ctx, started);
  }

  /**
   * Handle a single-email summary (legacy behavior with v1 output shape,
   * backward-compatible).
   */
  private async handleEmail(
    job: IntelligenceJob,
    ctx: ProcessorContext,
    started: number,
  ): Promise<SummaryResult> {
    const mail = ctx.getMessage(job.emailId);
    if (!mail) {
      throw new SummaryProcessorError("mail-missing", "mail-missing", false);
    }
    if (isImageOnlyBody(mail)) {
      return {
        type: "summary",
        bullets: [],
        actionItems: [],
        urgency: "low",
        _status: "completed",
        reason: "image-only-body",
      };
    }
    if (!hasSummarizableBody(mail)) {
      throw new SummaryProcessorError(
        "body-not-available",
        "mail-body-not-available",
        false,
      );
    }

    // Build context using ContextBuilder for bounded, log-safe context
    const degradedRecovery = job.payload?.strategy === "degraded";
    const contextBuilder = new ContextBuilder({ feature: "summary" });
    const contextResult = contextBuilder.build({
      subject: mail.subject,
      from: mail.from.name
        ? `${mail.from.name} <${mail.from.email}>`
        : mail.from.email,
      bodyText: degradedRecovery
        ? mail.bodyText?.slice(0, 4_000)
        : mail.bodyText,
      bodyHtml: degradedRecovery ? undefined : mail.bodyHtml,
    });

    // Log context metadata (body-free)
    this.logger("summary-context-built", {
      emailId: job.emailId,
      contextRefs: contextResult.contextRefs.join(","),
      totalTokenEstimate: contextResult.totalTokenEstimate,
      truncated: contextResult.truncated ? 1 : 0,
      recoveryStrategy: degradedRecovery ? "degraded" : "standard",
    });

    // Build system prompt with optional language instruction
    const systemPrompt = this.buildSystemPrompt(SUMMARY_SYSTEM_PROMPT);

    const ctaCandidates = extractSummaryCtaCandidates(mail);
    const userMessage = contextResult.promptText +
      formatWorkspaceContext(ctx.workspace) +
      formatSummaryCtaCandidates(ctaCandidates);

    let response;
    try {
      response = await this.llmClient.generate({
        model: this.model,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        jsonSchema: SUMMARY_JSON_SCHEMA,
        temperature: 0.2,
        maxTokens: 4096,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
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
        // Salvage: when a provider rejects strict json_schema the client falls
        // back to a weaker mode, and the model emits a bare string for a
        // maxItems:1 array (e.g. details). Accept the raw JSON and coerce it
        // below instead of failing the whole summary job on a trivial format
        // deviation. Mirrors the TagProcessor salvage path.
        this.logger("summary-schema-mismatch-salvaged", {
          emailId: job.emailId,
          type: "summary",
          model: this.model,
        });
        response = { text: error.rawText, finishReason: "stop" as const };
      } else {
        const duration = this.now() - started;
        this.logger("summary-llm-error", {
          emailId: job.emailId,
          type: "summary",
          durationMs: duration,
          model: this.model,
          code,
        });
        throw error;
      }
    }

    const outputTruncated = response.finishReason === "length";
    if (outputTruncated) {
      this.logger("summary-truncated-recovery", {
        emailId: job.emailId,
        type: "summary",
        model: this.model,
      });
    }

    let responseText = response.text;
    if (looksFenced(responseText)) {
      this.logger("summary-fenced", {
        emailId: job.emailId,
        type: "summary",
        model: this.model,
      });
      responseText = outputTruncated
        ? responseText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
        : stripJsonFence(responseText);
    }

    let parsed: unknown;
    try {
      parsed = outputTruncated
        ? parsePartialJson(responseText, Allow.OBJ | Allow.ARR)
        : JSON.parse(responseText);
    } catch {
      const duration = this.now() - started;
      this.logger("summary-parse-error", {
        emailId: job.emailId,
        type: "summary",
        durationMs: duration,
        model: this.model,
      });
      throw new SummaryProcessorError(
        "invalid-json",
        "response-not-json",
        false,
      );
    }

    // Coerce bare-string values for maxItems:1 array fields into single-element
    // arrays. The summary schema declares details/actions/actionItems as arrays
    // of at most one string, but a model on a non-strict fallback path often
    // writes a single string; normalize so the validator accepts it.
    coerceSummarySingletonArrays(parsed);

    const initialResult = groundDataInsight(
      validateSummary(parsed, ctaCandidates),
      mail,
    );
    const usableBody = (
      mail.bodyText?.trim() ||
      stripHtml(mail.bodyHtml ?? "")
    ).trim();
    if (usableBody.length >= 40 && summaryClaimsEmptyBody(initialResult)) {
      throw new SummaryProcessorError(
        "false-empty-body",
        "summary-contradicts-available-body",
        true,
      );
    }

    let result = initialResult;
    let inputTokens = response.usage?.inputTokens ?? 0;
    let outputTokens = response.usage?.outputTokens ?? 0;

    // Deterministic fallback: the body looks like a monitoring/operations
    // report (structured table + metrics) but the model omitted dataInsight
    // — common with internal run-report mail that gets labeled system_notice.
    // Do one focused retry so genuine monitoring mail still surfaces the
    // data insight and the "generate data-insight report" action.
    const retryBudgetMs = Math.max(0, this.timeoutMs - (this.now() - started));
    if (!result.dataInsight && retryBudgetMs >= 1_000 && hasMonitoringDataCandidate(mail)) {
      this.logger("summary-monitoring-retry-attempt", {
        emailId: job.emailId,
        type: "summary",
        model: this.model,
      });
      const retry = await this.attemptMonitoringRetry(
        job.emailId,
        userMessage,
        mail,
        ctaCandidates,
        retryBudgetMs,
      );
      if (retry.result) {
        result = retry.result;
      }
      if (retry.usage) {
        inputTokens += retry.usage.inputTokens ?? 0;
        outputTokens += retry.usage.outputTokens ?? 0;
      }
    }

    const duration = this.now() - started;

    // Build AI quality metadata
    const metadata: AiResultMetadata = {
      processor: "summary",
      version: SUMMARY_PROCESSOR_VERSION,
      model: this.model,
      contextRefs: contextResult.contextRefs,
      createdAt: new Date(started).toISOString(),
      durationMs: duration,
      tokenUsage: {
        inputTokens,
        outputTokens,
      },
      ...(outputTruncated ? { truncated: true } : {}),
      ...(typeof mail.bodyVersion === "number"
        ? { bodyVersion: mail.bodyVersion }
        : {}),
      contentFingerprint: summaryContentFingerprint(mail),
    };

    this.logger("summary-ok", {
      emailId: job.emailId,
      type: "summary",
      durationMs: duration,
      model: this.model,
      inputTokens,
      outputTokens,
      dataInsight: result.dataInsight ? 1 : 0,
      ctaCount: result.ctas?.length ?? 0,
      version: SUMMARY_PROCESSOR_VERSION,
      contextRefs: contextResult.contextRefs.join(","),
    });
    await this.usage?.record({
      accountId: mail.accountId,
      category: "summary",
      processor: "summary",
      emailId: job.emailId,
      inputTokens,
      outputTokens,
      model: this.model,
      provider: this.provider,
      durationMs: duration,
    });
    return { ...result, _metadata: metadata };
  }

  /**
   * Handle a thread-level summary with structured output.
   */
  private async handleThread(
    job: IntelligenceJob,
    ctx: ProcessorContext,
    started: number,
  ): Promise<SummaryThreadResult> {
    const messages = this.threadMessages ?? [];

    if (messages.length === 0) {
      throw new SummaryProcessorError(
        "no-thread-messages",
        "thread-mode-requires-messages",
        false,
      );
    }

    // Sort messages chronologically (oldest first)
    const sorted = [...messages].sort(
      (a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime(),
    );

    // Build thread context with stable section ids
    const sectionIds = sorted.map((_, i) => `thread-msg-${i}`);
    const userMessage = buildThreadSummaryUserMessage(
      sorted,
      this.summaryLanguage,
      ctx.workspace,
    );

    // Estimate tokens for metadata
    const estimatedTokens = estimateTokens(userMessage);

    // Build system prompt with optional language instruction
    const systemPrompt = this.buildSystemPrompt(THREAD_SUMMARY_SYSTEM_PROMPT);

    this.logger("summary-thread-context-built", {
      emailId: job.emailId,
      type: "summary",
      mode: "thread",
      messageCount: sorted.length,
      totalTokenEstimate: estimatedTokens,
      contextRefs: sectionIds.join(","),
    });

    let response;
    try {
      response = await this.llmClient.generate({
        model: this.model,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        jsonSchema: THREAD_SUMMARY_JSON_SCHEMA,
        temperature: 0.2,
        maxTokens: 4096,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      const duration = this.now() - started;
      const code =
        error instanceof LlmClientError
          ? (error.code ?? `http-${error.status ?? 0}`)
          : "unknown";
      this.logger("summary-thread-llm-error", {
        emailId: job.emailId,
        type: "summary",
        mode: "thread",
        durationMs: duration,
        model: this.model,
        code,
      });
      throw error;
    }

    if (response.finishReason === "length") {
      this.logger("summary-thread-truncated", {
        emailId: job.emailId,
        type: "summary",
        mode: "thread",
        model: this.model,
      });
      throw new SummaryProcessorError(
        "truncated",
        "truncated response",
        false,
      );
    }

    let responseText = response.text;
    if (looksFenced(responseText)) {
      this.logger("summary-thread-fenced", {
        emailId: job.emailId,
        type: "summary",
        mode: "thread",
        model: this.model,
      });
      responseText = stripJsonFence(responseText);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      const duration = this.now() - started;
      this.logger("summary-thread-parse-error", {
        emailId: job.emailId,
        type: "summary",
        mode: "thread",
        durationMs: duration,
        model: this.model,
      });
      throw new SummaryProcessorError(
        "invalid-json",
        "response-not-json",
        false,
      );
    }

    const result = validateThreadSummary(parsed);
    // Ensure mode is set correctly
    result.mode = "thread";
    const duration = this.now() - started;

    // Build AI quality metadata
    const metadata: AiResultMetadata = {
      processor: "summary",
      version: SUMMARY_PROCESSOR_VERSION,
      model: this.model,
      contextRefs: sectionIds,
      createdAt: new Date(started).toISOString(),
      durationMs: duration,
      tokenUsage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      },
    };

    this.logger("summary-thread-ok", {
      emailId: job.emailId,
      type: "summary",
      mode: "thread",
      durationMs: duration,
      model: this.model,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      version: SUMMARY_PROCESSOR_VERSION,
      contextRefs: sectionIds.join(","),
      bulletCount: result.bullets.length,
      actionItemCount: result.actionItems.length,
    });

    const accountId = job.emailId.split(":")[0] ?? "unknown";
    await this.usage?.record({
      accountId,
      category: "summary",
      processor: "summary",
      emailId: job.emailId,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      model: this.model,
      provider: this.provider,
      durationMs: duration,
    });

    return { ...result, _metadata: metadata };
  }

  /**
   * Single focused retry used only when the body is a deterministic
   * monitoring/report candidate but the initial summary omitted
   * `dataInsight`. Returns the recovered summary only when the retry
   * actually produces a grounded `dataInsight`; otherwise returns a
   * null result so the caller keeps the original summary. Any LLM,
   * parse, or validation failure is swallowed and logged — this path
   * must never regress an otherwise-valid summary.
   */
  private async attemptMonitoringRetry(
    emailId: string,
    userMessage: string,
    mail: Pick<MailMessage, "subject" | "bodyText" | "bodyHtml">,
    ctaCandidates: SummaryCtaCandidate[],
    timeoutMs: number,
  ): Promise<{ result: SummaryResult | null; usage: LlmUsage | undefined }> {
    const systemPrompt = this.buildSystemPrompt(
      `${SUMMARY_SYSTEM_PROMPT} ${MONITORING_RETRY_DIRECTIVE}`,
    );
    let response: LlmResponse;
    try {
      response = await this.llmClient.generate({
        model: this.model,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        jsonSchema: SUMMARY_JSON_SCHEMA,
        temperature: 0.2,
        maxTokens: 4096,
        timeoutMs,
      });
    } catch (error) {
      this.logger("summary-monitoring-retry-error", {
        emailId,
        type: "summary",
        model: this.model,
        code:
          error instanceof LlmClientError
            ? (error.code ?? `http-${error.status ?? 0}`)
            : "unknown",
      });
      return { result: null, usage: undefined };
    }

    if (response.finishReason === "length") {
      this.logger("summary-monitoring-retry-truncated", {
        emailId,
        type: "summary",
        model: this.model,
      });
      return { result: null, usage: response.usage };
    }

    let text = response.text;
    if (looksFenced(text)) {
      text = stripJsonFence(text);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.logger("summary-monitoring-retry-parse-error", {
        emailId,
        type: "summary",
        model: this.model,
      });
      return { result: null, usage: response.usage };
    }

    try {
      const retryResult = groundDataInsight(
        validateSummary(parsed, ctaCandidates),
        mail,
      );
      const usableBody = (
        mail.bodyText?.trim() ||
        stripHtml(mail.bodyHtml ?? "")
      ).trim();
      if (usableBody.length >= 40 && summaryClaimsEmptyBody(retryResult)) {
        this.logger("summary-monitoring-retry-empty-body", {
          emailId,
          type: "summary",
          model: this.model,
        });
        return { result: null, usage: response.usage };
      }
      if (!retryResult.dataInsight) {
        this.logger("summary-monitoring-retry-no-insight", {
          emailId,
          type: "summary",
          model: this.model,
        });
        return { result: null, usage: response.usage };
      }
      this.logger("summary-monitoring-retry-ok", {
        emailId,
        type: "summary",
        model: this.model,
        metrics: retryResult.dataInsight.metrics.length,
        chartRecommended: retryResult.dataInsight.chartRecommended ? 1 : 0,
      });
      return { result: retryResult, usage: response.usage };
    } catch (error) {
      this.logger("summary-monitoring-retry-invalid", {
        emailId,
        type: "summary",
        model: this.model,
        code: error instanceof SummaryProcessorError ? error.code : "unknown",
      });
      return { result: null, usage: response.usage };
    }
  }

  /**
   * Build a system prompt with an optional language instruction appended,
   * then layer the user's custom instructions (F4) at the end.
   */
  private buildSystemPrompt(basePrompt: string): string {
    let prompt = basePrompt;
    if (this.summaryLanguage) {
      const lang = this.summaryLanguage.toLowerCase();
      if (lang !== "english" && lang !== "en") {
        prompt = `${prompt} Produce all text fields in ${this.summaryLanguage}.`;
      }
    }
    return applyCustomInstructions(prompt, this.getCustomInstructions?.());
  }
}

function normalizeSummaryLanguage(language: string | undefined): string {
  if (!language || language.trim().length === 0) return "Chinese";
  const trimmed = language.trim();
  if (trimmed.toLowerCase() === "auto") return "Chinese";
  return trimmed;
}
