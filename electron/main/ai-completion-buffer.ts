import type { MailDatabaseCompleteAiArtifactParams } from "../../shared/wemail/mailDatabaseProtocol.js";

export interface AiCompletionBufferOptions {
  /**
   * Flush a non-empty snapshot of pending items to the writer (typically
   * `producer.completeAiArtifactBatch`). Must resolve on success or reject on
   * failure; return one current/committed flag per item.
   */
  flush: (items: MailDatabaseCompleteAiArtifactParams[]) => Promise<readonly boolean[]>;
  /** Flush as soon as this many items accumulate (default 16). */
  maxItems?: number;
  /** Max wall time an item waits before a timed flush (default 500ms). */
  flushIntervalMs?: number;
  log?: (phase: string, extra?: Record<string, unknown>) => void;
}

const DEFAULT_MAX_ITEMS = 16;
const DEFAULT_FLUSH_INTERVAL_MS = 500;

/**
 * Coalesces AI artifact completions from every CanonicalAiWorker into periodic
 * batched flushes — one `completeAiArtifactBatch` transaction per flush — so a
 * bulk backfill no longer hammers the single SQLite writer thread one row at a
 * time. Real-time (user-visible) completions bypass the buffer and write
 * through directly in the worker; only bulk-priority completions are enqueued.
 *
 * Safety: completions are lease-guarded and idempotent at the writer
 * (`applyAiArtifactCompletion` rolls back a stale-lease item cleanly), so an
 * app crash with items still buffered simply leaves those jobs `leased`. They
 * are reclaimed and reprocessed after their 70s lease expires, and any replay
 * is a no-op rollback. The 500ms flush interval is far below that lease, so
 * buffered items almost always commit before any re-claim can occur.
 *
 * Flushes are serialized: a slow flush never starts a second concurrent one.
 */
export class AiCompletionBuffer {
  private readonly queue: Array<{ item: MailDatabaseCompleteAiArtifactParams; resolve: (committed: boolean) => void }> = [];
  private readonly maxItems: number;
  private readonly flushIntervalMs: number;
  private readonly flush: AiCompletionBufferOptions["flush"];
  private readonly log: (phase: string, extra?: Record<string, unknown>) => void;
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private activeFlush: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: AiCompletionBufferOptions) {
    this.flush = options.flush;
    this.maxItems = Math.max(1, Math.floor(options.maxItems ?? DEFAULT_MAX_ITEMS));
    this.flushIntervalMs = Math.max(50, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.log = options.log ?? (() => {});
  }

  /** Number of items waiting for the next flush (for diagnostics/tests). */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Enqueue a bulk completion. Flushes immediately when the size threshold is
   * reached; otherwise a timer guarantees a flush within `flushIntervalMs`.
   */
  enqueue(item: MailDatabaseCompleteAiArtifactParams): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const committed = new Promise<boolean>((resolve) => this.queue.push({ item, resolve }));
    this.armTimer();
    if (this.queue.length >= this.maxItems) {
      void this.flushNow();
    }
    return committed;
  }

  /** Join an active flush, or start the next pending batch. */
  flushNow(): Promise<void> {
    if (this.flushing) return this.activeFlush;
    if (this.queue.length === 0) return Promise.resolve();
    this.flushing = true;
    this.activeFlush = this.flushBatch();
    return this.activeFlush;
  }

  private async flushBatch(): Promise<void> {
    try {
      const items = this.queue.splice(0);
      try {
        const committed = await this.flush(items.map((entry) => entry.item));
        items.forEach((entry, index) => entry.resolve(committed[index] === true));
      } catch (error) {
        items.forEach((entry) => entry.resolve(false));
        // Drop-and-let-lease-expire: items have left the buffer, so their jobs
        // stay `leased` and are reclaimed/reprocessed after the 70s lease. Do
        // NOT re-enqueue — a poison item would block the buffer forever.
        this.log("ai-completion-buffer-flush-failed", {
          count: items.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.flushing = false;
      // Drain a backlog without waiting for the next timer tick. Safe to tail
      // — each flushNow is its own async call (no stack growth), and an empty
      // queue stops the chain.
      if (!this.disposed && this.queue.length > 0) {
        void this.flushNow();
      }
    }
  }

  /** Graceful shutdown: stop the timer and flush whatever remains. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flushNow();
    if (this.queue.length > 0) await this.flushNow();
  }

  private armTimer(): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, this.flushIntervalMs);
    // Don't keep the event loop alive solely for a pending flush; graceful
    // shutdown disposes (and flushes) explicitly.
    this.timer.unref();
  }
}
