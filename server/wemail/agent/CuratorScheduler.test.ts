import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CuratorScheduler,
  FEEDBACK_EVENT_THRESHOLD,
  MAIL_ARRIVED_THRESHOLD,
  TIME_COOLDOWN_MS,
} from "./CuratorScheduler.js";
import {
  InMemoryCuratorCursorStore,
} from "./CuratorCursorStore.js";
import type {
  CuratorAgentRuntime,
  CuratorRunInput,
  CuratorRunReason,
  CuratorRunSummary,
} from "./CuratorAgentRuntime.js";

interface RecordedRun {
  reason: CuratorRunReason;
}

class FakeRuntime {
  readonly runs: RecordedRun[] = [];
  resolveNext: (() => void) | null = null;
  blockUntilManualResolve = false;

  async run(input: CuratorRunInput): Promise<CuratorRunSummary> {
    this.runs.push({ reason: input.reason });
    if (this.blockUntilManualResolve) {
      await new Promise<void>((resolve) => {
        this.resolveNext = resolve;
      });
    }
    return {
      durationMs: 1,
      iterations: 0,
      tokensUsed: 0,
      filesWritten: [],
      errors: [],
    };
  }

  asRuntime(): CuratorAgentRuntime {
    return this as unknown as CuratorAgentRuntime;
  }
}

test("CuratorScheduler.tickTime runs accounts older than 24h cooldown", async () => {
  const cursors = new InMemoryCuratorCursorStore();
  const fake = new FakeRuntime();
  let now = new Date("2026-04-29T12:00:00Z");
  const scheduler = new CuratorScheduler({
    runtimeFor: () => fake.asRuntime(),
    accountIds: () => ["acct-1", "acct-2"],
    persistedCursors: cursors,
    clock: () => now,
  });
  // acct-1 last ran 25h ago (eligible); acct-2 last ran 10h ago (not eligible)
  await cursors.setLastRunAt("acct-1", new Date(now.getTime() - 25 * 60 * 60 * 1000));
  await cursors.setLastRunAt("acct-2", new Date(now.getTime() - 10 * 60 * 60 * 1000));

  const pending = await scheduler.tickTime();
  await Promise.all(pending);

  assert.deepEqual(fake.runs.map((r) => r.reason), ["time"]);
  // acct-1 should have a fresh lastRunAt now
  const last = await cursors.getLastRunAt("acct-1");
  assert.equal(last?.toISOString(), now.toISOString());

  // Subsequent tick within cooldown → no run
  fake.runs.length = 0;
  now = new Date(now.getTime() + 60 * 1000);
  const next = await scheduler.tickTime();
  await Promise.all(next);
  assert.equal(fake.runs.length, 0);
});

test("CuratorScheduler.tickTime treats never-run accounts as eligible", async () => {
  const cursors = new InMemoryCuratorCursorStore();
  const fake = new FakeRuntime();
  const scheduler = new CuratorScheduler({
    runtimeFor: () => fake.asRuntime(),
    accountIds: () => ["fresh"],
    persistedCursors: cursors,
    clock: () => new Date("2026-04-29T12:00:00Z"),
  });
  const pending = await scheduler.tickTime();
  await Promise.all(pending);
  assert.equal(fake.runs.length, 1);
  assert.equal(fake.runs[0].reason, "time");
});

test("CuratorScheduler.notifyEvent triggers when counter crosses threshold and resets", async () => {
  const cursors = new InMemoryCuratorCursorStore();
  const fake = new FakeRuntime();
  const scheduler = new CuratorScheduler({
    runtimeFor: () => fake.asRuntime(),
    accountIds: () => ["acct-1"],
    persistedCursors: cursors,
    clock: () => new Date("2026-04-29T12:00:00Z"),
  });

  for (let i = 0; i < FEEDBACK_EVENT_THRESHOLD - 1; i += 1) {
    const out = await scheduler.notifyEvent("acct-1", "feedback-event");
    assert.equal(out, null);
  }
  const counters1 = await cursors.getCounters("acct-1");
  assert.equal(counters1["feedback-event"], FEEDBACK_EVENT_THRESHOLD - 1);
  assert.equal(fake.runs.length, 0);

  const triggered = await scheduler.notifyEvent("acct-1", "feedback-event");
  assert.ok(triggered, "expected a run promise");
  await triggered;
  assert.equal(fake.runs.length, 1);
  assert.equal(fake.runs[0].reason, "count");

  // Counters reset post-run
  const counters2 = await cursors.getCounters("acct-1");
  assert.equal(counters2["feedback-event"], 0);
  assert.equal(counters2["mail-arrived"], 0);
});

test("CuratorScheduler.triggerManual bypasses cooldown", async () => {
  const cursors = new InMemoryCuratorCursorStore();
  const fake = new FakeRuntime();
  const now = new Date("2026-04-29T12:00:00Z");
  const scheduler = new CuratorScheduler({
    runtimeFor: () => fake.asRuntime(),
    accountIds: () => ["acct-1"],
    persistedCursors: cursors,
    clock: () => now,
  });
  // Just ran a minute ago — still well inside cooldown.
  await cursors.setLastRunAt("acct-1", new Date(now.getTime() - 60_000));
  await scheduler.triggerManual("acct-1");
  assert.equal(fake.runs.length, 1);
  assert.equal(fake.runs[0].reason, "manual");
});

test("CuratorScheduler coalesces concurrent triggers per account", async () => {
  const cursors = new InMemoryCuratorCursorStore();
  const fake = new FakeRuntime();
  fake.blockUntilManualResolve = true;
  const scheduler = new CuratorScheduler({
    runtimeFor: () => fake.asRuntime(),
    accountIds: () => ["acct-1"],
    persistedCursors: cursors,
    clock: () => new Date("2026-04-29T12:00:00Z"),
  });

  const first = scheduler.triggerManual("acct-1");
  // Wait one microtask so the first run has captured the in-flight slot.
  await Promise.resolve();
  const second = scheduler.triggerManual("acct-1");
  // The first and second promises are the SAME promise — coalesced.
  assert.equal(first, second);

  // Release the first run; the scheduler should queue a follow-up.
  fake.blockUntilManualResolve = false;
  fake.resolveNext?.();
  await first;

  // Wait for the follow-up to run.
  await new Promise((r) => setTimeout(r, 10));
  // Two runs total (the original and the coalesced follow-up).
  assert.equal(fake.runs.length, 2);
  assert.equal(fake.runs[0].reason, "manual");
  assert.equal(fake.runs[1].reason, "manual");
});

test("CuratorScheduler picks highest-priority reason when coalescing", async () => {
  const cursors = new InMemoryCuratorCursorStore();
  const fake = new FakeRuntime();
  fake.blockUntilManualResolve = true;
  const fixedNow = new Date("2026-04-29T12:00:00Z");
  const scheduler = new CuratorScheduler({
    runtimeFor: () => fake.asRuntime(),
    accountIds: () => ["acct-1"],
    persistedCursors: cursors,
    clock: () => fixedNow,
  });

  // Pre-arrange: lastRunAt is old enough to qualify for the time tick.
  await cursors.setLastRunAt(
    "acct-1",
    new Date(fixedNow.getTime() - TIME_COOLDOWN_MS - 1),
  );
  // Pre-arrange: feedback counter one below threshold so the next
  // notifyEvent will trigger.
  await cursors.setCounters("acct-1", {
    "mail-arrived": 0,
    "feedback-event": FEEDBACK_EVENT_THRESHOLD - 1,
  });

  // 1) Start the time-based run (becomes the in-flight slot).
  const timePending = await scheduler.tickTime();
  assert.equal(timePending.length, 1);
  // 2) Coalesce a count-based trigger then a manual trigger while the
  //    first run is still blocked. Don't await the returned promises —
  //    they all share the in-flight slot and would deadlock.
  void scheduler.notifyEvent("acct-1", "feedback-event");
  void scheduler.triggerManual("acct-1");

  // 3) Release the first run; the follow-up should be 'manual' (highest
  //    priority of the coalesced set).
  fake.blockUntilManualResolve = false;
  fake.resolveNext?.();
  await Promise.all(timePending);
  // Allow the queued follow-up microtask to run.
  await new Promise((r) => setTimeout(r, 20));

  const reasons = fake.runs.map((r) => r.reason);
  assert.equal(reasons[0], "time");
  assert.equal(reasons[reasons.length - 1], "manual");
});

test("CuratorScheduler.triggerManual propagates runtime errors so callers can return 500", async () => {
  const cursors = new InMemoryCuratorCursorStore();
  const onError: Array<{ accountId: string; message: string }> = [];
  const scheduler = new CuratorScheduler({
    runtimeFor: () =>
      ({
        async run() {
          throw new Error("llm provider down");
        },
      }) as unknown as CuratorAgentRuntime,
    accountIds: () => ["acct-1"],
    persistedCursors: cursors,
    clock: () => new Date("2026-04-29T12:00:00Z"),
    onError: (accountId, err) =>
      onError.push({ accountId, message: err.message }),
  });
  await assert.rejects(
    () => scheduler.triggerManual("acct-1"),
    /llm provider down/,
  );
  // onError is still invoked — the side-channel for telemetry/logging
  // must fire whether the caller catches or not.
  assert.deepEqual(onError, [
    { accountId: "acct-1", message: "llm provider down" },
  ]);
});

test("CuratorScheduler background ticks swallow runtime errors and report via onError", async () => {
  // tickTime / notifyEvent run from a background loop with no caller to
  // forward errors to — they must keep the legacy "log + continue"
  // behaviour so a flaky LLM doesn't tear down the periodic scheduler.
  const cursors = new InMemoryCuratorCursorStore();
  const onError: Array<{ accountId: string; message: string }> = [];
  const fixedNow = new Date("2026-04-29T12:00:00Z");
  const scheduler = new CuratorScheduler({
    runtimeFor: () =>
      ({
        async run() {
          throw new Error("transient blip");
        },
      }) as unknown as CuratorAgentRuntime,
    accountIds: () => ["acct-1"],
    persistedCursors: cursors,
    clock: () => fixedNow,
    onError: (accountId, err) =>
      onError.push({ accountId, message: err.message }),
  });
  await cursors.setLastRunAt(
    "acct-1",
    new Date(fixedNow.getTime() - TIME_COOLDOWN_MS - 1),
  );
  const pending = await scheduler.tickTime();
  // Should resolve to null, not reject.
  const results = await Promise.all(pending);
  assert.deepEqual(results, [null]);
  assert.equal(onError.length, 1);
  assert.equal(onError[0].message, "transient blip");
});

test("CuratorScheduler.notifyEvent uses MAIL_ARRIVED_THRESHOLD for mail-arrived", async () => {
  const cursors = new InMemoryCuratorCursorStore();
  const fake = new FakeRuntime();
  const scheduler = new CuratorScheduler({
    runtimeFor: () => fake.asRuntime(),
    accountIds: () => ["acct-1"],
    persistedCursors: cursors,
    clock: () => new Date("2026-04-29T12:00:00Z"),
  });
  for (let i = 0; i < MAIL_ARRIVED_THRESHOLD - 1; i += 1) {
    const out = await scheduler.notifyEvent("acct-1", "mail-arrived");
    assert.equal(out, null);
  }
  const triggered = await scheduler.notifyEvent("acct-1", "mail-arrived");
  assert.ok(triggered);
  await triggered;
  assert.equal(fake.runs.length, 1);
  assert.equal(fake.runs[0].reason, "count");
});
