/**
 * IntelligenceService — unified entry point for all intelligence operations.
 *
 * Three caller paths converge here:
 *   1. System: new-mail event triggers automatic pipeline via orchestrator
 *   2. PI Agent: tool calls trigger/query/operate on intelligence
 *   3. User: frontend buttons trigger retry, confirm tag, etc.
 *
 * Every method writes an audit log entry via AuditLogService with CallerContext.
 * No intelligence operation should bypass this layer.
 */

import type {
  AiFeedbackEvent,
  AiFeedbackEventType,
  CallerContext,
  ClarificationResult,
  EmailIntelligenceState,
  IntelligenceJob,
  InboxCategory,
  IntelligenceJobType,
  IntelligenceResult,
  IntelligenceStatus,
  ReplyDecisionResult,
  ReplyDraftResult,
  SummaryMode,
  SummaryResult,
  SummaryThreadResult,
  TagResult,
  ComposeMailResult,
  LinkExtractionResult,
  TodoExtractionResult,
  TranslationResult,
  WritingDraftState,
} from "../../../shared/wemail/intelligence.js";
import { isSentFolder } from "../../../shared/folders.js";
import type { WritingStyle } from "../../../shared/wemail/settings.js";
import { LlmRuntime } from "../ai/LlmRuntime.js";
import {
  COMPOSE_DRAFT_JSON_SCHEMA,
  COMPOSE_DRAFT_SYSTEM_PROMPT,
  buildComposeDraftUserMessage,
} from "../ai/prompts/composeDraftPrompt.js";
import type { IntelligenceOrchestrator } from "./IntelligenceOrchestrator.js";
import type { IntelligenceResultRepository } from "./IntelligenceResultRepository.js";
import type { JobRepository } from "../queue/JobRepository.js";
import type { IntelligenceJobLookup } from "../queue/JobRepository.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import type { TagFeedbackRuleRepository } from "../feedback/TagFeedbackRuleRepository.js";
import type { AiFeedbackEventRepository } from "../feedback/AiFeedbackEventRepository.js";
import type { DraftVersionRepository, DraftVersion } from "../feedback/DraftVersionRepository.js";
import type { AuditLogService } from "../telemetry/AuditLogService.js";
import type { TodoRepository } from "../todos/TodoRepository.js";
import {
  hasSummarizableBody,
  hasMonitoringDataCandidate,
  summaryContentFingerprint,
} from "./SummaryContentFingerprint.js";

interface StructuredComposeDraftResponse {
  status: "draft" | "needsClarification";
  subject: string;
  draftMarkdown: string;
  recipientChanges: Record<"to" | "cc" | "bcc", {
    operation: "add" | "replace" | "remove";
    recipients: string[];
  }>;
  suggestedSendAt: string;
  questions: string[];
  missingFields: string[];
}

type ComposeRecipientResolution =
  | { status: "exact"; name?: string; email: string }
  | { status: "ambiguous"; candidates: Array<{ name: string; email: string; departmentPath?: string; title?: string }> }
  | { status: "not_found" }
  | { status: "unavailable" };

function parseComposeDraftResponse(
  text: string,
): StructuredComposeDraftResponse | null {
  try {
    const value = JSON.parse(text) as Partial<StructuredComposeDraftResponse>;
    if (value.status !== "draft" && value.status !== "needsClarification") {
      return null;
    }
    return {
      status: value.status,
      subject: typeof value.subject === "string" ? value.subject : "",
      draftMarkdown:
        typeof value.draftMarkdown === "string" ? value.draftMarkdown : "",
      recipientChanges: parseRecipientChanges(value.recipientChanges),
      suggestedSendAt:
        typeof value.suggestedSendAt === "string" ? value.suggestedSendAt : "",
      questions: Array.isArray(value.questions)
        ? value.questions.filter((item): item is string => typeof item === "string")
        : [],
      missingFields: Array.isArray(value.missingFields)
        ? value.missingFields.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    };
  } catch {
    // Backward-compatible fallback for providers that ignore structured output.
    return null;
  }
}

function parseRecipientChanges(value: unknown): StructuredComposeDraftResponse["recipientChanges"] {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const parseField = (field: "to" | "cc" | "bcc") => {
    const raw = record[field] && typeof record[field] === "object"
      ? record[field] as Record<string, unknown>
      : {};
    const operation: "add" | "replace" | "remove" = raw.operation === "replace" || raw.operation === "remove"
      ? raw.operation
      : "add";
    return {
      operation,
      recipients: Array.isArray(raw.recipients)
        ? raw.recipients.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 20)
        : [],
    };
  };
  return { to: parseField("to"), cc: parseField("cc"), bcc: parseField("bcc") };
}

function addressEmail(value: string): string {
  return (value.match(/<([^>]+)>\s*$/)?.[1] ?? value).trim().toLowerCase();
}

function formatComposeAddress(name: string | undefined, email: string): string {
  const trimmedName = name?.trim();
  return trimmedName ? `${trimmedName} <${email.trim()}>` : email.trim();
}

function dedupeComposeAddresses(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = addressEmail(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function allowsRecipientOperation(intent: string, operation: "add" | "replace" | "remove"): boolean {
  if (operation === "add") return true;
  if (operation === "replace") {
    return /只(?:发|寄|送)|仅(?:发|寄|送)|改为|改成|替换|only|replace/i.test(intent);
  }
  return /移除|删除|去掉|不要(?:发|抄送|密送)|取消(?:抄送|密送)|remove|exclude|without/i.test(intent);
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function explicitlyRequestsConciseDraft(intent: string): boolean {
  return /(?:只|仅).{0,4}(?:回复|写)|一句话|一行|简短|简洁|精简|concise|brief|one[- ]line/i.test(
    intent,
  );
}

function needsComposeQualityRetry(intent: string, draftMarkdown: string): boolean {
  if (explicitlyRequestsConciseDraft(intent)) return false;
  const compactDraft = draftMarkdown.replace(/\s+/g, "").trim();
  const normalizedIntent = intent
    .replace(/[“”"'‘’。，、；：！？,.!?:;\s]/g, "")
    .toLowerCase();
  const normalizedDraft = compactDraft
    .replace(/[“”"'‘’。，、；：！？,.!?:;]/g, "")
    .toLowerCase();
  const asksForCompleteTone =
    /正式|完整|邮件|回信|礼貌|professional|formal|complete|email/i.test(intent);
  const echoesInstruction =
    normalizedDraft.length > 0 &&
    (normalizedDraft === normalizedIntent ||
      normalizedIntent.endsWith(normalizedDraft));
  return echoesInstruction || (asksForCompleteTone && compactDraft.length < 20);
}

export interface IntelligenceServiceDeps {
  /** Lazy getter for the per-account orchestrator (may be undefined before login). */
  getOrchestrator: () => IntelligenceOrchestrator | undefined;
  jobs: JobRepository;
  results: IntelligenceResultRepository;
  mail: CanonicalMailRepository;
  feedbackRules?: TagFeedbackRuleRepository;
  aiFeedback?: AiFeedbackEventRepository;
  audit: AuditLogService;
  todos?: TodoRepository;
  /** Sole source of LLM client, provider, and model state. */
  llmRuntime?: LlmRuntime;
  /** Summary language from AI profile settings. */
  summaryLanguage?: string;
  /** Translation language from AI profile settings. */
  translationLanguage?: string;
  /** Compose language from AI profile settings. */
  composeLanguage?: string;
  /** Draft version repository for persisting draft lifecycle. */
  draftVersions?: DraftVersionRepository;
  /** Writing style lookup function. */
  styleLookup?: (styleId: string) => WritingStyle | null;
  resolveComposeRecipient?: (accountId: string, query: string) => Promise<ComposeRecipientResolution>;
  backgroundAdmission?: () => Promise<boolean>;
  /** Resolve a body-hydrated message when Mail Core stores bodies separately. */
  resolveMessage?: (id: string) => MailMessage | null;
}

function hasSummaryText(items: string[] | undefined): boolean {
  return (items ?? []).some((item) => item.trim().length > 0);
}

function isValidSummaryResult(result: IntelligenceResult | undefined): boolean {
  if (!result || (result as any).type !== "summary") return false;
  const summary = result as SummaryResult;
  if (summary._status === "completed") return true;
  return (
    hasSummaryText(summary.bullets) ||
    hasSummaryText(summary.actionItems) ||
    hasSummaryText(summary.headline ? [summary.headline] : []) ||
    hasSummaryText(summary.details) ||
    hasSummaryText(summary.actions)
  );
}

function toCapabilityJob(job: IntelligenceJobLookup): Pick<
  IntelligenceJob,
  "id" | "status" | "attempts" | "maxAttempts" | "createdAt" | "updatedAt" | "startedAt" | "finishedAt" | "error"
> {
  return {
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt ?? "",
    updatedAt: job.updatedAt ?? "",
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

export class IntelligenceService {
  private readonly getOrchestrator: () => IntelligenceOrchestrator | undefined;
  private readonly jobs: JobRepository;
  private readonly results: IntelligenceResultRepository;
  private readonly mail: CanonicalMailRepository;
  private readonly feedbackRules?: TagFeedbackRuleRepository;
  private readonly aiFeedback?: AiFeedbackEventRepository;
  private readonly audit: AuditLogService;
  private readonly todos?: TodoRepository;
  private readonly llmRuntime: LlmRuntime;
  private readonly summaryLanguage?: string;
  private readonly translationLanguage?: string;
  private readonly composeLanguage?: string;
  private readonly draftVersions?: DraftVersionRepository;
  private readonly styleLookup?: (styleId: string) => WritingStyle | null;
  private readonly resolveComposeRecipient?: IntelligenceServiceDeps["resolveComposeRecipient"];
  private readonly backgroundAdmission?: () => Promise<boolean>;
  private readonly resolveMessage: (id: string) => MailMessage | null;

  constructor(deps: IntelligenceServiceDeps) {
    this.getOrchestrator = deps.getOrchestrator;
    this.jobs = deps.jobs;
    this.results = deps.results;
    this.mail = deps.mail;
    this.feedbackRules = deps.feedbackRules;
    this.aiFeedback = deps.aiFeedback;
    this.audit = deps.audit;
    this.todos = deps.todos;
    this.llmRuntime = deps.llmRuntime ?? new LlmRuntime({ initialSettings: null });
    this.summaryLanguage = deps.summaryLanguage;
    this.translationLanguage = deps.translationLanguage;
    this.composeLanguage = deps.composeLanguage;
    this.draftVersions = deps.draftVersions;
    this.styleLookup = deps.styleLookup;
    this.resolveComposeRecipient = deps.resolveComposeRecipient;
    this.backgroundAdmission = deps.backgroundAdmission;
    this.resolveMessage =
      deps.resolveMessage ?? ((id) => this.mail.getMessageById(id));
  }

  // ── Query ──────────────────────────────────────────────────────

  async getState(emailId: string): Promise<EmailIntelligenceState> {
    const stored = this.results.findByEmailId(emailId);
    const jobs = this.findJobs(emailId);
    const summaryStatus = this.ensureSummaryCoverage(
      emailId,
      stored.summary,
      jobs.summary?.status,
    );
    if (summaryStatus) {
      const refreshed = this.jobs.findByEmailAndType(emailId, "summary");
      if (refreshed) {
        jobs.summary = { ...refreshed, status: summaryStatus };
      }
    }

    // Hydrate immutable extraction output with the current todo lifecycle.
    const hydratedTodoExtraction = this.hydrateTodoAgentStatus(
      emailId,
      stored.todoExtraction as TodoExtractionResult | undefined,
    );
    const summaryState = summaryStatus
      ? {
          status: summaryStatus,
          canRetry: true,
          ...(jobs.summary ? { job: toCapabilityJob(jobs.summary) } : {}),
        }
      : this.buildCapabilityState(
          emailId, "summary", stored.summary as SummaryResult | undefined, jobs.summary,
        );

    return {
      emailId,
      summary: summaryState,
      tags: this.buildCapabilityState(
        emailId, "tags", stored.tags as TagResult | undefined, jobs.tags,
      ),
      replyDecision: this.buildReplyDecisionState(
        emailId, stored.replyDecision, jobs.replyDecision?.status,
      ),
      replyDraft: this.buildReplyDraftState(
        emailId, stored.replyDraft, stored.replyDecision, jobs.replyDraft?.status,
      ),
      todoExtraction: this.buildCapabilityState(
        emailId,
        "todoExtraction",
        hydratedTodoExtraction,
        jobs.todoExtraction,
      ),
      linkExtraction: this.buildCapabilityState(
        emailId,
        "linkExtraction",
        stored.linkExtraction as LinkExtractionResult | undefined,
        jobs.linkExtraction,
      ),
      translation: this.buildCapabilityState(
        emailId,
        "translation",
        stored.translation as TranslationResult | undefined,
        jobs.translation,
      ),
      composeMail: this.buildCapabilityState(
        emailId,
        "composeMail",
        stored.composeMail as ComposeMailResult | undefined,
        jobs.composeMail,
      ),
    };
  }

  async getSummary(emailId: string): Promise<SummaryResult | null> {
    const message = this.resolveMessage(emailId);
    if (!message || !hasSummarizableBody(message)) return null;
    const stored = this.results.findByEmailId(emailId);
    return (stored.summary as SummaryResult) ?? null;
  }

  async getTags(emailId: string): Promise<TagResult | null> {
    const stored = this.results.findByEmailId(emailId);
    return (stored.tags as TagResult) ?? null;
  }

  async getReplyDecision(emailId: string): Promise<ReplyDecisionResult | null> {
    const stored = this.results.findByEmailId(emailId);
    return (stored.replyDecision as ReplyDecisionResult) ?? null;
  }

  async getReplyDraft(emailId: string): Promise<ReplyDraftResult | null> {
    const stored = this.results.findByEmailId(emailId);
    return (stored.replyDraft as ReplyDraftResult) ?? null;
  }

  async getTodos(emailId: string) {
    return this.todos?.listByEmail(emailId) ?? [];
  }

  async getSmartLinks(emailId: string): Promise<LinkExtractionResult | null> {
    const stored = this.results.findByEmailId(emailId);
    return (stored.linkExtraction as LinkExtractionResult) ?? null;
  }

  /**
   * Get the unsubscribe URL from a link extraction result, if present.
   * Returns null if no link extraction result exists or if no unsubscribe URL was found.
   */
  async getUnsubscribeUrl(emailId: string): Promise<string | null> {
    const linkResult = await this.getSmartLinks(emailId);
    return linkResult?.unsubscribeUrl ?? null;
  }

  /**
   * Get risky links from a link extraction result, with risk reasons.
   * Returns an empty array if no link extraction result exists.
   */
  async getRiskyLinks(emailId: string): Promise<LinkExtractionResult["links"]> {
    const linkResult = await this.getSmartLinks(emailId);
    if (!linkResult) return [];
    return linkResult.links.filter((l) => l.risk);
  }

  async getTranslation(emailId: string): Promise<TranslationResult | null> {
    const stored = this.results.findByEmailId(emailId);
    return (stored.translation as TranslationResult) ?? null;
  }

  getLlmStatus(): { configured: boolean; provider?: string; model?: string } {
    const llm = this.llmRuntime.snapshot();
    return {
      configured: llm.configured,
      provider: llm.provider,
      model: llm.modelFor("default"),
    };
  }

  /**
   * Get all inbox categories for an account: system categories first,
   * then dynamic tags, each with message counts.
   * Account-isolated: only counts messages for the given account.
   */
  getCategories(accountId: string): InboxCategory[] {
    return this.results.listCategories({ accountId });
  }

  /**
   * Get the priority information for a reply decision result.
   * Returns null if no reply decision exists for the email.
   */
  async getPriority(emailId: string): Promise<{
    priorityScore: number;
    level: "low" | "normal" | "high";
    replyRequired: boolean;
    deadline?: string;
    signals: Array<{ name: string; value: string; weight?: number }>;
  } | null> {
    const stored = this.results.findByEmailId(emailId);
    const decision = stored.replyDecision as ReplyDecisionResult | undefined;
    if (!decision || decision.type !== "replyDecision") return null;
    return {
      priorityScore: decision.priorityScore,
      level: decision.level,
      replyRequired: decision.replyRequired,
      deadline: decision.deadline,
      signals: decision.signals,
    };
  }

  /**
   * List email IDs that require a reply, ordered by priority level.
   * Filters for the given account's emails where replyRequired=true.
   */
  listReplyRequired(accountId: string, options?: {
    level?: "low" | "normal" | "high";
    limit?: number;
  }): Array<{
    emailId: string;
    priorityScore: number;
    level: "low" | "normal" | "high";
    deadline?: string;
  }> {
    return this.results.listReplyRequired(accountId, options);
  }

  /**
   * Background backfill for historical mail. Enqueues summary jobs for
   * messages that have never been summarized or were skipped while the
   * LLM was unavailable.
   */
  async backfillSummariesForAccount(
    accountId: string,
    options?: { batchSize?: number; maxMessages?: number; signal?: AbortSignal },
  ): Promise<{ scanned: number; enqueued: number }> {
    if (!this.llmRuntime.snapshot().configured) return { scanned: 0, enqueued: 0 };
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) return { scanned: 0, enqueued: 0 };

    const batchSize = Math.min(200, Math.max(1, options?.batchSize ?? 100));
    const maxMessages = Math.max(batchSize, options?.maxMessages ?? 2_000);
    const descriptor = orchestrator.getDescriptor("summary");
    const maxAttempts = descriptor?.lane.maxAttempts ?? 2;

    let scanned = 0;
    let enqueued = 0;
    let before: { receivedAt: string; id: string } | undefined;

    while (scanned < maxMessages) {
      if (options?.signal?.aborted) break;
      if (this.backgroundAdmission && !(await this.backgroundAdmission())) break;
      const remaining = maxMessages - scanned;
      const page = this.mail.listMessageIds({
        accountId,
        limit: Math.min(batchSize, remaining),
        before,
      });
      if (page.length === 0) break;

      for (const row of page) {
        if (options?.signal?.aborted) break;
        scanned += 1;
        const message = this.mail.getMessageById(row.id);
        if (!message || isSentFolder(message.folder) || !hasSummarizableBody(message)) {
          continue;
        }
        const stored = this.results.findByEmailId(row.id);
        const existing = stored.summary as Record<string, unknown> | undefined;
        const job = this.jobs.findByEmailAndType(row.id, "summary");
        const hasRealSummary =
          !!existing &&
          existing.type === "summary" &&
          existing._status !== "skipped";
        const isSkipped =
          !!existing &&
          (existing._status === "skipped" || typeof existing.reason === "string");
        const hasLiveJob =
          job?.status === "pending" || job?.status === "running" || job?.status === "succeeded";

        if (hasRealSummary || hasLiveJob) continue;
        if (job?.status === "failed" && this.shouldAutoRetrySummaryFailure(job.id)) {
          this.jobs.resetForManualRetry(job.id);
          enqueued += 1;
          continue;
        }
        if (!existing || isSkipped) {
          const result = orchestrator.enqueueSingle(row.id, "summary", maxAttempts);
          if (result.inserted) enqueued += 1;
        }
      }

      const last = page[page.length - 1];
      before = last ? { receivedAt: last.receivedAt, id: last.id } : undefined;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (page.length < Math.min(batchSize, remaining)) break;
    }

    return { scanned, enqueued };
  }

  // ── Trigger ────────────────────────────────────────────────────

  async triggerSummary(emailId: string, caller: CallerContext): Promise<string> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) throw new Error("Intelligence orchestrator not available");
    const descriptor = orchestrator.getDescriptor("summary");
    const maxAttempts = descriptor?.lane.maxAttempts ?? 2;
    const result = orchestrator.enqueueSingle(emailId, "summary", maxAttempts);
    this.audit.log({
      emailId,
      action: "trigger-summary",
      processor: "summary",
      caller,
      result: { jobId: result.id, inserted: result.inserted },
    });
    return result.id;
  }

  /**
   * Trigger a thread-level summary. Fetches all messages in the thread
   * and enqueues a summary job with mode="thread" and thread message payloads.
   */
  async triggerThreadSummary(
    threadId: string,
    caller: CallerContext,
    mode: SummaryMode = "thread",
  ): Promise<string> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) throw new Error("Intelligence orchestrator not available");

    // Fetch thread messages for the payload
    const threadMessages = this.mail.getMessagesByThreadId(threadId);
    if (threadMessages.length === 0) {
      throw new Error(`No messages found for thread ${threadId}`);
    }

    // Use the first message's emailId as the job's emailId (for result storage)
    const emailId = threadMessages[0].id;
    const descriptor = orchestrator.getDescriptor("summary");
    const maxAttempts = descriptor?.lane.maxAttempts ?? 2;

    const result = orchestrator.enqueueSingle(emailId, "summary", maxAttempts, {
      mode,
      summaryLanguage: this.summaryLanguage,
      threadMessages: threadMessages.map((msg) => {
        // Token optimization: when this message already has a per-email
        // summary, feed the summary instead of re-sending the raw body.
        // The thread pass then summarizes summaries instead of re-reading
        // every message body.
        const stored = this.results.findByEmailId(msg.id).summary;
        const storedSummary =
          stored?.type === "summary" && isValidSummaryResult(stored)
            ? (stored as SummaryResult)
            : undefined;
        const summaryText = storedSummary
          ? [
              "[AI 摘要]（原始正文未随附，基于该邮件的单封摘要）",
              ...(storedSummary.headline ? [storedSummary.headline] : []),
              ...(storedSummary.bullets ?? []),
            ].join("\n")
          : undefined;
        return {
          emailId: msg.id,
          subject: msg.subject,
          from: msg.from.name
            ? `${msg.from.name} <${msg.from.email}>`
            : msg.from.email,
          bodyText: summaryText ?? msg.bodyText,
          bodyHtml: summaryText ? undefined : msg.bodyHtml,
          receivedAt: msg.receivedAt,
        };
      }),
    });

    this.audit.log({
      emailId,
      action: "trigger-thread-summary",
      processor: "summary",
      caller,
      result: {
        jobId: result.id,
        inserted: result.inserted,
        threadId,
        messageCount: threadMessages.length,
        mode,
      },
    });
    return result.id;
  }

  /**
   * Get a thread-level summary result for a thread.
   */
  async getThreadSummary(threadId: string): Promise<SummaryThreadResult | null> {
    const messages = this.mail.getMessagesByThreadId(threadId);
    if (messages.length === 0) return null;
    const emailId = messages[0].id;
    const stored = this.results.findByEmailId(emailId);
    const summary = stored.summary;
    if (!summary) return null;
    // Only return if it's a thread-mode result
    const threadResult = summary as SummaryThreadResult;
    if (threadResult.mode === "thread") return threadResult;
    return null;
  }

  async triggerTags(emailId: string, caller: CallerContext): Promise<string> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) throw new Error("Intelligence orchestrator not available");
    const descriptor = orchestrator.getDescriptor("tags");
    const maxAttempts = descriptor?.lane.maxAttempts ?? 3;
    const result = orchestrator.enqueueSingle(emailId, "tags", maxAttempts);
    this.audit.log({
      emailId,
      action: "trigger-tags",
      processor: "tags",
      caller,
      result: { jobId: result.id, inserted: result.inserted },
    });
    return result.id;
  }

  async triggerReplyDecision(emailId: string, caller: CallerContext): Promise<string> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) throw new Error("Intelligence orchestrator not available");
    const descriptor = orchestrator.getDescriptor("replyDecision");
    const maxAttempts = descriptor?.lane.maxAttempts ?? 3;
    const result = orchestrator.enqueueSingle(emailId, "replyDecision", maxAttempts);
    this.audit.log({
      emailId,
      action: "trigger-reply-decision",
      processor: "replyDecision",
      caller,
      result: { jobId: result.id, inserted: result.inserted },
    });
    return result.id;
  }

  async triggerReplyDraft(emailId: string, caller: CallerContext): Promise<string> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) throw new Error("Intelligence orchestrator not available");
    const descriptor = orchestrator.getDescriptor("replyDraft");
    const maxAttempts = descriptor?.lane.maxAttempts ?? 3;
    const result = orchestrator.enqueueSingle(emailId, "replyDraft", maxAttempts);
    this.audit.log({
      emailId,
      action: "trigger-reply-draft",
      processor: "replyDraft",
      caller,
      result: { jobId: result.id, inserted: result.inserted },
    });
    return result.id;
  }

  async triggerTodoExtraction(emailId: string, caller: CallerContext): Promise<string> {
    const jobId = this.enqueueCapability(emailId, "todoExtraction");
    this.audit.log({
      emailId,
      action: "trigger-todo-extraction",
      processor: "todoExtraction",
      caller,
      result: { jobId, status: "queued" },
    });
    return jobId;
  }

  async triggerLinkExtraction(emailId: string, caller: CallerContext): Promise<string> {
    const jobId = this.enqueueCapability(emailId, "linkExtraction");
    this.audit.log({
      emailId,
      action: "trigger-link-extraction",
      processor: "linkExtraction",
      caller,
      result: { jobId, status: "queued" },
    });
    return jobId;
  }

  async triggerTranslation(
    emailId: string,
    targetLanguage?: string,
    caller?: CallerContext,
  ): Promise<string> {
    const resolved = targetLanguage?.trim() || this.translationLanguage?.trim();
    if (!resolved) {
      throw new Error("targetLanguage is required (no profile default set)");
    }
    const jobId = this.enqueueCapability(emailId, "translation", {
      targetLanguage: resolved,
    });
    this.audit.log({
      emailId,
      action: "trigger-translation",
      processor: "translation",
      caller: caller ?? { source: "user" },
      result: { jobId, status: "queued", targetLanguage: resolved },
    });
    return jobId;
  }

  async retry(emailId: string, type: IntelligenceJobType, caller: CallerContext): Promise<string> {
    // Idempotent retry: check for existing successful result first.
    // If a successful result already exists, do NOT re-enqueue —
    // this prevents duplicate successful results.
    const stored = this.results.findByEmailId(emailId);
    const existingResult = stored[type as keyof typeof stored] as IntelligenceResult | undefined;
    const invalidExistingSummary =
      type === "summary" &&
      existingResult != null &&
      (existingResult as any).type === "summary" &&
      !isValidSummaryResult(existingResult);
    if (existingResult && (existingResult as any).type === type && !invalidExistingSummary) {
      // A successful result already exists for this email+type.
      // Return the existing job id without re-enqueueing.
      const existingJob = this.jobs.findByEmailAndType(emailId, type);
      if (existingJob && existingJob.status === "succeeded") {
        this.audit.log({
          emailId,
          action: "retry",
          processor: type,
          caller,
          result: { jobId: existingJob.id, inserted: false, reenqueued: false, reason: "already-succeeded" },
        });
        return existingJob.id;
      }
    }

    // For retry, we re-enqueue the job. The idempotency check in enqueueJob
    // will find the existing failed row. We need to reset it to pending.
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) throw new Error("Intelligence orchestrator not available");
    const existing = this.jobs.findByEmailAndType(emailId, type);
    if (!existing) {
      // No existing job — create a new one
      const descriptor = orchestrator.getDescriptor(type);
      const maxAttempts = descriptor?.lane.maxAttempts ?? 3;
      const result = orchestrator.enqueueSingle(emailId, type, maxAttempts);
      this.audit.log({
        emailId,
        action: "retry",
        processor: type,
        caller,
        result: { jobId: result.id, inserted: result.inserted, reenqueued: false },
      });
      return result.id;
    }

    // Only retry if the job is in a failed or terminal state (not already succeeded)
    if (existing.status === "succeeded" && !invalidExistingSummary) {
      this.audit.log({
        emailId,
        action: "retry",
        processor: type,
        caller,
        result: { jobId: existing.id, inserted: false, reenqueued: false, reason: "already-succeeded" },
      });
      return existing.id;
    }

    // Reset the existing job to pending for retry. Exhausted jobs need the
    // attempt budget cleared or QueueRunner will never pick them up again.
    if ("resetForManualRetry" in this.jobs && typeof this.jobs.resetForManualRetry === "function") {
      this.jobs.resetForManualRetry(existing.id);
    } else {
      this.jobs.requeuePending(existing.id);
    }
    this.audit.log({
      emailId,
      action: "retry",
      processor: type,
      caller,
      result: { jobId: existing.id, inserted: false, reenqueued: true },
    });
    return existing.id;
  }

  // ── Operate ────────────────────────────────────────────────────

  async confirmTag(emailId: string, tagName: string, caller: CallerContext): Promise<void> {
    // Remove any existing rejection rule so the tag won't be suppressed
    if (this.feedbackRules) {
      const mail = this.mail.getMessageById(emailId);
      if (mail) {
        this.feedbackRules.removeRejection({
          accountId: mail.accountId,
          tagName,
          senderPattern: mail.from.email.toLowerCase(),
          subjectPattern: mail.subject.slice(0, 32).toLowerCase(),
        });
      }
    }
    this.audit.log({
      emailId,
      action: "confirm-tag",
      processor: "tags",
      caller,
      result: { tagName },
    });
  }

  async rejectTag(emailId: string, tagName: string, caller: CallerContext): Promise<void> {
    if (this.feedbackRules) {
      const mail = this.mail.getMessageById(emailId);
      if (mail) {
        this.feedbackRules.addRejection({
          accountId: mail.accountId,
          tagName,
          senderPattern: mail.from.email.toLowerCase(),
          subjectPattern: mail.subject.slice(0, 32).toLowerCase(),
        });
      }
    }
    this.audit.log({
      emailId,
      action: "reject-tag",
      processor: "tags",
      caller,
      result: { tagName },
    });
  }

  async acceptDraft(emailId: string, caller: CallerContext): Promise<void> {
    // Update draft version state if draftVersions is available
    if (this.draftVersions) {
      const active = this.draftVersions.getActive(emailId);
      if (active) {
        this.draftVersions.updateState(active.id, "accepted");
      }
    }
    // Record feedback event
    const mail = this.mail.getMessageById(emailId);
    if (mail) {
      this.aiFeedback?.save({
        accountId: mail.accountId,
        feature: "replyDraft",
        eventType: "accept",
        emailId,
        payload: { action: "accept-draft" },
      });
    }
    this.audit.log({
      emailId,
      action: "accept-draft",
      processor: "replyDraft",
      caller,
    });
  }

  async editAndSendDraft(emailId: string, caller: CallerContext): Promise<void> {
    // Update draft version state if draftVersions is available
    if (this.draftVersions) {
      const active = this.draftVersions.getActive(emailId);
      if (active) {
        this.draftVersions.updateState(active.id, "edited_and_sent");
      }
    }
    // Record feedback event
    const mail = this.mail.getMessageById(emailId);
    if (mail) {
      this.aiFeedback?.save({
        accountId: mail.accountId,
        feature: "replyDraft",
        eventType: "edit",
        emailId,
        payload: { action: "edit-and-send-draft" },
      });
    }
    this.audit.log({
      emailId,
      action: "edit-and-send-draft",
      processor: "replyDraft",
      caller,
    });
  }

  async deleteDraft(emailId: string, caller: CallerContext): Promise<void> {
    // Update draft version state if draftVersions is available
    if (this.draftVersions) {
      const active = this.draftVersions.getActive(emailId);
      if (active) {
        this.draftVersions.updateState(active.id, "deleted");
      }
    }
    // Record feedback event
    const mail = this.mail.getMessageById(emailId);
    if (mail) {
      this.aiFeedback?.save({
        accountId: mail.accountId,
        feature: "replyDraft",
        eventType: "delete",
        emailId,
        payload: { action: "delete-draft" },
      });
    }
    this.audit.log({
      emailId,
      action: "delete-draft",
      processor: "replyDraft",
      caller,
    });
  }

  async completeTodo(todoId: string, caller: CallerContext) {
    const todo = this.todos?.complete(todoId) ?? null;
    this.audit.log({
      emailId: todo?.emailId ?? "unknown",
      action: "complete-todo",
      processor: "todoExtraction",
      caller,
      result: { todoId, found: !!todo },
    });
    return todo;
  }

  async confirmTodo(todoId: string, caller: CallerContext) {
    const todo = this.todos?.confirm(todoId) ?? null;
    this.audit.log({
      emailId: todo?.emailId ?? "unknown",
      action: "confirm-todo",
      processor: "todoExtraction",
      caller,
      result: { todoId, found: !!todo },
    });
    return todo;
  }

  async restoreTodo(todoId: string, caller: CallerContext) {
    const todo = this.todos?.restore(todoId) ?? null;
    this.audit.log({
      emailId: todo?.emailId ?? "unknown",
      action: "restore-todo",
      processor: "todoExtraction",
      caller,
      result: { todoId, found: !!todo },
    });
    return todo;
  }

  async updateTodo(
    todoId: string,
    accountId: string,
    patch: {
      title?: string;
      description?: string | null;
      dueDate?: string | null;
      startTime?: string | null;
      endTime?: string | null;
      timezone?: string | null;
      priority?: "high" | "medium" | "low";
    },
    caller: CallerContext,
  ) {
    const todo = this.todos?.updateManual({ id: todoId, accountId, ...patch }) ?? null;
    this.audit.log({
      emailId: todo?.emailId ?? "unknown",
      action: "update-todo",
      processor: "todoExtraction",
      caller,
      result: { todoId, found: !!todo },
    });
    return todo;
  }

  async deleteTodo(todoId: string, caller: CallerContext) {
    const todo = this.todos?.getById(todoId);
    const found = this.todos?.delete(todoId) ?? false;
    this.audit.log({
      emailId: todo?.emailId ?? "unknown",
      action: "delete-todo",
      processor: "todoExtraction",
      caller,
      result: { todoId, found },
    });
    return found;
  }

  async rejectTodo(todoId: string, caller: CallerContext) {
    const todo = this.todos?.getById(todoId);
    const found = this.todos?.deleteAndSuppress(todoId) ?? false;
    this.audit.log({
      emailId: todo?.emailId ?? "unknown",
      action: "reject-todo",
      processor: "todoExtraction",
      caller,
      result: { todoId, found },
    });
    return found;
  }

  async listTodos(accountId: string, options?: {
    status?: "open" | "completed";
    emailId?: string;
  }) {
    return this.todos?.list({ accountId, ...options }) ?? [];
  }

  async composeMail(
    input: {
      operationType: "NEW" | "REPLY";
      intent: string;
      accountId?: string;
      emailId?: string;
      to?: string[];
      currentTo?: string[];
      currentCc?: string[];
      currentBcc?: string[];
      targetLanguage?: string;
      styleId?: string;
      /** Existing draft body (HTML or plain text). When provided, the
       *  LLM treats `intent` as edit instructions on this body. */
      currentBody?: string;
      currentSubject?: string;
      clientNow?: string;
      clientTimeZone?: string;
    },
    caller: CallerContext,
  ): Promise<ComposeMailResult> {
    const llm = this.llmRuntime.snapshot();
    if (input.operationType === "REPLY" && !input.emailId) {
      throw new Error("emailId is required for REPLY compose");
    }

    // A requested style must resolve explicitly. Silently dropping an
    // unknown style makes the UI claim a tone was applied when it was not.
    const selectedStyle = input.styleId
      ? this.styleLookup?.(input.styleId) ?? null
      : null;
    if (input.styleId && !selectedStyle) {
      throw new Error(`Invalid styleId: ${input.styleId}`);
    }

    // New messages may be drafted before recipients are filled. Only a
    // missing purpose blocks generation; addressing remains a send-time concern.
    if (input.operationType === "NEW") {
      const missingFields: string[] = [];
      const questions: string[] = [];

      const recipients = input.to ?? [];
      if (!input.intent || input.intent.trim().length === 0) {
        missingFields.push("intent");
        questions.push("What is the purpose of this message?");
      }

      if (missingFields.length > 0) {
        const clarification: ClarificationResult = {
          status: "needsClarification",
          questions,
          missingFields,
        };
        const result: ComposeMailResult = {
          type: "composeMail",
          operationType: input.operationType,
          status: "needsClarification",
          to: recipients,
          subject: input.currentSubject?.trim() ?? "",
          draftMarkdown: "",
          targetLanguage: input.targetLanguage,
          styleId: input.styleId,
          language: this.composeLanguage,
          clarification,
        };
        this.audit.log({
          emailId: input.emailId ?? "compose-new",
          action: "compose-mail-clarification",
          processor: "composeMail",
          caller,
          result: {
            operationType: input.operationType,
            status: "needsClarification",
            missingFields,
          },
        });
        return result;
      }
    }

    const original = input.emailId ? this.mail.getMessageById(input.emailId) : null;
    if (input.operationType === "REPLY" && input.emailId && !original) {
      this.audit.log({
        emailId: input.emailId,
        action: "compose-mail-failed",
        processor: "composeMail",
        caller,
        result: {
          operationType: input.operationType,
          reason: "original-email-not-found",
        },
      });
      throw new Error(`Original email ${input.emailId} was not found`);
    }

    // Resolve recipients: explicit to, or original sender for REPLY
    const to =
      input.currentTo && input.currentTo.length > 0
        ? input.currentTo
        : input.to && input.to.length > 0
          ? input.to
        : original
          ? [original.from.email]
          : [];
    const cc = input.currentCc ?? [];
    const bcc = input.currentBcc ?? [];

    const subject =
      input.operationType === "REPLY" && original
        ? original.subject.startsWith("Re:")
          ? original.subject
          : `Re: ${original.subject}`
        : input.currentSubject?.trim() ?? "";

    const model = llm.modelFor("draft");
    if (!llm.client || !model) {
      this.audit.log({
        emailId: input.emailId ?? "compose-new",
        action: "compose-mail-failed",
        processor: "composeMail",
        caller,
        result: {
          operationType: input.operationType,
          reason: "llm-not-configured",
        },
      });
      throw new Error("AI compose is not configured");
    }

    let draftMarkdown: string;
    let structuredDraft: StructuredComposeDraftResponse | null = null;
    let modelClarification: ClarificationResult | undefined;
    try {
      const userMessage = buildComposeDraftUserMessage({
        operationType: input.operationType,
        intent: input.intent,
        original,
        to,
        targetLanguage: input.targetLanguage,
        style: selectedStyle,
        currentBody: input.currentBody,
        currentSubject: input.currentSubject,
        currentTo: to,
        currentCc: cc,
        currentBcc: bcc,
        clientNow: input.clientNow,
        clientTimeZone: input.clientTimeZone,
      });
      let requestMessage = userMessage;
      draftMarkdown = "";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const llmResult = await llm.client.generate({
          model,
          system: COMPOSE_DRAFT_SYSTEM_PROMPT,
          messages: [{ role: "user", content: requestMessage }],
          temperature: 0.5,
          maxTokens: 1200,
          timeoutMs: 25_000,
          jsonSchema: COMPOSE_DRAFT_JSON_SCHEMA,
        });
        const text = llmResult.text.trim();
        if (!text) {
          throw new Error("AI compose returned an empty draft");
        }
        const structured = parseComposeDraftResponse(text);
        structuredDraft = structured;
        if (structured?.status === "needsClarification") {
          modelClarification = {
            status: "needsClarification",
            questions: structured.questions.filter(Boolean),
            missingFields: structured.missingFields.filter(Boolean),
          };
          draftMarkdown = "";
          break;
        }

        draftMarkdown = structured?.draftMarkdown.trim() || text;
        if (
          attempt === 0 &&
          needsComposeQualityRetry(input.intent, draftMarkdown)
        ) {
          requestMessage = [
            userMessage,
            "",
            "### QUALITY CORRECTION:",
            "The previous result was too short or echoed the instruction. Produce a complete, directly usable email body with an appropriate greeting, the requested message, and a natural closing sentence. Preserve all facts and do not add commitments.",
          ].join("\n");
          continue;
        }
        break;
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = rawMessage.startsWith("AI compose")
        ? rawMessage
        : `AI compose generation failed: ${rawMessage || "unknown error"}`;
      this.audit.log({
        emailId: input.emailId ?? "compose-new",
        action: "compose-mail-failed",
        processor: "composeMail",
        caller,
        result: {
          operationType: input.operationType,
          reason: message,
        },
      });
      throw new Error(message);
    }

    if (modelClarification) {
      const result: ComposeMailResult = {
        type: "composeMail",
        operationType: input.operationType,
        status: "needsClarification",
        to,
        cc,
        bcc,
        subject,
        draftMarkdown: "",
        targetLanguage: input.targetLanguage,
        styleId: input.styleId,
        language: this.composeLanguage ?? "en",
        clarification: modelClarification,
      };
      this.audit.log({
        emailId: input.emailId ?? "compose-new",
        action: "compose-mail-clarification",
        processor: "composeMail",
        caller,
        result: {
          operationType: input.operationType,
          status: result.status,
          missingFields: modelClarification.missingFields,
        },
      });
      return result;
    }

    const recipientResult = await this.resolveComposeEnvelope({
      accountId: input.accountId ?? original?.accountId,
      intent: input.intent,
      current: { to, cc, bcc },
      changes: structuredDraft?.recipientChanges,
    });
    if (recipientResult.clarification) {
      const result: ComposeMailResult = {
        type: "composeMail",
        operationType: input.operationType,
        status: "needsClarification",
        to,
        cc,
        bcc,
        subject,
        draftMarkdown: "",
        targetLanguage: input.targetLanguage,
        styleId: input.styleId,
        language: this.composeLanguage ?? "en",
        clarification: recipientResult.clarification,
      };
      return result;
    }

    let suggestedSendAt: string | undefined;
    const rawSuggestedSendAt = structuredDraft?.suggestedSendAt.trim();
    if (rawSuggestedSendAt) {
      const clientNowMs = Date.parse(input.clientNow ?? "");
      const sendAtMs = Date.parse(rawSuggestedSendAt);
      if (!input.clientTimeZone || !validTimeZone(input.clientTimeZone)) {
        return this.composeClarificationResult(input, recipientResult.envelope, subject, "请确认你所在的时区后再设置发送时间。", "clientTimeZone");
      }
      if (!Number.isFinite(clientNowMs) || !Number.isFinite(sendAtMs) || sendAtMs <= clientNowMs) {
        return this.composeClarificationResult(input, recipientResult.envelope, subject, "发送时间需要是明确的未来日期和时间，请重新指定。", "sendAt");
      }
      suggestedSendAt = new Date(sendAtMs).toISOString();
    }

    const shouldApplyGeneratedSubject = !input.currentSubject?.trim() || /主题|标题|subject/i.test(input.intent);
    const finalSubject = shouldApplyGeneratedSubject && structuredDraft?.subject.trim()
      ? structuredDraft.subject.trim()
      : subject;
    const changeSummary = [...recipientResult.changeSummary];
    if (suggestedSendAt) changeSummary.push(`建议在 ${new Date(suggestedSendAt).toLocaleString("zh-CN", { timeZone: input.clientTimeZone })} 发送`);

    const result: ComposeMailResult = {
      type: "composeMail",
      operationType: input.operationType,
      status: "draft",
      to: recipientResult.envelope.to,
      cc: recipientResult.envelope.cc,
      bcc: recipientResult.envelope.bcc,
      subject: finalSubject,
      draftMarkdown,
      suggestedSendAt,
      suggestedSendTimeZone: suggestedSendAt ? input.clientTimeZone : undefined,
      changeSummary,
      targetLanguage: input.targetLanguage,
      styleId: input.styleId,
      language: this.composeLanguage ?? "en",
    };
    this.audit.log({
      emailId: input.emailId ?? "compose-new",
      action: "compose-mail",
      processor: "composeMail",
      caller,
      result: {
        operationType: input.operationType,
        status: result.status,
      },
    });
    return result;
  }

  private composeClarificationResult(
    input: { operationType: "NEW" | "REPLY"; targetLanguage?: string; styleId?: string },
    envelope: { to: string[]; cc: string[]; bcc: string[] },
    subject: string,
    question: string,
    missingField: string,
  ): ComposeMailResult {
    return {
      type: "composeMail",
      operationType: input.operationType,
      status: "needsClarification",
      ...envelope,
      subject,
      draftMarkdown: "",
      targetLanguage: input.targetLanguage,
      styleId: input.styleId,
      language: this.composeLanguage ?? "en",
      clarification: { status: "needsClarification", questions: [question], missingFields: [missingField] },
    };
  }

  private async resolveComposeEnvelope(input: {
    accountId?: string;
    intent: string;
    current: { to: string[]; cc: string[]; bcc: string[] };
    changes?: StructuredComposeDraftResponse["recipientChanges"];
  }): Promise<{
    envelope: { to: string[]; cc: string[]; bcc: string[] };
    changeSummary: string[];
    clarification?: ClarificationResult;
  }> {
    const envelope = {
      to: dedupeComposeAddresses(input.current.to),
      cc: dedupeComposeAddresses(input.current.cc),
      bcc: dedupeComposeAddresses(input.current.bcc),
    };
    const changeSummary: string[] = [];
    if (!input.changes) return { envelope, changeSummary };

    for (const field of ["to", "cc", "bcc"] as const) {
      const change = input.changes[field];
      if (change.recipients.length === 0) continue;
      const resolved: string[] = [];
      for (const query of change.recipients) {
        const explicit = query.match(/^(.*?)\s*<([^>]+)>\s*$/);
        const email = explicit?.[2]?.trim() ?? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query.trim()) ? query.trim() : undefined);
        if (email) {
          resolved.push(formatComposeAddress(explicit?.[1]?.trim(), email));
          continue;
        }
        if (!input.accountId || !this.resolveComposeRecipient) {
          return {
            envelope,
            changeSummary,
            clarification: { status: "needsClarification", questions: [`无法读取当前账号的企业通讯录来确认“${query}”，请补充邮箱地址。`], missingFields: [field] },
          };
        }
        const match = await this.resolveComposeRecipient(input.accountId, query);
        if (match.status === "exact") {
          resolved.push(formatComposeAddress(match.name, match.email));
          continue;
        }
        if (match.status === "ambiguous") {
          const choices = match.candidates.slice(0, 5).map((candidate) =>
            [candidate.name, candidate.departmentPath, candidate.title].filter(Boolean).join(" · ")
          ).join("；");
          return {
            envelope,
            changeSummary,
            clarification: { status: "needsClarification", questions: [`找到多位“${query}”：${choices}。请说明部门或职务。`], missingFields: [field] },
          };
        }
        const question = match.status === "unavailable"
          ? `企业通讯录暂时不可用，无法确认“${query}”。请稍后重试或直接输入邮箱。`
          : `企业通讯录中没有找到“${query}”。请补充姓名、部门或直接输入邮箱。`;
        return { envelope, changeSummary, clarification: { status: "needsClarification", questions: [question], missingFields: [field] } };
      }

      const operation = allowsRecipientOperation(input.intent, change.operation) ? change.operation : "add";
      const before = envelope[field];
      if (operation === "replace") envelope[field] = dedupeComposeAddresses(resolved);
      else if (operation === "remove") {
        const removed = new Set(resolved.map(addressEmail));
        envelope[field] = before.filter((value) => !removed.has(addressEmail(value)));
      } else envelope[field] = dedupeComposeAddresses([...before, ...resolved]);
      const label = field === "to" ? "收件人" : field === "cc" ? "抄送人" : "密送人";
      changeSummary.push(`${operation === "remove" ? "移除" : operation === "replace" ? "更新" : "新增"}${label} ${resolved.map((value) => value.replace(/\s*<.*$/, "")).join("、")}`);
    }
    return { envelope, changeSummary };
  }

  // ── AI Feedback ────────────────────────────────────────────────

  /**
   * Record AI feedback for a feature. The payload is automatically
   * sanitized to remove body content, prompt text, and raw LLM responses.
   */
  async recordFeedback(input: {
    accountId: string;
    feature: IntelligenceJobType;
    eventType: AiFeedbackEventType;
    emailId?: string;
    threadId?: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.aiFeedback?.save(input);
  }

  /**
   * Query AI feedback events for an account.
   */
  async getFeedback(
    accountId: string,
    filters?: { feature?: IntelligenceJobType; emailId?: string },
  ): Promise<AiFeedbackEvent[]> {
    return this.aiFeedback?.findByAccount(accountId, filters) ?? [];
  }

  /**
   * Query AI feedback events for a specific email.
   */
  async getFeedbackByEmailId(emailId: string): Promise<AiFeedbackEvent[]> {
    return this.aiFeedback?.findByEmailId(emailId) ?? [];
  }

  // ── Draft Versioning (ai-writing-suite) ────────────────────────

  /**
   * Get all draft versions for an email.
   */
  async getDraftVersions(emailId: string): Promise<DraftVersion[]> {
    return this.draftVersions?.findByEmailId(emailId) ?? [];
  }

  /**
   * Get the latest active draft version for an email.
   */
  async getActiveDraftVersion(emailId: string): Promise<DraftVersion | null> {
    return this.draftVersions?.getActive(emailId) ?? null;
  }

  /**
   * Save a draft version when a draft is generated or regenerated.
   * Records the draft content with its lifecycle state.
   */
  async saveDraftVersion(input: {
    emailId: string;
    state: WritingDraftState;
    draftMarkdown: string;
    language?: string;
    styleId?: string;
    model?: string;
  }): Promise<DraftVersion | null> {
    if (!this.draftVersions) return null;
    const version = this.draftVersions.save(input);
    this.audit.log({
      emailId: input.emailId,
      action: `save-draft-version:${input.state}`,
      processor: "replyDraft",
      caller: { source: "system" },
      result: { versionId: version.id, version: version.version, state: input.state },
    });
    return version;
  }

  /**
   * Regenerate a draft: marks the current active draft as superseded
   * and creates a new initial version.
   */
  async regenerateDraft(
    emailId: string,
    newDraftMarkdown: string,
    input: {
      language?: string;
      styleId?: string;
      model?: string;
    },
  ): Promise<DraftVersion | null> {
    if (!this.draftVersions) return null;

    // Mark current active as regenerated (superseded)
    const active = this.draftVersions.getActive(emailId);
    if (active) {
      this.draftVersions.updateState(active.id, "regenerated");
    }

    // Create new initial version
    const version = this.draftVersions.save({
      emailId,
      state: "initial",
      draftMarkdown: newDraftMarkdown,
      language: input.language,
      styleId: input.styleId,
      model: input.model,
    });

    // Record feedback
    const mail = this.mail.getMessageById(emailId);
    if (mail) {
      this.aiFeedback?.save({
        accountId: mail.accountId,
        feature: "replyDraft",
        eventType: "reject",
        emailId,
        payload: { action: "regenerate-draft", previousVersionId: active?.id },
      });
    }

    this.audit.log({
      emailId,
      action: "regenerate-draft",
      processor: "replyDraft",
      caller: { source: "user" },
      result: { versionId: version.id, version: version.version },
    });
    return version;
  }

  // ── Agent context (ai-agent-task-assistant) ────────────────────

  /**
   * Build agent context for a given email. Returns the intelligence state
   * plus the mail envelope (no body). Used by the suggestion builder and
   * the agent tools to provide context-aware suggestions.
   */
  async getAgentContext(emailId: string): Promise<{
    intelligenceState: EmailIntelligenceState;
    envelope: {
      id: string;
      subject: string;
      from: string;
      snippet: string;
      folder: string;
      language?: string;
      attachments?: Array<{ id?: string; filename?: string; mimetype?: string }>;
    } | null;
  }> {
    const [intelligenceState, mail] = await Promise.all([
      this.getState(emailId),
      Promise.resolve(this.mail.getMessageById(emailId)),
    ]);
    const envelope = mail
      ? {
          id: mail.id,
          subject: mail.subject,
          from: mail.from.name
            ? `${mail.from.name} <${mail.from.email}>`
            : mail.from.email,
          snippet: mail.snippet,
          folder: mail.folder,
          attachments: mail.attachments.map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            mimetype: attachment.mimetype,
          })),
        }
      : null;
    return { intelligenceState, envelope };
  }

  // ── Private helpers ────────────────────────────────────────────

  /**
   * Find job statuses for an email through the canonical mail job queue.
   * Returns statuses for any job that exists (pending, running, or failed).
   * This lets us distinguish "failed" (job ran but errored) from "skipped"
   * (no job was ever created or job was pre-screened away).
   */
  private findJobs(
    emailId: string,
  ): Partial<Record<IntelligenceJobType, IntelligenceJobLookup>> {
    const out: Partial<Record<IntelligenceJobType, IntelligenceJobLookup>> = {};
    const jobTypes: IntelligenceJobType[] = [
      "summary",
      "tags",
      "replyDecision",
      "replyDraft",
      "todoExtraction",
      "linkExtraction",
      "translation",
      "composeMail",
    ];
    for (const type of jobTypes) {
      const job = this.jobs.findByEmailAndType(emailId, type);
      if (job) {
        out[type] = job;
      }
    }
    return out;
  }

  /**
   * F3 — Merge the latest Task Agent status from the todos table into
   * the cached TodoExtractionResult. The result blob in
   * Canonical extraction artifacts are immutable; live status is in `todos`.
   */
  private hydrateTodoAgentStatus(
    emailId: string,
    extraction: TodoExtractionResult | undefined,
  ): TodoExtractionResult | undefined {
    if (!extraction || !this.todos) return extraction;
    const live = this.todos.listByEmail(emailId);
    if (live.length === 0) return extraction;
    const byId = new Map(live.map((t) => [t.id, t]));
    const byTitle = new Map(live.map((t) => [t.title, t]));
    return {
      ...extraction,
      todos: extraction.todos.map((t) => {
        const match = (t.id ? byId.get(t.id) : undefined) ?? byTitle.get(t.title);
        if (!match) return t;
        return {
          ...t,
          id: t.id ?? match.id,
          agentStatus: match.agentStatus ?? null,
          agentStatusLocked: match.agentStatusLocked ?? false,
        };
      }),
    };
  }

  private buildCapabilityState<T extends IntelligenceResult>(
    _emailId: string,
    type: IntelligenceJobType,
    result: T | undefined,
    job?: IntelligenceJobLookup,
  ): {
    status: IntelligenceStatus;
    result?: T;
    canRetry?: boolean;
    skipReason?: string;
    error?: string;
    job?: Pick<IntelligenceJob, "id" | "status" | "attempts" | "maxAttempts" | "createdAt" | "updatedAt" | "startedAt" | "finishedAt" | "error">;
  } {
    if (result) {
      // Check if this is a real typed result or a skipped placeholder
      const typed = result as any;
      if (typed._status === "skipped") {
        if (job) {
          if (job.status === "failed") {
            return {
              status: "failed",
              canRetry: type === "summary",
              error: job.error,
              job: toCapabilityJob(job),
            };
          }
          return {
            status: job.status,
            canRetry: type === "summary" ? true : undefined,
            error: job.error,
            job: toCapabilityJob(job),
          };
        }
        return { status: "skipped", skipReason: typed.reason };
      }
      if (typed.type === type) {
        if (type === "summary" && !isValidSummaryResult(result)) {
          return { status: "failed", canRetry: true };
        }
        return { status: "succeeded", result };
      }
      // Fallback: reason field indicates a skipped result
      if (typed.reason) {
        if (job) {
          if (job.status === "failed") {
            return {
              status: "failed",
              canRetry: type === "summary",
              error: job.error,
              job: toCapabilityJob(job),
            };
          }
          return {
            status: job.status,
            canRetry: type === "summary" ? true : undefined,
            error: job.error,
            job: toCapabilityJob(job),
          };
        }
        return { status: "skipped", skipReason: typed.reason };
      }
      if (type === "summary" && !isValidSummaryResult(result)) {
        return { status: "failed", canRetry: true };
      }
      return { status: "succeeded", result };
    }
    if (job) {
      // Job exists but no result — could be pending, running, or failed
      if (job.status === "failed") {
        const canRetry = type === "summary";
        return {
          status: "failed",
          canRetry,
          error: job.error,
          job: toCapabilityJob(job),
        };
      }
      return {
        status: job.status,
        canRetry: type === "summary" ? true : undefined,
        error: job.error,
        job: toCapabilityJob(job),
      };
    }
    // No result and no job — capability was not triggered
    return { status: "skipped" as IntelligenceStatus };
  }

  /**
   * Ensure summary coverage for any email whose summary was never queued
   * or was previously skipped because the LLM was unavailable.
   *
   * This backfills legacy / historical messages when a caller opens the
   * detail view or otherwise queries intelligence state.
   */
  private ensureSummaryCoverage(
    emailId: string,
    storedSummary: IntelligenceResult | undefined,
    jobStatus?: IntelligenceStatus,
  ): IntelligenceStatus | undefined {
    if (!this.llmRuntime.snapshot().configured) return undefined;
    const message = this.resolveMessage(emailId);
    if (!message || isSentFolder(message.folder)) return undefined;
    if (!hasSummarizableBody(message)) return "skipped";
    if (jobStatus === "failed") {
      const existingJob = this.jobs.findByEmailAndType(emailId, "summary");
      if (existingJob && this.shouldAutoRetrySummaryFailure(existingJob.id)) {
        this.jobs.resetForManualRetry(existingJob.id);
        return "pending";
      }
      return undefined;
    }
    const summary = storedSummary as SummaryResult | undefined;
    if (summary?.type === "summary") {
      if (summary._status === "completed") return undefined;
      const metadata = summary._metadata;
      const currentFingerprint = summaryContentFingerprint(message);
      const fingerprintChanged =
        typeof metadata?.contentFingerprint === "string" &&
        metadata.contentFingerprint !== currentFingerprint;
      const bodyVersionChanged =
        typeof metadata?.bodyVersion === "number" &&
        typeof message.bodyVersion === "number" &&
        metadata.bodyVersion !== message.bodyVersion;
      const legacySummaryWithHydratedBody =
        !metadata?.contentFingerprint &&
        Boolean(
          message.bodyText?.trim() ||
          message.bodyHtml?.trim()
        );
      if (
        fingerprintChanged ||
        bodyVersionChanged ||
        legacySummaryWithHydratedBody ||
        (!metadata?.contentFingerprint && hasMonitoringDataCandidate(message))
      ) {
        if (jobStatus === "pending" || jobStatus === "running") {
          return jobStatus;
        }
        const orchestrator = this.getOrchestrator();
        const descriptor = orchestrator?.getDescriptor("summary");
        this.jobs.enqueueOrResetJob({
          accountId: message.accountId,
          emailId,
          type: "summary",
          maxAttempts: descriptor?.lane.maxAttempts ?? 2,
          payload: {
            retrySource: "mail-content-changed",
            bodyVersion: message.bodyVersion ?? 0,
          },
        });
        return "pending";
      }
    }
    if (jobStatus && jobStatus !== "skipped") return undefined;
    if (storedSummary) {
      const typed = storedSummary as any;
      const isSkipped = typed._status === "skipped" || typeof typed.reason === "string";
      if (!isSkipped) return undefined;
    }

    const orchestrator = this.getOrchestrator();
    if (!orchestrator) return undefined;
    const descriptor = orchestrator.getDescriptor("summary");
    const maxAttempts = descriptor?.lane.maxAttempts ?? 2;
    orchestrator.enqueueSingle(emailId, "summary", maxAttempts);
    return "pending";
  }

  private shouldAutoRetrySummaryFailure(jobId: string): boolean {
    const row = this.jobs.getJobById(jobId);
    return row?.status === "failed" && isRecoverableSummaryFailure(row.error);
  }

  private buildReplyDecisionState(
    emailId: string,
    result: IntelligenceResult | undefined,
    jobStatus?: IntelligenceStatus,
  ): { status: IntelligenceStatus; result?: ReplyDecisionResult; skipReason?: string } {
    if (result) {
      const typed = result as ReplyDecisionResult;
      if (typed.type === "replyDecision") {
        return { status: "succeeded", result: typed };
      }
      // Could be a skipped result stored as JSON
      const skipData = result as any;
      if (skipData.reason && !skipData.shouldReply) {
        return {
          status: "skipped",
          skipReason: skipData.reason,
        };
      }
      return { status: "succeeded", result: typed };
    }
    if (jobStatus) {
      return { status: jobStatus };
    }
    return { status: "skipped" as IntelligenceStatus };
  }

  private buildReplyDraftState(
    emailId: string,
    result: IntelligenceResult | undefined,
    decisionResult: IntelligenceResult | undefined,
    jobStatus?: IntelligenceStatus,
  ): { status: IntelligenceStatus | "not-needed"; result?: ReplyDraftResult; canRetry?: boolean } {
    // Check if replyDecision says no reply needed
    if (decisionResult) {
      const decision = decisionResult as ReplyDecisionResult;
      if (decision.type === "replyDecision" && decision.shouldReply === false) {
        return { status: "not-needed" };
      }
    }

    if (result) {
      return { status: "succeeded", result: result as ReplyDraftResult };
    }
    if (jobStatus) {
      if (jobStatus === "failed") {
        const job = this.jobs.findByEmailAndType(emailId, "replyDraft");
        const canRetry = job != null && job.attempts < job.maxAttempts;
        return { status: "failed", canRetry };
      }
      return { status: jobStatus };
    }
    return { status: "skipped" as IntelligenceStatus };
  }

  private enqueueCapability(
    emailId: string,
    type: IntelligenceJobType,
    payload?: Record<string, unknown>,
  ): string {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) throw new Error("Intelligence orchestrator not available");
    const descriptor = orchestrator.getDescriptor(type);
    const maxAttempts = descriptor?.lane.maxAttempts ?? 3;
    const result = orchestrator.enqueueSingle(emailId, type, maxAttempts, payload);
    return result.id;
  }
}

function isRecoverableSummaryFailure(error: string | undefined): boolean {
  return (
    typeof error === "string" &&
    (/cooling down/i.test(error) || error === "summary-too-long")
  );
}
