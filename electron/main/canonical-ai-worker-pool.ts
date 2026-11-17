import {
  AI_WORKER_CONCURRENCY_MAX,
  AI_WORKER_CONCURRENCY_MIN,
} from "../../shared/wemail/settings.js";
import type { CanonicalAiWorker } from "./canonical-ai-worker.js";
import type { AiCompletionBuffer } from "./ai-completion-buffer.js";

export interface CanonicalAiWorkerPoolOptions {
  /**
   * Creates one fresh worker. Called for each member of the initial set on
   * construction and for every grow. The factory closes over the long-lived
   * singletons (DB producer, circuit breaker, governor, composition deps) held
   * by app.ts, so a runtime-spawned worker receives the same instances as the
   * boot-time ones.
   */
  factory: () => CanonicalAiWorker;
  /** Initial number of workers. Clamped to [MIN, MAX]. */
  initialSize: number;
  /**
   * Optional shared AI completion buffer (Phase B). When present, `stop()`
   * drains it (flushing any buffered completions) so a graceful shutdown
   * persists already-computed results instead of leaving them to lease-expiry
   * replay. `forceTerminate()` (crash/watchdog path) skips the drain.
   */
  completionBuffer?: AiCompletionBuffer;
}

/**
 * Owns the lifecycle of the CanonicalAiWorker set that drains AI intelligence
 * jobs (summary / tags / reply-decision / todo). Replaces the bare
 * module-level array plus ad-hoc wake/stop loops that previously lived in
 * `electron/main/app.ts`.
 *
 * Concurrency model: `resize()` mutates `active` SYNCHRONOUSLY (push on grow,
 * splice on shrink) and `wake()` is synchronous, so on Node's single event
 * loop the two can never observe a half-mutated set — no locks, epochs, or
 * async queues are needed. Shrink retires surplus workers in the background
 * (fire-and-forget `worker.retire()`): each finishes its in-flight job, then
 * stops consuming. The `active` count is accurate immediately and grow is
 * never blocked behind a slow retire.
 */
export class CanonicalAiWorkerPool {
  private active: CanonicalAiWorker[] = [];
  private readonly retiring = new Set<CanonicalAiWorker>();
  private stopped = false;

  constructor(private readonly options: CanonicalAiWorkerPoolOptions) {
    const initial = clampConcurrency(options.initialSize);
    for (let i = 0; i < initial; i++) {
      this.active.push(options.factory());
    }
  }

  /** Number of workers actively consuming (excludes those draining to a stop). */
  get size(): number {
    return this.active.length;
  }

  /** Wake every active worker. Retiring workers are intentionally skipped. */
  wake(): void {
    if (this.stopped) return;
    // Shallow copy: a synchronous splice between snapshot and iteration
    // (impossible on one tick, but defensive) cannot truncate the loop.
    for (const worker of [...this.active]) worker.wake();
  }

  /**
   * Resize to `target` active workers, clamped to [MIN, MAX]. Grow spawns
   * synchronously and wakes the new workers at once. Shrink removes the
   * surplus from `active` synchronously (so `size` is immediately accurate)
   * and retires them in the background — preferring idle workers so in-flight
   * in-flight leases are not interrupted. Idempotent: a no-op when already at the
   * target. A no-op once stopped.
   */
  resize(target: number): void {
    if (this.stopped) return;
    const clamped = clampConcurrency(target);
    const current = this.active.length;
    if (clamped === current) return;

    if (clamped > current) {
      for (let i = current; i < clamped; i++) {
        const worker = this.options.factory();
        this.active.push(worker);
        worker.wake();
      }
      return;
    }

    const surplus = this.pickWorkersToRetire(current - clamped);
    for (const worker of surplus) {
      const index = this.active.indexOf(worker);
      if (index >= 0) this.active.splice(index, 1);
      this.retiring.add(worker);
    }
    for (const worker of surplus) {
      worker
        .retire()
        .catch(() => undefined)
        .finally(() => {
          this.retiring.delete(worker);
        });
    }
  }

  /**
   * Pick `count` workers to retire: idle workers first (so no in-flight job is
   * interrupted), then the most-recently-spawned busy workers (least state).
   * Returns at most `count`; never throws if fewer are available.
   */
  private pickWorkersToRetire(count: number): CanonicalAiWorker[] {
    const idle = this.active.filter((worker) => !worker.isBusy());
    const busy = this.active.filter((worker) => worker.isBusy());
    idle.reverse();
    busy.reverse();
    return [...idle, ...busy].slice(0, count);
  }

  /**
   * Graceful shutdown for app quit: hard-stop every active and retiring worker,
   * then drain the shared completion buffer so already-computed (but buffered)
   * artifacts are persisted rather than left to lease-expiry replay. Awaiting
   * the returned promise guarantees the flush attempt has completed.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const worker of this.active) worker.stop();
    for (const worker of this.retiring) worker.stop();
    this.active = [];
    this.retiring.clear();
    await this.options.completionBuffer?.dispose();
  }

  /**
   * Watchdog / crash path: hard-abort every worker WITHOUT draining the buffer.
   * Buffered completions are dropped here; their jobs stay leased and are
   * reclaimed/reprocessed after the lease expires on the next start.
   */
  forceTerminate(): void {
    this.stopped = true;
    for (const worker of this.active) worker.stop();
    for (const worker of this.retiring) worker.stop();
    this.active = [];
    this.retiring.clear();
  }
}

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return AI_WORKER_CONCURRENCY_MIN;
  return Math.max(
    AI_WORKER_CONCURRENCY_MIN,
    Math.min(AI_WORKER_CONCURRENCY_MAX, Math.trunc(value)),
  );
}
