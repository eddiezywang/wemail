const AI_RETRY_BASE_DELAY_MS = 5_000;
const AI_RETRY_MAX_DELAY_MS = 15 * 60_000;

export function aiRetryDelayMs(attempt: number, error?: unknown): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const exponent = Math.min(30, normalizedAttempt - 1);
  const exponential = Math.min(
    AI_RETRY_MAX_DELAY_MS,
    AI_RETRY_BASE_DELAY_MS * 2 ** exponent,
  );
  const candidate = error as { retryAfterMs?: unknown } | null;
  const retryAfterMs = typeof candidate?.retryAfterMs === "number" &&
    Number.isFinite(candidate.retryAfterMs)
    ? Math.max(0, candidate.retryAfterMs)
    : 0;
  return Math.min(AI_RETRY_MAX_DELAY_MS, Math.max(exponential, retryAfterMs));
}

export const AI_RETRY_LIMITS = Object.freeze({
  baseDelayMs: AI_RETRY_BASE_DELAY_MS,
  maxDelayMs: AI_RETRY_MAX_DELAY_MS,
});
