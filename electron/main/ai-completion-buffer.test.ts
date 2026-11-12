import assert from "node:assert/strict";
import { test } from "node:test";
import type { MailDatabaseCompleteAiArtifactParams } from "../../shared/wemail/mailDatabaseProtocol.js";
import { AiCompletionBuffer } from "./ai-completion-buffer.js";

function item(jobId: number): MailDatabaseCompleteAiArtifactParams {
  return {
    jobId,
    owner: `owner-${jobId}`,
    accountId: "account-1",
    emailId: `message-${jobId}`,
    artifactKind: "summary",
    sourceContentSha256: "sha",
    sourceVersion: 1,
    processorVersion: "v1",
    modelId: "m",
    result: { bullets: [] },
    completedAt: "2026-01-01T00:00:00.000Z",
  };
}

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("commit acknowledgements and dispose wait for the writer and pending batch", async () => {
  let finish!: () => void;
  let calls = 0;
  const buffer = new AiCompletionBuffer({
    maxItems: 1,
    flush: async (items) => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => { finish = resolve; });
      return items.map(() => calls === 1);
    },
  });
  let acknowledged = false;
  const first = buffer.enqueue(item(1)).then((result) => { acknowledged = true; return result; });
  const stale = buffer.enqueue(item(2));
  let disposed = false;
  const closing = buffer.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  assert.equal(disposed, false);
  finish();
  await closing;
  assert.equal(await first, true);
  assert.equal(await stale, false);
  assert.equal(await buffer.enqueue(item(3)), false);
  assert.equal(calls, 2);
});

test("buffer flushes when the size threshold is reached", async () => {
  const flushed: number[][] = [];
  const buffer = new AiCompletionBuffer({
    flush: async (items) => {
      flushed.push(items.map((i) => i.jobId));
      return items.map(() => true);
    },
    maxItems: 3,
    flushIntervalMs: 10_000,
  });
  buffer.enqueue(item(1));
  buffer.enqueue(item(2));
  await tick(5);
  assert.equal(flushed.length, 0, "no flush before the threshold");
  buffer.enqueue(item(3));
  await tick(5);
  assert.deepEqual(flushed, [[1, 2, 3]], "threshold triggers an immediate flush");
  await buffer.dispose();
});

test("buffer flushes on the timer when under the size threshold", async () => {
  const flushed: number[][] = [];
  const buffer = new AiCompletionBuffer({
    flush: async (items) => {
      flushed.push(items.map((i) => i.jobId));
      return items.map(() => true);
    },
    maxItems: 100,
    flushIntervalMs: 50,
  });
  buffer.enqueue(item(1));
  buffer.enqueue(item(2));
  await tick(120);
  assert.deepEqual(flushed, [[1, 2]], "timer flushes pending items");
  await buffer.dispose();
});

test("buffer dispose flushes remaining items and stops the timer", async () => {
  const flushed: number[][] = [];
  const buffer = new AiCompletionBuffer({
    flush: async (items) => {
      flushed.push(items.map((i) => i.jobId));
      return items.map(() => true);
    },
    maxItems: 100,
    flushIntervalMs: 10_000,
  });
  buffer.enqueue(item(1));
  buffer.enqueue(item(2));
  await buffer.dispose();
  assert.deepEqual(flushed, [[1, 2]]);
  assert.equal(buffer.pending, 0);
  // Enqueue after dispose is a no-op.
  buffer.enqueue(item(3));
  assert.equal(buffer.pending, 0);
});

test("buffer never runs two flushes concurrently (tail-drains the backlog)", async () => {
  let active = 0;
  let maxOverlap = 0;
  const trace: string[] = [];
  const buffer = new AiCompletionBuffer({
    flush: async (items) => {
      active += 1;
      maxOverlap = Math.max(maxOverlap, active);
      trace.push(`start:${items[0]!.jobId}`);
      await tick(20);
      trace.push(`end:${items[0]!.jobId}`);
      active -= 1;
      return items.map(() => true);
    },
    maxItems: 2,
    flushIntervalMs: 10_000,
  });
  buffer.enqueue(item(1));
  buffer.enqueue(item(2));
  buffer.enqueue(item(3));
  buffer.enqueue(item(4));
  await tick(120);
  assert.equal(maxOverlap, 1, "flushes must not overlap");
  assert.equal(trace.length, 4, "two sequential flushes (start/end each)");
  await buffer.dispose();
});

test("buffer drops items and keeps working when a flush fails", async () => {
  const phases: string[] = [];
  let calls = 0;
  const buffer = new AiCompletionBuffer({
    flush: async (items) => {
      calls += 1;
      if (calls === 1) throw new Error("transient-writer-failure");
      // succeed on subsequent calls
      return items.map(() => true);
    },
    maxItems: 2,
    flushIntervalMs: 10_000,
    log: (phase) => {
      phases.push(phase);
    },
  });
  buffer.enqueue(item(1));
  buffer.enqueue(item(2)); // flush -> throws
  await tick(10);
  assert.ok(phases.includes("ai-completion-buffer-flush-failed"), "failure is logged");
  assert.equal(buffer.pending, 0, "failed items are dropped, not re-enqueued");
  buffer.enqueue(item(3));
  buffer.enqueue(item(4)); // flush -> succeeds
  await tick(10);
  assert.equal(calls, 2, "buffer recovers and flushes again");
  await buffer.dispose();
});
