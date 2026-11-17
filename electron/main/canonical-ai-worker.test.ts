import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmRuntimeSnapshot } from "../../server/wemail/ai/LlmRuntime.js";
import type { ResourceGovernor } from "../../server/wemail/performance/ResourceGovernor.js";
import type { MailDatabaseProducer } from "../mail-core/mail-database-producer.js";
import { CanonicalAiWorker, safeAiJobErrorCode } from "./canonical-ai-worker.js";
import { LlmClientError } from "../../server/wemail/ai/LlmClient.js";

test("AI job errors never persist provider text or arbitrary error codes", () => {
  assert.equal(safeAiJobErrorCode(new LlmClientError({ message: "secret mail", code: "secret-key" })), "llm-request-failed");
  assert.equal(safeAiJobErrorCode(new LlmClientError({ message: "secret mail", status: 429 })), "llm-http-429");
  assert.equal(safeAiJobErrorCode(new Error("secret mail")), "ai-job-failed");
  assert.equal(safeAiJobErrorCode(new Error("mail-missing")), "mail-missing");
});

function configuredLlm(): LlmRuntimeSnapshot {
  return {
    generation: 1,
    configured: true,
    client: {},
    modelFor: () => "model",
  } as unknown as LlmRuntimeSnapshot;
}

function makeWorker(
  database: unknown,
  governor: unknown,
  startupMaintenance?: () => Promise<void>,
): CanonicalAiWorker {
  return new CanonicalAiWorker({
    database: database as unknown as MailDatabaseProducer,
    getLlmSnapshot: () => configuredLlm(),
    governor: governor as unknown as ResourceGovernor,
    startupMaintenance,
    log: () => {},
  });
}

test("ai worker defers to a paused governor before reconciliation and does not reschedule", async () => {
  let reconcileCalls = 0;
  let nextDueCalls = 0;
  const database = {
    reconcileAiJobs: async () => { reconcileCalls += 1; },
    resetTerminalAiJobsForRetry: async () => {},
    claimJob: async () => null,
    nextJobDue: async () => { nextDueCalls += 1; return null; },
  };
  const worker = makeWorker(database, { waitForAdmission: async () => false });
  // Bypass the 15s startup-maintenance deferral so the drain reaches the
  // governor gate instead of bailing on maintenance.
  (worker as unknown as { startupMaintenanceReady: boolean }).startupMaintenanceReady = true;

  worker.wake();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reconcileCalls, 0, "reconcile must not run while the governor is paused");
  assert.equal(nextDueCalls, 0, "must not schedule the next due poll while paused");
  worker.stop();
});

test("ai workers share one lazy startup maintenance run", async () => {
  let maintenanceCalls = 0;
  let maintenance: Promise<void> | null = null;
  const runMaintenance = (): Promise<void> => {
    maintenance ??= Promise.resolve().then(() => {
      maintenanceCalls += 1;
    });
    return maintenance;
  };
  const database = {
    reconcileAiJobs: async () => { throw new Error("worker-local reconciliation used"); },
    claimJob: async () => null,
    nextJobDue: async () => null,
  };
  const workers = [
    makeWorker(database, undefined, runMaintenance),
    makeWorker(database, undefined, runMaintenance),
  ];
  for (const worker of workers) {
    (worker as unknown as { startupMaintenanceReady: boolean }).startupMaintenanceReady = true;
    worker.wake();
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(maintenanceCalls, 1);
  for (const worker of workers) worker.stop();
});

test("ai worker re-checks admission before every claim", async () => {
  let admissionCalls = 0;
  let claimCalls = 0;
  let terminalCalls = 0;
  const database = {
    reconcileAiJobs: async () => {},
    resetTerminalAiJobsForRetry: async () => {},
    claimJob: async () => {
      claimCalls += 1;
      // Return a job whose payload parsePayload rejects, so process() only
      // touches terminalJob (cheap) and the loop can re-check admission.
      return { id: 1, payload: {} };
    },
    terminalJob: async () => { terminalCalls += 1; },
    nextJobDue: async () => null,
  };
  const governor = {
    // Calls: 1 = before reconcile (true), 2 = before claim 1 (true),
    // 3 = before claim 2 (false) -> the loop must break after one claim.
    waitForAdmission: async () => ++admissionCalls < 3,
  };
  const worker = makeWorker(database, governor);
  (worker as unknown as { startupMaintenanceReady: boolean }).startupMaintenanceReady = true;

  worker.wake();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(admissionCalls, 3, "admission must be consulted before reconcile and before each claim");
  assert.equal(claimCalls, 1, "a second claim must not start once admission is denied");
  assert.equal(terminalCalls, 1, "the single claimed job should be terminalized (invalid payload)");
  worker.stop();
});

test("ai worker retire resolves immediately when idle and stops consuming", async () => {
  let claimAfterRetire = 0;
  let claimedBeforeRetire = false;
  const database = {
    reconcileAiJobs: async () => {},
    resetTerminalAiJobsForRetry: async () => {},
    // First drain claims nothing so the worker goes idle (schedules nextDue).
    // retire() clears that timer and re-enters drain, which must exit on the
    // retiring flag without claiming again.
    claimJob: async () => {
      if (claimedBeforeRetire) claimAfterRetire += 1;
      return null;
    },
    nextJobDue: async () => null,
  };
  const worker = makeWorker(database, undefined);
  (worker as unknown as { startupMaintenanceReady: boolean }).startupMaintenanceReady = true;

  worker.wake();
  await new Promise((resolve) => setTimeout(resolve, 20));
  claimedBeforeRetire = true;
  assert.equal(worker.isBusy(), false, "worker is idle after an empty claim");

  await worker.retire();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(claimAfterRetire, 0, "a retired worker must not claim again");
  worker.stop();
});

test("ai worker retire finishes the in-flight job before resolving", async () => {
  let resolveSnapshot: () => void = () => {};
  const snapshotPromise = new Promise<void>((resolve) => {
    resolveSnapshot = resolve;
  });
  const database = {
    reconcileAiJobs: async () => {},
    resetTerminalAiJobsForRetry: async () => {},
    // Claim a well-formed job, then hang inside process() at getSnapshot so
    // the worker is observably busy when retire() is called.
    claimJob: async () => ({
      id: 1,
      attempts: 1,
      maxAttempts: 3,
      kind: "ai.summary",
      payload: { accountId: "a", emailId: "e", contentSha256: "x", contentVersion: 1 },
    }),
    getSnapshot: async () => snapshotPromise.then(() => ({ message: null, bodyState: "ready" })),
    deferJob: async () => {},
    nextJobDue: async () => null,
  };
  const worker = makeWorker(database, undefined);
  (worker as unknown as { startupMaintenanceReady: boolean }).startupMaintenanceReady = true;

  worker.wake();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(worker.isBusy(), true, "worker is busy while the in-flight job is unresolved");

  let retired = false;
  const retirePromise = worker.retire().then(() => {
    retired = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(retired, false, "retire must not resolve while the in-flight job is still running");

  resolveSnapshot(); // let process() complete
  await retirePromise;
  assert.equal(retired, true, "retire resolves once the in-flight job finishes");
  worker.stop();
});

test("ai worker retire aborts a paused-governor wait so the promise resolves", async () => {
  const governor = {
    // Never resolves on its own; only when the retire() abort fires the signal.
    waitForAdmission: (_class: unknown, signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        if (signal.aborted) resolve(false);
        else signal.addEventListener("abort", () => resolve(false), { once: true });
      }),
  };
  const database = {
    reconcileAiJobs: async () => {},
    resetTerminalAiJobsForRetry: async () => {},
    claimJob: async () => null,
    nextJobDue: async () => null,
  };
  const worker = makeWorker(database, governor);
  (worker as unknown as { startupMaintenanceReady: boolean }).startupMaintenanceReady = true;

  worker.wake();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Without abort the worker would hang here forever; retire() must unblock it.
  await worker.retire();
  worker.stop();
});

test("ai worker retire promise resolves even if stop() races it", async () => {
  const database = {
    reconcileAiJobs: async () => {},
    resetTerminalAiJobsForRetry: async () => {},
    claimJob: async () => null,
    nextJobDue: async () => null,
  };
  const worker = makeWorker(database, undefined);
  (worker as unknown as { startupMaintenanceReady: boolean }).startupMaintenanceReady = true;
  worker.wake();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const retirePromise = worker.retire();
  worker.stop(); // hard stop must still settle the retire promise (backstop)
  await retirePromise; // should not hang
});
