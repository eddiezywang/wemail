import { Worker } from "node:worker_threads";
import { describeError } from "./describe-error.js";
import type {
  MailDatabaseRequest,
  MailDatabaseWorkerData,
  MailDatabaseWorkerEvent,
  MailDatabaseWorkerRequest,
} from "../../shared/wemail/mailDatabaseProtocol.js";

interface PendingRequest {
  request: MailDatabaseRequest;
  resolve: (value: {
    result: unknown;
    queueMs: number;
    handlerMs: number;
  }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DbServiceWorkerLaneOptions {
  entryPath: string;
  databasePath: string;
  label: MailDatabaseWorkerData["label"];
  mode: MailDatabaseWorkerData["mode"];
  editionFeatures?: MailDatabaseWorkerData["editionFeatures"];
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * Cooldown before a degraded lane is allowed a recovery restart. Aligned with
 * the 60s restart-budget window in `restart()`: by the time this elapses, the
 * window has aged out so the budget resets and the worker respawns.
 */
const COOLDOWN_RECOVERY_MS = 60_000;

export class DbServiceWorkerLane {
  private worker: Worker | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private stopping = false;
  private restartPromise: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastHeartbeatAt = 0;
  private threadId: number | null = null;
  private restartCount = 0;
  private restartWindowStartedAt = Date.now();
  private commitVersion = 0;
  private queueDepth = 0;
  /** When the lane entered "degraded" via budget exhaustion (null when not). */
  private degradedAtMs: number | null = null;
  state: "idle" | "starting" | "ready" | "degraded" = "idle";

  constructor(private readonly options: DbServiceWorkerLaneOptions) {}

  start(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.stopping = false;
    if (this.worker && this.state === "ready") return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.spawn();
    return this.readyPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const worker = this.worker;
    this.worker = null;
    this.rejectPending(new Error(`${this.options.label} stopped`));
    if (worker) await worker.terminate().catch(() => 0);
    this.state = "degraded";
    this.threadId = null;
  }

  call(request: MailDatabaseRequest): Promise<{
    result: unknown;
    queueMs: number;
    handlerMs: number;
  }> {
    if (!this.worker || this.state !== "ready") {
      const recovery = this.restartPromise ?? this.readyPromise;
      if (recovery) {
        return recovery.then(() => this.call(request));
      }
      // Self-heal: a lane that exhausted its restart budget (e.g. a burst of
      // slow detail queries) would otherwise stay "degraded" forever — call()
      // rejects without re-triggering restart(), so the 60s budget window
      // never resets and every subsequent request fails fast as "is degraded".
      // After the cooldown the window has aged out, so a recovery restart
      // respawns the worker. Bump degradedAtMs so a failed attempt waits a
      // full cooldown before retrying (no tight loop).
      if (
        this.state === "degraded" &&
        this.degradedAtMs !== null &&
        Date.now() - this.degradedAtMs >= COOLDOWN_RECOVERY_MS &&
        !this.stopping
      ) {
        this.degradedAtMs = Date.now();
        void this.restart("cooldown-recovery").catch(() => {
          /* budget-exhaustion is logged in restart(); retry on next call */
        });
        if (this.restartPromise) {
          return this.restartPromise.then(() => this.call(request));
        }
      }
      return Promise.reject(new Error(`${this.options.label} is ${this.state}`));
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const remaining = request.deadlineMs - Date.now();
    if (remaining <= 0) return Promise.reject(new Error("request-deadline-expired"));
    const timeoutMs = Math.min(
      remaining,
      this.options.requestTimeoutMs ?? 10_000,
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pendingCount = this.pending.size;
        this.pending.delete(request.requestId);
        reject(new Error(`${this.options.label}-timeout`));
        if (this.options.mode === "writer") {
          // better-sqlite3 executes synchronously in the writer thread, so a
          // timeout cannot cancel the statement. Restarting here tears down a
          // healthy writer while it is still finishing the slow request and
          // rejects every other queued write (the cascade seen as
          // `writer restarted:request-timeout`). Let the statement finish and
          // drain the queue; the caller already received its timeout. Reader
          // lanes remain recyclable because their large reads are cancellable.
          this.options.log?.("db-writer-request-timeout", {
            label: this.options.label,
            method: request.method,
            requestId: request.requestId,
            queueDepth: this.queueDepth,
            pendingCount,
            lastHeartbeatAt: this.lastHeartbeatAt || null,
            heartbeatStaleMs: this.lastHeartbeatAt
              ? Math.max(0, Date.now() - this.lastHeartbeatAt)
              : null,
          });
        } else {
          void this.restart("request-timeout");
        }
      }, timeoutMs);
      timer.unref();
      this.pending.set(request.requestId, { request, resolve, reject, timer });
      this.postRequest(request);
    });
  }

  cancel(requestId: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || this.options.mode === "writer") return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    const error = new Error(`${this.options.label}-request-cancelled`);
    error.name = "AbortError";
    pending.reject(error);
    // better-sqlite3 statements are synchronous inside the reader thread.
    // Recycling the isolated reader prevents a cancelled large-body query
    // from blocking the next interactive detail request.
    void this.restart("request-cancelled", false, true).catch((restartError) => {
      this.options.log?.("db-lane-cancel-restart-failed", {
        label: this.options.label,
        message: restartError instanceof Error ? restartError.message : String(restartError),
      });
    });
    return true;
  }

  health() {
    return {
      label: this.options.label,
      state: this.state,
      threadId: this.threadId,
      lastHeartbeatAt: this.lastHeartbeatAt || null,
      restartCount: this.restartCount,
      commitVersion: this.commitVersion,
      queueDepth: this.queueDepth,
    };
  }

  private spawn(): void {
    this.state = "starting";
    const worker = new Worker(this.options.entryPath, {
      workerData: {
        databasePath: this.options.databasePath,
        label: this.options.label,
        mode: this.options.mode,
        ...(this.options.editionFeatures ? { editionFeatures: this.options.editionFeatures } : {}),
      } satisfies MailDatabaseWorkerData,
      name: `wemail-db-${this.options.label}`,
      resourceLimits: {
        maxOldGenerationSizeMb: this.options.mode === "writer" ? 32 : 16,
        maxYoungGenerationSizeMb: 4,
        stackSizeMb: 2,
      },
    });
    this.worker = worker;
    worker.on("message", (event: MailDatabaseWorkerEvent) => {
      this.handleMessage(worker, event);
    });
    worker.on("error", (error) => {
      this.options.log?.("db-lane-error", {
        label: this.options.label,
        message: describeError(error),
      });
      if (this.state === "starting" && this.readyReject) {
        const reject = this.readyReject;
        this.readyResolve = null;
        this.readyReject = null;
        this.readyPromise = null;
        reject(error);
      }
    });
    worker.on("exit", (code) => {
      if (worker !== this.worker) return;
      const wasStarting = this.state === "starting";
      this.worker = null;
      this.state = "degraded";
      this.threadId = null;
      this.rejectPending(new Error(`${this.options.label} exited:${code}`));
      if (!this.stopping && !wasStarting) {
        void this.restart("worker-exit");
      }
    });
  }

  private handleMessage(worker: Worker, event: MailDatabaseWorkerEvent): void {
    if (worker !== this.worker) return;
    if (event.type === "ready") {
      this.state = "ready";
      this.degradedAtMs = null;
      this.threadId = event.threadId;
      this.lastHeartbeatAt = Date.now();
      this.commitVersion = event.commitVersion ?? this.commitVersion;
      this.queueDepth = event.queueDepth ?? 0;
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      this.readyPromise = null;
      return;
    }
    if (event.type === "heartbeat") {
      this.lastHeartbeatAt = event.at;
      this.commitVersion = event.commitVersion ?? this.commitVersion;
      this.queueDepth = event.queueDepth ?? this.queueDepth;
      return;
    }
    const pending = this.pending.get(event.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(event.requestId);
    if (event.ok) {
      pending.resolve({
        result: event.result,
        queueMs: event.queueMs,
        handlerMs: event.handlerMs,
      });
    } else {
      pending.reject(new Error(event.error));
    }
    if (this.pending.size === 0) this.scheduleIdleReap();
  }

  private restart(
    reason: string,
    countTowardsBudget = true,
    preservePending = false,
  ): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.restartPromise) return this.restartPromise;
    const now = Date.now();
    if (now - this.restartWindowStartedAt > 60_000) {
      this.restartWindowStartedAt = now;
      this.restartCount = 0;
    }
    if (countTowardsBudget && this.restartCount >= 3) {
      this.state = "degraded";
      this.degradedAtMs = Date.now();
      const error = new Error(`${this.options.label}-restart-budget-exhausted`);
      this.options.log?.("db-lane-restart-budget-exhausted", {
        label: this.options.label,
        reason,
        restartCount: this.restartCount,
      });
      return Promise.reject(error);
    }
    this.restartPromise = (async () => {
      const worker = this.worker;
      this.worker = null;
      this.state = "degraded";
      this.threadId = null;
      if (countTowardsBudget) this.restartCount += 1;
      if (!preservePending) {
        this.rejectPending(new Error(`${this.options.label} restarted:${reason}`));
      }
      if (worker) await worker.terminate().catch(() => 0);
      this.options.log?.("db-lane-restart", {
        label: this.options.label,
        reason,
        restartCount: this.restartCount,
      });
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
      this.spawn();
      await this.readyPromise;
      if (preservePending) {
        for (const [requestId, pending] of this.pending) {
          if (pending.request.deadlineMs <= Date.now()) {
            clearTimeout(pending.timer);
            this.pending.delete(requestId);
            pending.reject(new Error("request-deadline-expired"));
            continue;
          }
          this.postRequest(pending.request);
        }
      }
    })().finally(() => {
      this.restartPromise = null;
    });
    return this.restartPromise;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private postRequest(request: MailDatabaseRequest): void {
    this.worker?.postMessage({
      type: "query",
      request,
      queuedAt: Date.now(),
    } satisfies MailDatabaseWorkerRequest);
  }

  private scheduleIdleReap(): void {
    const timeoutMs = this.options.idleTimeoutMs;
    if (!timeoutMs || this.options.mode === "writer" || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size > 0 || !this.worker) return;
      const worker = this.worker;
      this.worker = null;
      this.state = "idle";
      this.threadId = null;
      void worker.terminate().catch(() => 0);
      this.options.log?.("db-lane-idle-reaped", {
        label: this.options.label,
        timeoutMs,
      });
    }, timeoutMs);
    this.idleTimer.unref();
  }
}
