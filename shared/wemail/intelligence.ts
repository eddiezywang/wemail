import type { AutomationAction, AutomationConditions } from "./automation.js";
import type { InvoiceMailStatusSummary } from "./invoice.js";
import type { AgentSuggestionAction } from "./usage.js";

export type IntelligenceJobType =
  | "summary"
  | "tags"
  | "replyDecision"
  | "replyDraft"
  | "todoExtraction"
  | "linkExtraction"
  | "translation"
  | "composeMail";

/**
 * @deprecated Use {@link IntelligenceJobType} instead. Kept for backward
 * compatibility with legacy queue.ts imports during the Package C cutover.
 */
export type IntelligenceProcessorName = IntelligenceJobType;

export type IntelligenceStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export type SummaryWorkState =
  | "missing"
  | "invalid"
  | IntelligenceStatus;

export interface SummaryHealthStatus {
  total: number;
  succeeded: number;
  failed: number;
  missing: number;
  invalid: number;
  pending: number;
  running: number;
  skipped: number;
  retryable: number;
  items?: SummaryHealthItem[];
  hasMore?: boolean;
  nextOffset?: number;
}

export type SummaryRetryMode = "failed" | "missing" | "all";

/** Job kinds that per-attribute retry can route (matches requestIntelligence). */
export type IntelligenceAttributeKind =
  | "summary"
  | "tags"
  | "replyDecision"
  | "todoExtraction";

export const INTELLIGENCE_ATTRIBUTE_KINDS: readonly IntelligenceAttributeKind[] =
  ["summary", "tags", "replyDecision", "todoExtraction"] as const;

/**
 * Per-attribute generation status for one email (Route C / WP H). Lets
 * the summary center show which capability succeeded/failed and retry a
 * single attribute without re-running the others.
 */
export interface IntelligenceAttributeStatus {
  kind: IntelligenceAttributeKind;
  state: SummaryWorkState;
  error?: string | null;
  job?: Pick<
    IntelligenceJob,
    "id" | "status" | "attempts" | "maxAttempts" | "createdAt" | "updatedAt" | "startedAt" | "finishedAt" | "error"
  >;
}

export interface SummaryRetryAllResult {
  queued: number;
  inserted: number;
  reset: number;
  /** Candidates skipped because their mail body content was not ready. */
  skipped?: number;
}

export interface SummaryHealthItem {
  emailId: string;
  subject: string;
  sender: string;
  receivedAt: string;
  state: SummaryWorkState;
  error?: string | null;
  diagnostic?: {
    source: "result" | "job" | "derived";
    errorCode?: string;
    errorMessage?: string;
    updatedAt?: string;
  };
  job?: Pick<
    IntelligenceJob,
    "id" | "status" | "attempts" | "maxAttempts" | "createdAt" | "updatedAt" | "startedAt" | "finishedAt" | "error"
  >;
  /**
   * Per-attribute generation status (summary/tags/replyDecision/todo).
   * Present when the health query built attribute rows for this email.
   */
  attributes?: IntelligenceAttributeStatus[];
}

/**
 * @deprecated Use {@link IntelligenceStatus} instead. Kept for backward
 * compatibility with legacy code during the Package C cutover.
 */
export type JobStatus = IntelligenceStatus;

/* ---------------------------------------------------------------- *
 * Category Taxonomy (ai-classification-inbox-tabs)                 *
 * ---------------------------------------------------------------- */

/**
 * The eight canonical system category ids for inbox classification.
 * These are language-independent; the API never uses display labels
 * as identifiers.
 */
export const SYSTEM_CATEGORY_IDS = Object.freeze([
  "important",
  "action_required",
  "newsletter",
  "marketing",
  "receipt",
  "notification",
  "personal",
  "other",
] as const) as readonly string[];

export type SystemCategoryId = (typeof SYSTEM_CATEGORY_IDS)[number];

/** Set for O(1) membership checks. */
export const SYSTEM_CATEGORY_SET: ReadonlySet<string> = new Set(SYSTEM_CATEGORY_IDS);

/**
 * Default display labels for system categories. The renderer may
 * override with localized strings. The API never uses these as ids.
 */
export const SYSTEM_CATEGORY_LABELS: Readonly<Record<SystemCategoryId, string>> = {
  important: "Important",
  action_required: "Action Required",
  newsletter: "Newsletter",
  marketing: "Marketing",
  receipt: "Receipt",
  notification: "Notification",
  personal: "Personal",
  other: "Other",
};

/**
 * User-visible, independently matchable system classifications.
 *
 * Unlike the legacy eight-way category taxonomy above, these signals are not
 * mutually exclusive. The legacy taxonomy remains readable during migration,
 * but new product surfaces and filters use this vocabulary.
 */
export const SMART_CLASSIFICATION_IDS = Object.freeze([
  "important",
  "action_required",
  "invoice",
] as const);

export type SmartClassificationId = (typeof SMART_CLASSIFICATION_IDS)[number];

export const SMART_CLASSIFICATION_SET: ReadonlySet<string> = new Set(
  SMART_CLASSIFICATION_IDS,
);

export const SMART_CLASSIFICATION_LABELS: Readonly<
  Record<SmartClassificationId, string>
> = {
  important: "重要",
  action_required: "待处理",
  invoice: "发票",
};

export interface MailReceivedEvent {
  type: "mail.received";
  accountId: string;
  emailId: string;
  threadId: string;
  receivedAt: string;
}

/* ---------------------------------------------------------------- *
 * Wave 0 cross-package locked types (consumed by Packages C/E/F/G) *
 * ---------------------------------------------------------------- */

/**
 * Processor-facing job shape shared with the canonical durable queue.
 */
export interface IntelligenceJob {
  id: string;
  emailId: string;
  type: IntelligenceJobType;
  status: IntelligenceStatus;
  payload?: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export type SummaryIntent =
  | "invoice"
  | "receipt"
  | "system_notice"
  | "marketing"
  | "request"
  | "approval"
  | "meeting"
  | "risk"
  | "thread"
  | "other";

export type SummaryAttention =
  | "ignore"
  | "know"
  | "verify"
  | "reply"
  | "act"
  | "follow_up";

export type SummaryDisplayMode =
  | "one_line"
  | "brief"
  | "actionable"
  | "thread";

export type SummaryActionObligation =
  | "none"
  | "required"
  | "recommended"
  | "optional";

export interface SummaryDataInsight {
  kind: "monitoring_report";
  metrics: Array<{
    label: string;
    value: string;
    context?: string;
  }>;
  findings: Array<{
    kind: "fact" | "anomaly" | "trend";
    text: string;
  }>;
  evidenceLevel: "snapshot" | "time_series";
  chartRecommended: boolean;
  chartReason?: string;
}

export type SummaryCtaConfidence = "h" | "m" | "l";

/**
 * A content CTA selected during the existing summary request. The model only
 * returns a compact candidate index, label, and confidence; trusted local code
 * restores the URL and risk signals from the extracted candidate.
 */
export interface SummaryCta {
  url: string;
  label: string;
  confidence: SummaryCtaConfidence;
  risk: boolean;
  riskReasons: LinkExtractionResult["links"][number]["riskReasons"];
  category: LinkExtractionResult["links"][number]["category"];
}

export interface SummaryResult {
  type: "summary";
  schemaVersion?: 1 | 2 | 3;
  intent?: SummaryIntent;
  attention?: SummaryAttention;
  displayMode?: SummaryDisplayMode;
  headline?: string;
  details?: string[];
  actions?: string[];
  /** Whether the surfaced action is a recipient obligation or a lower-strength suggestion. */
  actionObligation?: SummaryActionObligation;
  bullets: string[];
  actionItems: string[];
  urgency: "low" | "medium" | "high";
  dataInsight?: SummaryDataInsight;
  /** Optional content CTAs chosen in the same LLM call as this summary. */
  ctas?: SummaryCta[];
  /** Deterministic completion marker for bodies with no readable text. */
  _status?: "completed";
  reason?: string;
  /** AI quality metadata, attached by processors that adopt the quality foundation. */
  _metadata?: AiResultMetadata;
}

export interface MailSceneActionContext {
  kind: "insight-report";
  operation: "generate" | "aggregate" | "edit" | "regenerate";
  reportId?: string;
  reportVersion?: number;
  sourceEmailIds?: string[];
  lookbackPreset?: "24h" | "7d";
  lookbackDays?: number;
}

export interface MailSceneAction {
  id:
    | "monitoring.generate_chart"
    | "insight-report.view"
    | "insight-report.edit"
    | "insight-report.regenerate"
    | "insight-report.regenerate_24h"
    | "insight-report.regenerate_7d"
    | "insight-report.aggregate"
    | "insight-report.aggregate_24h"
    | "insight-report.aggregate_7d"
    | "invoice.upload"
    | `summary.action.${number}`
    /** Edition-contributed scene actions (P2 module seam). */
    | `edition.${string}`;
  scene:
    | "monitoring_report"
    | "insight_report"
    | "invoice"
    | "summary_action"
    /** Edition-contributed scene (P2 module seam). */
    | "edition";
  label: string;
  icon: "chart" | "upload" | "action";
  status: "available" | "completed";
  /** Concise user-facing Agent message, including its action label prefix. */
  composerText?: string;
  /** Non-visible action metadata sent with the Agent request. */
  agentContext?: MailSceneActionContext;
  agentPrompt?: string;
  reportId?: string;
  reportVersion?: number;
  applicationMessageId?: string;
  risk: "none" | "confirmation_required";
}

/**
 * Classification result: extended TagResult with reason and confidence
 * at the classification level. The TagResult still carries per-tag
 * confidence; this adds the overall classification confidence.
 */
export interface ClassificationResult {
  /** The selected system category id. */
  categoryId: SystemCategoryId;
  /** Human-readable reason for the classification. */
  reason: string;
  /** Overall classification confidence in [0, 1]. */
  confidence: number;
}

export interface ClassificationSignal {
  matched: boolean;
  confidence: number;
  reason: string;
  source: "ai" | "rule" | "user";
}

export interface SystemClassificationResult {
  important: ClassificationSignal;
  actionRequired: ClassificationSignal & { actions?: string[] };
  invoice: ClassificationSignal & { evidence?: string[] };
}

export interface ContentTopicTag {
  name: string;
  confidence: number;
  source: "ai" | "user";
  topicId?: string;
  tier: "auto" | "suggested";
}

export type SmartTagPromotionGenerationStatus = "generated" | "fallback";

export interface SmartTagPromotionDraft {
  name: string;
  description: string;
  topicId: string;
  sourceEmailId: string;
  generationStatus: SmartTagPromotionGenerationStatus;
  generationError?: string;
}

export interface SmartTagPromotionPreviewRequest {
  emailId: string;
  candidateName: string;
  topicId?: string;
  /** 命中缓存时是否强制重新生成描述（重新生成会覆盖缓存）。 */
  refresh?: boolean;
}

export interface SmartTagPromotionPreviewResponse {
  ok: true;
  draft: SmartTagPromotionDraft;
}

export interface SmartTagPromotionCreateRequest {
  emailId: string;
  candidateName: string;
  topicId?: string;
  name: string;
  description: string;
}

export interface SmartTagPromotionCreateResponse {
  ok: true;
  tag: {
    id: string;
    accountId: string;
    name: string;
    description: string;
    prompt: string;
    effectivePrompt: string;
    creationSource: "topic-suggestion";
    sourceTopicId?: string;
    createdAt: string;
    updatedAt: string;
  };
  topicId: string;
  sourceEmailId: string;
  backfill: {
    runId: string;
    status: "running" | "completed";
    scanned: number;
    queued: number;
    recent: number;
    historical: number;
  };
  idempotent: boolean;
}

export interface TagResult {
  type: "tags";
  /** Schema 3 introduces independent system signals and content topics. */
  schemaVersion?: 3;
  tags: Array<{
    name: string;
    confidence: number;
    source: "ai" | "rule" | "user";
    tier: "auto" | "suggested";
  }>;
  /** The authoritative system-classification model for new results. */
  system?: SystemClassificationResult;
  /** Bounded, inline-only content topics. Never rendered in the sidebar. */
  contentTags?: ContentTopicTag[];
  /** Optional classification into a system category (ai-classification-inbox-tabs). */
  classification?: ClassificationResult;
  /** AI quality metadata, attached by processors that adopt the quality foundation. */
  _metadata?: AiResultMetadata;
}

export function smartClassificationSignal(
  result: TagResult | null | undefined,
  id: SmartClassificationId,
): ClassificationSignal | undefined {
  if (!result) return undefined;
  if (result.system) {
    if (id === "important") return result.system.important;
    if (id === "action_required") return result.system.actionRequired;
    return result.system.invoice;
  }
  // Conservative legacy compatibility. Historical receipts are deliberately
  // not promoted to invoices; they must be reclassified under the new rules.
  const legacy = result.classification;
  if (legacy?.categoryId === id) {
    return {
      matched: true,
      confidence: legacy.confidence,
      reason: legacy.reason,
      source: "ai",
    };
  }
  return undefined;
}

export function matchedSmartClassificationIds(
  result: TagResult | null | undefined,
): SmartClassificationId[] {
  return SMART_CLASSIFICATION_IDS.filter(
    (id) => smartClassificationSignal(result, id)?.matched === true,
  );
}

export interface ReplyDecisionResult {
  type: "replyDecision";
  shouldReply: boolean;
  reason: string;
  confidence: number;
  /**
   * Priority score in [0, 1]. Higher = more important. Deterministic for
   * identical stored inputs and prompt version.
   */
  priorityScore: number;
  /**
   * Coarse priority bucket derived from priorityScore:
   *   low    = score < 0.35
   *   normal = 0.35 <= score < 0.7
   *   high   = score >= 0.7
   */
  level: "low" | "normal" | "high";
  /** Whether a reply is required (may differ from shouldReply when priority is low). */
  replyRequired: boolean;
  /** Optional ISO-8601 deadline extracted from the message body, if present. */
  deadline?: string;
  /**
   * Explainable signals that contributed to the priority and reply decision.
   * Each signal carries a name, human-readable value, and optional weight
   * in [0, 1] indicating how much it influenced the result.
   */
  signals: Array<{ name: string; value: string; weight?: number }>;
  /** AI quality metadata, attached by processors that adopt the quality foundation. */
  _metadata?: AiResultMetadata;
}

/** ReplyDraftResult is defined at the end of this file (ai-writing-suite). */

/**
 * Task Agent statuses (Feature F3 — Task Agent state machine).
 * The Task Agent labels every active to-do with a status that updates
 * as the email thread evolves; a user override locks the status.
 */
export type TaskAgentStatus =
  | "to-respond"
  | "awaiting-reply"
  | "review-needed"
  | "approval-needed"
  | "meeting-update"
  | "suggested-done";

/** Ordered list of all valid Task Agent statuses (used for cycling). */
export const TASK_AGENT_STATUSES: readonly TaskAgentStatus[] = Object.freeze([
  "to-respond",
  "awaiting-reply",
  "review-needed",
  "approval-needed",
  "meeting-update",
  "suggested-done",
]);

export interface TodoExtractionResult {
  type: "todoExtraction";
  todos: Array<{
    id?: string;
    title: string;
    description?: string;
    dueDate?: string;
    startTime?: string;
    confidence: number;
    status: "suggested" | "confirmed";
    /** Task Agent state-machine label (Feature F3). */
    agentStatus?: TaskAgentStatus | null;
    /** Whether the user has manually locked the agent status. */
    agentStatusLocked?: boolean;
    /**
     * Route C / WP G: AI evidence supporting this todo. Each item is a
     * 1–2 sentence quote or paraphrase from the email. Populated by
     * Batch 2G; Batch 1A only opens the channel.
     */
    evidence?: string[];
    /** Route C / WP G: model's free-form rationale for extracting this todo. */
    extractionReason?: string;
    /** Route C / WP G: 0..1 model confidence for the extraction itself. */
    extractionConfidence?: number;
  }>;
  /** AI quality metadata, attached by processors that adopt the quality foundation. */
  _metadata?: AiResultMetadata;
}

export interface LinkExtractionResult {
  type: "linkExtraction";
  links: Array<{
    url: string;
    actionText: string;
    risk: boolean;
    category:
      | "action"
      | "subscribe"
      | "unsubscribe"
      | "confirm"
      | "download"
      | "navigate"
      | "payment"
      | "meeting"
      | "approval"
      | "document";
    /**
     * Machine-readable risk reason codes for this link. Empty when risk=false.
     * Each code identifies a specific risk signal detected by the processor.
     */
    riskReasons: Array<
      | "display-domain-mismatch"
      | "suspicious-domain"
      | "shortener"
      | "unsafe-scheme"
      | "credential-in-query"
      | "suspicious-tld"
      | "deeply-nested-subdomain"
    >;
  }>;
  unsubscribeUrl: string | null;
  /**
   * AI quality metadata. The link extractor is hybrid: when an LLM is
   * configured the metadata records the model + token usage; when running
   * pure-local heuristics (`model: "deterministic"`) tokenUsage is zero.
   */
  _metadata?: AiResultMetadata;
}

export interface TranslationResult {
  type: "translation";
  targetLanguage: string;
  translatedText: string;
  cached: boolean;
  /** Ordered paragraph mappings for side-by-side rendering. */
  paragraphs?: TranslationParagraph[];
  /** AI quality metadata, attached by processors that adopt the quality foundation. */
  _metadata?: AiResultMetadata;
}

/**
 * A single paragraph mapping preserving source order for side-by-side
 * rendering of original and translated text.
 */
export interface TranslationParagraph {
  /** Zero-based index of this paragraph in the source text. */
  index: number;
  /** Original source paragraph text. */
  source: string;
  /** Translated paragraph text. */
  translated: string;
}

export interface ComposeMailResult {
  type: "composeMail";
  operationType: "NEW" | "REPLY";
  /** Draft status: "draft" when content is ready, "needsClarification" when info is missing. */
  status: "draft" | "waiting_confirmed" | "needsClarification";
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  draftMarkdown: string;
  /** Future ISO timestamp suggested by AI. This does not schedule the draft. */
  suggestedSendAt?: string;
  /** IANA timezone used to interpret the user's scheduling instruction. */
  suggestedSendTimeZone?: string;
  /** Short user-facing summaries of envelope and scheduling changes. */
  changeSummary?: string[];
  targetLanguage?: string;
  styleId?: string;
  /** ISO-639 language code for the draft. */
  language?: string;
  /** AI quality metadata. */
  _metadata?: AiResultMetadata;
  /** Present when status is "needsClarification". */
  clarification?: ClarificationResult;
}

/**
 * Discriminated union returned by processors. Downstream callers MUST
 * narrow on `result.type`.
 */
export type IntelligenceResult =
  | SummaryResult
  | SummaryThreadResult
  | TagResult
  | ReplyDecisionResult
  | ReplyDraftResult
  | TodoExtractionResult
  | LinkExtractionResult
  | TranslationResult
  | ComposeMailResult;

export interface CallerContext {
  source: "system" | "agent" | "user";
  sessionId?: string;
  userId?: string;
  meta?: Record<string, string>;
}

/* ---------------------------------------------------------------- *
 * AI Summary Thread Quality (ai-summary-thread-quality)            *
 * ---------------------------------------------------------------- */

/**
 * A structured action item with evidence references. Replaces the
 * plain-string actionItems from the legacy SummaryResult when the
 * processor is in thread mode or when the v2 output schema is active.
 */
export interface StructuredActionItem {
  /** Imperative phrase the recipient should do. */
  text: string;
  /** Optional owner / assignee. */
  owner?: string;
  /** Optional deadline or due date. */
  deadline?: string;
  /** Section or email ids that support this action item. */
  evidenceRefs: string[];
}

/**
 * Summary mode: single-email ("email") or thread-level ("thread").
 * Thread mode builds ordered context from oldest to newest and
 * compresses long history into bounded sections with source ids.
 */
export type SummaryMode = "email" | "thread";

/**
 * Extended summary result with structured action items, evidence
 * references, risks, and open questions. Produced when the processor
 * operates in thread mode or with the v2 output schema.
 *
 * The `mode` discriminator allows consumers to distinguish between
 * the legacy SummaryResult (which uses plain-string actionItems) and
 * the new structured output.
 */
export interface SummaryThreadResult {
  type: "summary";
  /** Processing mode: "email" for single-message, "thread" for thread-level. */
  mode: SummaryMode;
  bullets: string[];
  /** Structured action items with evidence references. Empty when no actionable content. */
  actionItems: StructuredActionItem[];
  urgency: "low" | "medium" | "high";
  /** Optional risk items identified in the content. */
  risks?: string[];
  /** Optional open questions that remain unanswered. */
  openQuestions?: string[];
  /** Section or email ids cited as evidence for the summary. */
  evidenceRefs: string[];
  /** AI quality metadata. */
  _metadata?: AiResultMetadata;
}

/**
 * Thread context entry: one message in a thread, passed to the
 * ContextBuilder for thread-mode summary building.
 */
export interface ThreadMessageInput {
  /** The email id (used as evidenceRef). */
  emailId: string;
  subject?: string;
  from?: string;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  /** ISO-8601 timestamp for chronological ordering. */
  receivedAt: string;
}

/* ---------------------------------------------------------------- *
 * AI Quality Foundation (ai-quality-foundation)                    *
 * ---------------------------------------------------------------- */

/**
 * Token usage breakdown attached to AI result metadata.
 */
export interface AiTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Metadata attached to every AI result row. Provides provenance,
 * performance, and reproducibility information for all AI features.
 *
 * Stored alongside the canonical artifact. Every processor that adopts the
 * quality foundation MUST include this.
 */
export interface AiResultMetadata {
  /** The processor type that produced this result (e.g. "summary", "tags"). */
  processor: IntelligenceJobType;
  /** Schema/processor version for reproducibility. Incremented on breaking changes. */
  version: number;
  /** The LLM model identifier used (e.g. "gpt-4o-mini"). */
  model: string;
  /** Optional confidence score in [0, 1] when the processor can compute one. */
  confidence?: number;
  /** References to context sections used, enabling traceability without logging body. */
  contextRefs: string[];
  /** ISO-8601 timestamp when the processor started. */
  createdAt: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Token usage breakdown from the LLM call. */
  tokenUsage: AiTokenUsage;
  /** Whether any content was split from an oversized paragraph during processing. */
  truncated?: boolean;
  /** Fingerprint of the smart-tag definitions used by the tags processor. */
  tagDefinitionFingerprint?: string;
  /** Mail body version used to produce this result. */
  bodyVersion?: number;
  /** Body-free digest used to invalidate results after mail content changes. */
  contentFingerprint?: string;
}

/**
 * Normalized event types for AI feedback. Each maps to a user action
 * on an AI output.
 */
export type AiFeedbackEventType =
  | "accept"
  | "reject"
  | "edit"
  | "confirm"
  | "delete"
  | "rate";

/**
 * Normalized feedback record for AI feature outputs. Persisted without
 * storing full mail body content, prompt text, or raw LLM response text.
 *
 * This is the primary data structure for the feedback loop that drives
 * personalization and quality improvement.
 */
export interface AiFeedbackEvent {
  id: string;
  /** The account this feedback belongs to. */
  accountId: string;
  /** The feature/processor type this feedback targets. */
  feature: IntelligenceJobType;
  /** The kind of user action. */
  eventType: AiFeedbackEventType;
  /** Optional email this feedback relates to. */
  emailId?: string;
  /** Optional thread this feedback relates to. */
  threadId?: string;
  /**
   * Sanitized payload. MUST NOT contain bodyText, bodyHtml, prompt text,
   * or raw LLM response text. Only structured data like tag names,
   * confidence scores, urgency levels, etc.
   */
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * A section produced by ContextBuilder. Each section has a stable id
 * (used in contextRefs) and a token estimate for budgeting.
 */
export interface ContextSection {
  /** Stable section identifier (e.g. "header", "body-text", "body-html-stripped"). */
  id: string;
  /** Estimated token count for this section. */
  tokenEstimate: number;
}

/**
 * Result of building context for an AI feature. Contains the assembled
 * prompt text (for LLM consumption only — never logged) and metadata
 * (safe to log).
 */
export interface ContextBuildResult {
  /** The assembled prompt text. NOT safe for logging. */
  promptText: string;
  /** Metadata about context sections — safe for logging. */
  sections: ContextSection[];
  /** All section ids — used as contextRefs in AiResultMetadata. */
  contextRefs: string[];
  /** Total estimated token count across all sections. */
  totalTokenEstimate: number;
  /** Whether any section was truncated to fit budget. */
  truncated: boolean;
}

/**
 * Context builder input: a subset of mail fields needed to build
 * bounded, feature-specific context.
 */
export interface ContextBuilderInput {
  subject?: string;
  from?: string;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
}

/**
 * Eval fixture result: machine-readable pass/fail output for each fixture.
 */
export interface EvalFixtureResult {
  /** Unique fixture identifier. */
  fixtureId: string;
  /** The feature being tested (e.g. "summary", "tags"). */
  feature: IntelligenceJobType;
  /** Pass/fail status. */
  status: "pass" | "fail";
  /** List of violation codes (empty when status is "pass"). */
  violations: string[];
  /** Estimated token count for the context. */
  tokenEstimate: number;
}

/**
 * Full eval run report with aggregated results.
 */
export interface EvalRunReport {
  /** ISO-8601 timestamp when the run started. */
  runAt: string;
  /** Total number of fixtures loaded. */
  fixturesLoaded: number;
  /** Number of fixtures that passed. */
  passed: number;
  /** Number of fixtures that failed. */
  failed: number;
  /** Per-fixture results. */
  results: EvalFixtureResult[];
}

export interface EmailIntelligenceState {
  emailId: string;
  invoiceStatus?: InvoiceMailStatusSummary;
  sceneActions?: MailSceneAction[];
  summary: {
    status: IntelligenceStatus;
    result?: SummaryResult;
    canRetry?: boolean;
    error?: string;
    job?: Pick<
      IntelligenceJob,
      "id" | "status" | "attempts" | "maxAttempts" | "createdAt" | "updatedAt" | "startedAt" | "finishedAt" | "error"
    >;
    skipReason?: string;
  };
  tags: {
    status: IntelligenceStatus;
    result?: TagResult;
  };
  replyDecision: {
    status: IntelligenceStatus;
    result?: ReplyDecisionResult;
    skipReason?: string;
  };
  replyDraft: {
    status: IntelligenceStatus | "not-needed";
    result?: ReplyDraftResult;
    canRetry?: boolean;
  };
  todoExtraction?: {
    status: IntelligenceStatus;
    result?: TodoExtractionResult;
    canRetry?: boolean;
  };
  linkExtraction?: {
    status: IntelligenceStatus;
    result?: LinkExtractionResult;
    canRetry?: boolean;
  };
  translation?: {
    status: IntelligenceStatus;
    result?: TranslationResult;
    canRetry?: boolean;
  };
  composeMail?: {
    status: IntelligenceStatus;
    result?: ComposeMailResult;
    canRetry?: boolean;
  };
}

/* ---------------------------------------------------------------- *
 * AI Classification Inbox Tabs (ai-classification-inbox-tabs)      *
 * ---------------------------------------------------------------- */

/**
 * A category tab item returned by the canonical category query.
 * System categories always come first; dynamic categories follow.
 */
export interface InboxCategory {
  /** Canonical id — never a display label. */
  id: string;
  /** Display label (localized or default). */
  label: string;
  /** Number of messages in this category for the requested account. */
  count: number;
  /** Number of unread messages in this category for the requested account. */
  unreadCount: number;
  /** Whether this is a system (built-in) category. */
  system: boolean;
}

/**
 * Suppression signal: when a user rejects a category for a sender+
 * subject pattern, future similar mail should not show that category
 * unless strong contrary evidence exists.
 */
export interface CategorySuppressionSignal {
  accountId: string;
  categoryId: string;
  senderPattern: string;
  subjectPattern: string;
}

/* ---------------------------------------------------------------- *
 * AI Semantic Search QA (ai-semantic-search-qa)                    *
 * ---------------------------------------------------------------- */

/** Search mode used to satisfy a semantic search request. */
export type SemanticSearchMode = "semantic" | "lexical";

/** A single chunk matched by semantic or lexical search. */
export interface SemanticSearchChunk {
  /** The email this chunk belongs to. */
  emailId: string;
  /** Chunk identifier within the email. */
  chunkId: string;
  /** Relevance score in [0, 1]. Higher = more relevant. */
  score: number;
  /** Snippet of the chunk text (truncated for display). */
  snippet: string;
  /** Canonical logical identity used to merge keyword and semantic hits. */
  messageId?: string;
  /** Metadata from the preferred physical mail copy. */
  subject?: string;
  sender?: string;
  recipient?: string;
  receivedAt?: string;
  folder?: string;
  read?: boolean;
  starred?: boolean;
  hasAttachments?: boolean;
}

/** Result of a semantic search query. */
export interface SemanticSearchResult {
  /** The search mode used: "semantic" when embeddings available, "lexical" as fallback. */
  mode: SemanticSearchMode;
  /** Matched chunks, ranked by relevance. */
  chunks: SemanticSearchChunk[];
  /** Total number of matched chunks (may exceed chunks.length when paginated). */
  totalChunks: number;
}

/** A citation referencing an email chunk as evidence. */
export interface MailQaCitation {
  /** The email id cited. */
  emailId: string;
  /** The chunk id within the email. */
  chunkId: string;
  /** Optional quoted snippet from the chunk supporting the claim. */
  quote?: string;
}

/** A factual claim within a QA answer, backed by citations. */
export interface MailQaClaim {
  /** The factual claim text. */
  text: string;
  /** Citations supporting this claim. */
  citations: MailQaCitation[];
}

/** Result of a mail QA query. */
export interface MailQaResult {
  /** Whether sufficient evidence was found to answer the question. */
  hasEvidence: boolean;
  /** The answer text, when hasEvidence is true. */
  answer?: string;
  /** Structured claims with citations. Each claim cites its supporting evidence. */
  claims: MailQaClaim[];
  /** Search mode used to retrieve supporting chunks. */
  mode: SemanticSearchMode;
  /** Total chunks retrieved for context building. */
  retrievedChunkCount: number;
}

/** Request body for bounded canonical semantic search. */
export interface SemanticSearchRequest {
  /** Account to search within. Results are account-isolated. */
  accountId: string;
  /** Natural language or keyword query. */
  query: string;
  /** Maximum number of results. Defaults to 10. */
  limit?: number;
  /** Offset for pagination. Defaults to 0. */
  offset?: number;
}

/** Request body for POST /api/agent/mail-qa. */
export interface MailQaRequest {
  /** Account to search within. Results are account-isolated. */
  accountId: string;
  /** Natural language question about email content. */
  question: string;
  /** Maximum chunks to retrieve as context. Defaults to 20. */
  maxChunks?: number;
}

/* ---------------------------------------------------------------- *
 * AI Writing Suite (ai-writing-suite)                               *
 * ---------------------------------------------------------------- */

/**
 * Status of a writing draft through its lifecycle.
 * Drafts are created, possibly regenerated, then accepted/deleted or
 * edited-and-sent. No draft ever auto-sends.
 */
export type WritingDraftState =
  | "initial"
  | "regenerated"
  | "accepted"
  | "deleted"
  | "edited_and_sent";

/**
 * One Quick Reply variant (Upstream parity F2).
 *
 * The processor generates up to 3 variants per draft (different
 * lengths/tones) so the renderer can show "3 选 1" chips below
 * the email. The primary `draftMarkdown` on `ReplyDraftResult`
 * remains the medium / neutral variant for backward compatibility.
 */
export interface ReplyDraftVariant {
  /** Tone hint — typically "concise" | "neutral" | "friendly". */
  tone: string;
  /** Length hint — typically "short" | "medium". */
  length: string;
  /** Variant body, Markdown, NO subject / headers / signatures. */
  draftMarkdown: string;
}

/**
 * Extended reply draft result with style, language, and metadata.
 * Reply drafts MUST NOT include subject lines, headers, or fake signatures.
 */
export interface ReplyDraftResult {
  type: "replyDraft";
  draftMarkdown: string;
  /** ISO-639 language code for the draft language. */
  language: string;
  /** Writing style id applied, if any. */
  styleId?: string;
  /**
   * Quick Reply variants (Upstream parity F2). Optional for backward
   * compatibility with results persisted before this field existed.
   * When present the renderer shows up to 3 chip buttons; clicking a
   * chip pre-fills the compose body with the variant's `draftMarkdown`.
   * The first / `length === "medium"` variant should match the primary
   * `draftMarkdown` above.
   */
  variants?: ReplyDraftVariant[];
  /** AI quality metadata. */
  _metadata?: AiResultMetadata;
}

/**
 * Result returned when compose or reply cannot proceed because required
 * information is missing. The caller MUST present the questions to the
 * user and re-submit with the missing fields filled in.
 */
export interface ClarificationResult {
  status: "needsClarification";
  questions: string[];
  missingFields: string[];
}

/* ---------------------------------------------------------------- *
 * AI Automation Rule Suggestions (ai-automation-rule-suggestions)  *
 * ---------------------------------------------------------------- */

/** Input for POST /api/automation/rules/suggest. */
export interface AutomationSuggestInput {
  /** Account to scope the suggestion to. */
  accountId: string;
  /** Suggest a rule based on a specific email. */
  emailId?: string;
  /** Suggest a rule targeting this sender. */
  sender?: string;
  /** Suggest a rule for this inbox category. */
  category?: string;
  /** Natural language description of the desired rule. */
  naturalLanguageIntent?: string;
}

/** A single condition explanation in a dry-run match. */
export interface AutomationMatchReason {
  /** The condition field that matched (e.g. "sender", "subjectKeyword"). */
  field: string;
  /** Human-readable explanation of why the condition matched. */
  reason: string;
}

/** A single matched email from a dry-run, with reasons. */
export interface AutomationDryRunMatch {
  /** The email id that matched. */
  id: string;
  /** The email subject (for display). */
  subject: string;
  /** Explanations for why this email matched each condition. */
  reasons: AutomationMatchReason[];
  /** Actions that would be applied to this email. */
  plannedActions: AutomationAction[];
}

/** Result of a dry-run evaluation. Uses AutomationAction from automation.ts. */
export interface AutomationDryRunResult {
  /** Whether the dry-run completed successfully. */
  ok: true;
  /** The draft rule id used for the dry-run. */
  ruleId: string;
  /** Matched emails with explanations. */
  matched: AutomationDryRunMatch[];
  /** Total number of matched emails. */
  matchedCount: number;
  /** Whether this was a dry-run (always true). */
  dryRun: true;
}

/** A suggested automation rule draft. Always disabled. */
export interface AutomationSuggestedRule {
  /** Stable id for the draft (not persisted until saved). */
  id: string;
  /** Account this suggestion is scoped to. */
  accountId: string;
  /** Human-readable name for the suggested rule. */
  name: string;
  /** Always false — suggestions MUST NOT auto-enable. */
  enabled: false;
  /** Conditions for the suggested rule. */
  conditions: AutomationConditions;
  /** Actions for the suggested rule. */
  actions: AutomationAction[];
  /** AI-generated rationale for why this rule was suggested. */
  rationale: string;
}

/* ---------------------------------------------------------------- *
 * AI Todo Extraction Quality (ai-todo-extraction-quality)          *
 * ---------------------------------------------------------------- */

/**
 * A todo item with full lifecycle support.
 * AI-extracted todos start as `suggested`; user confirmation moves
 * them to `confirmed`. Manual and AI todos share one repository.
 */
export interface TodoItem {
  /** Unique todo id. */
  id: string;
  /** The email this todo was extracted from or linked to. */
  emailId: string;
  /** Account isolation key. */
  accountId: string;
  /** Imperative title of the todo. */
  title: string;
  /** Optional longer description. */
  description?: string;
  /** ISO-8601 due date, only set when explicit or strongly implied. */
  dueDate?: string;
  /** ISO-8601 start time, if present. */
  startTime?: string;
  /** ISO-8601 end time, paired with `startTime` for ranged todos. */
  endTime?: string;
  /** IANA timezone (e.g. "Asia/Shanghai") for the create-todo sheet. */
  timezone?: string;
  /** User-set priority bucket; defaults to "medium" on creation. */
  priority?: "high" | "medium" | "low";
  /** Whether the todo has been completed. */
  done: boolean;
  /** ISO-8601 date when the todo was completed. */
  doneDate?: string;
  /** Lifecycle status: suggested (AI) or confirmed (user). */
  status: "suggested" | "confirmed";
  /** Who created this todo: ai, user, or agent. */
  source: "ai" | "user" | "agent" | "mcp";
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
  /**
   * Task Agent state-machine label (Feature F3). The TaskAgentStatusUpdater
   * recomputes this when the parent thread evolves. Null/undefined when no
   * status has been computed yet.
   */
  agentStatus?: TaskAgentStatus | null;
  /**
   * When true, the user has manually overridden the agent status; the
   * Task Agent must not auto-update it.
   */
  agentStatusLocked?: boolean;
  /** ISO-8601 timestamp of the last agent-status update. */
  agentStatusUpdatedAt?: string;
}

/**
 * Suppression record for a user-deleted AI todo suggestion.
 * Prevents the same suggestion from reappearing for the same email.
 */
export interface TodoSuppression {
  id: string;
  emailId: string;
  accountId: string;
  normalizedTitle: string;
  dueDate?: string;
  createdAt: string;
}

/* ---------------------------------------------------------------- *
 * AI Agent Task Assistant (ai-agent-task-assistant)                *
 * ---------------------------------------------------------------- */

/**
 * A citation referencing the source of a mail-content claim made
 * by the agent. Every mail fact the agent states MUST include at
 * least one citation so the caller can inspect the source data.
 */
export interface AgentCitation {
  /** The email id the claim was derived from. */
  emailId: string;
  /** The tool that produced the cited result. */
  tool: string;
  /**
   * Dot-separated path into the tool result object
   * (e.g. "summary.bullets", "replyDraft.draftMarkdown").
   */
  path: string;
}

/**
 * High-risk actions the agent must NOT execute directly. Instead,
 * it returns a `pendingAction` for the caller (UI) to confirm and
 * execute through the appropriate safe endpoint.
 */
export type HighRiskActionType =
  | "send"
  | "delete"
  | "move"
  | "archive"
  | "mark_spam"
  | "unsubscribe"
  | "run_automation"
  | "run_wecli_command"
  | "install_wecli"
  | "upload_allowance_invoices"
  | "delete_allowance_invoices"
  | "configure_smart_tag"
  | "configure_automation_rule"
  | "configure_writing_style"
  | "schedule_send"
  | "cancel_scheduled_send"
  | "permanent_delete"
  | "delete_draft"
  | "bulk_mail_operation"
  | "configure_business_preferences";

/**
 * Coarse risk classification used by UI for color-coding pending
 * actions without re-deriving from `actionType`. Always present on
 * records returned by the API; legacy DB rows without a stored value
 * fall back to a derivation from actionType in the route layer.
 */
export type AgentActionRiskLevel = "low" | "medium" | "high";

/**
 * A pending high-risk action returned by the agent instead of
 * executing it. The caller MUST present this to the user for
 * confirmation and then execute via the appropriate safe API.
 */
export interface AgentPendingAction {
  /** Unique id for this pending action. */
  id: string;
  /** The type of high-risk action. */
  actionType: HighRiskActionType;
  /** Human-readable description of what the action will do. */
  description: string;
  /** The tool that would perform the action. */
  toolName: string;
  /** The input that would be passed to the tool. */
  inputJson: string;
  /** Risk explanation for the user. */
  riskReason: string;
  /**
   * Coarse risk classification used by UI for color coding. Always
   * present on records returned by the API; legacy DB rows without it
   * fall back to a derivation from actionType in the route layer.
   */
  riskLevel: AgentActionRiskLevel;
  /** Immutable parameters displayed to the user and authorized on confirm. */
  parameters?: Record<string, unknown>;
  /** Client must echo this key when confirming; retries return the first result. */
  idempotencyKey?: string;
  /** Absolute expiry for the authorization request. */
  expiresAt?: string;
  status?: "pending" | "confirmed" | "rejected" | "expired";
  executionState?: "not_started" | "executing" | "succeeded" | "failed" | "outcome_unknown";
  executionResult?: Record<string, unknown>;
  /** Conversation containing the originating confirmation card. */
  conversationId?: string;
  /** Mail context associated with the proposed operation, when available. */
  emailId?: string;
  /** Present when the confirmation originated from a local MCP client. */
  origin?: "mcp";
  /** Exact prepared operation bound to this confirmation. */
  operationId?: string;
}

/**
 * Aggregated payload returned by `GET /api/action-center` (Route C / WP 3H).
 *
 * The Action Center is a single place where the renderer reads
 * everything that needs the user's attention right now: pending
 * agent actions, open todos, and the most recent Curator-authored
 * daily learnings file. Combining these into one endpoint avoids
 * fan-out from the renderer (3+ requests on every page load /
 * polling tick).
 */
export interface ActionCenterPayload {
  /** Open (not-done) todos for the active account. */
  todos: TodoItem[];
  /** Recent smart-tag corrections waiting for/feeding the learning loop. */
  smartTagActions: SmartTagActionItem[];
  /** Automatic prompt updates generated from smart-tag corrections. */
  smartTagPromptRevisions: SmartTagPromptRevisionItem[];
  /** Durable batch optimization attempts and their objective A/B outcomes. */
  smartTagLearningRuns?: SmartTagLearningRunItem[];
  /**
   * Curator-authored daily learnings for the active account. The
   * Curator runtime (Route C / WP J.5-J.6) writes one file per day at
   * `learnings/YYYY-MM-DD.md`. The API returns the most recent file's
   * raw markdown — or null if none exist yet (Curator hasn't run).
   */
  curatorInsights: { date: string; content: string } | null;
  /** Generated at request time, ISO-8601. */
  generatedAt: string;
}

export interface SmartTagActionItem {
  id: string;
  accountId: string;
  emailId: string;
  tagId?: string;
  tagName: string;
  actionType: "apply" | "remove";
  feedbackType: "positive" | "negative";
  reason?: string;
  processedAt?: string;
  createdAt: string;
}

export interface SmartTagPromptRevisionItem {
  id: string;
  accountId: string;
  tagId: string;
  tagName: string;
  oldPrompt: string;
  newPrompt: string;
  summary: string;
  actionCount: number;
  createdAt: string;
}

export interface SmartTagLearningRunItem {
  id: string;
  accountId: string;
  tagId: string;
  tagName: string;
  status: "generating" | "evaluating" | "activated" | "rejected" | "failed" | "stale";
  sampleCount: number;
  positiveCount: number;
  negativeCount: number;
  optimizationCount: number;
  validationCount: number;
  currentCorrect: number;
  candidateCorrect: number;
  correctedCount: number;
  regressionCount: number;
  reason?: string;
  createdAt: string;
  completedAt?: string;
  activatedAt?: string;
}

/**
 * A state-aware suggestion derived from current intelligence state.
 * Suggestions are ordered by relevance; the first is the most
 * important next step for the user.
 */
export interface AgentSuggestionItem {
  /** Unique id for this suggestion. */
  id: string;
  /** Human-readable short label. */
  label: string;
  /** The prompt the agent would execute if the user accepts. */
  prompt: string;
  /** Optional typed action for clients that support direct task handoff. */
  action?: AgentSuggestionAction;
  /**
   * The intelligence gap this suggestion addresses.
   * E.g. "no-summary", "no-todos", "reply-needed-no-draft",
   * "foreign-language-no-translation", "account-triage".
   */
  reason: string;
  /**
   * Priority: higher = more important. Used for ordering.
   *   3 = critical (reply needed but no draft)
   *   2 = important (has action items but no todos)
   *   1 = useful (no summary, no translation)
   *   0 = contextual (account-level triage)
   */
  priority: number;
}

/* ---------------------------------------------------------------- *
 * AI Personalization Learning (ai-personalization-learning)        *
 * ---------------------------------------------------------------- */

/**
 * Per-feature learning summary aggregated from raw feedback events.
 * Bounded: contains only aggregated signals, never raw private feedback text.
 * Prompt builders consume this alongside the profile.
 */
export interface LearningSummary {
  /** The feature this summary covers. */
  feature: IntelligenceJobType;
  /** The account this summary belongs to. */
  accountId: string;
  /** Aggregated signals derived from feedback (e.g. suppressed tags, tone preferences). */
  signals: Record<string, unknown>;
  /** ISO-8601 timestamp when the summary was last recomputed. */
  updatedAt: string;
}

/**
 * Result of building a personalized prompt. Contains the prompt text
 * (for LLM consumption only — never logged) and safe-to-log metadata.
 */
export interface PersonalizedPromptResult {
  /** The assembled prompt text. NOT safe for logging. */
  promptText: string;
  /** Safe-to-log metadata: ids, feature, version, outcome. */
  meta: {
    feature: IntelligenceJobType;
    version: number;
    profileFieldsUsed: string[];
    learningSummaryUsed: boolean;
    /**
     * True when the user's free-form `customInstructions` were appended to
     * the prompt. The instructions text itself is NEVER logged.
     */
    customInstructionsUsed: boolean;
  };
}

/* ---------------------------------------------------------------- *
 * Processor workspace context (Route C / WP J.3)                    *
 * ---------------------------------------------------------------- */

/**
 * Compiled workspace context that processors receive at handle() time.
 * Empty content means the user hasn't accumulated relevant workspace
 * notes yet; processors should fall back to their default behavior.
 */
export interface ProcessorWorkspaceContext {
  /** Each input path declared by the capability descriptor. */
  sections: Array<{ path: string; content: string }>;
  /** Sum of section content rough token estimates. */
  totalTokenEstimate: number;
  /** True when content was truncated to stay within budget. */
  truncated: boolean;
}

/**
 * Usage statistics grouped by stable UI bucket and processor version.
 */
export interface UsageBucketStats {
  /** Stable UI bucket category. */
  category: string;
  /** Human-readable label for the bucket. */
  label: string;
  /** Total token count (input + output) for this bucket. */
  tokens: number;
  /** Input (prompt) token count for this bucket. */
  inputTokens: number;
  /** Output (completion) token count for this bucket. */
  outputTokens: number;
  /** Total number of calls for this bucket. */
  calls: number;
  /** Detailed rows grouped by processor version. */
  details: Array<{
    processor: string;
    processorVersion: number;
    model: string;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    calls: number;
    avgDurationMs: number;
  }>;
  /** Model dimension: rows grouped by provider + model name. */
  models: Array<{
    provider: string;
    model: string;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    calls: number;
  }>;
}
