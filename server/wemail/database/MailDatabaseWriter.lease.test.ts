import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMailDatabase } from "./Database.js";
import { MailDatabaseWriter } from "./MailDatabaseWriter.js";
import { insertCanonicalTestAccount } from "./MailDatabase.test-support.js";
import { SmartTagBackfillRepository } from "../intelligence/SmartTagBackfillRepository.js";

test("backfill progress commits with job terminal transitions and lease recovery", () => {
  const db = createMailDatabase(":memory:");
  try {
    insertCanonicalTestAccount(db, { id: "account-1" });
    const writer = new MailDatabaseWriter(db);
    const backfills = new SmartTagBackfillRepository(db);
    const run = backfills.create({ accountId: "account-1", reason: "test" });
    backfills.addProgress({ id: run.id, queuedDelta: 5 });
    for (let index = 0; index < 4; index += 1) writer.enqueueJob({
      accountId: "account-1", kind: "ai.tags", maxAttempts: 1, priority: 4,
      idempotencyKey: `backfill:${index}`, payload: { smartTagBackfillRunId: run.id },
    });
    const claim = () => writer.claimJob({ owner: "worker", filter: { kinds: ["ai.tags"] } })!;
    const first = claim();
    db.exec(`CREATE TRIGGER fail_progress BEFORE UPDATE ON mail_smart_tag_backfill_runs
      BEGIN SELECT RAISE(ABORT, 'progress-write-failed'); END;`);
    assert.throws(() => writer.completeJob(first.id, "worker"), /progress-write-failed/);
    assert.equal(db.prepare("SELECT state FROM mail_jobs WHERE id = ?").pluck().get(first.id), "leased");
    db.exec("DROP TRIGGER fail_progress");
    assert.equal(writer.completeJob(first.id, "worker"), true);
    assert.equal(writer.completeJob(first.id, "worker"), false);
    db.prepare("UPDATE mail_jobs SET state = 'leased', lease_owner = 'worker' WHERE id = ?").run(first.id);
    assert.equal(writer.completeJob(first.id, "worker"), true);
    assert.equal(backfills.getById(run.id)?.processedCount, 1, "replayed terminal transitions count once per run");
    assert.equal(writer.failJob(claim().id, "worker", "model-failed"), true);
    const third = claim();
    assert.equal(writer.terminalJob(third.id, "worker", "invalid-result"), true);
    assert.equal(writer.terminalJob(third.id, "worker", "invalid-result"), false);
    const fourth = claim();
    db.prepare("UPDATE mail_jobs SET lease_expires_at_ms = 0 WHERE id = ?").run(fourth.id);
    assert.equal(writer.recoverExpiredJobLeases(), 1);
    assert.equal(writer.recoverExpiredJobLeases(), 0);
    const finished = backfills.getById(run.id)!;
    assert.equal(finished.processedCount, 1);
    assert.equal(finished.failedCount, 3);
    assert.equal(finished.status, "running");
  } finally { db.close(); }
});

test("expired job leases are recovered in bounded waves without stealing active work", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-job-lease-"));
  const databasePath = path.join(directory, "wemail.sqlite");
  const db = createMailDatabase(databasePath);
  try {
    const writer = new MailDatabaseWriter(db);
    const timestamp = new Date().toISOString();
    writer.configureAccount({
      account: {
        id: "account-1",
        emailAddress: "account-1@example.test",
        imap: {
          host: "imap.example.test",
          port: 993,
          secure: true,
          username: "account-1@example.test",
        },
        smtp: {
          host: "smtp.example.test",
          port: 465,
          secure: true,
          username: "account-1@example.test",
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      credentialRef: "credential:account-1",
      credentialGeneration: 1,
    });

    for (let index = 0; index < 60; index += 1) {
      writer.enqueueJob({
        kind: "ai.summary",
        accountId: "account-1",
        priority: 4,
        idempotencyKey: `summary:${index}`,
      });
    }
    const now = Date.now();
    db.prepare(`
      UPDATE mail_jobs
      SET state = 'leased', attempt_count = 1, lease_owner = 'crashed-worker',
          lease_expires_at_ms = ?, updated_at_ms = ?
    `).run(now - 1_000, now - 1_000);

    assert.equal(writer.claimJob({ owner: "recovery-worker", leaseMs: 30_000 }), null);
    assert.equal(writer.nextJobDue(["ai.summary"]), now - 1_000);
    assert.equal(writer.recoverExpiredJobLeases(now), 50);
    const claimed = writer.claimJob({ owner: "recovery-worker", leaseMs: 30_000 });
    assert.ok(claimed);
    assert.equal(claimed.leaseOwner, "recovery-worker");
    assert.equal(writer.completeJob(claimed.id, "crashed-worker"), false);

    const states = db.prepare(`
      SELECT state, lease_owner, COUNT(*) AS count
      FROM mail_jobs
      GROUP BY state, lease_owner
      ORDER BY state, lease_owner
    `).all() as Array<{ state: string; lease_owner: string | null; count: bigint }>;
    assert.deepEqual(states, [
      { state: "leased", lease_owner: "crashed-worker", count: 10n },
      { state: "leased", lease_owner: "recovery-worker", count: 1n },
      { state: "pending", lease_owner: null, count: 49n },
    ]);
    assert.equal(writer.recoverExpiredJobLeases(now), 10);
    assert.equal(writer.recoverExpiredJobLeases(now), 0);
    assert.equal(db.prepare("SELECT lease_owner FROM mail_jobs WHERE id = ?")
      .pluck().get(claimed.id), "recovery-worker");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("next-due discovery uses covering queue indexes and keeps account scope", () => {
  const db = createMailDatabase(":memory:");
  try {
    insertCanonicalTestAccount(db, { id: "first" });
    insertCanonicalTestAccount(db, { id: "second" });
    const writer = new MailDatabaseWriter(db);
    const enqueue = (accountId: string, kind: string, key: string) => writer.enqueueJob({
      kind, accountId, priority: 4, payload: {}, idempotencyKey: key,
    });
    const leased = enqueue("first", "ai.summary", "leased");
    enqueue("first", "ai.tags", "pending");
    enqueue("second", "ai.summary", "other-account");
    enqueue("first", "mail.body.ensure", "body");
    db.exec("UPDATE mail_jobs SET available_at_ms = 9000");
    db.prepare("UPDATE mail_jobs SET state = 'leased', lease_owner = 'worker', lease_expires_at_ms = 5000 WHERE id = ?").run(leased.id);
    db.prepare("UPDATE mail_jobs SET available_at_ms = 1000 WHERE account_id = (SELECT id FROM mail_accounts WHERE public_id = 'second')").run();
    db.prepare("UPDATE mail_jobs SET available_at_ms = 7000 WHERE job_kind = 'mail.body.ensure'").run();
    db.pragma("query_only = ON");
    assert.equal(writer.nextJobDue(["ai.summary", "ai.tags"]), 1000);
    assert.equal(writer.nextJobDue(["ai.tags", "ai.tags"]), 9000);
    assert.equal(writer.nextJobDue(["absent"]), null);
    assert.equal(writer.nextMailDue("first"), 7000);
    assert.equal(writer.nextMailDue("second"), null);
    for (const [state, field, index, account] of [
      ["pending", "available_at_ms", "idx_mail_jobs_due", false],
      ["leased", "lease_expires_at_ms", "idx_mail_jobs_leased_due", false],
      ["pending", "available_at_ms", "idx_mail_jobs_account_pending_due", true],
      ["leased", "lease_expires_at_ms", "idx_mail_jobs_account_leased_due", true],
    ] as const) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT MIN(${field}) FROM mail_jobs INDEXED BY ${index}
        WHERE state = '${state}' AND job_kind = 'ai.summary' ${account ? "AND account_id = 1" : ""}`)
        .all() as Array<{ detail: string }>;
      assert.ok(plan.some((row) => row.detail.includes(`COVERING INDEX ${index}`)), plan.map((row) => row.detail).join("; "));
    }
  } finally { db.close(); }
});
