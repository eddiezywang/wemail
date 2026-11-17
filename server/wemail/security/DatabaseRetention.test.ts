import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMailDatabase, type MailDatabase } from "../database/Database.js";
import { MailDatabaseWriter } from "../database/MailDatabaseWriter.js";
import { DataRetentionService } from "./DataRetentionService.js";
import type { DatabaseRetentionBatchResult } from "../../../shared/wemail/retention.js";

const now = "2026-11-02T00:00:00.000Z";
const expired = "2026-08-01T00:00:00.000Z";
const future = "2027-01-01T00:00:00.000Z";
const empty: DatabaseRetentionBatchResult = {
  wecliAuditLogsDeleted: 0, applicationMessagesDeleted: 0, automationPreviewsDeleted: 0,
  automationManifestItemsDeleted: 0, automationResultsExpired: 0, automationStepDetailsExpired: 0, hasMore: false,
};

test("retention batches bound all six domains, preserve unexpired data and roll back together", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-retention-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    for (const [id, date] of [["old-1", expired], ["old-2", expired], ["keep", future]] as const) {
      db.prepare("INSERT INTO wecli_audit_logs (id, command, args_json, approval_status, created_at) VALUES (?, 'test', '[]', 'approved', ?)").run(id, date);
      db.prepare(`INSERT INTO application_messages
        (id, account_id, source_type, message_type, severity, title, preview, content_json, references_json, interactions_json, created_at, expires_at)
        VALUES (?, 'account', 'system', 'test', 'info', 'Test', '', '[]', '[]', '[]', ?, ?)`).run(id, expired, date);
      db.prepare(`INSERT INTO automation_rule_previews
        (id, account_id, normalized_rule_json, rule_hash, capability_fingerprint, preview_json, created_at, expires_at)
        VALUES (?, 'account', '{}', 'hash', 'fingerprint', '{}', ?, ?)`).run(id, expired, date);
      db.prepare(`INSERT INTO automation_run_manifests
        (run_id, account_scope_json, item_count, content_hash, created_at, expires_at)
        VALUES (?, '[]', 1, 'hash', ?, ?)`).run(id, expired, date);
      db.prepare(`INSERT INTO automation_run_manifest_items
        (run_id, ordinal, account_id, reference_type, reference_id, occurred_at, selection_reason, content_hash)
        VALUES (?, 0, 'account', 'mail', 'mail', ?, 'test', 'hash')`).run(id, expired);
      db.prepare(`INSERT INTO automation_result_envelopes
        (id, run_id, schema_id, schema_version, renderer_id, renderer_version, status, result_json, content_hash, created_at, expires_at)
        VALUES (?, ?, 'schema', '1', 'renderer', '1', 'ready', '{"keep":"until-expiry"}', 'hash', ?, ?)`).run(id, id, expired, date);
      db.prepare(`INSERT INTO automation_step_runs
        (id, run_id, rule_id, rule_version, step_id, provider, capability, capability_fingerprint, status,
         input_summary_json, output_json, warnings_json, side_effects_json, error_json, started_at, completed_at, expires_at)
        VALUES (?, ?, 'rule', 1, 'step', 'provider', 'capability', 'fingerprint', 'succeeded', '{}', '{}', '[]', '[]', '{}', ?, ?, ?)`)
        .run(id, id, expired, expired, date);
    }
    db.exec("CREATE TRIGGER reject_retention BEFORE UPDATE ON automation_step_runs BEGIN SELECT RAISE(ABORT, 'retention-failed'); END");
    assert.throws(() => writer.runRetentionBatch({ now, limit: 1 }), /retention-failed/);
    assert.equal(db.prepare("SELECT COUNT(*) FROM wecli_audit_logs").pluck().get(), 3n);
    assert.equal(db.prepare("SELECT COUNT(*) FROM automation_result_envelopes WHERE status = 'expired'").pluck().get(), 0n);
    db.exec("DROP TRIGGER reject_retention");
    const expected = Object.fromEntries(Object.keys(empty).map((key) => [key, key === "hasMore" ? true : 1]));
    assert.deepEqual(writer.runRetentionBatch({ now, limit: 1 }), expected);
    assert.deepEqual(writer.runRetentionBatch({ now, limit: 1 }), expected);
    assert.deepEqual(writer.runRetentionBatch({ now, limit: 1 }), empty);
    for (const table of ["wecli_audit_logs", "application_messages", "automation_rule_previews"]) {
      assert.deepEqual(db.prepare(`SELECT id FROM ${table}`).all(), [{ id: "keep" }]);
    }
    assert.deepEqual(db.prepare("SELECT run_id FROM automation_run_manifest_items").all(), [{ run_id: "keep" }]);
    assert.equal(db.prepare("SELECT result_json FROM automation_result_envelopes WHERE id = 'keep'").pluck().get(), '{"keep":"until-expiry"}');
    assert.equal(db.prepare("SELECT output_json FROM automation_step_runs WHERE id = 'keep'").pluck().get(), "{}");
    assert.equal(db.prepare("SELECT COUNT(*) FROM automation_result_envelopes WHERE status = 'expired' AND result_json IS NULL").pluck().get(), 2n);
    assert.equal(db.prepare("SELECT COUNT(*) FROM automation_step_runs WHERE output_json IS NULL AND json_extract(error_json, '$.code') = 'detail-expired'").pluck().get(), 2n);
    assert.throws(() => writer.runRetentionBatch({ now, limit: 0 }));
    assert.throws(() => writer.runRetentionBatch({ now: "invalid" }));
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("desktop retention awaits writer batches, coalesces runs and never touches the main DB", async () => {
  let calls = 0;
  let release!: (value: DatabaseRetentionBatchResult) => void;
  const first = new Promise<DatabaseRetentionBatchResult>((resolve) => { release = resolve; });
  const service = new DataRetentionService({
    db: {} as MailDatabase,
    logsBaseDir: "unused",
    fsAdapter: { existsSync: () => false, readdirSync: assert.fail, statSync: assert.fail, unlinkSync: assert.fail },
    databaseRetention: async (params) => {
      calls += 1;
      assert.deepEqual(params, { now, limit: 100 });
      return calls === 1 ? first : empty;
    },
  });
  const running = service.runRetention(new Date(now));
  assert.equal(service.runRetention(new Date(now)), running);
  release({ ...empty, wecliAuditLogsDeleted: 100, hasMore: true });
  const report = await running;
  assert.equal(calls, 2);
  assert.equal(report.wecliAuditLogsDeleted, 100);
  assert.equal(report.mailBodiesPurged, 0);
  service.stop();
});

test("stop cancels remaining retention batches and writer failure does not use a local fallback", async () => {
  let release!: (value: DatabaseRetentionBatchResult) => void;
  const first = new Promise<DatabaseRetentionBatchResult>((resolve) => { release = resolve; });
  let calls = 0;
  let fail = false;
  const service = new DataRetentionService({
    db: {} as MailDatabase, logsBaseDir: "unused",
    fsAdapter: { existsSync: () => false, readdirSync: assert.fail, statSync: assert.fail, unlinkSync: assert.fail },
    databaseRetention: async () => { calls += 1; if (fail) throw new Error("writer-offline"); return first; },
  });
  const running = service.runRetention(new Date(now));
  service.stop();
  release({ ...empty, applicationMessagesDeleted: 100, hasMore: true });
  assert.equal((await running).applicationMessagesDeleted, 100);
  assert.equal(calls, 1);
  fail = true;
  await assert.rejects(service.runRetention(new Date(now)), /writer-offline/);
  assert.equal(calls, 2);
});
