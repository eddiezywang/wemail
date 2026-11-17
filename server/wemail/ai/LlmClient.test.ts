import assert from "node:assert/strict";
import { test } from "node:test";
import { LlmClientError, readBoundedLlmResponse } from "./LlmClient.js";

test("model response buffering preserves status, headers and body", async () => {
  const response = await readBoundedLlmResponse(new Response('{"error":"busy"}', {
    status: 429, headers: { "retry-after": "3", "content-type": "application/json" },
  }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "3");
  assert.deepEqual(await response.json(), { error: "busy" });
});

test("model response buffering rejects oversized bodies and cancels the stream", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(5)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(() => readBoundedLlmResponse(response, 4),
    (error: unknown) => error instanceof LlmClientError && error.code === "RESPONSE_TOO_LARGE" && !error.retryable);
  assert.equal(cancelled, true);
});
