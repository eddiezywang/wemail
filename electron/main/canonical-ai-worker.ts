import { randomUUID } from "node:crypto";
import type { AiJobDispatcher } from "./ai-job-dispatcher.js";
import { AiNetworkCircuitBreaker } from "../../server/wemail/ai/AiNetworkCircuitBreaker.js";
import { LlmClientError } from "../../server/wemail/ai/LlmClient.js";
import { aiRetryDelayMs } from "../../server/wemail/ai/AiRetryPolicy.js";
import type { LlmRuntimeSnapshot } from "../../server/wemail/ai/LlmRuntime.js";
import type { ResourceGovernor } from "../../server/wemail/performance/ResourceGovernor.js";
import {
  SUMMARY_PROCESSOR_VERSION,
  SummaryProcessor,
  SummaryProcessorError,
} from "../../server/wemail/intelligence/processors/SummaryProcessor.js";
import {
  TAG_PROCESSOR_VERSION,
  TagProcessor,
  TagProcessorError,
} from "../../server/wemail/intelligence/processors/TagProcessor.js";
import {
  REPLY_DECISION_PROCESSOR_VERSION,
  ReplyDecisionProcessor,
} from "../../server/wemail/intelligence/processors/ReplyDecisionProcessor.js";
import {
  TODO_EXTRACTION_PROCESSOR_VERSION,
  TodoExtractionProcessor,
  TodoExtractionProcessorError,
  type TodoExtractionProcessorDeps,
} from "../../server/wemail/intelligence/processors/TodoExtractionProcessor.js";
import type { TodoRepository } from "../../server/wemail/todos/TodoRepository.js";
import type { AiUsageRecorder } from "../../shared/wemail/usage.js";
import type { MailDatabaseProducer } from "../mail-core/mail-database-producer.js";
import type { MailDatabaseCompleteAiArtifactParams } from "../../shared/wemail/mailDatabaseProtocol.js";
import type {
  IntelligenceJob,
  SummaryResult,
  SummaryThreadResult,
  TagResult,
} from "../../shared/wemail/intelligence.js";
import type { UserTag } from "../../server/wemail/intelligence/UserTagRepository.js";

interface SummaryJobPayload {
  accountId: string;
  emailId: string;
  contentSha256: string;
  contentVersion: number;
  smartTagBackfillRunId?: string;
  /** Set by the worker on retry (>1 attempt) to shrink the re-sent context. */
  strategy?: "degraded";
}

// Startup reconciliation is maintenance work. Give account configuration,
// the first mail list, and a focused body a quiet window before it touches the
// single SQLite writer.
const STARTUP_MAINTENANCE_DELAY_MS = 15_000;
export const CANONICAL_AI_JOB_LEASE_MS = 100_000;

export function safeAiJobErrorCode(error: unknown): string {
  if (error instanceof LlmClientError) {
    if (Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599) return `llm-http-${error.status}`;
    const codes = new Set(["NO_FETCH", "NO_MODEL", "TIMEOUT", "ABORTED", "NETWORK", "PARSE", "NO_CONTENT", "REFUSAL", "CONTENT_FILTERED", "STRUCTURED_FINISH_REASON", "NO_TOOL_USE", "RESPONSE_TOO_LARGE"]);
    return error.code && codes.has(error.code) ? error.code : "llm-request-failed";
  }
  const message = error instanceof Error ? error.message : "";
  return ["mail-body-not-available", "mail-missing", "invalid-ai-job-payload"].includes(message)
    ? message : "ai-job-failed";
}

const SAFE_SUMMARY_PROCESSOR_CODES = new Set([
    "body-not-available", "false-empty-body", "invalid-actionItems", "invalid-bullets",
    "invalid-evidenceRefs", "invalid-headline", "invalid-json", "invalid-openQuestions",
    "invalid-risks", "invalid-shape", "invalid-urgency", "mail-missing",
    "no-thread-messages", "truncated",
]);
const SAFE_TAG_PROCESSOR_CODES = new Set(["invalid-json", "invalid-shape", "invalid-tags", "mail-missing", "truncated"]);
const SAFE_TODO_PROCESSOR_CODES = new Set(["mail-missing", "response-not-json", "response-not-object", "todos-not-array", "truncated"]);

/** Body-free diagnostics; job retry semantics continue to use safeAiJobErrorCode. */
export function safeAiProcessorCode(error: unknown): string | undefined {
  if (error instanceof SummaryProcessorError && SAFE_SUMMARY_PROCESSOR_CODES.has(error.code)) return `summary:${error.code}`;
  if (error instanceof TagProcessorError && SAFE_TAG_PROCESSOR_CODES.has(error.code)) return `tags:${error.code}`;
  if (error instanceof TodoExtractionProcessorError && SAFE_TODO_PROCESSOR_CODES.has(error.message)) return `todo:${error.message}`;
  return undefined;
}

/**
 * Jobs with priority <= this are user-visible / real-time (on-demand body,
 * foreground trigger, incremental new mail) and write through directly so the
 * result appears with zero added latency. Higher priorities (historical /
 * backfill) are coalesced through the shared AiCompletionBuffer to reduce
 * single-writer contention under bulk load. Lower number = higher precedence.
 */
const AI_REALTIME_PRIORITY_MAX = 2;

/**
 * Sink the worker feeds bulk completions into (the shared AiCompletionBuffer).
 * Decoupled from the buffer class so the worker depends only on this minimal
 * surface and stays unit-testable with a mock.
 */
export interface AiCompletionSink {
  enqueue(item: MailDatabaseCompleteAiArtifactParams): Promise<boolean>;
}

export class CanonicalAiWorker {
  private readonly owner = `ai-${process.pid}-${randomUUID()}`;
  private readonly abortController = new AbortController();
  private scheduled = false;
  private draining = false;
  private stopped = false;
  private startupReconciled = false;
  private startupMaintenanceReady = false;
  private startupMaintenanceTimer: NodeJS.Timeout | null = null;
  private dueTimer: NodeJS.Timeout | null = null;
  private blockedGeneration: number | null = null;
  /**
   * Soft-retire state, set by `retire()` for pool-driven shrink. When true
   * the drain loop finishes any in-flight job, then stops consuming without
   * rescheduling. Distinct from `stopped` (hard abort for app quit/watchdog).
   */
  private retiring = false;
  private retired = false;
  private readonly retireResolvers: Array<() => void> = [];

  constructor(private readonly options: {
    database: MailDatabaseProducer;
    dispatcher?: AiJobDispatcher;
    getLlmSnapshot: () => LlmRuntimeSnapshot;
    getUserTags?: (accountId: string) => UserTag[] | Promise<UserTag[]>;
    /**
     * Shared resource governor (from the main-process composition). AI work is
     * background-class work: when the machine is under load the governor pauses
     * this worker via waitForAdmission, letting foreground UI / other apps run.
     * Note that user-triggered AI jobs (priority 1) are ALSO background-class —
     * a busy machine may delay them; that is the intended trade-off.
     */
    governor?: ResourceGovernor;
    /**
     * Master switch for the reply-decision capability. When false the worker
     * never claims `ai.reply-decision` jobs and omits them from due-time
     * scheduling — existing pending reply-decision jobs stay pending and are
     * preserved (not deleted), they simply stop draining. Flip back on to
     * resume. Defaults to true.
     */
    replyDecisionEnabled?: boolean;
    /**
     * In-process store for standalone consumers; Electron uses persistTodos
     * to commit suggestions through the database writer.
     */
    todos?: TodoRepository;
    persistTodos?: TodoExtractionProcessorDeps["persistTodos"];
    /**
     * Acknowledged usage sink. Electron records usage through the DB writer.
     */
    usage?: AiUsageRecorder;
    /** Live editable instructions for the standalone todo capability. */
    getTodoPrompt?: TodoExtractionProcessorDeps["getTodoPrompt"];
    /** Pool-shared, lazy startup reconciliation. */
    startupMaintenance?: () => Promise<void>;
    log: (phase: string, extra?: Record<string, unknown>) => void;
    onTagsCompleted?: (input: {
      accountId: string;
      emailId: string;
      result: TagResult;
    }) => void;
    onSummaryCompleted?: (input: {
      accountId: string;
      emailId: string;
      summary: SummaryResult | SummaryThreadResult;
    }) => void | Promise<void>;
    /** Shared by all AI workers so a provider outage pauses the whole queue. */
    circuitBreaker?: AiNetworkCircuitBreaker;
    onLlmFailure?: (input: { error: unknown; kind: string }) => void;
    onLlmSuccess?: () => void;
    /**
     * Optional shared completion buffer (Phase B). When set, completions for
     * bulk-priority jobs (priority > AI_REALTIME_PRIORITY_MAX) are enqueued
     * here for batched flushing instead of written through one at a time.
     * Real-time completions always bypass it and write through directly.
     */
    completionBuffer?: AiCompletionSink;
  }) {
    this.circuitBreaker = options.circuitBreaker;
    this.completionBuffer = options.completionBuffer;
  }

  private readonly completionBuffer: AiCompletionSink | undefined;

  private readonly circuitBreaker: AiNetworkCircuitBreaker | undefined;

  /** Consecutive drain-loop throws (e.g. claim timeouts); drives backoff. */
  private drainFailureCount = 0;

  wake(): void {
    if (this.stopped || this.scheduled || this.draining) return;
    const llm = this.options.getLlmSnapshot();
    if (!llm.configured && this.blockedGeneration === llm.generation) return;
    if (this.dueTimer) {
      clearTimeout(this.dueTimer);
      this.dueTimer = null;
    }
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  stop(): void {
    this.stopped = true;
    // Resolve any pending retire() promises so a hard stop can't leak them
    // (the drain finally is the primary resolver; this is the backstop for a
    // retire that never re-entered drain).
    this.resolveRetire();
    // Cancel any in-flight waitForAdmission so a drain blocked on the governor
    // (machine under load) exits immediately instead of re-looping forever.
    this.abortController.abort();
    if (this.startupMaintenanceTimer) clearTimeout(this.startupMaintenanceTimer);
    this.startupMaintenanceTimer = null;
    if (this.dueTimer) clearTimeout(this.dueTimer);
    this.dueTimer = null;
  }

  /**
   * Graceful retire for pool-driven shrink: finish the in-flight job (if any),
   * then stop consuming. The returned promise resolves once the worker is
   * truly idle — on every drain exit path and in `stop()` (backstop), so it
   * can never leak.
   *
   * The abort is SAFE: `abortController` is only consumed by
   * `awaitBackgroundAdmission()` (the governor wait), never by `process()`,
   * the LLM call, or `claimJob`. Aborting therefore does not interrupt a
   * running job — it only unblocks a worker stuck on a paused governor so the
   * promise can resolve instead of hanging.
   */
  retire(): Promise<void> {
    if (this.retired || this.stopped) {
      this.retired = true;
      return Promise.resolve();
    }
    this.retiring = true;
    this.abortController.abort();
    if (this.startupMaintenanceTimer) {
      clearTimeout(this.startupMaintenanceTimer);
      this.startupMaintenanceTimer = null;
    }
    if (this.dueTimer) {
      clearTimeout(this.dueTimer);
      this.dueTimer = null;
    }
    // Re-enter drain() so the loop observes `retiring` and exits cleanly. If
    // the worker is already draining, wake() is a no-op and the in-flight
    // drain's finally resolves the promise once the current job finishes.
    this.wake();
    return new Promise<void>((resolve) => {
      this.retireResolvers.push(resolve);
    });
  }

  /** Whether this worker currently holds a claimed job (mid-`process`). */
  isBusy(): boolean {
    return this.draining;
  }

  /** Idempotently settle all pending retire() promises. */
  private resolveRetire(): void {
    if (this.retired) return;
    this.retired = true;
    const resolvers = this.retireResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }

  /**
   * ai.* job kinds this worker will claim and schedule. `ai.reply-decision` is
   * dropped when the reply-decision switch is off so pending reply-decision
   * jobs stop draining — they remain in the queue, preserved, and resume the
   * moment the switch is flipped back on.
   */
  private aiJobKinds(): string[] {
    const kinds = this.options.replyDecisionEnabled === false
      ? ["ai.summary", "ai.tags"]
      : ["ai.summary", "ai.tags", "ai.reply-decision"];
    if (this.options.todos || this.options.persistTodos) kinds.push("ai.todo");
    return kinds;
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = true;
    let admissionBlocked = false;
    let maintenanceDeferred = false;
    let circuitBlocked = false;
    try {
      // A retire that re-entered drain (idle worker) exits here so the finally
      // settles the retire promise. Checked INSIDE try so the finally always
      // runs — never via the pre-try early-return guard (which would leak it).
      if (this.retiring) {
        return;
      }
      const llm = this.options.getLlmSnapshot();
      if (!llm.client || !llm.modelFor("summary")) {
        this.blockedGeneration = llm.generation;
        admissionBlocked = true;
        this.options.log("canonical-ai-admission-blocked", {
          reason: "llm-not-configured",
          generation: llm.generation,
        });
        return;
      }
      this.blockedGeneration = null;
      // Gate BEFORE startup reconciliation: when the machine is under load the
      // governor pauses background AI work, and reconcileAiJobs/
      // resetTerminalAiJobsForRetry are heavy single-writer maintenance — they
      // must not run while paused.
      if (this.options.governor && !(await this.awaitBackgroundAdmission())) {
        admissionBlocked = true;
        return;
      }
      if (!this.startupMaintenanceReady) {
        maintenanceDeferred = true;
        this.deferStartupMaintenance();
        return;
      }
      if (!this.startupReconciled) {
        this.startupReconciled = true;
        if (this.options.startupMaintenance) {
          await this.options.startupMaintenance();
        } else {
          await this.options.database.reconcileAiJobs(10);
          // Revive transient-failure terminal ai.* jobs (auth_unavailable,
          // timeouts, network/HTTP, lease-expired, …) left over from a prior
          // run so a restart recovers them without requiring a model change.
          try {
            await this.options.database.resetTerminalAiJobsForRetry();
          } catch {
            /* best-effort; reconcile already ran */
          }
        }
      }
      let processed = 0;
      while (!this.stopped && !this.retiring && processed < 2) {
        // Re-check admission before EVERY claim, not just once per drain: a job
        // that completed while the machine got busy must not trigger a second
        // claim (or a third, …) before yielding.
        if (this.options.governor && !(await this.awaitBackgroundAdmission())) {
          admissionBlocked = true;
          break;
        }
        if (this.circuitBreaker && !this.circuitBreaker.tryAcquire()) {
          circuitBlocked = true;
          break;
        }
        // Lease must exceed SUMMARY_LLM_TIMEOUT_MS plus getSnapshot +
        // completeJob overhead, so a slow-but-progressing LLM call is not
        // double-dispatched to another worker on lease expiry.
        const claim = this.options.dispatcher
          ? this.options.dispatcher.claim.bind(this.options.dispatcher)
          : this.options.database.claimJob.bind(this.options.database);
        try {
          const claimed = await claim(
            this.owner,
            CANONICAL_AI_JOB_LEASE_MS,
            {
              kinds: this.aiJobKinds(),
              priorities: [0, 1, 2, 3, 4],
              // Priority is followed by message received_at DESC in the writer,
              // so the newest message in each AI tier wins even when a metadata
              // page inserted jobs newest-first.
              order: "lifo",
            },
          );
          if (!claimed) {
            this.drainFailureCount = 0;
            this.circuitBreaker?.releaseProbe();
            return;
          }
          this.drainFailureCount = 0;
          await this.process(claimed);
          processed += 1;
        } finally {
          // A half-open probe must also be released when claiming fails or
          // processing exits without a network success/failure (for example,
          // invalid model output or missing source content).
          this.circuitBreaker?.releaseProbe();
        }
        if (this.retiring) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      this.drainFailureCount += 1;
      this.options.log("canonical-ai-worker-error", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.draining = false;
      // Retire/stop: settle the retire promise and do NOT reschedule. Checked
      // before admission/circuit so an abort-while-waiting still resolves.
      if (this.retiring || this.stopped) {
        this.resolveRetire();
        return;
      }
      if (!admissionBlocked && !maintenanceDeferred) {
        if (circuitBlocked) this.scheduleCircuitProbe();
        else if (this.drainFailureCount > 0) this.scheduleDrainBackoff();
        else await this.scheduleNextDue();
      }
    }
  }

  /**
   * Wait until the resource governor admits background AI work. Returns true
   * when admitted (or no governor is configured); false when the worker was
   * stopped (abort) while waiting — callers must treat false as "do no work
   * and do not reschedule".
   */
  private async awaitBackgroundAdmission(): Promise<boolean> {
    if (!this.options.governor) return true;
    const startedAt = Date.now();
    const admitted = await this.options.governor.waitForAdmission(
      "background",
      this.abortController.signal,
    );
    const waitedMs = Date.now() - startedAt;
    if (waitedMs > 100) {
      this.options.log("canonical-ai-admission-wait", { waitedMs });
    }
    return admitted;
  }

  private deferStartupMaintenance(): void {
    if (
      this.stopped ||
      this.startupMaintenanceReady ||
      this.startupMaintenanceTimer
    ) return;
    this.options.log("canonical-ai-startup-maintenance-deferred", {
      delayMs: STARTUP_MAINTENANCE_DELAY_MS,
    });
    this.startupMaintenanceTimer = setTimeout(() => {
      this.startupMaintenanceTimer = null;
      this.startupMaintenanceReady = true;
      this.wake();
    }, STARTUP_MAINTENANCE_DELAY_MS);
    this.startupMaintenanceTimer.unref();
  }

  private async scheduleNextDue(): Promise<void> {
    if (this.stopped || this.scheduled || this.draining) return;
    if (this.options.dispatcher) return this.options.dispatcher.schedule();
    try {
      const dueAt = await this.options.database.nextJobDue(this.aiJobKinds());
      if (dueAt === null || this.stopped) return;
      // One shared nearest-due timer paces background AI work. Content-change
      // wakeups still admit newly committed interactive jobs immediately.
      const delayMs = Math.min(
        2_147_483_647,
        Math.max(250, dueAt - Date.now()),
      );
      this.dueTimer = setTimeout(() => {
        this.dueTimer = null;
        this.wake();
      }, delayMs);
      this.dueTimer.unref();
    } catch (error) {
      this.options.log("canonical-ai-next-due-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ponytail: fixed-cap exponential backoff; a smarter scheme (jitter,
  // per-kind delays) only if this still saturates the writer in practice.
  private scheduleDrainBackoff(): void {
    if (this.stopped || this.scheduled || this.draining) return;
    const delayMs = Math.min(
      60_000,
      5_000 * 2 ** Math.min(this.drainFailureCount - 1, 4),
    );
    if (this.options.dispatcher) {
      void this.options.dispatcher.schedule(delayMs);
      return;
    }
    this.dueTimer = setTimeout(() => {
      this.dueTimer = null;
      this.wake();
    }, delayMs);
    this.dueTimer.unref();
  }

  private scheduleCircuitProbe(): void {
    if (this.stopped || this.scheduled || this.draining) return;
    const nextProbeAt = this.circuitBreaker?.health().nextProbeAt;
    if (nextProbeAt === null || nextProbeAt === undefined) return;
    const delayMs = Math.min(
      2_147_483_647,
      Math.max(250, nextProbeAt - Date.now()),
    );
    if (this.options.dispatcher) {
      void this.options.dispatcher.schedule(delayMs);
      return;
    }
    this.dueTimer = setTimeout(() => {
      this.dueTimer = null;
      this.wake();
    }, delayMs);
    this.dueTimer.unref();
  }

  private async process(claimed: Awaited<ReturnType<MailDatabaseProducer["claimJob"]>> & {}): Promise<void> {
    const payload = this.parsePayload(claimed.payload);
    if (!payload) {
      await this.options.database.terminalJob(claimed.id, this.owner, "invalid-ai-job-payload");
      return;
    }
    const snapshot = await this.options.database.getSnapshot(payload.emailId);
    if (!snapshot.message || snapshot.bodyState !== "ready") {
      await this.options.database.deferJob(
        claimed.id,
        this.owner,
        "ai-source-content-pending",
        5 * 60_000,
      );
      return;
    }
    const llm = this.options.getLlmSnapshot();
    const client = llm.client;
    const model = llm.modelFor(
      claimed.kind === "ai.summary" ? "summary" : "default",
    );
    if (!client || !model) {
      await this.options.database.deferJob(
        claimed.id,
        this.owner,
        "llm-not-configured",
        5 * 60_000,
      );
      return;
    }
    const now = new Date().toISOString();
    const job: IntelligenceJob = {
      id: String(claimed.id),
      emailId: payload.emailId,
      type: "summary",
      status: "running",
      payload: {
        contentSha256: payload.contentSha256,
        contentVersion: payload.contentVersion,
        // Retry pass: shrink the context (smaller body, no HTML) so a
        // repeated call does not re-bill the full content — retries are
        // usually for malformed output, not missing context.
        ...(claimed.attempts > 1 ? { strategy: "degraded" as const } : {}),
      },
      attempts: claimed.attempts,
      maxAttempts: claimed.maxAttempts,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };
    try {
      const context = {
        getMessage: (emailId: string) => emailId === payload.emailId ? snapshot.message : null,
      };
      let result: Awaited<ReturnType<SummaryProcessor["handle"]>> | unknown;
      let artifactKind: "summary" | "tags" | "replyDecision" | "todoExtraction";
      let processorVersion: string;
      let promptVersion: string;
      if (claimed.kind === "ai.tags") {
        const state = await this.options.database.getIntelligenceState(
          payload.emailId,
        );
        const processor = new TagProcessor({
          llmClient: client,
          model,
          feedbackRules: {} as never,
          feedbackMode: "bypass",
          provider: llm.provider,
          usage: this.options.usage,
          getUserTags: this.options.getUserTags,
          getStoredSummary: () =>
            state.summary?.result?.type === "summary"
              ? (state.summary.result as SummaryResult)
              : undefined,
          logger: (event, fields) => this.options.log(event, fields),
        });
        result = await processor.handle({ ...job, type: "tags" }, context);
        artifactKind = "tags";
        processorVersion = String(TAG_PROCESSOR_VERSION);
        promptVersion = "tags-v3";
      } else if (claimed.kind === "ai.reply-decision") {
        const state = await this.options.database.getIntelligenceState(payload.emailId);
        const processor = new ReplyDecisionProcessor({
          llmClient: client,
          model,
          resultRepo: {
            findByEmailId: () => ({
              summary: state.summary.result,
              tags: state.tags.result,
            }),
          } as never,
          jobRepo: { enqueueJob: () => undefined } as never,
          accountId: payload.accountId,
          provider: llm.provider,
          usage: this.options.usage,
          logger: (event, fields) => this.options.log(event, fields),
        });
        result = await processor.handle({ ...job, type: "replyDecision" }, context);
        artifactKind = "replyDecision";
        processorVersion = String(REPLY_DECISION_PROCESSOR_VERSION);
        promptVersion = "reply-decision-v2";
      } else if (claimed.kind === "ai.todo") {
        const todos = this.options.todos;
        if (!todos && !this.options.persistTodos) {
          await this.options.database.deferJob(
            claimed.id,
            this.owner,
            "todo-repository-unavailable",
            5 * 60_000,
          );
          return;
        }
        const processor = new TodoExtractionProcessor({
          llmClient: client,
          model,
          todos,
          persistTodos: this.options.persistTodos,
          provider: llm.provider,
          usage: this.options.usage,
          getTodoPrompt: this.options.getTodoPrompt,
          logger: (event, fields) => this.options.log(event, fields),
        });
        result = await processor.handle(
          { ...job, type: "todoExtraction" },
          context,
        );
        artifactKind = "todoExtraction";
        processorVersion = String(TODO_EXTRACTION_PROCESSOR_VERSION);
        promptVersion = "todo-extraction-v5";
      } else {
        const processor = new SummaryProcessor({
          llmClient: client,
          model,
          provider: llm.provider,
          usage: this.options.usage,
          logger: (event, fields) => this.options.log(event, fields),
        });
        result = await processor.handle(job, context);
        artifactKind = "summary";
        processorVersion = String(SUMMARY_PROCESSOR_VERSION);
        promptVersion = "summary-v6";
      }
      this.circuitBreaker?.recordSuccess();
      this.options.onLlmSuccess?.();
      const bullets = result !== null && typeof result === "object" &&
        "bullets" in result && Array.isArray(result.bullets)
        ? result.bullets.join("\n")
        : undefined;
      const completionInput: MailDatabaseCompleteAiArtifactParams = {
        jobId: claimed.id,
        owner: this.owner,
        accountId: payload.accountId,
        emailId: payload.emailId,
        artifactKind,
        sourceContentSha256: payload.contentSha256,
        sourceVersion: payload.contentVersion,
        processorVersion,
        promptVersion,
        modelId: model,
        // The DB RPC rejects aliased object graphs to keep payload validation
        // deterministic. Normalize the processor result into plain JSON so
        // repeated references cannot make an otherwise valid artifact vanish.
        result: JSON.parse(JSON.stringify(result)) as unknown,
        ...(bullets ? { textValue: bullets } : {}),
        completedAt: new Date().toISOString(),
      };
      // Real-time (user-visible) completions write through directly; bulk
      // (historical/backfill) completions are coalesced through the shared
      // buffer to cut single-writer contention. Publish hooks only after the
      // writer confirms a current artifact; stale results cannot trigger actions.
      if (this.completionBuffer && claimed.priority > AI_REALTIME_PRIORITY_MAX) {
        if (!(await this.completionBuffer.enqueue(completionInput))) return;
      } else {
        const completed = await this.options.database.completeAiArtifact(completionInput);
        if (!completed.value.current) return;
      }
      if (artifactKind === "tags") {
        this.options.onTagsCompleted?.({
          accountId: payload.accountId,
          emailId: payload.emailId,
          result: result as TagResult,
        });
      }
      if (artifactKind === "summary") {
        try {
          await this.options.onSummaryCompleted?.({
            accountId: payload.accountId,
            emailId: payload.emailId,
            summary: result as SummaryResult | SummaryThreadResult,
          });
        } catch (error) {
          this.options.log("canonical-summary-automation-failed", {
            emailId: payload.emailId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.options.log("canonical-ai-completed", {
        emailId: payload.emailId,
        jobId: claimed.id,
        kind: claimed.kind,
      });
    } catch (error) {
      const retryable = !(error && typeof error === "object" && "retryable" in error) ||
        (error as { retryable?: unknown }).retryable !== false;
      const code = safeAiJobErrorCode(error);
      const processorCode = safeAiProcessorCode(error);
      if (error instanceof LlmClientError) {
        this.circuitBreaker?.recordFailure(error);
        this.options.onLlmFailure?.({ error, kind: claimed.kind });
      }
      const retryDelayMs = retryable ? aiRetryDelayMs(claimed.attempts, error) : 0;
      this.options.log("canonical-ai-failed", {
        emailId: payload.emailId,
        jobId: claimed.id,
        kind: claimed.kind,
        retryable,
        code,
        ...(processorCode ? { processorCode } : {}),
        ...(error instanceof LlmClientError && error.status !== undefined && error.status > 0
          ? { status: error.status }
          : {}),
        retryDelayMs,
      });
      if (!retryable) {
        await this.options.database.terminalJob(claimed.id, this.owner, code);
      } else {
        await this.options.database.failJob(
          claimed.id,
          this.owner,
          code,
          retryDelayMs,
        );
      }
    }
  }

  private parsePayload(value: unknown): SummaryJobPayload | null {
    if (!value || typeof value !== "object") return null;
    const input = value as Partial<SummaryJobPayload>;
    return typeof input.accountId === "string" &&
      typeof input.emailId === "string" &&
      typeof input.contentSha256 === "string" &&
      typeof input.contentVersion === "number"
      && (input.smartTagBackfillRunId === undefined || typeof input.smartTagBackfillRunId === "string")
      && (input.strategy === undefined || input.strategy === "degraded")
      ? input as SummaryJobPayload
      : null;
  }
}
