/**
 * Intelligence Orchestrator.
 *
 * Subscribes to inserted-mail events, runs local pre-screening,
 * applies the fan-out strategy to determine which jobs to enqueue,
 * and handles LLM-not-configured by immediately skipping
 * capabilities that require LLM.
 *
 * Three caller paths all converge here:
 *   1. System: inserted-mail event → automatic pipeline
 *   2. Agent: IntelligenceService.trigger*() → single capability
 *   3. User: API route → IntelligenceService → orchestrator
 */

import type {
  IntelligenceJob,
  IntelligenceJobType,
  IntelligenceResult,
  ProcessorWorkspaceContext,
} from "../../../shared/wemail/intelligence.js";
import { isSentFolder } from "../../../shared/folders.js";
import { isMailBodyCached, type MailMessage } from "../../../shared/wemail/mail.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type { JobRepository } from "../queue/JobRepository.js";
import type { WorkspaceContextLoader } from "../workspace/WorkspaceContextLoader.js";
import type { IntelligenceResultRepository } from "./IntelligenceResultRepository.js";
import type {
  MailIntelligenceProcessor,
  ProcessorContext,
} from "./MailIntelligenceProcessor.js";
import type { CapabilityRegistry } from "./CapabilityRegistry.js";
import type { CapabilityDescriptor } from "./CapabilityDescriptor.js";
import type { FanOutStrategy } from "./FanOutStrategy.js";
import type { LocalPrescreener } from "./LocalPrescreener.js";
import { BUILTIN_SMART_TAG_FINGERPRINT } from "../ai/prompts/smartTagDefinitions.js";
import { hasSummarizableBody, isImageOnlyBody } from "./SummaryContentFingerprint.js";

export interface IntelligenceOrchestratorOptions {
  registry: CapabilityRegistry;
  jobs: JobRepository;
  results: IntelligenceResultRepository;
  repository: CanonicalMailRepository;
  prescreener: LocalPrescreener;
  strategy: FanOutStrategy;
  accountId: string;
  /** Whether LLM client is configured */
  llmConfigured: boolean;
  /** Body-free logger */
  logger?: (message: string) => void;
  /**
   * Optional workspace context loader. When provided, every dispatch
   * for a capability with a non-empty `workspaceInputs` declaration
   * loads its compiled context and surfaces it on
   * `ProcessorContext.workspace`. When absent, processors observe
   * `ctx.workspace === undefined` and fall back to their default
   * prompt behavior.
   */
  workspaceLoader?: WorkspaceContextLoader;
  /**
   * Bounded startup repair for accounts that already have local mail
   * rows but no tags job/result because historical syncs previously did
   * not emit the internal inserted-mail event.
   */
  startupTagBackfillLimit?: number;
  tagDefinitionFingerprint?: () => string;
  /**
   * Optional full-message resolver. Mail Core stores hydrated bodies outside
   * the envelope row, so worker runtimes use this hook to overlay that body
   * before processors build their prompts.
   */
  resolveMessage?: (id: string) => MailMessage | null;
}

/**
 * Dispatch outcome with an added "skipped" variant.
 */
export type OrchestratorDispatchOutcome =
  | { kind: "ok"; result: IntelligenceResult }
  | { kind: "no-processor" }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; error: Error };

export class IntelligenceOrchestrator {
  private readonly registry: CapabilityRegistry;
  private readonly jobs: JobRepository;
  private readonly results: IntelligenceResultRepository;
  private readonly repository: CanonicalMailRepository;
  private readonly prescreener: LocalPrescreener;
  private readonly strategy: FanOutStrategy;
  private readonly accountId: string;
  private readonly llmConfigured: boolean;
  private readonly logger: (message: string) => void;
  private readonly workspaceLoader?: WorkspaceContextLoader;
  private readonly startupTagBackfillLimit: number;
  private readonly tagDefinitionFingerprint: () => string;
  private readonly resolveMessage: (id: string) => MailMessage | null;
  private readonly processors = new Map<
    IntelligenceJobType,
    MailIntelligenceProcessor
  >();
  private readonly summaryNotificationCandidates = new Set<string>();
  private started = false;

  constructor(options: IntelligenceOrchestratorOptions) {
    this.registry = options.registry;
    this.jobs = options.jobs;
    this.results = options.results;
    this.repository = options.repository;
    this.prescreener = options.prescreener;
    this.strategy = options.strategy;
    this.accountId = options.accountId;
    this.llmConfigured = options.llmConfigured;
    this.logger = options.logger ?? (() => {});
    this.workspaceLoader = options.workspaceLoader;
    this.startupTagBackfillLimit = Math.max(
      0,
      options.startupTagBackfillLimit ?? 5000,
    );
    this.tagDefinitionFingerprint =
      options.tagDefinitionFingerprint ?? (() => BUILTIN_SMART_TAG_FINGERPRINT);
    this.resolveMessage =
      options.resolveMessage ?? ((id) => this.repository.getMessageById(id));
  }

  private log(
    event: string,
    fields: Record<string, string | number | boolean>,
  ): void {
    this.logger(JSON.stringify({ event, ...fields }));
  }

  /** Register a pre-created processor instance. */
  registerProcessor(processor: MailIntelligenceProcessor): void {
    this.processors.set(processor.type, processor);
  }

  hasProcessor(type: IntelligenceJobType): boolean {
    return this.processors.has(type);
  }

  /** Get the capability descriptor for a job type. */
  getDescriptor(type: IntelligenceJobType): CapabilityDescriptor | undefined {
    return this.registry.get(type);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.summaryNotificationCandidates.clear();
  }

  /**
   * `new-mail` is emitted only for live/manual receive paths, before the
   * generic `mail-inserted` intelligence event. Historical sync intentionally
   * omits it, so old-mail backfills never become notification candidates.
   */
  private readonly onNewMail = (message: MailMessage): void => {
    this.summaryNotificationCandidates.add(message.id);
  };

  /**
   * Handler for inserted-mail events from Mail Core sync worker.
   * Runs pre-screening → applies fan-out strategy → enqueues jobs.
   */
  private readonly onMailInserted = (message: MailMessage): void => {
    this.enqueueForMessage(message);
  };

  async enqueueMissingStartupTagJobs(options: {
    batchSize?: number;
    admit?: () => Promise<boolean>;
    signal?: AbortSignal;
  } = {}): Promise<void> {
    if (this.startupTagBackfillLimit === 0) return;
    const descriptor = this.registry.get("tags");
    if (!descriptor) return;
    if (descriptor.requiresLlm && !this.llmConfigured) {
      this.log("startup-tag-backfill-skipped", {
        account: this.accountId,
        reason: "llm-not-configured",
      });
      return;
    }

    const batchSize = Math.min(200, Math.max(1, options.batchSize ?? 100));
    let queued = 0;
    let inspected = 0;
    let cursor: { receivedAt: string; id: string } | undefined;
    while (inspected < this.startupTagBackfillLimit && !options.signal?.aborted) {
      if (options.admit && !(await options.admit())) break;
      const messages = this.repository.listAllMessagesByAccountPage({
        accountId: this.accountId,
        limit: Math.min(batchSize, this.startupTagBackfillLimit - inspected),
        cursor,
      });
      if (messages.length === 0) break;
      for (const message of messages) {
        const result = this.ensureTagJob(
          message,
          descriptor.lane.maxAttempts,
          "startup-tag-backfill",
        );
        if (result.inserted || result.reset) queued += 1;
      }
      inspected += messages.length;
      const last = messages.at(-1)!;
      cursor = { receivedAt: last.receivedAt, id: last.id };
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (messages.length < batchSize) break;
    }

    if (queued > 0) {
      this.log("startup-tag-backfill", {
        account: this.accountId,
        inspected,
        queued,
      });
    }
  }

  /**
   * Enqueue intelligence jobs for an inserted mail message.
   * Returns the list of created job references.
   */
  enqueueForMessage(message: MailMessage): Array<{
    id: string;
    type: IntelligenceJobType;
    inserted: boolean;
  }> {
    if (!isMailBodyCached(message)) {
      this.log("enqueue-jobs-deferred", {
        account: this.accountId,
        emailId: message.id,
        reason: "body-not-cached",
      });
      return [];
    }
    const prescreen = this.prescreener.check(message);
    const plan = this.strategy.plan(message, prescreen);
    const notifyWhenSummarized = this.summaryNotificationCandidates.has(
      message.id,
    );
    const created: Array<{
      id: string;
      type: IntelligenceJobType;
      inserted: boolean;
    }> = [];

    for (const jobPlan of plan) {
      const descriptor = this.registry.get(jobPlan.type);

      // If capability requires LLM and LLM is not configured, skip immediately
      if (descriptor?.requiresLlm && !this.llmConfigured) {
        this.results.saveSkipped(message.id, jobPlan.type, "llm-not-configured");
        this.log("job-skipped", {
          emailId: message.id,
          type: jobPlan.type,
          reason: "llm-not-configured",
        });
        continue;
      }

      const result = jobPlan.type === "tags"
        ? this.ensureTagJob(message, jobPlan.maxAttempts, "mail-inserted")
        : this.jobs.enqueueJob({
            emailId: message.id,
            type: jobPlan.type,
            accountId: this.accountId,
            maxAttempts: jobPlan.maxAttempts,
            ...(jobPlan.type === "summary" && notifyWhenSummarized
              ? { payload: { source: "mail-received" } }
              : {}),
          });
      created.push({ id: result.id, type: jobPlan.type, inserted: result.inserted });
    }
    this.summaryNotificationCandidates.delete(message.id);

    const newRows = created.filter((r) => r.inserted).length;
    this.log("enqueue-jobs", {
      account: this.accountId,
      emailId: message.id,
      created: newRows,
      planned: plan.length,
      prescreenSkip: prescreen.skipReply,
    });

    return created;
  }

  private ensureTagJob(
    message: MailMessage,
    maxAttempts: number,
    reason: string,
  ): { id: string; inserted: boolean; reset: boolean } {
    const fingerprint = this.tagDefinitionFingerprint();
    if (this.results.hasFreshTagResult(message.id, fingerprint)) {
      const existing = this.jobs.findByEmailAndType(message.id, "tags");
      return {
        id: existing?.id ?? `fresh-tags-${message.id}`,
        inserted: false,
        reset: false,
      };
    }

    const existing = this.jobs.findByEmailAndType(message.id, "tags");
    if (
      existing &&
      (existing.status === "pending" || existing.status === "running") &&
      existing.attempts < existing.maxAttempts
    ) {
      return { id: existing.id, inserted: false, reset: false };
    }

    return this.jobs.enqueueOrResetJob({
      emailId: message.id,
      type: "tags",
      accountId: this.accountId,
      maxAttempts,
      payload: { reason, tagDefinitionFingerprint: fingerprint },
    });
  }

  /**
   * Enqueue a single capability job (for agent/user-initiated triggers).
   * Returns the job ID, or throws if the capability is not registered
   * or requires LLM but LLM is not configured.
   */
  enqueueSingle(
    emailId: string,
    type: IntelligenceJobType,
    maxAttempts: number,
    payload?: Record<string, unknown>,
  ): { id: string; inserted: boolean } {
    const descriptor = this.registry.get(type);
    if (!descriptor) {
      throw new Error(`Capability not registered: ${type}`);
    }
    const message = this.resolveMessage(emailId);
    if (type === "summary" && (!message || (!hasSummarizableBody(message) && !isImageOnlyBody(message)))) {
      this.results.saveSkipped(emailId, type, "body-not-available");
      this.log("job-skipped", { emailId, type, reason: "body-not-available" });
      return { id: `skip-${type}-${emailId}`, inserted: false };
    }
    if (
      (type === "summary" || type === "replyDecision") &&
      message &&
      isSentFolder(message.folder)
    ) {
      this.results.saveSkipped(emailId, type, "sent-mail");
      this.log("job-skipped", { emailId, type, reason: "sent-mail" });
      return { id: `skip-${type}-${emailId}`, inserted: false };
    }
    if (descriptor.requiresLlm && !this.llmConfigured) {
      this.results.saveSkipped(emailId, type, "llm-not-configured");
      this.log("job-skipped", { emailId, type, reason: "llm-not-configured" });
      return { id: `skip-${type}-${emailId}`, inserted: false };
    }
    return this.jobs.enqueueJob({
      emailId,
      type,
      accountId: this.accountId,
      maxAttempts,
      payload,
    });
  }

  /**
   * Dispatch a single pending job. Called by QueueRunner.
   * Returns a structured outcome for the runner to persist.
   */
  async dispatch(job: IntelligenceJob): Promise<OrchestratorDispatchOutcome> {
    if (job.type === "summary" || job.type === "replyDecision") {
      const message = this.resolveMessage(job.emailId);
      if (job.type === "summary" && (!message || (!hasSummarizableBody(message) && !isImageOnlyBody(message)))) {
        return { kind: "skipped", reason: "body-not-available" };
      }
      if (message && isSentFolder(message.folder)) {
        return { kind: "skipped", reason: "sent-mail" };
      }
    }
    const processor = this.processors.get(job.type);
    if (!processor) {
      this.log("no-processor", {
        type: job.type,
        id: job.id,
        emailId: job.emailId,
      });
      return { kind: "no-processor" };
    }

    // Hydrate `ctx.workspace` from the capability's declared
    // `workspaceInputs` when both a loader and a non-empty input set
    // are present. Failures here are logged and swallowed — workspace
    // context is best-effort prompt fuel; a load failure should never
    // block dispatch.
    const descriptor = this.registry.get(job.type);
    let workspaceContext: ProcessorWorkspaceContext | undefined;
    if (
      this.workspaceLoader &&
      descriptor &&
      descriptor.workspaceInputs.length > 0
    ) {
      try {
        workspaceContext = await this.workspaceLoader.loadFor({
          descriptor,
          accountId: this.accountId,
        });
      } catch (err) {
        this.log("workspace-load-failed", {
          type: job.type,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const ctx: ProcessorContext = {
      getMessage: this.resolveMessage,
      workspace: workspaceContext,
    };

    try {
      const result = await processor.handle(job, ctx);
      return { kind: "ok", result };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return { kind: "error", error: err };
    }
  }
}
