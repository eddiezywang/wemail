import assert from "node:assert/strict";
import test from "node:test";
import { aiRetryDelayMs, AI_RETRY_LIMITS } from "./AiRetryPolicy.js";

test("AI retry delay grows exponentially and is capped", () => {
  assert.equal(aiRetryDelayMs(1), AI_RETRY_LIMITS.baseDelayMs);
  assert.equal(aiRetryDelayMs(2), AI_RETRY_LIMITS.baseDelayMs * 2);
  assert.equal(aiRetryDelayMs(3), AI_RETRY_LIMITS.baseDelayMs * 4);
  assert.equal(aiRetryDelayMs(99), AI_RETRY_LIMITS.maxDelayMs);
});

test("AI retry delay respects an upstream Retry-After value within the cap", () => {
  assert.equal(
    aiRetryDelayMs(1, { retryAfterMs: 30_000 }),
    30_000,
  );
  assert.equal(
    aiRetryDelayMs(1, { retryAfterMs: 30 * 60_000 }),
    AI_RETRY_LIMITS.maxDelayMs,
  );
});
