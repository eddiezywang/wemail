import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { JobRepository } from "./JobRepository.js";

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-jobrepo-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1", email: "a@x.com" });
  const now = () => "2026-04-24T00:00:00.000Z";
  return { repo: new JobRepository(db, now), db };
}

/** Helper: enqueue the canonical three-kind fan-out (summary, tags, replyDecision). */
function enqueueThree(repo: JobRepository, emailId: string, accountId: string) {
  const specs = [
    { type: "summary" as const, maxAttempts: 2 },
    { type: "tags" as const, maxAttempts: 3 },
    { type: "replyDecision" as const, maxAttempts: 3 },
  ];
  return specs.map((s) => {
    const r = repo.enqueueJob({ emailId, accountId, type: s.type, maxAttempts: s.maxAttempts });
    return { ...r, type: s.type };
  });
}

test("enqueueJob creates pending jobs (summary, tags, replyDecision)", () => {
  const { repo, db } = makeRepo();
  const rows = enqueueThree(repo, "email-1", "acct-1");
  assert.equal(rows.length, 3);
  const types = rows.map((r) => r.type).sort();
  assert.deepEqual(types, ["replyDecision", "summary", "tags"]);
  assert.ok(rows.every((r) => r.inserted));

  const dbRows = db
    .prepare("SELECT job_kind AS processor, state AS status, max_attempts FROM mail_jobs ORDER BY job_kind")
    .all() as Array<{ processor: string; status: string; max_attempts: number }>;
  assert.equal(dbRows.length, 3);
  const summary = dbRows.find((r) => r.processor === "summary")!;
  assert.equal(summary.max_attempts, 2, "summary jobs have maxAttempts=2 per Handoff §2");
  const tags = dbRows.find((r) => r.processor === "tags")!;
  assert.equal(tags.max_attempts, 3);
});

test("enqueueJob is idempotent under the (email_id, type) unique constraint", () => {
  const { repo, db } = makeRepo();
  enqueueThree(repo, "email-1", "acct-1");
  const second = enqueueThree(repo, "email-1", "acct-1");
  assert.ok(second.every((r) => !r.inserted));
  const count = (db.prepare("SELECT COUNT(*) as n FROM mail_jobs").get() as { n: number }).n;
  assert.equal(count, 3);
});

test("pending inserts and manual resets notify active queue listeners", () => {
  const { repo } = makeRepo();
  let notifications = 0;
  const unsubscribe = repo.onWorkAvailable(() => {
    notifications += 1;
  });

  const created = repo.enqueueJob({
    emailId: "email-notify",
    accountId: "acct-1",
    type: "summary",
  });
  assert.equal(notifications, 1);

  repo.markJobFailed(created.id, "failed");
  repo.resetForManualRetry(created.id);
  assert.equal(notifications, 2);

  repo.enqueueOrResetJob({
    emailId: "email-notify",
    accountId: "acct-1",
    type: "summary",
  });
  assert.equal(notifications, 3);

  unsubscribe();
  repo.enqueueJob({
    emailId: "email-after-unsubscribe",
    accountId: "acct-1",
    type: "summary",
  });
  assert.equal(notifications, 3);
});

test("findByEmailAndType returns the job row id or null regardless of status", () => {
  const { repo } = makeRepo();
  assert.equal(repo.findByEmailAndType("email-x", "summary"), null);
  repo.enqueueJob({ emailId: "email-x", accountId: "acct-1", type: "summary" });
  const found = repo.findByEmailAndType("email-x", "summary");
  assert.ok(found);
  assert.equal(found!.status, "pending");
  // Transition to succeeded and confirm the row is still found (any-status lookup).
  repo.markJobRunning(found!.id);
  repo.markJobSucceeded(found!.id);
  const after = repo.findByEmailAndType("email-x", "summary");
  assert.ok(after);
  assert.equal(after!.status, "succeeded");
});

test("listPendingJobs returns only pending rows with attempts < maxAttempts", () => {
  const { repo } = makeRepo();
  enqueueThree(repo, "email-a", "acct-1");
  enqueueThree(repo, "email-b", "acct-1");
  const pending = repo.listPendingJobs(10);
  assert.equal(pending.length, 6);
  repo.markJobRunning(pending[0]!.id);
  repo.markJobSucceeded(pending[0]!.id);
  const still = repo.listPendingJobs(10);
  assert.equal(still.length, 5);
});

test("listPendingJobs prioritizes newly enqueued jobs first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-jobrepo-priority-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1", email: "a@x.com" });
  let tick = 0;
  const repo = new JobRepository(
    db,
    () => `2026-04-24T00:00:0${tick++}.000Z`,
  );

  repo.enqueueJob({ emailId: "email-old", accountId: "acct-1", type: "summary" });
  repo.enqueueJob({ emailId: "email-new", accountId: "acct-1", type: "summary" });

  const pending = repo.listPendingJobs(10);
  assert.deepEqual(
    pending.map((job) => job.emailId),
    ["email-new", "email-old"],
  );
});

test("status transitions: running → succeeded and running → failed", () => {
  const { repo } = makeRepo();
  const first = repo.enqueueJob({ emailId: "email-c", accountId: "acct-1", type: "summary" });
  repo.markJobRunning(first.id);
  let row = repo.getJobById(first.id)!;
  assert.equal(row.status, "running");
  assert.equal(row.attempts, 1);

  repo.markJobFailed(first.id, "boom");
  row = repo.getJobById(first.id)!;
  assert.equal(row.status, "failed");
  assert.equal(row.error, "boom");
});

test("recordAttemptError flips a running row back to pending with an error message", () => {
  const { repo } = makeRepo();
  const first = repo.enqueueJob({ emailId: "email-d", accountId: "acct-1", type: "summary" });
  repo.markJobRunning(first.id);
  repo.recordAttemptError(first.id, "transient");
  const row = repo.getJobById(first.id)!;
  assert.equal(row.status, "pending");
  assert.equal(row.error, "transient");
});

test("recordAttemptError can delay a retry and preserve attempt budget for cooldowns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-jobrepo-delay-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1", email: "a@x.com" });
  let now = "2026-04-24T00:00:00.000Z";
  const repo = new JobRepository(db, () => now);

  const first = repo.enqueueJob({ emailId: "email-delay", accountId: "acct-1", type: "summary" });
  repo.markJobRunning(first.id);
  repo.recordAttemptError(first.id, "cooling down", {
    delayMs: 30_000,
    preserveAttempt: true,
  });

  let row = repo.getJobById(first.id)!;
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(repo.listPendingJobs(10).length, 0, "delayed row should not be runnable yet");

  now = "2026-04-24T00:00:30.000Z";
  row = repo.getJobById(first.id)!;
  assert.equal(repo.listPendingJobs(10).length, 1, "row becomes runnable after delay");
  assert.equal(row.error, "cooling down");
});

test("resetForManualRetry clears exhausted attempts so pending job is runnable again", () => {
  const { repo } = makeRepo();
  const first = repo.enqueueJob({
    emailId: "email-retry",
    accountId: "acct-1",
    type: "summary",
    maxAttempts: 2,
  });
  repo.markJobRunning(first.id);
  repo.recordAttemptError(first.id, "network");
  repo.markJobRunning(first.id);
  repo.markJobFailed(first.id, "terminal");

  repo.resetForManualRetry(first.id);

  const row = repo.getJobById(first.id)!;
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(row.error, undefined);
  assert.deepEqual(repo.listPendingJobs(10).map((job) => job.id), [first.id]);
});

test("summary recovery metadata gates automatic retries and manual retry clears it", () => {
  const { repo, db } = makeRepo();
  const job = repo.enqueueJob({
    emailId: "email-recovery",
    accountId: "acct-1",
    type: "summary",
    maxAttempts: 2,
  });
  repo.markJobFailed(job.id, "provider timeout");
  repo.scheduleSummaryRecovery({
    id: job.id,
    failureClass: "transient",
    nextRetryAt: "2026-04-25T00:00:00.000Z",
    reason: "provider timeout",
    processorVersion: "summary-v1",
  });

  assert.equal(repo.listDueSummaryRecoveryJobs("acct-1").length, 0);
  const stored = db
    .prepare(
      `SELECT payload_json, available_at_ms FROM mail_jobs WHERE public_id = ?`,
    )
    .get(job.id) as {
      payload_json: string;
      available_at_ms: number;
    };
  const storedRecovery = (JSON.parse(stored.payload_json) as {
    __wemailQueue: { failureClass: string; recoveryAttempts: number; nextRetryAt: string };
  }).__wemailQueue;
  assert.equal(storedRecovery.failureClass, "transient");
  assert.equal(storedRecovery.recoveryAttempts, 1);
  assert.equal(storedRecovery.nextRetryAt, "2026-04-25T00:00:00.000Z");
  assert.equal(stored.available_at_ms, Date.parse("2026-04-25T00:00:00.000Z"));

  repo.resetForManualRetry(job.id);
  const cleared = db
    .prepare(
      `SELECT payload_json, attempt_count, state FROM mail_jobs WHERE public_id = ?`,
    )
    .get(job.id) as {
      payload_json: string;
      attempt_count: number;
      state: string;
    };
  assert.equal((JSON.parse(cleared.payload_json) as Record<string, unknown>).__wemailQueue, undefined);
  assert.equal(cleared.attempt_count, 0);
  assert.equal(cleared.state, "pending");
});
