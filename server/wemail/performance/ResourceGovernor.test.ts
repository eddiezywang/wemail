import assert from "node:assert/strict";
import { test } from "node:test";
import { ResourceGovernor } from "./ResourceGovernor.js";

function memory(rss = 100) {
  return {
    rss,
    heapTotal: 0,
    heapUsed: 50,
    external: 0,
    arrayBuffers: 0,
  };
}

test("resource governor pauses background work and resumes after low-water cooldown", () => {
  let nowMs = Date.parse("2026-07-22T00:00:00.000Z");
  const governor = new ResourceGovernor({
    now: () => new Date(nowMs),
    memoryUsage: () => memory(),
    cpuUsage: () => ({ user: 0, system: 0 }),
    cpuCount: 1,
    thresholds: {
      memoryHighWaterBytes: 600,
      memoryLowWaterBytes: 500,
      cooldownMs: 2_000,
    },
  });

  governor.sampleNow({ workingSetBytes: 700 });
  assert.equal(governor.getState().backgroundPaused, true);
  assert.equal(governor.getState().throttleReason, "memory-high");
  assert.equal(governor.canRun("background"), false);
  assert.equal(governor.canRun("interactive"), true);
  assert.equal(governor.canRun("live"), true);

  nowMs += 1_000;
  governor.sampleNow({ workingSetBytes: 400, cpuPercent: 0, eventLoopP95Ms: 0 });
  assert.equal(governor.getState().backgroundPaused, true);

  nowMs += 1_000;
  governor.sampleNow({ workingSetBytes: 400, cpuPercent: 0, eventLoopP95Ms: 0 });
  assert.equal(governor.getState().backgroundPaused, false);
  assert.equal(governor.getState().throttleReason, null);
  governor.stop();
});

test("resource governor reports CPU and event-loop pressure independently", () => {
  const governor = new ResourceGovernor({
    memoryUsage: () => memory(),
    cpuUsage: () => ({ user: 0, system: 0 }),
  });
  governor.sampleNow({ cpuPercent: 35, workingSetBytes: 100 });
  assert.equal(governor.getState().throttleReason, "cpu-high");
  governor.stop();

  const eventLoopGovernor = new ResourceGovernor({
    memoryUsage: () => memory(),
    cpuUsage: () => ({ user: 0, system: 0 }),
  });
  eventLoopGovernor.sampleNow({ eventLoopP95Ms: 250, workingSetBytes: 100 });
  assert.equal(eventLoopGovernor.getState().throttleReason, "event-loop-high");
  eventLoopGovernor.stop();
});

test("an aborted admission wait cannot block shutdown", async () => {
  const governor = new ResourceGovernor({
    memoryUsage: () => memory(),
    cpuUsage: () => ({ user: 0, system: 0 }),
  });
  governor.sampleNow({ workingSetBytes: 700 * 1024 * 1024 });
  const controller = new AbortController();
  const waiting = governor.waitForAdmission("background", controller.signal);
  controller.abort();
  assert.equal(await waiting, false);
  governor.stop();
});

test("resource governor does not oscillate while baseline growth remains above resume budget", () => {
  let nowMs = Date.parse("2026-07-30T00:00:00.000Z");
  const governor = new ResourceGovernor({
    now: () => new Date(nowMs),
    memoryUsage: () => memory(100),
    cpuUsage: () => ({ user: 0, system: 0 }),
    cpuCount: 1,
    thresholds: {
      memoryHighWaterBytes: 600,
      memoryLowWaterBytes: 500,
      firstSyncGrowthBudgetBytes: 200,
      firstSyncGrowthResumeBudgetBytes: 150,
      cooldownMs: 2_000,
    },
  });

  governor.sampleNow({ workingSetBytes: 340, cpuPercent: 0, eventLoopP95Ms: 0 });
  assert.equal(governor.getState().backgroundPaused, true);

  nowMs += 2_000;
  governor.sampleNow({ workingSetBytes: 340, cpuPercent: 0, eventLoopP95Ms: 0 });
  assert.equal(governor.getState().backgroundPaused, true);

  nowMs += 1_000;
  governor.sampleNow({ workingSetBytes: 240, cpuPercent: 0, eventLoopP95Ms: 0 });
  assert.equal(governor.getState().backgroundPaused, false);
  governor.stop();
});

test("foreground activity temporarily holds background admission", () => {
  let nowMs = Date.parse("2026-07-29T00:00:00.000Z");
  const governor = new ResourceGovernor({
    now: () => new Date(nowMs),
    memoryUsage: () => memory(),
    cpuUsage: () => ({ user: 0, system: 0 }),
  });

  governor.markForegroundActivity(2_000);
  assert.equal(governor.canRun("background"), false);
  assert.equal(governor.canRun("interactive"), true);

  nowMs += 1_999;
  assert.equal(governor.canRun("background"), false);
  nowMs += 1;
  assert.equal(governor.canRun("background"), true);
  governor.stop();
});

test("resource governor invokes onTransition on pause and resume", () => {
  let nowMs = Date.parse("2026-07-22T00:00:00.000Z");
  const transitions: Array<{ transition: string; reason: string | null }> = [];
  const governor = new ResourceGovernor({
    now: () => new Date(nowMs),
    memoryUsage: () => memory(),
    cpuUsage: () => ({ user: 0, system: 0 }),
    cpuCount: 1,
    thresholds: {
      memoryHighWaterBytes: 600,
      memoryLowWaterBytes: 500,
      cooldownMs: 2_000,
    },
    onTransition: (transition, reason) => {
      transitions.push({ transition, reason });
    },
  });

  governor.sampleNow({ workingSetBytes: 700 });
  assert.deepEqual(transitions, [{ transition: "paused", reason: "memory-high" }]);

  nowMs += 2_000;
  governor.sampleNow({ workingSetBytes: 400, cpuPercent: 0, eventLoopP95Ms: 0 });
  assert.deepEqual(transitions, [
    { transition: "paused", reason: "memory-high" },
    { transition: "resumed", reason: "memory-high" },
  ]);
  governor.stop();
});
