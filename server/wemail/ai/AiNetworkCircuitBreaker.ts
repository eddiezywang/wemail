export type AiCircuitState = "closed" | "open" | "half-open";

export interface AiNetworkCircuitBreakerOptions {
  failureThreshold?: number;
  openDurationMs?: number;
  maxOpenDurationMs?: number;
  now?: () => number;
}

export class AiNetworkCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  private readonly maxOpenDurationMs: number;
  private readonly now: () => number;
  private state: AiCircuitState = "closed";
  private consecutiveFailures = 0;
  private nextProbeAt: number | null = null;
  private probeInFlight = false;

  constructor(options: AiNetworkCircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.openDurationMs = Math.max(1_000, options.openDurationMs ?? 60_000);
    this.maxOpenDurationMs = Math.max(
      this.openDurationMs,
      options.maxOpenDurationMs ?? 15 * 60_000,
    );
    this.now = options.now ?? Date.now;
  }

  tryAcquire(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (this.nextProbeAt !== null && this.now() < this.nextProbeAt) return false;
      this.state = "half-open";
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.nextProbeAt = null;
    this.probeInFlight = false;
  }

  recordFailure(error: unknown): void {
    this.probeInFlight = false;
    if (!isAiNetworkFailure(error)) {
      this.state = "closed";
      this.consecutiveFailures = 0;
      this.nextProbeAt = null;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.state === "half-open" || this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      const exponent = Math.max(0, this.consecutiveFailures - this.failureThreshold);
      const exponentialDuration = Math.min(
        this.maxOpenDurationMs,
        this.openDurationMs * 2 ** exponent,
      );
      const candidate = error as { retryAfterMs?: unknown } | null;
      const retryAfterMs = typeof candidate?.retryAfterMs === "number" &&
        Number.isFinite(candidate.retryAfterMs)
        ? Math.max(0, candidate.retryAfterMs)
        : 0;
      const duration = Math.min(
        this.maxOpenDurationMs,
        Math.max(exponentialDuration, retryAfterMs),
      );
      this.nextProbeAt = this.now() + duration;
    }
  }

  /** Release a half-open probe when the queue had no job to test. */
  releaseProbe(): void {
    if (this.state === "half-open") this.probeInFlight = false;
  }

  /** Reset the circuit after the user changes endpoint, key, or model. */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.nextProbeAt = null;
    this.probeInFlight = false;
  }

  health() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      nextProbeAt: this.nextProbeAt,
    };
  }
}

export function isAiNetworkFailure(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    cause?: unknown;
  } | null;
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  if (
    candidate?.code === "NETWORK" ||
    candidate?.code === "TIMEOUT" ||
    candidate?.code === "ECONNRESET" ||
    candidate?.code === "ECONNREFUSED" ||
    (status !== undefined && status >= 400 && status <= 599)
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(network-error|fetch failed|socket|eof|econnreset|econnrefused|connection (?:closed|reset|failed))\b/i.test(message)) {
    return true;
  }
  return candidate?.cause ? isAiNetworkFailure(candidate.cause) : false;
}
