import assert from "node:assert/strict";
import { test } from "node:test";
import { AiJobDispatcher } from "./ai-job-dispatcher.js";

test("parallel empty claims share discovery until a new wake", async () => {
  let claims = 0;
  let dueCalls = 0;
  let wakes = 0;
  const dispatcher = new AiJobDispatcher({
    database: {
      claimJob: async () => { claims += 1; return null; },
      nextJobDue: async () => { dueCalls += 1; return null; },
    },
    kinds: () => ["ai.summary"], wake: () => { wakes += 1; }, log: () => {},
  });
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => dispatcher.claim(`worker-${index}`)));
    assert.equal(claims, 1);
    await Promise.all(Array.from({ length: 8 }, () => dispatcher.schedule()));
    assert.equal(dueCalls, 1);
    dispatcher.wake();
    assert.equal(wakes, 1);
    await dispatcher.claim("worker-0");
    assert.equal(claims, 2);
    dispatcher.stop();
    await dispatcher.claim("stopped");
    dispatcher.wake();
    assert.equal(claims, 2);
    assert.equal(wakes, 1);
  } finally { dispatcher.stop(); }
});

test("a wake during an empty claim does not hide newly queued work", async () => {
  let finish!: (value: null) => void;
  let calls = 0;
  const dispatcher = new AiJobDispatcher({
    database: {
      claimJob: async () => {
        calls += 1;
        if (calls === 1) return new Promise<null>((resolve) => { finish = resolve; });
        return null;
      },
      nextJobDue: async () => null,
    },
    kinds: () => ["ai.summary"], wake: () => {}, log: () => {},
  });
  try {
    const pending = dispatcher.claim("first");
    await Promise.resolve();
    dispatcher.wake();
    finish(null);
    await pending;
    await dispatcher.claim("second");
    assert.equal(calls, 2);
  } finally { dispatcher.stop(); }
});

test("one database failure backs off all execution slots", async () => {
  let calls = 0;
  const dispatcher = new AiJobDispatcher({
    database: {
      claimJob: async () => { calls += 1; throw new Error("database unavailable"); },
      nextJobDue: async () => null,
    },
    kinds: () => ["ai.summary"], wake: () => {}, log: () => {},
  });
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => dispatcher.claim("worker")));
    assert.equal(calls, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    dispatcher.wake();
    await dispatcher.claim("event-during-backoff");
    assert.equal(calls, 1);
  } finally { dispatcher.stop(); }
});

test("an early timer callback re-arms the remaining backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  let wakes = 0;
  const dispatcher = new AiJobDispatcher({
    database: {
      claimJob: async () => { throw new Error("database unavailable"); },
      nextJobDue: async () => null,
    },
    kinds: () => ["ai.summary"], wake: () => { wakes += 1; }, log: () => {},
  });
  try {
    await assert.rejects(dispatcher.claim("worker"));
    now = 5_999;
    t.mock.timers.tick(5_000);
    assert.equal(wakes, 0);
    now = 6_000;
    t.mock.timers.tick(1);
    assert.equal(wakes, 1);
  } finally { dispatcher.stop(); }
});

test("a concurrent wake refreshes stale due discovery", async () => {
  let finish!: (value: null) => void;
  let calls = 0;
  const dispatcher = new AiJobDispatcher({
    database: {
      claimJob: async () => null,
      nextJobDue: async () => {
        calls += 1;
        if (calls === 1) return new Promise<null>((resolve) => { finish = resolve; });
        return null;
      },
    },
    kinds: () => ["ai.summary"], wake: () => {}, log: () => {},
  });
  try {
    const pending = dispatcher.schedule();
    dispatcher.wake();
    finish(null);
    await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
  } finally { dispatcher.stop(); }
});
