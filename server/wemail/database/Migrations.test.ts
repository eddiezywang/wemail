import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMailDatabase } from "./Database.js";
import { insertCanonicalTestAccount, insertCanonicalTestMessage } from "./MailDatabase.test-support.js";
import {
  MAIL_DATABASE_MIGRATION_VERSION,
  runMailDatabaseMigrations,
} from "./Migrations.js";

test("invoice subject upgrade repairs historical membership and counts once", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-invoice-migration-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    insertCanonicalTestAccount(db, { id: "invoice-account" });
    insertCanonicalTestMessage(db, { id: "invoice-mail", accountId: "invoice-account", subject: "电子发票通知" });
    insertCanonicalTestMessage(db, { id: "ordinary-mail", accountId: "invoice-account", subject: "支付收据" });
    insertCanonicalTestMessage(db, { id: "deleted-mail", accountId: "invoice-account", subject: "发票" });
    db.exec("UPDATE mail_messages SET deleted_at_ms = 1 WHERE public_id = 'deleted-mail'");
    db.exec("UPDATE db_meta SET value = '18' WHERE key = 'migration_version'");
    assert.deepEqual(runMailDatabaseMigrations(db).applied, ["19:invoice-subject-category"]);
    assert.deepEqual(db.prepare(`SELECT messages.public_id, membership.source
      FROM mail_message_system_categories membership
      JOIN mail_messages messages ON messages.id = membership.message_id`).all(),
    [{ public_id: "invoice-mail", source: "rule" }]);
    assert.deepEqual(db.prepare("SELECT total_count, unread_count FROM mail_category_counts WHERE total_count > 0").get(),
      { total_count: 1n, unread_count: 1n });
    assert.deepEqual(runMailDatabaseMigrations(db).applied, []);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates a 1.0.0-shaped schema once without replacing user data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-migration-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    db.exec(`
      INSERT INTO llm_settings (
        id, provider, default_model, created_at, updated_at
      ) VALUES ('existing-settings', 'openai', 'existing-model', 'before', 'before');
      ALTER TABLE ai_usage DROP COLUMN provider;
      ALTER TABLE llm_settings DROP COLUMN free_trial;
      ALTER TABLE llm_settings DROP COLUMN free_trial_base_url;
      ALTER TABLE llm_settings DROP COLUMN free_trial_model;
      ALTER TABLE llm_settings DROP COLUMN free_trial_expires_at;
      ALTER TABLE llm_settings DROP COLUMN reasoning_effort;
      ALTER TABLE mail_smart_topics DROP COLUMN promotion_description;
      ALTER TABLE ai_profile_settings DROP COLUMN todo_prompt;
      ALTER TABLE mcp_settings DROP COLUMN default_body_characters;
      ALTER TABLE mcp_settings DROP COLUMN max_body_characters;
      ALTER TABLE mcp_settings DROP COLUMN default_page_size;
      ALTER TABLE mcp_settings DROP COLUMN max_page_size;
      ALTER TABLE mcp_settings DROP COLUMN max_recipients;
      ALTER TABLE mcp_settings DROP COLUMN max_batch_messages;
      ALTER TABLE mcp_settings DROP COLUMN max_pending_operations;
      ALTER TABLE mcp_settings DROP COLUMN tool_timeout_seconds;
      DROP TABLE insight_report_sources;
      DROP TABLE insight_report_versions;
      DROP TABLE insight_reports;
      DELETE FROM db_meta WHERE key = 'migration_version';
      DROP INDEX idx_mail_jobs_expired_lease;
      DROP TABLE mail_smart_tag_backfill_job_results;
      DROP INDEX idx_mail_jobs_dispatch_recency;
      DROP INDEX idx_mail_jobs_due;
      DROP TRIGGER mail_jobs_insert_sort;
      DROP TRIGGER mail_jobs_update_sort;
      DROP TRIGGER mail_messages_insert_job_sort;
      DROP TRIGGER mail_messages_update_job_sort;
      DROP TRIGGER mail_messages_delete_job_sort;
      ALTER TABLE mail_jobs DROP COLUMN sort_received_at_ms;
      ALTER TABLE mail_jobs DROP COLUMN sort_message_id;
      INSERT INTO db_meta (key, value) VALUES ('migration_test_sentinel', 'preserved');
    `);
    insertCanonicalTestAccount(db, { id: "migration-account" });
    insertCanonicalTestMessage(db, {
      id: "migration-message", accountId: "migration-account", receivedAtMs: 1234,
    });
    db.exec(`
      INSERT INTO mail_jobs (
        public_id, account_id, job_kind, subject_kind, subject_public_id,
        dedupe_key, payload_json, priority, state, attempt_count, max_attempts,
        available_at_ms, input_version, created_at_ms, updated_at_ms, row_version
      ) SELECT 'migration-job', id, 'ai.summary', 'message', 'migration-message',
        'migration-job', '{}', 1, 'pending', 0, 5, 0, 1, 0, 0, 1
        FROM mail_accounts WHERE public_id = 'migration-account';
    `);

    const first = runMailDatabaseMigrations(db);
    assert.equal(first.fromVersion, 0);
    assert.equal(first.toVersion, MAIL_DATABASE_MIGRATION_VERSION);
    assert.equal(first.applied.length, MAIL_DATABASE_MIGRATION_VERSION);
    assert.equal(meta(db, "migration_test_sentinel"), "preserved");
    assert.equal(meta(db, "migration_version"), String(MAIL_DATABASE_MIGRATION_VERSION));
    assert.equal(db.prepare("SELECT sort_received_at_ms FROM mail_jobs WHERE public_id = 'migration-job'")
      .pluck().get(), 1234n);
    const leasePlan = db.prepare(`
      EXPLAIN QUERY PLAN SELECT id FROM mail_jobs
      WHERE state = 'leased' AND lease_expires_at_ms <= 0
      ORDER BY lease_expires_at_ms, id LIMIT 50
    `).all() as Array<{ detail: string }>;
    assert.ok(leasePlan.some((row) => row.detail.includes("idx_mail_jobs_expired_lease")));
    const dispatchPlan = db.prepare(`
      EXPLAIN QUERY PLAN SELECT id FROM mail_jobs INDEXED BY idx_mail_jobs_dispatch_recency
      WHERE state = 'pending' AND job_kind = 'ai.summary' AND available_at_ms <= 0
      ORDER BY priority, sort_received_at_ms DESC, sort_message_id DESC, id DESC LIMIT 1
    `).all() as Array<{ detail: string }>;
    assert.ok(dispatchPlan.some((row) => row.detail.includes("idx_mail_jobs_dispatch_recency")));
    assert.ok(dispatchPlan.every((row) => !row.detail.includes("TEMP B-TREE")));
    assert.ok(columns(db, "ai_usage").includes("provider"));
    for (const column of [
      "free_trial",
      "free_trial_base_url",
      "free_trial_model",
      "free_trial_expires_at",
      "reasoning_effort",
    ]) {
      assert.ok(columns(db, "llm_settings").includes(column));
    }
    assert.ok(columns(db, "mail_smart_topics").includes("promotion_description"));
    assert.ok(columns(db, "ai_profile_settings").includes("todo_prompt"));
    for (const column of ["default_body_characters", "max_body_characters", "default_page_size", "max_page_size", "max_recipients", "max_batch_messages", "max_pending_operations", "tool_timeout_seconds"]) {
      assert.ok(columns(db, "mcp_settings").includes(column));
    }
    assert.equal(tableExists(db, "insight_reports"), true);
    assert.deepEqual(
      db.prepare(
        "SELECT provider, default_model FROM llm_settings WHERE id = 'existing-settings'",
      ).get(),
      { provider: "openai", default_model: "existing-model" },
    );

    const second = runMailDatabaseMigrations(db);
    assert.deepEqual(second.applied, []);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a database migrated by a newer app", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-migration-newer-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    db.prepare("UPDATE db_meta SET value = ? WHERE key = 'migration_version'")
      .run(String(MAIL_DATABASE_MIGRATION_VERSION + 1));
    assert.throws(
      () => runMailDatabaseMigrations(db),
      /mail-database-newer-than-app/,
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rolls back the complete migration chain when one migration fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-migration-rollback-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    db.exec(`
      DROP TABLE insight_report_sources;
      DROP TABLE insight_report_versions;
      DROP TABLE insight_reports;
      DROP TABLE ai_usage;
      DELETE FROM db_meta WHERE key = 'migration_version';
    `);

    assert.throws(
      () => runMailDatabaseMigrations(db),
      /mail-database-migration-missing-table: ai_usage/,
    );
    assert.equal(meta(db, "migration_version"), undefined);
    assert.equal(tableExists(db, "insight_reports"), false);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function columns(db: ReturnType<typeof createMailDatabase>, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>)
    .map((entry) => entry.name);
}

function meta(db: ReturnType<typeof createMailDatabase>, key: string): string | undefined {
  return db.prepare("SELECT value FROM db_meta WHERE key = ?").pluck().get(key) as
    | string
    | undefined;
}

function tableExists(db: ReturnType<typeof createMailDatabase>, table: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table);
}
