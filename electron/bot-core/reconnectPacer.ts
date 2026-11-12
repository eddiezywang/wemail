/**
 * Spaces reconnect attempts apart and coalesces bursts into one reconnect.
 *
 * WeCom's server sees a rapid reconnect (while the old connection's slot is
 * still releasing) as a second connection and kicks the new one — the seed of
 * a kick→reconnect→kick feedback loop. Forcing a minimum gap between reconnect
 * initiations gives the server time to release the old slot. Bursts (a kick
 * arriving while a reconnect is already pending) coalesce into the single
 * pending reconnect.
 *
 * Extracted as a pure class so the scheduling logic is unit-testable without
 * instantiating the WeCom SDK.
 */
export interface ReconnectPacerOptions {
  /** Minimum spacing between reconnect initiations, in milliseconds. */
  gapMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable scheduler for tests. */
  schedule?: (fn: () => void, ms: number) => ReconnectHandle;
  /** Injectable cancel for tests. */
  cancel?: (handle: ReconnectHandle) => void;
}

export interface ReconnectHandle {
  unref?: () => void;
}

export class ReconnectPacer {
  private lastRunAt = 0;
  private pending?: ReconnectHandle;

  constructor(private readonly options: ReconnectPacerOptions) {}

  /**
   * Request a reconnect. Runs immediately if the gap has elapsed; otherwise
   * schedules it for the remainder. Additional requests while one is pending
   * are coalesced (dropped) — the pending reconnect covers them.
   */
  schedule(run: () => void): void {
    if (this.pending) return;
    const now = this.options.now ?? Date.now;
    const schedule = this.options.schedule ?? defaultSchedule;
    const remaining = this.options.gapMs - (now() - this.lastRunAt);
    if (remaining <= 0) {
      this.lastRunAt = now();
      run();
      return;
    }
    const fire = () => {
      this.pending = undefined;
      this.lastRunAt = (this.options.now ?? Date.now)();
      run();
    };
    this.pending = schedule(fire, remaining);
  }

  /** Cancel a pending reconnect (e.g. on explicit disconnect). */
  cancel(): void {
    if (!this.pending) return;
    const cancel = this.options.cancel ?? defaultCancel;
    cancel(this.pending);
    this.pending = undefined;
  }
}

function defaultSchedule(fn: () => void, ms: number): ReconnectHandle {
  const handle = setTimeout(fn, ms) as unknown as ReconnectHandle & {
    unref?: () => void;
  };
  handle.unref?.();
  return handle;
}

function defaultCancel(handle: ReconnectHandle): void {
  clearTimeout(handle as unknown as NodeJS.Timeout);
}
