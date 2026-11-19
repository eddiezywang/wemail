import { randomUUID } from "node:crypto";
import { EDITION_MODULES } from "../bootstrap/editionModules.js";
import { Worker } from "node:worker_threads";
import {
  isMailBodyCached,
  type InlineImageCapture,
  type MailMessage,
} from "../../../shared/wemail/mail.js";
import type { MailSyncCursor } from "../../../shared/wemail/mail.js";
import type {
  AccountWorkerCommand,
  AccountWorkerData,
  AccountWorkerEvent,
} from "./AccountWorkerProtocol.js";
import type {
  ClaimMailJobFilter,
  EnqueueMailJob,
  MailJob,
} from "./MailJobQueueTypes.js";
import {
  parseMailCoreMutation,
  type MailCoreRemoteOperation,
  type MailCoreRemoteRelocation,
} from "./MailCoreMutation.js";
import type {
  MailCoreMetadataPersistResult,
  MailCoreSyncOrigin,
} from "./MailCoreMetadata.js";
import type { WorkerHeartbeatMetrics, WorkerRuntimeMetrics } from "./WorkerRuntimeMetrics.js";
import type { MailboxCredentialEnvelope } from "../../../shared/wemail/mailCoreProtocol.js";
import type { ResourceGovernor } from "../performance/ResourceGovernor.js";
import { MAIL_JOB_MAX_ATTEMPTS, isPermanentBodyError } from "./MailJobRetryPolicy.js";
import type {
  MailDatabaseClaimedSend,
  MailDatabaseCompleteSendParams,
  MailDatabaseWriteResult,
} from "../../../shared/wemail/mailDatabaseProtocol.js";
import { MAIL_JOB_PRIORITY_MAX } from "../../../shared/wemail/mailDatabaseProtocol.js";
import type { MailFolderSyncStates, MailSyncCheckpoint, MailReceiptHealth } from "../../../shared/wemail/mailSync.js";

export type MailCoreAccountRuntimeState =
  | "starting"
  | "ready"
  | "credential-required"
  | "degraded"
  | "stopped";

interface AccountWorkerLike {
  postMessage(value: AccountWorkerCommand): void;
  on(event: "message", listener: (value: AccountWorkerEvent) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

interface PendingAttachmentFetch {
  requestId: string;
  remoteEmailId: string;
  partPath: string;
  source: "inline" | "download";
  viewId?: string;
  attempts: number;
  enqueuedAt: number;
  cancelled: boolean;
  settled: boolean;
  resolve: (result: { bytes: Buffer; mediaType: string }) => void;
  reject: (error: Error) => void;
}

interface ForegroundMailDemand {
  emailId: string;
  viewId: string;
}

export interface MailCoreAccountRuntimeOptions {
  entryPath: string;
  dataDir: string;
  accountId: string;
  credential?: MailboxCredentialEnvelope;
  initialCursor?: MailSyncCursor;
  dbWriter: {
    enqueueJob: (input: EnqueueMailJob) => Promise<MailJob>;
    claimJob: (
      owner: string,
      leaseMs?: number,
      filter?: ClaimMailJobFilter,
    ) => Promise<MailJob | null>;
    completeJob: (id: number, owner: string) => Promise<boolean>;
    failJob: (
      id: number,
      owner: string,
      error: string,
      retryDelayMs?: number,
    ) => Promise<boolean>;
    /** Marks a leased job terminal in one step; used for permanent body errors. */
    terminalJob?: (id: number, owner: string, error: string) => Promise<boolean>;
    deferJob?: (
      id: number,
      owner: string,
      reason: string,
      delayMs: number,
    ) => Promise<boolean>;
    claimOutbox: (
      owner: string,
      leaseMs?: number,
      filter?: ClaimMailJobFilter,
    ) => Promise<MailJob | null>;
    failOutbox: (
      id: number,
      owner: string,
      error: string,
      retryDelayMs?: number,
    ) => Promise<boolean>;
    claimSend: (owner: string, leaseMs?: number) => Promise<MailDatabaseClaimedSend | null>;
    completeSend: (
      input: MailDatabaseCompleteSendParams,
    ) => Promise<MailDatabaseWriteResult<{ outboxId: string; messageId: string }>>;
    failSend: (
      id: number,
      owner: string,
      error: string,
      retryDelayMs?: number,
    ) => Promise<boolean>;
    persistMailBody: (message: MailMessage) => Promise<unknown>;
    recordMailBodyFailure: (
      emailId: string,
      errorCode: string,
      failedAt: string,
    ) => Promise<{ attempts: number; nextRetryAt: string }>;
    persistMailMetadata: (input: {
      accountId: string;
      origin: MailCoreSyncOrigin;
      messages: MailMessage[];
      replaceCursors: boolean;
      initialSyncCompleted?: boolean;
      checkpoint?: MailSyncCheckpoint;
      lease?: { id: number; owner: string };
    }) => Promise<MailCoreMetadataPersistResult>;
    resolveRemoteOperation: (
      input: NonNullable<ReturnType<typeof getRemoteOperationInput>>,
    ) => Promise<MailCoreRemoteOperation>;
    completeRemoteOperation: (
      outboxId: number,
      owner: string,
      emailId: string,
      relocation?: MailCoreRemoteRelocation,
    ) => Promise<unknown>;
    resetMailBodyFailure?: (emailId: string) => Promise<boolean>;
    reconcileBodyHydration?: (
      accountId: string,
      options?: {
        limit?: number;
        nowMs?: number;
        base?: number;
        minuteMs?: number;
        maxPriority?: number;
      },
    ) => Promise<{
      reprioritized: number;
      enqueued: number;
      revived: number;
      skippedPermanent: number;
    }>;
    nextMailDue?: (accountId: string) => Promise<number | null>;
  };
  e2eMode?: boolean;
  heartbeatTimeoutMs?: number;
  log?: (event: string, data?: Record<string, unknown>) => void;
  createWorker?: (entryPath: string, data: AccountWorkerData) => AccountWorkerLike;
  persistMetadata?: (
    origin: MailCoreSyncOrigin,
    messages: MailMessage[],
    replaceCursors: boolean,
    initialSyncCompleted?: boolean,
    checkpoint?: MailSyncCheckpoint,
    lease?: { id: number; owner: string },
  ) => Promise<MailCoreMetadataPersistResult>;
  persistBody?: (
    message: MailMessage,
    job: { id: number; owner: string; traceId?: string },
    /** Transient inline-image bytes (parse capture) for cache pre-seeding. */
    inlineImages?: InlineImageCapture[],
  ) => Promise<{ jobCompleted: boolean }>;
  persistBodyFailure?: (failure: {
    accountId: string;
    emailId: string;
    errorCode: string;
    failedAt: string;
    retryAt?: string;
    retryable: boolean;
    job: { id: number; owner: string };
  }) => Promise<{ attempts: number; nextRetryAt: string; jobCompleted: boolean }>;
  onBodyReady?: (message: MailMessage) => void | Promise<void>;
  onMetadataCommitted?: (
    origin: MailCoreSyncOrigin,
    result: MailCoreMetadataPersistResult,
    messages: MailMessage[],
  ) => void | Promise<void>;
  onBodyFailed?: (failure: {
    accountId: string;
    emailId: string;
    errorCode: string;
    failedAt: string;
    retryAt?: string;
    retryable: boolean;
  }) => void | Promise<void>;
  onCredentialInvalid?: (event: {
    accountId: string;
    code: "MAIL_CREDENTIAL_INVALID";
    stage: "imap.login";
  }) => void;
  /**
   * Shared resource governor from the mail-core process. Background work
   * (metadata sync, background body hydration, periodic reconcile) waits for
   * admission when the machine is under load. The interactive/foreground body
   * lane is NOT gated — clicking an email always wins.
   */
  resourceGovernor?: ResourceGovernor;
  autoSync?: boolean;
  loadSyncCursor?: () => Promise<MailSyncCursor | null>;
  loadSyncStates?: () => Promise<MailFolderSyncStates>;
  metadataCheckIntervalMs?: number;
  metadataProgressTimeoutMs?: number;
}

const BODY_JOB_KIND = "mail.body.ensure";
const METADATA_JOB_KIND = "mail.metadata.sync";
const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const MAX_ATTACHMENT_QUEUE_DEPTH = 16;

/**
 * Background body hydration is ordered by message recency via a continuous
 * priority: newer messages get a smaller number (claimed first). claimJob
 * orders `priority ASC`, so this yields newest-first hydration. Minute
 * granularity (not hour buckets) so same-day messages order correctly;
 * 180 days ≈ 259k, well within MAIL_JOB_PRIORITY_MAX.
 *
 * Values start at BODY_PRIORITY_BASE (10) so foreground (0), incremental live
 * mail (1), and metadata/AI demand (2–4) all preempt bulk hydration. Callers
 * MUST pass the same `nowMs` across one batch so messages don't cross a minute
 * boundary and invert.
 */
const BODY_PRIORITY_BASE = 10;
const BODY_PRIORITY_MINUTE_MS = 60_000;
function bodyHydrationPriority(receivedAtMs: number, nowMs: number): number {
  const ageMs = receivedAtMs > 0 ? Math.max(0, nowMs - receivedAtMs) : Number.MAX_SAFE_INTEGER;
  return Math.min(
    MAIL_JOB_PRIORITY_MAX,
    BODY_PRIORITY_BASE + Math.floor(ageMs / BODY_PRIORITY_MINUTE_MS),
  );
}

export class MailCoreAccountRuntime {
  private worker: AccountWorkerLike | null = null;
  private currentInteractiveJob: MailJob | null = null;
  private currentBackgroundJob: MailJob | null = null;
  private currentOutbox: MailJob | null = null;
  private currentSend: MailDatabaseClaimedSend | null = null;
  private currentAttachment: PendingAttachmentFetch | null = null;
  private readonly attachmentQueue: PendingAttachmentFetch[] = [];
  private foregroundMail: ForegroundMailDemand | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private bodyReconcileTimer: NodeJS.Timeout | null = null;
  private metadataCheckTimer: NodeJS.Timeout | null = null;
  private realtimeRequest: Promise<{ status: "queued"; jobId: number }> | null = null;
  private pendingRealtime: { origin: MailCoreSyncOrigin; priority: 0 | 1 | 2 | 3 | 4 } | null = null;
  private activeReceiptVersion: number | null = null;
  private providerRetryAt = 0;
  private readonly receipt: MailReceiptHealth = {
    runtimeId: randomUUID(), generation: 0,
    requestedVersion: 0, completedVersion: 0, failedVersion: 0,
    stage: "idle", activeStartedAt: null, lastProgressAt: null,
    lastSuccessfulCheckAt: null, lastCommittedAt: null,
    nextCheckAt: null, nextRetryAt: null, consecutiveFailures: 0, lastError: null,
  };
  private bodyReconcileInFlight = false;
  private readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private restartAttempt = 0;
  private restartCount = 0;
  private restartBackoffMs = 0;
  private workerMetrics: WorkerHeartbeatMetrics | null = null;
  private lastHeartbeatAt = 0;
  private threadId: number | null = null;
  private stopping = false;
  private drainingInteractive = false;
  private drainingBackground = false;
  private interactiveWakeRequested = false;
  private backgroundWakeRequested = false;
  private backgroundAdmissionPending = false;
  private lastBackgroundWasBody = false;
  private metadataCancellation: MailJob | null = null;
  private credentialRequired = false;
  /**
   * Idle-claim backoff: when a claimInteractive pass finds no send/outbox work
   * (routine wakes from AI/body completions), skip re-querying the send/outbox
   * queues for a short window. New interactive work (foreground body,
   * attachment, outbox/send insert) clears it via wake(true), so user actions
   * are never delayed.
   */
  private interactiveIdleBackoffUntil = 0;
  private static readonly INTERACTIVE_IDLE_BACKOFF_MS = 1_500;
  private lastQueueSweepAt = 0;
  /**
   * Cancels a background admission wait on stop/reload so a runtime being torn
   * down (e.g. account switch, logout, credential re-config) never re-enters
   * the wait loop or claims jobs afterwards.
   */
  private readonly backgroundAbort = new AbortController();
  /** Debug instrumentation: claimedAt per body job id, for duration/queue timings. */
  private readonly bodyClaimedAt = new Map<number, number>();
  private lastBodyClaimEmptyLogAt = 0;
  state: MailCoreAccountRuntimeState = "stopped";

  constructor(private readonly options: MailCoreAccountRuntimeOptions) {}

  async start(): Promise<void> {
    if (this.worker && this.state === "ready") return;
    this.stopping = false;
    this.credentialRequired = false;
    const ready = new Promise<void>((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
    this.spawn();
    await ready;
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // Cancel any in-flight background admission wait so claimBackground /
    // runBodyReconcile blocked on the governor exit promptly and never claim
    // for a runtime that is being torn down.
    this.backgroundAbort.abort();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.bodyReconcileTimer) clearTimeout(this.bodyReconcileTimer);
    if (this.metadataCheckTimer) clearTimeout(this.metadataCheckTimer);
    this.metadataCheckTimer = null;
    this.receipt.nextCheckAt = null;
    this.receipt.nextRetryAt = null;
    this.realtimeRequest = null;
    this.pendingRealtime = null;
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(new Error("account-runtime-stopped"));
    this.restartTimer = null;
    this.heartbeatTimer = null;
    this.retryTimer = null;
    this.bodyReconcileTimer = null;
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      try { worker.postMessage({ type: "account-worker.shutdown" }); } catch {
        // A Worker that has already exited still needs its termination and lease cleanup awaited.
      }
      await worker.terminate().catch(() => 0);
    }
    await this.releaseCurrentJob("account-runtime-stopped");
    this.rejectAttachmentRequests("account-runtime-stopped");
    this.state = "stopped";
    this.threadId = null;
    this.workerMetrics = null;
  }

  async ensureBody(
    emailId: string,
    options: { forceRetry?: boolean; traceId?: string; onDemand?: boolean } = {},
  ): Promise<{ status: "queued" | "failed"; jobId: number }> {
    this.foregroundMail = {
      emailId,
      viewId: options.traceId ?? `body:${emailId}`,
    };
    if (options.forceRetry) {
      await this.options.dbWriter.resetMailBodyFailure?.(emailId);
    }
    const job = await this.options.dbWriter.enqueueJob({
      kind: BODY_JOB_KIND,
      accountId: this.options.accountId,
      payload: {
        emailId,
        aiPriority: 1,
        ...(options.traceId ? { traceId: options.traceId } : {}),
        ...(options.onDemand ? { onDemand: true } : {}),
      },
      priority: 0,
      maxAttempts: MAIL_JOB_MAX_ATTEMPTS.bodyEnsure,
      idempotencyKey: `body.ensure:${this.options.accountId}:${emailId}`,
      // Opening a message is explicit foreground demand. A previous terminal
      // body job may belong to an older worker/runtime failure, so reusing it
      // would leave a `missing` body on an endless renderer skeleton.
      terminalPolicy: "revive",
    });
    // A foreground detail request may bypass an account-level background
    // backoff. Periodic queue polling must not.
    this.wake(true);
    return {
      status:
        job.attempts >= job.maxAttempts
          ? "failed"
          : "queued",
      jobId: job.id,
    };
  }

  fetchAttachment(input: {
    requestId: string;
    remoteEmailId: string;
    partPath: string;
    source?: "inline" | "download";
    viewId?: string;
  }): Promise<{ bytes: Buffer; mediaType: string }> {
    if (this.state !== "ready" || !this.worker) {
      return Promise.reject(namedError(
        "ATTACHMENT_SERVICE_UNAVAILABLE",
        "account-runtime-unavailable",
      ));
    }
    if (
      this.attachmentQueue.length + Number(this.currentAttachment !== null) >=
      MAX_ATTACHMENT_QUEUE_DEPTH
    ) {
      return Promise.reject(namedError(
        "ATTACHMENT_QUEUE_BUSY",
        "attachment-queue-full",
      ));
    }
    return new Promise((resolve, reject) => {
      this.attachmentQueue.push({
        ...input,
        source: input.source ?? "inline",
        attempts: 0,
        enqueuedAt: Date.now(),
        cancelled: false,
        settled: false,
        resolve,
        reject,
      });
      this.wake(true);
    });
  }

  focusMessage(emailId: string, viewId: string): { status: "focused" } {
    this.foregroundMail = { emailId, viewId };
    this.options.log?.("mail.foreground.focused", {
      accountId: this.options.accountId,
      emailId,
      viewId,
    });
    this.wake(true);
    return { status: "focused" };
  }

  blurMessage(emailId: string, viewId: string): { status: "blurred" } {
    if (
      this.foregroundMail?.emailId === emailId &&
      this.foregroundMail.viewId === viewId
    ) {
      this.foregroundMail = null;
      this.options.log?.("mail.foreground.blurred", {
        accountId: this.options.accountId,
        emailId,
        viewId,
      });
      this.wake(true);
    }
    return { status: "blurred" };
  }

  cancelAttachment(requestId: string): void {
    const queuedIndex = this.attachmentQueue.findIndex(
      (pending) => pending.requestId === requestId,
    );
    if (queuedIndex >= 0) {
      const [pending] = this.attachmentQueue.splice(queuedIndex, 1);
      pending.cancelled = true;
      this.rejectAttachment(pending, "ATTACHMENT_CANCELLED", "attachment request cancelled");
      this.options.log?.("mail.attachment.cancelled", {
        accountId: this.options.accountId,
        requestId,
        phase: "queued",
      });
      this.wake(true);
      return;
    }
    if (this.currentAttachment?.requestId !== requestId) return;
    const pending = this.currentAttachment;
    pending.cancelled = true;
    this.rejectAttachment(pending, "ATTACHMENT_CANCELLED", "attachment request cancelled");
    this.worker?.postMessage({
      type: "account-worker.cancel-attachment",
      requestId,
    });
    this.options.log?.("mail.attachment.cancelled", {
      accountId: this.options.accountId,
      requestId,
      phase: "active",
    });
  }

  async enqueueMetadataSync(
    origin: MailCoreSyncOrigin,
    priority: 0 | 1 | 2 | 3 | 4 = 2,
  ): Promise<{ status: "queued"; jobId: number; receiptVersion?: number; runtimeId?: string }> {
    if (this.stopping || this.credentialRequired) {
      throw this.credentialRequired
        ? namedError("MAIL_CREDENTIAL_INVALID", "mail-credential-required")
        : new Error("account-runtime-stopped");
    }
    const receiptVersion = origin !== "historical" ? ++this.receipt.requestedVersion : undefined;
    this.options.log?.("mail.metadata.requested", {
      accountId: this.options.accountId, origin, receiptVersion,
      generation: this.receipt.generation, shared: Boolean(this.realtimeRequest), at: Date.now(),
    });
    if (origin !== "historical" && this.realtimeRequest) {
      if (!this.pendingRealtime || priority < this.pendingRealtime.priority) {
        this.pendingRealtime = { origin, priority };
      }
      if (origin === "manual") this.wake(true);
      return { ...await this.realtimeRequest, receiptVersion, runtimeId: this.receipt.runtimeId };
    }
    const request = this.queueMetadataSync(origin, priority);
    if (origin !== "historical") this.realtimeRequest = request;
    if (origin !== "historical" && this.activeReceiptVersion === null) this.receipt.stage = "queued";
    try {
      const result = await request;
      return origin === "historical" ? result : { ...result, receiptVersion, runtimeId: this.receipt.runtimeId };
    } catch (error) {
      if (this.realtimeRequest === request) this.realtimeRequest = null;
      throw error;
    }
  }

  private async queueMetadataSync(
    origin: MailCoreSyncOrigin,
    priority: 0 | 1 | 2 | 3 | 4,
  ): Promise<{ status: "queued"; jobId: number }> {
    const job = await this.options.dbWriter.enqueueJob({
      kind: METADATA_JOB_KIND,
      accountId: this.options.accountId,
      payload: { origin },
      priority,
      ...(origin !== "historical" && this.providerRetryAt > Date.now() ? { availableAt: new Date(this.providerRetryAt) } : {}),
      maxAttempts: MAIL_JOB_MAX_ATTEMPTS.metadataSync,
      idempotencyKey: origin === "historical"
        ? `metadata.sync:${this.options.accountId}:historical-coverage:v1`
        : `metadata.sync:${this.options.accountId}:realtime`,
      terminalPolicy: "revive",
    });
    this.wake(origin === "manual");
    return { status: "queued", jobId: job.id };
  }

  health() {
    return {
      state: this.state,
      accountId: this.options.accountId,
      threadId: this.threadId,
      lastHeartbeatAt: this.lastHeartbeatAt || null,
      metrics: this.runtimeMetrics(),
      receipt: { ...this.receipt },
      currentJobId: this.currentInteractiveJob?.id ?? this.currentBackgroundJob?.id ?? null,
      currentInteractiveJobId: this.currentInteractiveJob?.id ?? null,
      currentBackgroundJobId: this.currentBackgroundJob?.id ?? null,
      currentOutboxId: this.currentOutbox?.id ?? null,
      currentSendId: this.currentSend?.publicId ?? null,
      currentAttachmentRequestId: this.currentAttachment?.requestId ?? null,
      attachmentQueueDepth: this.attachmentQueue.length,
      foregroundEmailId: this.foregroundMail?.emailId ?? null,
      foregroundViewId: this.foregroundMail?.viewId ?? null,
    };
  }

  wake(overrideBackoff = false): void {
    if (this.state !== "ready" || !this.worker) return;
    if (overrideBackoff) {
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      // New interactive work was enqueued (foreground body, attachment,
      // outbox/send insert) — resume send/outbox claiming immediately.
      this.interactiveIdleBackoffUntil = 0;
    }
    this.wakeInteractive();
    if (!this.retryTimer) this.wakeBackground();
  }

  private wakeInteractive(): void {
    if (
      this.currentInteractiveJob ||
      this.currentOutbox ||
      this.currentSend ||
      this.currentAttachment
    ) return;
    if (this.drainingInteractive) {
      this.interactiveWakeRequested = true;
      return;
    }
    this.drainingInteractive = true;
    void this.claimInteractive().catch((error) => {
      this.handleClaimFailure("interactive", error);
    }).finally(() => {
      this.drainingInteractive = false;
      if (this.interactiveWakeRequested) {
        this.interactiveWakeRequested = false;
        this.wakeInteractive();
      }
    });
  }

  private async claimInteractive(): Promise<void> {
    if (this.attachmentQueue.length > 0) {
      this.dispatchNextAttachment();
      return;
    }
    const owner = `account:${this.options.accountId}:${randomUUID()}`;
    const foreground = this.foregroundMail;
    let job = foreground
      ? await this.claimWorkerJob(owner, 30_000, {
          accountId: this.options.accountId,
          kinds: [BODY_JOB_KIND],
          subjectPublicId: foreground.emailId,
        })
      : await this.claimWorkerJob(owner, 30_000, {
          accountId: this.options.accountId,
          kinds: [BODY_JOB_KIND],
          priorities: [0],
        });
    if (!job && foreground) {
      this.options.log?.("mail.foreground.waiting", {
        accountId: this.options.accountId,
        emailId: foreground.emailId,
        viewId: foreground.viewId,
      });
    }
    if (job) {
      if (!this.worker || this.state !== "ready") return;
      const emailId = getBodyEmailId(job);
      if (!emailId) {
        await this.options.dbWriter.failJob(job.id, owner, "invalid-body-job", 0);
        queueMicrotask(() => this.wake());
        return;
      }
      const claimedAt = Date.now();
      this.bodyClaimedAt.set(job.id, claimedAt);
      this.options.log?.("mail.body.claimed", {
        accountId: this.options.accountId,
        jobId: job.id,
        lane: "interactive",
        priority: job.priority,
        attempts: job.attempts,
        queuedMs: Math.max(0, claimedAt - Date.parse(job.availableAt)),
      });
      this.currentInteractiveJob = job;
      this.worker.postMessage({
        type: "account-worker.fetch-body",
        jobId: job.id,
        emailId,
        lane: "interactive",
        ...(getBodyTraceId(job) ? { traceId: getBodyTraceId(job)! } : {}),
        ...(getBodyOnDemand(job) ? { onDemand: true } : {}),
      });
      return;
    }

    const sendOwner = `account:${this.options.accountId}:send:${randomUUID()}`;
    if (Date.now() < this.interactiveIdleBackoffUntil) {
      // Idle backoff: nothing to claim on the last pass and no new
      // interactive work (wake(true)) since — skip the send/outbox queue
      // polls instead of spinning on every AI/body completion wake.
      return;
    }
    const send = await this.options.dbWriter.claimSend(sendOwner, 60_000);
    if (send) {
      if (!this.worker || this.state !== "ready") return;
      this.currentSend = send;
      this.worker.postMessage({
        type: "account-worker.send-draft",
        outboxId: send.id,
        draft: send.draft,
        messageIdHeader: send.messageIdHeader,
      });
      return;
    }

    const outboxOwner = `account:${this.options.accountId}:outbox:${randomUUID()}`;
    const outbox = await this.options.dbWriter.claimOutbox(outboxOwner, 30_000, {
      accountId: this.options.accountId,
      kinds: ["mail.remote.mutation"],
    });
    if (outbox) {
      if (!this.worker || this.state !== "ready") return;
      const pending = getRemoteOperationInput(outbox);
      if (!pending) {
        await this.options.dbWriter.failOutbox(outbox.id, outboxOwner, "invalid-remote-operation", 0);
        queueMicrotask(() => this.wake());
        return;
      }
      let operation: MailCoreRemoteOperation;
      try {
        operation = await this.options.dbWriter.resolveRemoteOperation(pending);
      } catch (error) {
        await this.options.dbWriter.failOutbox(
          outbox.id,
          outboxOwner,
          error instanceof Error ? error.message : "remote-locator-unavailable",
          30_000,
        );
        this.scheduleWake(30_000);
        return;
      }
      this.currentOutbox = outbox;
      this.worker.postMessage({
        type: "account-worker.execute-operation",
        outboxId: outbox.id,
        operation,
      });
      return;
    }

    if (!foreground) this.dispatchNextAttachment();
    // Both send and outbox were empty — back off the next idle poll so
    // routine wakes (AI/body completions) don't re-query empty queues.
    this.interactiveIdleBackoffUntil = Date.now() + MailCoreAccountRuntime.INTERACTIVE_IDLE_BACKOFF_MS;
  }

  private dispatchNextAttachment(): void {
    if (!this.worker || this.state !== "ready" || this.currentAttachment) return;
    const focusedEmailId = this.foregroundMail?.emailId;
    let selectedIndex = 0;
    for (let index = 1; index < this.attachmentQueue.length; index += 1) {
      const current = this.attachmentQueue[index];
      const selected = this.attachmentQueue[selectedIndex];
      if (attachmentPriority(current, focusedEmailId) < attachmentPriority(selected, focusedEmailId)) {
        selectedIndex = index;
      }
    }
    const [pending] = this.attachmentQueue.splice(selectedIndex, 1);
    if (!pending) return;
    this.currentAttachment = pending;
    this.options.log?.("mail.foreground.dispatched", {
      accountId: this.options.accountId,
      requestId: pending.requestId,
      emailId: pending.remoteEmailId,
      workKind: "attachment",
      source: pending.source,
      queueWaitMs: Math.max(0, Date.now() - pending.enqueuedAt),
    });
    this.worker.postMessage({
      type: "account-worker.fetch-attachment",
      requestId: pending.requestId,
      remoteEmailId: pending.remoteEmailId,
      partPath: pending.partPath,
      source: pending.source,
      ...(pending.viewId ? { viewId: pending.viewId } : {}),
    });
  }

  private wakeBackground(): void {
    if (this.currentBackgroundJob) return;
    if (this.drainingBackground) {
      this.backgroundWakeRequested = true;
      return;
    }
    this.drainingBackground = true;
    void this.claimBackground().catch((error) => {
      this.handleClaimFailure("background", error);
    }).finally(() => {
      this.drainingBackground = false;
      if (this.backgroundWakeRequested) {
        this.backgroundWakeRequested = false;
        this.wakeBackground();
      }
    });
  }

  private async claimBackground(): Promise<void> {
    if (!this.worker || this.state !== "ready" || this.stopping) return;
    if (EDITION_MODULES.sentArchive) {
      const owner = `account:${this.options.accountId}:sent-archive:${randomUUID()}`;
      const job = await this.claimWorkerJob(owner, 120_000, { accountId: this.options.accountId, kinds: ["mail.sent.archive"] });
      if (job) {
        const payload = job.payload as { draft?: import("../../../shared/wemail/mail.js").WemailDraftInput; messageId?: string };
        if (!payload?.draft || !payload.messageId || !this.worker) {
          await this.options.dbWriter.failJob(job.id, owner, "invalid-sent-archive", 0);
        } else {
          this.currentBackgroundJob = job;
          this.worker.postMessage({ type: "account-worker.archive-sent", jobId: job.id, draft: payload.draft, messageId: payload.messageId });
        }
        return;
      }
    }
    if (this.providerRetryAt > Date.now()) {
      this.scheduleWake(this.providerRetryAt - Date.now());
      return;
    }
    // Core receipt uses bounded sync admission; background pressure must not stop it.
    const metadataOwner = `account:${this.options.accountId}:metadata:${randomUUID()}`;
    const metadata = await this.claimWorkerJob(metadataOwner, 60_000, {
      accountId: this.options.accountId,
      kinds: [METADATA_JOB_KIND],
      priorities: [0, 1, 2, 3],
    });
    if (metadata) {
      if (!this.worker || this.state !== "ready") return;
      const origin = getMetadataOrigin(metadata);
      if (!origin) {
        await this.options.dbWriter.failJob(metadata.id, metadataOwner, "invalid-metadata-job", 0);
        queueMicrotask(() => this.wake());
        return;
      }
      await this.dispatchMetadata(metadata, origin);
      return;
    }

    const governor = this.options.resourceGovernor;
    if (governor && !governor.canRun("background")) {
      // Do not hold the drain while waiting: new metadata demand must still run.
      if (!this.backgroundAdmissionPending) {
        this.backgroundAdmissionPending = true;
        void governor.waitForAdmission("background", this.backgroundAbort.signal).then((admitted) => {
          this.backgroundAdmissionPending = false;
          if (admitted && !this.stopping) this.wake();
        }).catch((error) => {
          this.backgroundAdmissionPending = false;
          this.handleClaimFailure("background", error);
        });
      }
      return;
    }
    if (!this.worker || this.state !== "ready" || this.stopping) return;
    if (this.lastBackgroundWasBody && await this.claimHistoricalMetadata(metadataOwner)) return;
    const backgroundBodyOwner = `account:${this.options.accountId}:body-prefetch:${randomUUID()}`;
    const preferredBody = await this.claimWorkerJob(backgroundBodyOwner, 30_000, {
      accountId: this.options.accountId,
      kinds: [BODY_JOB_KIND],
      priorities: [1, 2],
      order: "lifo",
    });
    if (preferredBody) {
      await this.dispatchBackgroundBody(preferredBody, backgroundBodyOwner);
      return;
    }

    const legacyHistoricalBody = await this.claimWorkerJob(
      backgroundBodyOwner,
      30_000,
      {
        accountId: this.options.accountId,
        kinds: [BODY_JOB_KIND],
        priorities: [3, 4],
        order: "lifo",
      },
    );
    if (legacyHistoricalBody) {
      await this.dispatchBackgroundBody(legacyHistoricalBody, backgroundBodyOwner);
      return;
    }

    const historicalBody = await this.claimWorkerJob(
      backgroundBodyOwner,
      30_000,
      {
        accountId: this.options.accountId,
        kinds: [BODY_JOB_KIND],
        minPriority: BODY_PRIORITY_BASE,
        order: "lifo",
      },
    );
    if (historicalBody) {
      await this.dispatchBackgroundBody(historicalBody, backgroundBodyOwner);
      return;
    }

    if (await this.claimHistoricalMetadata(metadataOwner)) return;

    const now = Date.now();
    if (now - this.lastBodyClaimEmptyLogAt >= 60_000) {
      this.lastBodyClaimEmptyLogAt = now;
      this.options.log?.("mail.body.claim-empty", {
        accountId: this.options.accountId,
        lane: "background",
      });
    }
    const dueAt = await this.options.dbWriter.nextMailDue?.(this.options.accountId) ?? null;
    if (dueAt !== null) this.scheduleWake(Math.max(10, dueAt - Date.now()));
  }

  private async claimWorkerJob(owner: string, leaseMs: number, filter: ClaimMailJobFilter): Promise<MailJob | null> {
    const worker = this.worker;
    if (!worker || this.state !== "ready" || this.stopping) return null;
    const job = await this.options.dbWriter.claimJob(owner, leaseMs, filter);
    if (!job || (worker === this.worker && this.state === "ready" && !this.stopping)) return job;
    // A late claim is absent from stop's snapshot; release it so the next runtime need not wait for expiry.
    if (this.options.dbWriter.deferJob) {
      await this.options.dbWriter.deferJob(job.id, job.leaseOwner ?? owner, "account-worker-replaced", 0);
    } else {
      await this.options.dbWriter.failJob(job.id, job.leaseOwner ?? owner, "account-worker-replaced", 0);
    }
    return null;
  }

  private async claimHistoricalMetadata(owner: string): Promise<boolean> {
    const metadata = await this.claimWorkerJob(owner, 60_000, {
      accountId: this.options.accountId, kinds: [METADATA_JOB_KIND], priorities: [4],
    });
    if (!metadata) return false;
    if (!this.worker || this.state !== "ready" || this.stopping) return true;
    const origin = getMetadataOrigin(metadata);
    if (!origin) {
      await this.options.dbWriter.failJob(metadata.id, owner, "invalid-metadata-job", 0);
      queueMicrotask(() => this.wake());
      return true;
    }
    this.lastBackgroundWasBody = false;
    await this.dispatchMetadata(metadata, origin);
    return true;
  }

  private canAcceptMetadata(worker: AccountWorkerLike | null, job: MailJob | null): boolean {
    return worker !== null && worker === this.worker && job !== null && job === this.currentBackgroundJob &&
      !this.stopping && this.state !== "degraded";
  }

  private async dispatchMetadata(job: MailJob, origin: MailCoreSyncOrigin): Promise<void> {
    const worker = this.worker;
    this.currentBackgroundJob = job;
    if (origin !== "historical") {
      this.activeReceiptVersion ??= this.receipt.requestedVersion;
      this.receipt.stage = "provider";
      this.receipt.activeStartedAt ??= Date.now();
      this.receipt.lastProgressAt = Date.now();
    }
    try {
      const syncStates = await this.options.loadSyncStates?.();
      const cursor = origin !== "historical" && this.options.loadSyncCursor
        ? await this.options.loadSyncCursor()
        : undefined;
      if (!worker || !this.canAcceptMetadata(worker, job)) return;
      const recheckInbox = origin !== "historical" && this.pendingRealtime !== null;
      if (recheckInbox) {
        this.pendingRealtime = null;
        this.activeReceiptVersion = this.receipt.requestedVersion;
      }
      this.options.log?.("mail.metadata.dispatched", {
        accountId: this.options.accountId, jobId: job.id, owner: job.leaseOwner,
        origin, generation: this.receipt.generation,
        at: Date.now(),
        queuedMs: Math.max(0, Date.now() - Date.parse(job.availableAt)),
      });
      worker.postMessage({
        type: "account-worker.sync-metadata",
        jobId: job.id,
        origin,
        ...(cursor === undefined ? {} : { cursor }),
        ...(syncStates === undefined ? {} : { syncStates }),
        ...(recheckInbox ? { recheckInbox: true } : {}),
      });
    } catch (error) {
      if (!this.canAcceptMetadata(worker, job)) return;
      if (this.currentBackgroundJob === job) this.currentBackgroundJob = null;
      if (origin !== "historical") {
        this.recordReceiptFailure(error instanceof Error ? error.message : String(error));
        this.activeReceiptVersion = null;
        this.realtimeRequest = null;
        this.receipt.activeStartedAt = null;
        this.receipt.stage = "recovery";
        if (this.options.autoSync !== false) this.scheduleMetadataCheck(1_000);
      }
      if (job.leaseOwner) {
        await this.options.dbWriter.failJob(job.id, job.leaseOwner, String(error), 1_000);
      }
      throw error;
    }
  }

  private async dispatchBackgroundBody(job: MailJob, owner: string): Promise<void> {
    if (!this.worker || this.state !== "ready") return;
    const emailId = getBodyEmailId(job);
    if (!emailId) {
      await this.options.dbWriter.failJob(job.id, owner, "invalid-body-job", 0);
      queueMicrotask(() => this.wake());
      return;
    }
    const claimedAt = Date.now();
    this.bodyClaimedAt.set(job.id, claimedAt);
    this.options.log?.("mail.body.claimed", {
      accountId: this.options.accountId,
      jobId: job.id,
      lane: "background",
      priority: job.priority,
      attempts: job.attempts,
      queuedMs: Math.max(0, claimedAt - Date.parse(job.availableAt)),
    });
    this.currentBackgroundJob = job;
    this.lastBackgroundWasBody = true;
    this.worker.postMessage({
      type: "account-worker.fetch-body",
      jobId: job.id,
      emailId,
      lane: "background",
      ...(getBodyTraceId(job) ? { traceId: getBodyTraceId(job)! } : {}),
    });
  }

  private spawn(): void {
    if (this.worker || this.stopping) return;
    this.state = "starting";
    if (!this.options.credential && !this.options.createWorker) {
      throw new Error("mailbox-credential-envelope-required");
    }
    const credential = this.options.credential ?? testCredential(this.options.accountId);
    const data: AccountWorkerData = {
      accountId: this.options.accountId,
      dataDir: this.options.dataDir,
      e2eMode: this.options.e2eMode === true,
      credential,
      ...(this.options.initialCursor ? { initialCursor: this.options.initialCursor } : {}),
    };
    const createWorker = this.options.createWorker ?? ((entryPath, workerData) => new Worker(entryPath, {
      workerData,
      name: `wemail-account-${this.options.accountId}`,
      resourceLimits: {
        // This is the worker_thread's own heap limit — the one that OOM'd
        // ("Worker terminated due to reaching memory limit"). 48MB was too
        // tight for full-mailbox sync + MIME work.
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 2,
      },
    }));
    const worker = createWorker(this.options.entryPath, data);
    this.receipt.generation += 1;
    this.worker = worker;
    this.lastHeartbeatAt = Date.now();
    this.startHeartbeatMonitor();
    worker.on("message", (event) => this.onMessage(worker, event));
    worker.on("error", (error) => this.options.log?.("account-worker-error", {
      accountId: this.options.accountId,
      message: error.message,
    }));
    worker.on("exit", (code) => this.onExit(worker, code));
  }

  private onMessage(worker: AccountWorkerLike, event: AccountWorkerEvent): void {
    if (worker !== this.worker || event.accountId !== this.options.accountId) return;
    if (event.type === "account-worker.ready") {
      this.state = "ready";
      this.threadId = event.threadId;
      this.workerMetrics = event.metrics ?? null;
      this.lastHeartbeatAt = Date.now();
      this.restartAttempt = 0;
      this.startHeartbeatMonitor();
      this.scheduleBodyReconcile();
      this.realtimeRequest = null;
      this.pendingRealtime = null;
      this.activeReceiptVersion = null;
      if (this.options.autoSync !== false) this.requestAutomaticSync("bootstrap");
      for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
      this.options.log?.("account-worker-ready", {
        accountId: this.options.accountId,
        threadId: event.threadId,
      });
      return;
    }
    if (event.type === "account-worker.heartbeat") {
      this.lastHeartbeatAt = event.at;
      this.workerMetrics = event.metrics ?? this.workerMetrics;
      return;
    }
    if (event.type === "account-worker.body-result") {
      void this.handleBodyResult(event);
      return;
    }
    if (event.type === "account-worker.attachment-result") {
      this.handleAttachmentResult(event);
      return;
    }
    if (event.type === "account-worker.operation-result") {
      void this.handleOperationResult(event);
      return;
    }
    if (event.type === "account-worker.send-result") {
      void this.handleSendResult(event);
      return;
    }
    if (event.type === "account-worker.archive-sent-result") {
      const job = this.currentBackgroundJob;
      if (job?.id === event.jobId && job.leaseOwner) {
        this.currentBackgroundJob = null;
        void (event.ok
          ? this.options.dbWriter.completeJob(job.id, job.leaseOwner)
          : this.options.dbWriter.failJob(job.id, job.leaseOwner, event.errorCode ?? "sent-archive-failed", 0)
        ).catch(() => {
          this.options.log?.("sent-archive-result-commit-failed", { accountId: this.options.accountId, jobId: job.id });
        }).finally(() => this.wake());
      }
      return;
    }
    if (event.type === "account-worker.sync-request") {
      this.requestAutomaticSync(event.origin);
      return;
    }
    if (event.type === "account-worker.metadata-progress") {
      if (this.state === "ready" && this.currentBackgroundJob?.kind === METADATA_JOB_KIND && this.currentBackgroundJob.id === event.jobId && this.activeReceiptVersion !== null) {
        this.receipt.lastProgressAt = Date.now();
      }
      return;
    }
    if (event.type === "account-worker.metadata-cancelled") {
      void this.finishMetadataCancellation(worker, event.jobId).catch((error) => this.logMetadataEnqueueFailure(error));
      return;
    }
    if (event.type === "account-worker.metadata-result") {
      void this.handleMetadataResult(event, worker).catch((error) => this.logMetadataEnqueueFailure(error));
    }
  }

  private handleAttachmentResult(
    event: Extract<AccountWorkerEvent, { type: "account-worker.attachment-result" }>,
  ): void {
    const pending = this.currentAttachment;
    if (!pending || pending.requestId !== event.requestId) return;
    this.currentAttachment = null;
    if (pending.cancelled || pending.settled) {
      queueMicrotask(() => this.wake());
      return;
    }
    if (event.ok) {
      pending.settled = true;
      this.options.log?.("mail.foreground.completed", {
        accountId: this.options.accountId,
        requestId: pending.requestId,
        emailId: pending.remoteEmailId,
        workKind: "attachment",
        bytes: event.bytes.byteLength,
        attempts: pending.attempts,
      });
      pending.resolve({
        bytes: Buffer.from(event.bytes),
        mediaType: event.mediaType,
      });
    } else if (event.retryable && pending.attempts < 1 && !this.stopping) {
      pending.attempts += 1;
      this.attachmentQueue.unshift(pending);
    } else {
      this.rejectAttachment(pending, event.errorCode, event.errorCode);
    }
    queueMicrotask(() => this.wake());
  }

  private async handleOperationResult(
    event: Extract<AccountWorkerEvent, { type: "account-worker.operation-result" }>,
  ): Promise<void> {
    const outbox = this.currentOutbox;
    if (!outbox || outbox.id !== event.outboxId || !outbox.leaseOwner) return;
    this.currentOutbox = null;
    let retryWakeMs: number | null = null;
    try {
      if (event.ok) {
        const pending = getRemoteOperationInput(outbox);
        if (!pending) throw new Error("invalid-remote-operation");
        await this.options.dbWriter.completeRemoteOperation(
          outbox.id,
          outbox.leaseOwner,
          pending.emailId,
          event.relocation,
        );
        this.options.log?.("account-worker-operation-complete", {
          accountId: this.options.accountId,
          outboxId: outbox.id,
          attempts: outbox.attempts,
        });
      } else {
        const retryDelayMs = event.retryable ? retryDelay(outbox.attempts) : 30 * 60_000;
        await this.options.dbWriter.failOutbox(
          outbox.id,
          outbox.leaseOwner,
          event.errorCode,
          retryDelayMs,
        );
        if (event.retryable) retryWakeMs = retryDelayMs;
        else this.enterCredentialRequired(event.errorCode);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.dbWriter.failOutbox(outbox.id, outbox.leaseOwner, message, 1_000);
      retryWakeMs = 1_000;
      this.options.log?.("account-worker-operation-commit-failed", {
        accountId: this.options.accountId,
        outboxId: outbox.id,
        error: message,
      });
    } finally {
      if (retryWakeMs !== null) this.scheduleWake(retryWakeMs);
      // A delayed retry must not prevent ready operations for other mail
      // from being claimed while this item waits.
      queueMicrotask(() => this.wake());
    }
  }

  private async handleSendResult(
    event: Extract<AccountWorkerEvent, { type: "account-worker.send-result" }>,
  ): Promise<void> {
    const send = this.currentSend;
    if (!send || send.id !== event.outboxId) return;
    this.currentSend = null;
    try {
      if (event.ok) {
        await this.options.dbWriter.completeSend({
          id: send.id,
          owner: send.leaseOwner,
          messageId: event.messageId,
          ...(this.options.credential && EDITION_MODULES.sentArchive?.supports(this.options.credential) ? { archiveSent: true } : {}),
          ...(event.delivery ? { delivery: event.delivery } : {}),
        });
        this.options.log?.("account-worker-send-complete", {
          accountId: this.options.accountId,
          outboxId: send.publicId,
          attempts: send.attempts,
        });
      } else {
        await this.options.dbWriter.failSend(
          send.id,
          send.leaseOwner,
          event.errorCode,
        );
        if (event.credentialRequired) this.enterCredentialRequired(event.errorCode);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // If the writer is unavailable, leave the lease to expire rather than
      // submitting a message with an unknown delivery outcome again.
      const marked = await this.options.dbWriter.failSend(send.id, send.leaseOwner, message).catch(() => false);
      if (!marked) this.scheduleWake(60_000);
      this.options.log?.("account-worker-send-commit-failed", {
        accountId: this.options.accountId,
        outboxId: send.publicId,
        error: message,
      });
    } finally {
      // The failed send is terminal; unrelated queue items need not wait for
      // its former retry delay.
      queueMicrotask(() => this.wake());
    }
  }

  private async finishMetadataCancellation(worker: AccountWorkerLike, jobId: number): Promise<void> {
    const job = this.metadataCancellation;
    if (!job || job.id !== jobId || !job.leaseOwner || worker !== this.worker || this.stopping) return;
    await this.options.dbWriter.failJob(job.id, job.leaseOwner, "metadata-progress-timeout", 1_000);
    if (worker !== this.worker || this.stopping) return;
    this.metadataCancellation = null;
    this.currentBackgroundJob = null;
    this.recordReceiptFailure("metadata-progress-timeout");
    this.activeReceiptVersion = null;
    this.receipt.activeStartedAt = null;
    this.receipt.stage = this.credentialRequired ? "credential-required" : "recovery";
    this.realtimeRequest = null;
    this.pendingRealtime = null;
    this.state = this.credentialRequired ? "credential-required" : "ready";
    if (this.options.autoSync !== false) this.scheduleMetadataCheck(1_000);
    this.scheduleWake(1_000);
  }

  private async handleMetadataResult(
    event: Extract<AccountWorkerEvent, { type: "account-worker.metadata-result" }>,
    worker: AccountWorkerLike,
  ): Promise<void> {
    const job = this.currentBackgroundJob;
    if (!this.canAcceptMetadata(worker, job)) return;
    if (!job || job.kind !== METADATA_JOB_KIND || job.id !== event.jobId || !job.leaseOwner) return;
    const handlingStartedAt = Date.now();
    if (event.origin !== "historical") {
      this.receipt.lastProgressAt = handlingStartedAt;
      this.receipt.stage = event.ok ? "commit" : "recovery";
      if (event.ok) this.receipt.lastSuccessfulCheckAt = handlingStartedAt;
    }
    let retryWakeMs: number | null = null;
    try {
      if (event.ok) {
        // Checkpoint pages are atomic; legacy providers are split at the IPC boundary.
        const METADATA_PERSIST_BATCH_SIZE = 50;
        const messages = event.checkpoint ? event.messages : [...event.messages].sort((left, right) =>
          left.folder.localeCompare(right.folder) || left.sync.uid - right.sync.uid);
        // Checkpoint pages may exceed one batch (scan UIDs + trailing flag
        // refresh window); the cursor is applied on the last batch only, so
        // a partially committed page retries idempotently instead of
        // re-applying (or regressing) the checkpoint. Bound is a sanity
        // check against runaway worker pages, not an exact page size.
        if (event.checkpoint && messages.length > 1_000) {
          throw new Error("metadata-checkpoint-page-too-large");
        }
        const batches: MailMessage[][] = [];
        for (let i = 0; i < messages.length; i += METADATA_PERSIST_BATCH_SIZE) {
          batches.push(messages.slice(i, i + METADATA_PERSIST_BATCH_SIZE));
        }
        if (batches.length === 0) batches.push([]);
        const inserted: MailMessage[] = [];
        let updatedCount = 0;
        let bodiesQueued = true;
        let commitVersion: number | undefined;
        for (let i = 0; i < batches.length; i++) {
          if (!this.canAcceptMetadata(worker, job)) return;
          const isLast = i === batches.length - 1;
          const batchCheckpoint = event.checkpoint && isLast ? event.checkpoint : undefined;
          const batchResult = this.options.persistMetadata
            ? await this.options.persistMetadata(
                event.origin,
                batches[i],
                event.replaceCursors,
                event.origin === "historical" && event.completed && isLast,
                batchCheckpoint,
                { id: job.id, owner: job.leaseOwner },
              )
            : await this.options.dbWriter.persistMailMetadata({
                accountId: this.options.accountId,
                origin: event.origin,
                messages: batches[i],
                replaceCursors: event.replaceCursors,
                initialSyncCompleted:
                  event.origin === "historical" && event.completed && isLast,
                ...(batchCheckpoint ? { checkpoint: batchCheckpoint, lease: { id: job.id, owner: job.leaseOwner } } : {}),
              });
          inserted.push(...batchResult.inserted);
          updatedCount += batchResult.updatedCount;
          bodiesQueued &&= batchResult.bodiesQueued === true;
          commitVersion = batchResult.commitVersion;
          if (!this.canAcceptMetadata(worker, job)) return;
          if (event.origin !== "historical") {
            this.receipt.lastCommittedAt = Date.now();
            this.receipt.lastProgressAt = Date.now();
          }
        }
        const result = { inserted, updatedCount, bodiesQueued, commitVersion };
        await this.options.onMetadataCommitted?.(event.origin, result, event.messages);
        if (!this.canAcceptMetadata(worker, job)) return;
        if (!bodiesQueued) await this.enqueueInsertedMissingBodies(result.inserted, event.origin);
        if (!this.canAcceptMetadata(worker, job)) return;
        if (event.completed) {
          if (!await this.options.dbWriter.completeJob(job.id, job.leaseOwner)) {
            throw new Error("metadata-lease-lost");
          }
          if (!this.canAcceptMetadata(worker, job)) return;
          if (event.origin !== "historical") {
            this.receipt.completedVersion = this.activeReceiptVersion ?? this.receipt.requestedVersion;
            this.receipt.consecutiveFailures = 0;
            this.receipt.lastError = null;
          }
          if (event.origin === "bootstrap" && !this.options.initialCursor) {
            await this.enqueueMetadataSync("historical", 4);
          }
          if (event.origin === "historical") {
            // Reconcile pre-existing missing/failed bodies immediately after
            // the historical metadata window is committed; the periodic timer
            // handles subsequent bounded waves.
            void this.runBodyReconcile();
          }
        } else {
          // One page per lease lets due core checks preempt history without consuming retries.
          if (this.options.dbWriter.deferJob) {
            const deferred = await this.options.dbWriter.deferJob(
              job.id,
              job.leaseOwner,
              "historical-page-yield",
              0,
            );
            if (!deferred) throw new Error("metadata-lease-lost");
          } else {
            await this.options.dbWriter.failJob(
              job.id,
              job.leaseOwner,
              "historical-page-yield",
              0,
            );
          }
        }
        if (!this.canAcceptMetadata(worker, job)) return;
        if (event.checkpoint?.mode === "incremental" && !event.checkpoint.next.repair?.completed) {
          await this.enqueueMetadataSync("historical", 4);
        }
        if (!this.canAcceptMetadata(worker, job)) return;
        worker.postMessage({
          type: "account-worker.metadata-ack",
          jobId: job.id,
          continue: true,
        });
        this.options.log?.("account-worker-metadata-committed", {
          accountId: this.options.accountId,
          origin: event.origin,
          inserted: result.inserted.length,
          updated: result.updatedCount,
          commitAndDeliveryMs: Date.now() - handlingStartedAt,
          commitVersion,
          providerMs: event.providerMs,
          jobId: job.id, owner: job.leaseOwner, generation: this.receipt.generation,
          ...(event.checkpoint?.next.repair ? { repairCoverage: {
            folder: event.checkpoint.folder,
            version: event.checkpoint.next.repair.version,
            since: event.checkpoint.next.repair.since,
            completed: event.checkpoint.next.repair.completed,
          } } : {}),
        });
      } else {
        const backoff = event.origin === "historical" ? retryDelay(job.attempts)
          : Math.round(Math.min(60_000, 1_000 * 2 ** Math.min(this.receipt.consecutiveFailures, 6)) * (0.75 + Math.random() * 0.25));
        const retryDelayMs = event.retryable
          ? Math.max(event.retryAfterMs ?? 0, backoff) : 30 * 60_000;
        if (event.retryAfterMs !== undefined) this.providerRetryAt = Date.now() + event.retryAfterMs;
        await this.options.dbWriter.failJob(
          job.id,
          job.leaseOwner,
          event.errorCode,
          retryDelayMs,
        );
        if (!this.canAcceptMetadata(worker, job)) return;
        if (event.retryable) retryWakeMs = retryDelayMs;
        else this.enterCredentialRequired(event.errorCode);
        if (event.origin !== "historical" && event.errorCode !== "account-worker-busy") {
          // A busy bounce means the job was never attempted — it must not
          // inflate the receipt's consecutive-failure backoff.
          this.recordReceiptFailure(event.errorCode);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.canAcceptMetadata(worker, job)) return;
      worker.postMessage({
        type: "account-worker.metadata-ack",
        jobId: job.id,
        continue: false,
      });
      await this.options.dbWriter.failJob(job.id, job.leaseOwner, message, Math.max(retryDelay(job.attempts), 10_000));
      if (!this.canAcceptMetadata(worker, job)) return;
      retryWakeMs = Math.max(retryDelay(job.attempts), 10_000);
      if (event.origin !== "historical") this.recordReceiptFailure(message);
      this.options.log?.("account-worker-metadata-commit-failed", {
        accountId: this.options.accountId,
        error: message,
      });
    } finally {
      if (!this.canAcceptMetadata(worker, job)) return;
      if (this.currentBackgroundJob === job) this.currentBackgroundJob = null;
      if (event.origin !== "historical" && (!event.ok || event.completed || retryWakeMs !== null)) {
        this.activeReceiptVersion = null;
        this.receipt.activeStartedAt = null;
        this.receipt.stage = this.credentialRequired ? "credential-required" : retryWakeMs === null ? "idle" : "recovery";
        this.realtimeRequest = null;
        const pending = this.pendingRealtime;
        this.pendingRealtime = null;
        if (pending && retryWakeMs === null && !this.credentialRequired) {
          void this.enqueueMetadataSync(pending.origin, pending.priority).catch((error) => {
            this.logMetadataEnqueueFailure(error);
          });
        }
        if (this.options.autoSync !== false) {
          this.scheduleMetadataCheck(retryWakeMs ?? this.options.metadataCheckIntervalMs ?? 60_000);
        }
      }
      if (retryWakeMs === null) queueMicrotask(() => this.wake());
      else this.scheduleWake(retryWakeMs);
    }
  }

  /**
   * Drive one bounded body-hydration reconcile tick for this account: the DB
   * Service reprioritizes legacy backlog, enqueues missing bodies (newest
   * first), and revives non-permanent terminal jobs — all in one transaction.
   * Scheduled by {@link scheduleBodyReconcile}/{@link startBodyReconcileTimer}.
   */
  private scheduleBodyReconcile(delayMs = 5 * 60_000): void {
    if (this.stopping || this.bodyReconcileTimer) return;
    this.bodyReconcileTimer = setTimeout(() => {
      this.bodyReconcileTimer = null;
      void this.runBodyReconcile().finally(() => {
        if (!this.stopping) this.scheduleBodyReconcile();
      });
    }, delayMs);
  }

  private async runBodyReconcile(): Promise<void> {
    if (this.bodyReconcileInFlight) return;
    const reconcile = this.options.dbWriter.reconcileBodyHydration;
    if (!reconcile || this.state !== "ready") return;
    // Periodic reconcile is background scheduling work (single-writer DB scan +
    // enqueues) — yield to the machine under load just like claimBackground.
    if (this.options.resourceGovernor) {
      const admitted = await this.options.resourceGovernor.waitForAdmission(
        "background",
        this.backgroundAbort.signal,
      );
      if (!admitted || this.stopping) return;
    }
    this.bodyReconcileInFlight = true;
    try {
      const result = await reconcile.call(this.options.dbWriter, this.options.accountId, {});
      if (result.reprioritized + result.enqueued + result.revived > 0) {
        this.options.log?.("mail-body-reconcile", {
          accountId: this.options.accountId,
          ...result,
        });
        // Newly enqueued/revived jobs may be claimable now.
        this.wakeBackground();
      }
    } catch (error) {
      this.options.log?.("mail-body-reconcile-failed", {
        accountId: this.options.accountId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.bodyReconcileInFlight = false;
    }
  }

  private async enqueueInsertedMissingBodies(
    messages: MailMessage[],
    origin: MailCoreSyncOrigin,
  ): Promise<void> {
    const missing = messages.filter((message) => !isMailBodyCached(message));
    if (missing.length === 0) return;

    // Bootstrap is the visible recent window, so treat its bodies like live
    // incremental mail. Only the historical scan uses time-weighted bulk
    // priority. One nowMs for the whole batch avoids minute-boundary inversion.
    const isHistorical = origin === "historical";
    const nowMs = Date.now();
    for (const message of missing) {
      const priority = isHistorical
        ? bodyHydrationPriority(Date.parse(message.receivedAt), nowMs)
        : 1;
      await this.options.dbWriter.enqueueJob({
        kind: BODY_JOB_KIND,
        accountId: this.options.accountId,
        payload: {
          emailId: message.id,
          aiPriority: isHistorical ? 4 : 0,
        },
        priority,
        maxAttempts: MAIL_JOB_MAX_ATTEMPTS.bodyEnsure,
        idempotencyKey: `body.ensure:${this.options.accountId}:${message.id}`,
        terminalPolicy: "revive",
      });
    }
    this.options.log?.("mail-body-inserted-prefetch-scheduled", {
      accountId: this.options.accountId,
      origin,
      scheduled: missing.length,
    });
  }

  private async handleBodyResult(
    event: Extract<AccountWorkerEvent, { type: "account-worker.body-result" }>,
  ): Promise<void> {
    const job = this.currentInteractiveJob?.id === event.jobId
      ? this.currentInteractiveJob
      : this.currentBackgroundJob?.id === event.jobId
        ? this.currentBackgroundJob
        : null;
    if (!job || job.id !== event.jobId || !job.leaseOwner) return;
    const lane = job === this.currentInteractiveJob
      ? "interactive"
      : job === this.currentBackgroundJob
        ? "background"
        : "unknown";
    if (job === this.currentInteractiveJob) this.currentInteractiveJob = null;
    if (job === this.currentBackgroundJob) this.currentBackgroundJob = null;
    const claimedAt = this.bodyClaimedAt.get(job.id) ?? Date.now();
    this.bodyClaimedAt.delete(job.id);
    let retryWakeMs: number | null = null;
    try {
      if (event.ok) {
        let jobCompleted = false;
        // Strip transient inline-image bytes once, immutably: they must NOT
        // cross into the DB persist (no byte column) nor reach onBodyReady,
        // but ARE forwarded to the persistBody callback so mail-core can seed
        // the attachment disk cache with the bytes captured at parse.
        const { inlineImages, ...persistable } = event.message;
        if (this.options.persistBody) {
          const persisted = await this.options.persistBody(
            persistable,
            {
              id: job.id,
              owner: job.leaseOwner,
              ...(event.traceId ? { traceId: event.traceId } : {}),
            },
            inlineImages,
          );
          jobCompleted = persisted.jobCompleted;
        } else {
          await this.options.dbWriter.persistMailBody(persistable);
        }
        await this.options.onBodyReady?.(persistable);
        if (!jobCompleted) {
          await this.options.dbWriter.completeJob(job.id, job.leaseOwner);
        }
        this.options.log?.("account-worker-body-ready", {
          accountId: this.options.accountId,
          emailId: event.emailId,
          attempts: job.attempts,
          ...(event.traceId ? { traceId: event.traceId } : {}),
          ...(event.providerMs === undefined ? {} : { providerMs: event.providerMs }),
        });
        this.options.log?.("mail.body.completed", {
          accountId: this.options.accountId,
          jobId: job.id,
          emailId: event.emailId,
          lane,
          durationMs: Date.now() - claimedAt,
          ...(event.providerMs === undefined ? {} : { providerMs: event.providerMs }),
        });
      } else {
        const failedAt = new Date().toISOString();
        const retryDelayMs = event.retryable ? retryDelay(job.attempts) : 0;
        const retryAt = event.retryable
          ? new Date(Date.now() + retryDelayMs).toISOString()
          : undefined;
        let jobCompleted = false;
        let failure: { attempts: number; nextRetryAt: string };
        if (this.options.persistBodyFailure) {
          const persisted = await this.options.persistBodyFailure({
              accountId: this.options.accountId,
              emailId: event.emailId,
              errorCode: event.errorCode,
              failedAt,
              ...(retryAt ? { retryAt } : {}),
              retryable: event.retryable,
              job: { id: job.id, owner: job.leaseOwner },
            });
          failure = persisted;
          jobCompleted = persisted.jobCompleted;
        } else {
          failure = await this.options.dbWriter.recordMailBodyFailure(
              event.emailId,
              event.errorCode,
              failedAt,
            );
        }
        await this.options.onBodyFailed?.({
          accountId: this.options.accountId,
          emailId: event.emailId,
          errorCode: event.errorCode,
          failedAt,
          ...(event.retryable ? { retryAt: failure.nextRetryAt } : {}),
          retryable: event.retryable,
        });
        if (!jobCompleted) {
          if (!event.retryable && isPermanentBodyError(event.errorCode) && this.options.dbWriter.terminalJob) {
            // Permanent failure: re-fetching can never succeed, so don't burn
            // the remaining attempts on live IMAP fetches (the old flow
            // re-claimed and re-fetched until maxAttempts). Periodic revive
            // already skips permanent codes; foreground ensureBody revive
            // resets attempts for explicit user demand.
            await this.options.dbWriter.terminalJob(job.id, job.leaseOwner, event.errorCode);
          } else {
            await this.options.dbWriter.failJob(
              job.id,
              job.leaseOwner,
              event.errorCode,
              retryDelayMs,
            );
          }
        }
        if (event.retryable) retryWakeMs = retryDelayMs;
        else if (event.credentialRequired) this.enterCredentialRequired(event.errorCode);
        this.options.log?.("mail.body.failed", {
          accountId: this.options.accountId,
          jobId: job.id,
          emailId: event.emailId,
          lane,
          durationMs: Date.now() - claimedAt,
          errorCode: event.errorCode,
          retryable: event.retryable,
          ...(event.providerMs === undefined ? {} : { providerMs: event.providerMs }),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.dbWriter.failJob(job.id, job.leaseOwner, message, 1_000);
      retryWakeMs = 1_000;
      this.options.log?.("account-worker-body-commit-failed", {
        accountId: this.options.accountId,
        emailId: event.emailId,
        error: message,
      });
    } finally {
      if (retryWakeMs === null) queueMicrotask(() => this.wake());
      else this.scheduleWake(retryWakeMs);
    }
  }

  private onExit(worker: AccountWorkerLike, code: number): void {
    if (worker !== this.worker) return;
    this.worker = null;
    this.threadId = null;
    this.workerMetrics = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    void this.releaseCurrentJob(`account-worker-exit:${code}`);
    this.rejectAttachmentRequests(`account-worker-exit:${code}`);
    if (this.stopping) {
      this.state = "stopped";
      return;
    }
    if (this.credentialRequired) {
      this.state = "credential-required";
      return;
    }
    this.state = "degraded";
    this.recordReceiptFailure(`account-worker-exit:${code}`);
    this.receipt.stage = "recovery";
    this.options.log?.("account-worker-exit", { accountId: this.options.accountId, code });
    this.scheduleRestart();
  }

  private async releaseCurrentJob(error: string): Promise<void> {
    const jobs = [this.currentInteractiveJob, this.currentBackgroundJob];
    const outbox = this.currentOutbox;
    const send = this.currentSend;
    this.currentInteractiveJob = null;
    this.currentBackgroundJob = null;
    this.currentOutbox = null;
    this.currentSend = null;
    this.metadataCancellation = null;
    for (const job of jobs) {
      if (job?.leaseOwner) {
        await this.options.dbWriter.failJob(job.id, job.leaseOwner, error, 1_000).catch(() => false);
      }
    }
    if (outbox?.leaseOwner) {
      await this.options.dbWriter.failOutbox(
        outbox.id,
        outbox.leaseOwner,
        error,
        1_000,
      ).catch(() => false);
    }
    if (send) {
      await this.options.dbWriter.failSend(
        send.id,
        send.leaseOwner,
        error,
        1_000,
      ).catch(() => false);
    }
  }

  private rejectAttachmentRequests(message: string): void {
    const error = namedError("ATTACHMENT_SERVICE_UNAVAILABLE", message);
    if (this.currentAttachment) {
      this.currentAttachment.cancelled = true;
      this.rejectAttachment(this.currentAttachment, error.name, error.message);
    }
    this.currentAttachment = null;
    for (const pending of this.attachmentQueue.splice(0)) {
      pending.cancelled = true;
      this.rejectAttachment(pending, error.name, error.message);
    }
  }

  private rejectAttachment(
    pending: PendingAttachmentFetch,
    code: string,
    message: string,
  ): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.reject(namedError(code, message));
  }

  private startHeartbeatMonitor(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const timeout = this.options.heartbeatTimeoutMs ?? 8_000;
    const interval = Math.min(2_000, timeout);
    let lastCheckAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const monitorDelay = now - lastCheckAt;
      lastCheckAt = now;
      // Timers resume before queued worker heartbeats after system sleep or a
      // long event-loop pause. Give the worker one interval to report back.
      if (!this.worker || monitorDelay > timeout) return;
      if (this.metadataCancellation && !this.currentSend) {
        void this.worker.terminate();
        return;
      }
      if (this.activeReceiptVersion !== null && this.receipt.lastProgressAt !== null && !this.metadataCancellation &&
        now - this.receipt.lastProgressAt > (this.options.metadataProgressTimeoutMs ?? 60_000)) {
        if (this.currentSend && this.currentBackgroundJob?.kind !== METADATA_JOB_KIND) return;
        this.options.log?.("mail.metadata-progress-timeout", { accountId: this.options.accountId, stage: this.receipt.stage });
        this.state = "degraded";
        this.receipt.stage = "recovery";
        if (this.currentSend && this.currentBackgroundJob?.kind === METADATA_JOB_KIND) {
          this.metadataCancellation = this.currentBackgroundJob;
          this.worker.postMessage({ type: "account-worker.cancel-metadata", jobId: this.currentBackgroundJob.id });
        } else void this.worker.terminate();
        return;
      }
      if (now - this.lastHeartbeatAt <= timeout) {
        // Scheduled sends and leases may become due without an external event.
        // Sweep even when automatic mailbox synchronization is off.
        if (this.state === "ready" && now - this.lastQueueSweepAt >= 15_000) {
          this.lastQueueSweepAt = now;
          this.wake();
        }
        return;
      }
      this.options.log?.("account-worker-heartbeat-timeout", {
        accountId: this.options.accountId,
        lastHeartbeatAt: this.lastHeartbeatAt,
      });
      this.state = "degraded";
      this.receipt.stage = "recovery";
      void this.worker.terminate();
    }, interval);
    this.heartbeatTimer.unref();
  }

  private handleClaimFailure(lane: "interactive" | "background", error: unknown): void {
    this.options.log?.("mail.claim-failed", {
      accountId: this.options.accountId,
      lane,
      error: error instanceof Error ? error.message : String(error),
    });
    this.scheduleWake(1_000);
  }

  private scheduleRestart(): void {
    if (this.stopping || this.credentialRequired || this.restartTimer) return;
    const delay = RESTART_DELAYS_MS[Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)];
    this.restartAttempt += 1;
    this.restartCount += 1;
    this.restartBackoffMs = delay;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartBackoffMs = 0;
      this.spawn();
    }, delay);
    this.restartTimer.unref();
  }

  private scheduleWake(delayMs: number): void {
    if (this.stopping || this.credentialRequired || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.wake();
    }, Math.max(10, delayMs));
    this.retryTimer.unref();
  }

  private requestAutomaticSync(origin: MailCoreSyncOrigin): void {
    if (this.stopping || this.credentialRequired) return;
    if (this.providerRetryAt > Date.now()) {
      this.scheduleMetadataCheck(this.providerRetryAt - Date.now());
      return;
    }
    void this.enqueueMetadataSync(origin, 2).catch((error) => this.logMetadataEnqueueFailure(error));
    this.scheduleMetadataCheck(this.options.metadataCheckIntervalMs ?? 60_000);
  }

  private recordReceiptFailure(error: string): void {
    this.receipt.failedVersion = this.activeReceiptVersion ?? this.receipt.requestedVersion;
    this.receipt.consecutiveFailures += 1;
    this.receipt.lastError = error;
  }

  private logMetadataEnqueueFailure(error: unknown): void {
    this.options.log?.("mail.metadata-enqueue-failed", {
      accountId: this.options.accountId,
      error: error instanceof Error ? error.message : String(error),
    });
    this.scheduleMetadataCheck(5_000);
  }

  private scheduleMetadataCheck(delayMs: number): void {
    if (this.stopping || this.credentialRequired) return;
    if (this.metadataCheckTimer) clearTimeout(this.metadataCheckTimer);
    const delay = Math.max(10, delayMs, this.providerRetryAt - Date.now());
    this.receipt.nextCheckAt = Date.now() + delay;
    this.receipt.nextRetryAt = this.receipt.consecutiveFailures > 0 ? this.receipt.nextCheckAt : null;
    this.metadataCheckTimer = setTimeout(() => {
      this.metadataCheckTimer = null;
      this.receipt.nextCheckAt = null;
      this.requestAutomaticSync("live-poll");
    }, delay);
    this.metadataCheckTimer.unref();
  }

  private enterCredentialRequired(errorCode: string): void {
    if (this.credentialRequired) return;
    this.credentialRequired = true;
    this.state = "credential-required";
    this.receipt.stage = "credential-required";
    this.receipt.lastError = errorCode;
    this.receipt.nextCheckAt = null;
    this.receipt.nextRetryAt = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.metadataCheckTimer) clearTimeout(this.metadataCheckTimer);
    this.metadataCheckTimer = null;
    this.retryTimer = null;
    this.heartbeatTimer = null;
    this.options.log?.("account-worker-credential-required", {
      accountId: this.options.accountId,
      errorCode,
    });
    this.options.onCredentialInvalid?.({
      accountId: this.options.accountId,
      code: "MAIL_CREDENTIAL_INVALID",
      stage: "imap.login",
    });
    void this.worker?.terminate();
  }

  private runtimeMetrics(): WorkerRuntimeMetrics | null {
    if (!this.workerMetrics) return null;
    const current = this.currentInteractiveJob ?? this.currentOutbox ?? this.currentBackgroundJob;
    return {
      ...this.workerMetrics,
      threadId: this.threadId,
      queueDepth: Math.max(
        this.workerMetrics.queueDepth,
        Number(this.currentInteractiveJob !== null) +
          Number(this.currentOutbox !== null) +
          Number(this.currentBackgroundJob !== null) +
          Number(this.currentAttachment !== null) +
          this.attachmentQueue.length,
      ),
      activeJobKind: current?.kind ?? this.workerMetrics.activeJobKind,
      restartCount: this.restartCount,
      restartBackoffMs: this.restartBackoffMs,
      lastHeartbeatAt: this.lastHeartbeatAt || null,
    };
  }
}

function testCredential(accountId: string): MailboxCredentialEnvelope {
  return {
    version: 1,
    generation: 0,
    account: {
      id: accountId,
      emailAddress: "test@example.invalid",
      imap: { host: "invalid", port: 993, secure: true, username: "test" },
      smtp: { host: "invalid", port: 465, secure: true, username: "test" },
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    },
    imapPassword: "test-only",
  };
}

function getBodyEmailId(job: MailJob): string | null {
  if (typeof job.payload !== "object" || !job.payload || !("emailId" in job.payload)) return null;
  const emailId = (job.payload as { emailId?: unknown }).emailId;
  return typeof emailId === "string" && emailId ? emailId : null;
}

function getBodyTraceId(job: MailJob): string | null {
  if (typeof job.payload !== "object" || !job.payload || !("traceId" in job.payload)) return null;
  const traceId = (job.payload as { traceId?: unknown }).traceId;
  return typeof traceId === "string" && traceId ? traceId : null;
}

function getBodyOnDemand(job: MailJob): boolean {
  if (typeof job.payload !== "object" || !job.payload || !("onDemand" in job.payload)) return false;
  return (job.payload as { onDemand?: unknown }).onDemand === true;
}

function getRemoteOperationInput(item: MailJob): {
  accountId: string;
  emailId: string;
  mutation: MailCoreRemoteOperation["mutation"];
  fallbackLocator?: MailCoreRemoteOperation["locator"];
  fallbackMessageId?: string;
} | null {
  if (!item.payload || typeof item.payload !== "object") return null;
  const payload = item.payload as Record<string, unknown>;
  const mutation = parseMailCoreMutation(payload.mutation);
  if (
    typeof payload.accountId !== "string" ||
    payload.accountId !== item.accountId ||
    typeof payload.emailId !== "string" ||
    !payload.emailId ||
    !mutation
  ) {
    return null;
  }
  const fallbackLocator = parseRemoteLocator(
    payload.fallbackLocator ?? payload.remoteLocator,
  );
  const fallbackMessageIdValue = payload.fallbackMessageId ?? payload.remoteMessageId;
  const fallbackMessageId = typeof fallbackMessageIdValue === "string" && fallbackMessageIdValue
    ? fallbackMessageIdValue
    : undefined;
  return {
    accountId: payload.accountId,
    emailId: payload.emailId,
    mutation,
    ...(fallbackLocator ? { fallbackLocator } : {}),
    ...(fallbackMessageId ? { fallbackMessageId } : {}),
  };
}

function parseRemoteLocator(value: unknown): MailCoreRemoteOperation["locator"] | null {
  if (!value || typeof value !== "object") return null;
  const locator = value as Record<string, unknown>;
  if (
    typeof locator.folder !== "string" || !locator.folder ||
    typeof locator.uid !== "number" || !Number.isFinite(locator.uid) ||
    typeof locator.uidValidity !== "number" || !Number.isFinite(locator.uidValidity) ||
    typeof locator.internalDate !== "string" ||
    (locator.state !== "ready" && locator.state !== "unknown")
  ) return null;
  return {
    folder: locator.folder,
    uid: locator.uid,
    uidValidity: locator.uidValidity,
    internalDate: locator.internalDate,
    state: locator.state,
  };
}

function getMetadataOrigin(item: MailJob): MailCoreSyncOrigin | null {
  if (!item.payload || typeof item.payload !== "object" || !("origin" in item.payload)) return null;
  const origin = (item.payload as { origin?: unknown }).origin;
  return origin === "bootstrap" || origin === "historical" || origin === "live-idle" || origin === "live-poll" || origin === "manual"
    ? origin
    : null;
}

function retryDelay(attempts: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempts - 1), 30_000);
}

function attachmentPriority(
  pending: PendingAttachmentFetch,
  focusedEmailId: string | undefined,
): number {
  if (pending.source === "download") return 0;
  if (pending.remoteEmailId === focusedEmailId) return 1;
  return 2;
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
