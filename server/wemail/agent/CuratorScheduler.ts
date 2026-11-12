/**
 * Mail Curator scheduler (Route C / WP J.6).
 *
 * Three triggers:
 *   - tickTime(): per-account 24h cooldown — invoked from a process
 *     interval; if `now - lastRunAt(accountId) >= 24h`, schedule a run
 *     with `reason: "time"`.
 *   - notifyEvent(accountId, type): per-account counters reach a
 *     threshold (`mail-arrived` ≥ 50, `feedback-event` ≥ 20). Counters
 *     reset on each run.
 *   - triggerManual(accountId): immediate, bypasses cooldown.
 *
 * Concurrency: at most one run per account at a time. Subsequent
 * triggers while a run is in flight are coalesced — the scheduler
 * remembers that another run was requested and re-evaluates after the
 * current one settles.
 */

import type {
  CuratorAgentRuntime,
  CuratorRunReason,
  CuratorRunSummary,
} from "./CuratorAgentRuntime.js";
import type {
  CuratorCounters,
  CuratorCursorStore,
  CuratorEventCounter,
} from "./CuratorCursorStore.js";

export const TIME_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const MAIL_ARRIVED_THRESHOLD = 50;
export const FEEDBACK_EVENT_THRESHOLD = 20;

export interface CuratorScheduleResult {
  accountId: string;
  reason: CuratorRunReason;
  summary: CuratorRunSummary;
}

export interface CuratorSchedulerOptions {
  runtimeFor: (accountId: string) => CuratorAgentRuntime | undefined;
  accountIds: () => string[];
  persistedCursors: CuratorCursorStore;
  clock?: () => Date;
  /**
   * Optional async barrier called immediately before invoking a run.
   * Allows the test harness to assert that a coalesced trigger queues a
   * second run after the first one settles.
   */
  onBeforeRun?: (accountId: string, reason: CuratorRunReason) => void | Promise<void>;
  onError?: (accountId: string, err: Error) => void;
}

interface InFlight {
  promise: Promise<CuratorScheduleResult | null>;
  pending: { reason: CuratorRunReason } | undefined;
}

export class CuratorScheduler {
  private readonly runtimeFor: (accountId: string) => CuratorAgentRuntime | undefined;
  private readonly accountIds: () => string[];
  private readonly cursors: CuratorCursorStore;
  private readonly clock: () => Date;
  private readonly onBeforeRun: ((accountId: string, reason: CuratorRunReason) => void | Promise<void>) | undefined;
  private readonly onError: ((accountId: string, err: Error) => void) | undefined;
  private readonly inFlight = new Map<string, InFlight>();

  constructor(options: CuratorSchedulerOptions) {
    this.runtimeFor = options.runtimeFor;
    this.accountIds = options.accountIds;
    this.cursors = options.persistedCursors;
    this.clock = options.clock ?? (() => new Date());
    this.onBeforeRun = options.onBeforeRun;
    this.onError = options.onError;
  }

  /**
   * Walk all known accounts; trigger a run for any whose lastRunAt is
   * older than the cooldown. Returns the list of pending run promises.
   */
  async tickTime(): Promise<Array<Promise<CuratorScheduleResult | null>>> {
    const out: Array<Promise<CuratorScheduleResult | null>> = [];
    const ids = this.accountIds();
    for (const accountId of ids) {
      const last = await this.cursors.getLastRunAt(accountId);
      const now = this.clock();
      const gap = last ? now.getTime() - last.getTime() : Infinity;
      if (gap >= TIME_COOLDOWN_MS) {
        out.push(this.scheduleRun(accountId, "time"));
      }
    }
    return out;
  }

  /**
   * Bump a per-account counter; if it crosses the threshold, schedule a
   * run with `reason: "count"`. Counters are reset by the run itself.
   */
  async notifyEvent(
    accountId: string,
    type: CuratorEventCounter,
  ): Promise<Promise<CuratorScheduleResult | null> | null> {
    const counters = await this.cursors.getCounters(accountId);
    const next: CuratorCounters = {
      ...counters,
      [type]: (counters[type] ?? 0) + 1,
    };
    await this.cursors.setCounters(accountId, next);
    const threshold =
      type === "mail-arrived"
        ? MAIL_ARRIVED_THRESHOLD
        : FEEDBACK_EVENT_THRESHOLD;
    if (next[type] >= threshold) {
      return this.scheduleRun(accountId, "count");
    }
    return null;
  }

  /** Force a run regardless of cooldown / counters. */
  triggerManual(accountId: string): Promise<CuratorScheduleResult | null> {
    return this.scheduleRun(accountId, "manual");
  }

  /**
   * Internal: dispatch a run, coalescing concurrent triggers per
   * account.
   */
  private scheduleRun(
    accountId: string,
    reason: CuratorRunReason,
  ): Promise<CuratorScheduleResult | null> {
    const existing = this.inFlight.get(accountId);
    if (existing) {
      // Promote the queued reason according to a priority order:
      // manual > count > time. (Manual must never be downgraded.)
      const current = existing.pending?.reason ?? reason;
      existing.pending = { reason: priorityReason(current, reason) };
      return existing.promise;
    }
    const promise = this.executeRun(accountId, reason);
    this.inFlight.set(accountId, { promise, pending: undefined });
    return promise;
  }

  private async executeRun(
    accountId: string,
    reason: CuratorRunReason,
  ): Promise<CuratorScheduleResult | null> {
    let result: CuratorScheduleResult | null = null;
    let caught: unknown;
    try {
      if (this.onBeforeRun) await this.onBeforeRun(accountId, reason);
      const runtime = this.runtimeFor(accountId);
      if (!runtime) {
        // Account has no runtime (logout race). Treat as no-op.
        return null;
      }
      const summary = await runtime.run({ reason });
      result = { accountId, reason, summary };
      await this.cursors.setLastRunAt(accountId, this.clock());
      await this.cursors.setCounters(accountId, {
        "mail-arrived": 0,
        "feedback-event": 0,
      });
    } catch (err) {
      caught = err;
      this.onError?.(accountId, err as Error);
    } finally {
      const slot = this.inFlight.get(accountId);
      this.inFlight.delete(accountId);
      // Coalesced triggers: if anything came in while we were running,
      // dispatch one follow-up run with the highest-priority reason.
      if (slot?.pending) {
        const pending = slot.pending;
        // Run on the next tick to keep the call site's promise chain
        // simple — the caller's awaited promise already settled.
        queueMicrotask(() => {
          void this.scheduleRun(accountId, pending.reason);
        });
      }
    }
    if (caught !== undefined) {
      // Background ticks (time/count) keep the legacy "log + continue"
      // behaviour so a flaky LLM doesn't crash the periodic loop. Manual
      // triggers come from a synchronous caller (POST /curator/run, the
      // run_curator chat tool) that needs to surface failures, so we
      // re-throw and let the caller turn it into 500/error.
      if (reason === "manual") throw caught;
    }
    return result;
  }
}

const REASON_RANK: Record<CuratorRunReason, number> = {
  time: 0,
  count: 1,
  manual: 2,
};

function priorityReason(
  a: CuratorRunReason,
  b: CuratorRunReason,
): CuratorRunReason {
  return REASON_RANK[a] >= REASON_RANK[b] ? a : b;
}
