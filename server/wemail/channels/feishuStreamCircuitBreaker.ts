/**
 * Per-profile circuit breaker for Feishu streaming.
 *
 * Feishu streaming needs the `cardkit:card:write` permission; without it every
 * reply's `startCard` fails once before falling back to a one-shot send. To
 * avoid that per-request failure noise (and a bot-core/API round-trip) when the
 * permission is missing or the platform is rejecting card creates, we trip a
 * per-profile breaker after a couple of consecutive `startCard` failures: while
 * tripped, the worker skips streaming for that profile and goes straight to the
 * one-shot path. A successful `startCard` (e.g. after the permission is added)
 * resets the breaker immediately.
 */
const FEISHU_STREAM_FAILURE_THRESHOLD = 2;
const FEISHU_STREAM_COOLDOWN_MS = 10 * 60_000;

export class FeishuStreamCircuitBreaker {
  private readonly failures = new Map<string, number>();
  private readonly trippedUntil = new Map<string, number>();

  constructor(
    private readonly threshold: number = FEISHU_STREAM_FAILURE_THRESHOLD,
    private readonly cooldownMs: number = FEISHU_STREAM_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether streaming may be attempted for this profile right now. */
  allow(profileId: string): boolean {
    const until = this.trippedUntil.get(profileId);
    if (!until) return true;
    if (this.now() < until) return false;
    // cooldown elapsed — allow a fresh attempt (failure will re-trip if still bad)
    this.trippedUntil.delete(profileId);
    this.failures.delete(profileId);
    return true;
  }

  /** A `startCard` succeeded — reset the breaker for this profile. */
  recordSuccess(profileId: string): void {
    this.failures.delete(profileId);
    this.trippedUntil.delete(profileId);
  }

  /** A `startCard` failed — trip once the threshold is reached. */
  recordFailure(profileId: string): void {
    const count = (this.failures.get(profileId) ?? 0) + 1;
    this.failures.set(profileId, count);
    if (count >= this.threshold) {
      this.trippedUntil.set(profileId, this.now() + this.cooldownMs);
    }
  }
}
