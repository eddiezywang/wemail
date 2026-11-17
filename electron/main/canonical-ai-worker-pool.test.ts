import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalAiWorker } from "./canonical-ai-worker.js";
import { CanonicalAiWorkerPool } from "./canonical-ai-worker-pool.js";

/**
 * Minimal stand-in for CanonicalAiWorker exposing only the surface the pool
 * touches: wake/stop/retire/isBusy. retire() returns a controllable promise so
 * tests can observe the "finish in-flight job, then resolve" semantics.
 */
class MockWorker {
  wakeCalls = 0;
  stopCalls = 0;
  retireCalls = 0;
  busy = false;
  private retireResolver: (() => void) | null = null;

  wake(): void {
    this.wakeCalls += 1;
  }
  stop(): void {
    this.stopCalls += 1;
  }
  isBusy(): boolean {
    return this.busy;
  }
  retire(): Promise<void> {
    this.retireCalls += 1;
    return new Promise<void>((resolve) => {
      this.retireResolver = resolve;
    });
  }
  /** Test hook: complete the background retire so its promise resolves. */
  finishRetire(): void {
    const resolve = this.retireResolver;
    this.retireResolver = null;
    resolve?.();
  }
  asWorker(): CanonicalAiWorker {
    return this as unknown as CanonicalAiWorker;
  }
}

function makePool(initial: number, workers: MockWorker[]): CanonicalAiWorkerPool {
  return new CanonicalAiWorkerPool({
    initialSize: initial,
    factory: () => {
      const worker = new MockWorker();
      workers.push(worker);
      return worker.asWorker();
    },
  });
}

test("pool constructs the initial set without waking", () => {
  const workers: MockWorker[] = [];
  const pool = makePool(3, workers);
  assert.equal(pool.size, 3);
  assert.equal(workers.every((w) => w.wakeCalls === 0), true, "constructor must not wake workers");
  pool.stop();
});

test("pool resize up spawns and wakes the new workers", () => {
  const workers: MockWorker[] = [];
  const pool = makePool(2, workers);
  pool.resize(5);
  assert.equal(pool.size, 5);
  // The 3 grown workers are woken; the 2 initial ones are not.
  const woken = workers.filter((w) => w.wakeCalls === 1).length;
  assert.equal(woken, 3, "exactly the grown workers are woken once");
  pool.stop();
});

test("pool resize down (idle) retires the surplus synchronously", async () => {
  const workers: MockWorker[] = [];
  const pool = makePool(4, workers);
  pool.resize(2);
  assert.equal(pool.size, 2, "active count drops immediately");
  const retired = workers.filter((w) => w.retireCalls === 1);
  assert.equal(retired.length, 2, "two workers were asked to retire");
  for (const w of retired) w.finishRetire();
  await new Promise((resolve) => setTimeout(resolve, 5));
  pool.stop();
});

test("pool resize down prefers idle workers over busy ones", () => {
  const workers: MockWorker[] = [];
  const pool = makePool(4, workers);
  // Mark the first two as busy; the idle ones (last two) must be retired first.
  workers[0]!.busy = true;
  workers[1]!.busy = true;
  pool.resize(2);
  assert.equal(pool.size, 2);
  assert.equal(workers[0]!.retireCalls, 0, "busy worker is kept");
  assert.equal(workers[1]!.retireCalls, 0, "busy worker is kept");
  assert.equal(workers[2]!.retireCalls, 1, "idle worker retired");
  assert.equal(workers[3]!.retireCalls, 1, "idle worker retired");
  workers[2]!.finishRetire();
  workers[3]!.finishRetire();
  pool.stop();
});

test("pool resize down with busy workers keeps active accurate while retire is pending", async () => {
  const workers: MockWorker[] = [];
  const pool = makePool(4, workers);
  for (const w of workers) w.busy = true;
  pool.resize(2);
  assert.equal(pool.size, 2, "active count is accurate even while retire promises pending");
  const retiring = workers.filter((w) => w.retireCalls === 1);
  assert.equal(retiring.length, 2);
  // While pending, a further grow is not blocked.
  pool.resize(4);
  assert.equal(pool.size, 4);
  for (const w of retiring) w.finishRetire();
  await new Promise((resolve) => setTimeout(resolve, 5));
  pool.stop();
});

test("pool resize clamps to [1, 16] and truncates", () => {
  const workers: MockWorker[] = [];
  const pool = makePool(2, workers);
  pool.resize(0);
  assert.equal(pool.size, 1);
  pool.resize(100);
  assert.equal(pool.size, 16);
  pool.resize(3.7);
  assert.equal(pool.size, 3);
  pool.resize(-5);
  assert.equal(pool.size, 1);
  pool.stop();
});

test("pool resize is idempotent at the current size", () => {
  const workers: MockWorker[] = [];
  const pool = makePool(3, workers);
  const wakeBefore = workers.map((w) => w.wakeCalls);
  pool.resize(3);
  assert.equal(pool.size, 3);
  assert.deepEqual(workers.map((w) => w.wakeCalls), wakeBefore, "no worker touched on a no-op resize");
  pool.stop();
});

test("pool wake does not touch retiring workers", async () => {
  const workers: MockWorker[] = [];
  const pool = makePool(3, workers);
  for (const w of workers) w.busy = true;
  pool.resize(1); // retire 2 (busy), promises pending
  const active = workers.filter((w) => w.retireCalls === 0);
  assert.equal(active.length, 1);
  const wakeBeforeActive = active[0]!.wakeCalls;
  pool.wake();
  assert.equal(active[0]!.wakeCalls, wakeBeforeActive + 1, "active worker is woken");
  for (const w of workers.filter((w) => w.retireCalls === 1)) {
    assert.equal(w.wakeCalls, 0, "retiring worker is never woken by the pool");
    w.finishRetire();
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  pool.stop();
});

test("pool stop hard-stops both active and retiring workers", async () => {
  const workers: MockWorker[] = [];
  const pool = makePool(2, workers);
  for (const w of workers) w.busy = true;
  pool.resize(1); // one retiring (pending), one active
  pool.stop();
  assert.equal(workers.every((w) => w.stopCalls === 1), true, "every worker is hard-stopped");
});

test("pool consecutive resize calls do not interleave incorrectly", () => {
  const workers: MockWorker[] = [];
  const pool = makePool(3, workers);
  pool.resize(1);
  pool.resize(8); // synchronous, right after
  assert.equal(pool.size, 8, "final size reflects the last resize");
  pool.stop();
});

test("pool resize is a no-op after stop", () => {
  const workers: MockWorker[] = [];
  const pool = makePool(2, workers);
  pool.stop();
  pool.resize(8);
  assert.equal(pool.size, 0, "stopped pool stays empty");
});
