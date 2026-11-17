import type Database from "better-sqlite3";
import { ensureAgentPersistenceSchema } from "../agent/AgentPersistenceSchema.js";
import { ensureDirectorySnapshotSchema } from "../directory/DirectorySnapshotSchema.js";
import { ensureActionExecutionSchema } from "../agent/ActionExecutionSchema.js";
import { materializeInvoiceSubjectCategory } from "./InvoiceSubjectCategory.js";

interface MailDatabaseMigration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

export interface MailDatabaseMigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: string[];
}

// The 1.0.0 release used canonical schema_version=6 but had no migration
// counter. An absent migration_version therefore starts at 0. Never rewrite
// an applied migration: update the fresh canonical schema and append a new one.
const migrations: readonly MailDatabaseMigration[] = [
  {
    version: 1,
    name: "1.0.0-baseline",
    up(db) {
      ensureAgentPersistenceSchema(db);
      ensureMailAiInitialCoverage(db);
      ensureMailJobIndexes(db);
      ensureInsightReportSchema(db);
    },
  },
  {
    version: 2,
    name: "ai-usage-provider",
    up(db) {
      addColumnIfMissing(db, "ai_usage", "provider", "TEXT");
    },
  },
  {
    version: 3,
    name: "llm-settings-free-trial",
    up(db) {
      addColumnIfMissing(db, "llm_settings", "free_trial", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "llm_settings", "free_trial_base_url", "TEXT");
      addColumnIfMissing(db, "llm_settings", "free_trial_model", "TEXT");
      addColumnIfMissing(db, "llm_settings", "free_trial_expires_at", "TEXT");
    },
  },
  {
    version: 4,
    name: "smart-topic-promotion-description",
    up(db) {
      addColumnIfMissing(db, "mail_smart_topics", "promotion_description", "TEXT");
    },
  },
  {
    version: 5,
    name: "ai-profile-todo-prompt",
    up(db) {
      addColumnIfMissing(db, "ai_profile_settings", "todo_prompt", "TEXT");
    },
  },
  {
    version: 6,
    name: "mcp-max-body-characters",
    up(db) {
      addColumnIfMissing(
        db,
        "mcp_settings",
        "max_body_characters",
        "INTEGER NOT NULL DEFAULT 20000 CHECK(max_body_characters BETWEEN 1 AND 1000000)",
      );
    },
  },
  {
    version: 7,
    name: "mcp-user-configurable-limits",
    up(db) {
      addColumnIfMissing(db, "mcp_settings", "default_body_characters", "INTEGER NOT NULL DEFAULT 6000 CHECK(default_body_characters BETWEEN 1 AND 1000000)");
      addColumnIfMissing(db, "mcp_settings", "default_page_size", "INTEGER NOT NULL DEFAULT 25 CHECK(default_page_size BETWEEN 1 AND 1000)");
      addColumnIfMissing(db, "mcp_settings", "max_page_size", "INTEGER NOT NULL DEFAULT 100 CHECK(max_page_size BETWEEN 1 AND 1000)");
      addColumnIfMissing(db, "mcp_settings", "max_recipients", "INTEGER NOT NULL DEFAULT 200 CHECK(max_recipients BETWEEN 1 AND 1000)");
      addColumnIfMissing(db, "mcp_settings", "max_batch_messages", "INTEGER NOT NULL DEFAULT 100 CHECK(max_batch_messages BETWEEN 1 AND 1000)");
      addColumnIfMissing(db, "mcp_settings", "max_pending_operations", "INTEGER NOT NULL DEFAULT 100 CHECK(max_pending_operations BETWEEN 1 AND 10000)");
      addColumnIfMissing(db, "mcp_settings", "tool_timeout_seconds", "INTEGER NOT NULL DEFAULT 30 CHECK(tool_timeout_seconds BETWEEN 1 AND 600)");
    },
  },
  {
    version: 8,
    name: "ai-worker-concurrency",
    up(db) {
      // Nullable: NULL means "no user preference" — the runtime falls back to
      // WEMAIL_AI_WORKER_CONCURRENCY (then AI_WORKER_CONCURRENCY_DEFAULT). The
      // CHECK only constrains non-null values.
      addColumnIfMissing(
        db,
        "ai_profile_settings",
        "worker_concurrency",
        "INTEGER CHECK(worker_concurrency BETWEEN 1 AND 16)",
      );
    },
  },
  {
    version: 9,
    name: "llm-reasoning-effort",
    up(db) {
      addColumnIfMissing(db, "llm_settings", "reasoning_effort", "TEXT");
    },
  },
  {
    version: 10,
    name: "cjk-mail-search-index",
    up(db) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS mail_search_cjk_fts USING fts5(
          account_terms,
          subject_terms,
          sender_terms,
          recipient_terms,
          body_terms,
          attachment_terms,
          summary_terms,
          content='',
          contentless_delete=1,
          tokenize='unicode61 remove_diacritics 2'
        );
      `);
      db.prepare(
        "INSERT INTO db_meta (key, value) VALUES ('cjk_search_index_version', '0') "
        + "ON CONFLICT(key) DO NOTHING",
      ).run();
    },
  },
  {
    version: 11,
    name: "mail-job-dispatch-order",
    up(db) {
      // All enqueue paths (including legacy jobs) share these ordering invariants.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_mail_jobs_expired_lease
          ON mail_jobs(lease_expires_at_ms, id) WHERE state = 'leased';
        ALTER TABLE mail_jobs ADD COLUMN sort_received_at_ms INTEGER NOT NULL DEFAULT -1;
        ALTER TABLE mail_jobs ADD COLUMN sort_message_id INTEGER NOT NULL DEFAULT -1;
        UPDATE mail_jobs SET
          sort_received_at_ms = COALESCE((SELECT received_at_ms FROM mail_messages
            WHERE public_id = mail_jobs.subject_public_id AND account_id = mail_jobs.account_id), -1),
          sort_message_id = COALESCE((SELECT id FROM mail_messages
            WHERE public_id = mail_jobs.subject_public_id AND account_id = mail_jobs.account_id), -1);
        CREATE INDEX idx_mail_jobs_dispatch_recency
          ON mail_jobs(job_kind, priority, sort_received_at_ms DESC, sort_message_id DESC, id DESC)
          WHERE state = 'pending';
        CREATE INDEX idx_mail_jobs_due
          ON mail_jobs(job_kind, available_at_ms) WHERE state = 'pending';

        CREATE TRIGGER mail_jobs_insert_sort AFTER INSERT ON mail_jobs BEGIN
          UPDATE mail_jobs SET
            sort_received_at_ms = COALESCE((SELECT received_at_ms FROM mail_messages
              WHERE public_id = NEW.subject_public_id AND account_id = NEW.account_id), -1),
            sort_message_id = COALESCE((SELECT id FROM mail_messages
              WHERE public_id = NEW.subject_public_id AND account_id = NEW.account_id), -1)
          WHERE id = NEW.id;
        END;
        CREATE TRIGGER mail_jobs_update_sort AFTER UPDATE OF subject_public_id, account_id ON mail_jobs BEGIN
          UPDATE mail_jobs SET
            sort_received_at_ms = COALESCE((SELECT received_at_ms FROM mail_messages
              WHERE public_id = NEW.subject_public_id AND account_id = NEW.account_id), -1),
            sort_message_id = COALESCE((SELECT id FROM mail_messages
              WHERE public_id = NEW.subject_public_id AND account_id = NEW.account_id), -1)
          WHERE id = NEW.id;
        END;
        CREATE TRIGGER mail_messages_insert_job_sort AFTER INSERT ON mail_messages BEGIN
          UPDATE mail_jobs SET sort_received_at_ms = NEW.received_at_ms, sort_message_id = NEW.id
          WHERE subject_public_id = NEW.public_id AND account_id = NEW.account_id;
        END;
        CREATE TRIGGER mail_messages_update_job_sort AFTER UPDATE OF received_at_ms ON mail_messages
        WHEN OLD.received_at_ms <> NEW.received_at_ms BEGIN
          UPDATE mail_jobs SET sort_received_at_ms = NEW.received_at_ms, sort_message_id = NEW.id
          WHERE subject_public_id = NEW.public_id AND account_id = NEW.account_id;
        END;
        CREATE TRIGGER mail_messages_delete_job_sort AFTER DELETE ON mail_messages BEGIN
          UPDATE mail_jobs SET sort_received_at_ms = -1, sort_message_id = -1
          WHERE subject_public_id = OLD.public_id AND account_id = OLD.account_id;
        END;
      `);
    },
  },

  {
    version: 12,
    name: "smart-tag-backfill-job-results",
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS mail_smart_tag_backfill_job_results (
        job_id INTEGER NOT NULL REFERENCES mail_jobs(id) ON DELETE CASCADE,
        run_id INTEGER NOT NULL REFERENCES mail_smart_tag_backfill_runs(id) ON DELETE CASCADE,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'terminal')),
        recorded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (job_id, run_id)
      ) STRICT;`);
    },
  },
  {
    version: 13,
    name: "incremental-mail-counts",
    up: ensureIncrementalMailCounts,
  },
  {
    version: 14,
    name: "bounded-retention-indexes",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_wecli_audit_retention ON wecli_audit_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_application_messages_retention ON application_messages(expires_at)
          WHERE expires_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_automation_previews_retention ON automation_rule_previews(expires_at);
        CREATE INDEX IF NOT EXISTS idx_automation_manifests_retention ON automation_run_manifests(expires_at)
          WHERE expires_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_automation_results_retention ON automation_result_envelopes(expires_at)
          WHERE expires_at IS NOT NULL AND status <> 'expired';
        CREATE INDEX IF NOT EXISTS idx_automation_step_details_retention ON automation_step_runs(expires_at)
          WHERE expires_at IS NOT NULL AND (
            input_summary_json IS NOT NULL OR output_summary_json IS NOT NULL OR output_json IS NOT NULL OR
            usage_json IS NOT NULL OR effect_evidence_json IS NOT NULL
          );
      `);
    },
  },
  { version: 15, name: "directory-snapshot-publication", up: ensureDirectorySnapshotSchema },
  {
    version: 16,
    name: "job-due-queue-indexes",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_mail_jobs_leased_due
          ON mail_jobs(job_kind, lease_expires_at_ms) WHERE state = 'leased';
        CREATE INDEX IF NOT EXISTS idx_mail_jobs_account_leased_due
          ON mail_jobs(job_kind, account_id, lease_expires_at_ms) WHERE state = 'leased';
        CREATE INDEX IF NOT EXISTS idx_mail_jobs_account_pending_due
          ON mail_jobs(job_kind, account_id, available_at_ms) WHERE state = 'pending';
      `);
    },
  },
  { version: 17, name: "confirmed-action-executions", up: ensureActionExecutionSchema },
  { version: 18, name: "action-upload-source-lookup", up(db) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_action_execution_source ON agent_action_execution_items(
      account_id,json_extract(data_json,'$.emailId'),json_extract(data_json,'$.attachmentId'),phase)`);
  } },
  { version: 19, name: "invoice-subject-category", up: materializeInvoiceSubjectCategory },
  { version: 20, name: "pending-flag-mutation-index", up(db) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mail_pending_flags_message
      ON mail_remote_mutations(message_id, id)
      WHERE mutation_kind = 'flags' AND state IN ('pending', 'leased')`);
  } },
  { version: 21, name: "smtp-delivery-result", up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS mail_message_delivery (
      message_id INTEGER PRIMARY KEY REFERENCES mail_messages(id) ON DELETE CASCADE,
      result_json TEXT NOT NULL
    ) STRICT`);
  } },
  { version: 22, name: "outbox-delivery-result", up(db) {
    addColumnIfMissing(db, "mail_outbox_items", "delivery_json", "TEXT");
  } },
  { version: 23, name: "draft-compose-type", up(db) {
    addColumnIfMissing(db, "mail_drafts", "compose_type", "TEXT CHECK(compose_type IN ('new','reply','forward'))");
  } },
  { version: 24, name: "outbox-reply-headers", up(db) {
    addColumnIfMissing(db, "mail_outbox_items", "reply_source_public_id", "TEXT");
    addColumnIfMissing(db, "mail_outbox_items", "reply_message_id", "TEXT");
    addColumnIfMissing(db, "mail_outbox_items", "reply_references_json", "TEXT");
  } },
];

export const MAIL_DATABASE_MIGRATION_VERSION = migrations.length;

export function runMailDatabaseMigrations(
  db: Database.Database,
): MailDatabaseMigrationResult {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`non-contiguous-mail-database-migration: ${migration.version}`);
    }
  });

  return db.transaction(() => {
    // Read the version only after BEGIN IMMEDIATE owns the write lock. This
    // prevents two startup processes from both applying the same migration.
    const fromVersion = readMigrationVersion(db);
    if (fromVersion > MAIL_DATABASE_MIGRATION_VERSION) {
      throw new Error(
        `incompatible-mail-database: mail-database-newer-than-app: `
        + `database migration ${fromVersion}, `
        + `app supports ${MAIL_DATABASE_MIGRATION_VERSION}`,
      );
    }

    const applied: string[] = [];
    for (const migration of migrations) {
      if (migration.version <= fromVersion) continue;
      migration.up(db);
      db.prepare(
        "INSERT INTO db_meta (key, value) VALUES ('migration_version', ?) "
        + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(migration.version));
      applied.push(`${migration.version}:${migration.name}`);
    }
    if (applied.length > 0) assertMigrationIntegrity(db);

    return {
      fromVersion,
      toVersion: MAIL_DATABASE_MIGRATION_VERSION,
      applied,
    };
  }).immediate();
}

function assertMigrationIntegrity(db: Database.Database): void {
  const quickCheck = db.pragma("quick_check") as Array<{ quick_check: string }>;
  const foreignKeyErrors = db.pragma("foreign_key_check") as Array<Record<string, unknown>>;
  if (
    quickCheck.length !== 1
    || quickCheck[0]?.quick_check !== "ok"
    || foreignKeyErrors.length > 0
  ) {
    throw new Error("mail-database-migration-integrity-check-failed");
  }
}

function readMigrationVersion(db: Database.Database): number {
  const row = db.prepare(
    "SELECT value FROM db_meta WHERE key = 'migration_version'",
  ).get() as { value: string } | undefined;
  if (!row) return 0;
  if (!/^\d+$/.test(row.value)) {
    throw new Error(
      `incompatible-mail-database: invalid-mail-database-migration-version: ${row.value}`,
    );
  }
  const version = Number(row.value);
  if (!Number.isSafeInteger(version)) {
    throw new Error(
      `incompatible-mail-database: invalid-mail-database-migration-version: ${row.value}`,
    );
  }
  return version;
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table);
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as Array<{ name?: unknown }>)
    .some((entry) => entry.name === column);
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  declaration: string,
): void {
  if (!tableExists(db, table)) {
    throw new Error(
      `incompatible-mail-database: mail-database-migration-missing-table: ${table}`,
    );
  }
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

function ensureMailJobIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mail_jobs_claim_kind
      ON mail_jobs(job_kind, priority ASC, available_at_ms ASC, id)
      WHERE state = 'pending';
    CREATE INDEX IF NOT EXISTS idx_mail_jobs_claim_kind_lifo
      ON mail_jobs(job_kind, priority ASC, id DESC)
      WHERE state = 'pending';
    CREATE INDEX IF NOT EXISTS idx_mail_jobs_subject_version
      ON mail_jobs(subject_public_id, job_kind, input_version);
    DROP INDEX IF EXISTS idx_mail_jobs_claim;
  `);
  db.prepare(
    "INSERT INTO db_meta (key, value) VALUES ('index_layout_version', '2') "
    + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run();
}

function ensureMailAiInitialCoverage(db: Database.Database): void {
  const hasScope = hasColumn(db, "mail_messages", "ai_initial_summary_scope");
  const hasLegacyEligibility = hasColumn(
    db,
    "mail_messages",
    "ai_initial_summary_eligible",
  );
  if (!hasScope) {
    db.exec(`ALTER TABLE mail_messages
      ADD COLUMN ai_initial_summary_scope INTEGER NOT NULL DEFAULT 0
        CHECK (ai_initial_summary_scope IN (0,1,2))`);
    if (hasLegacyEligibility) {
      db.exec(`UPDATE mail_messages
        SET ai_initial_summary_scope = CASE
          WHEN ai_initial_summary_eligible = 1 THEN 1 ELSE 0 END`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_ai_initial_coverage (
      account_id INTEGER PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
      finalized_at_ms INTEGER NOT NULL,
      row_version INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_mail_messages_initial_ai_summary
      ON mail_messages(account_id, ai_initial_summary_scope,
                       received_at_ms DESC, id DESC)
      WHERE deleted_at_ms IS NULL AND ai_initial_summary_scope = 1;
  `);
}

function ensureInsightReportSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS insight_reports (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      current_version INTEGER NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('single', 'multi')),
      title TEXT NOT NULL,
      application_message_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS insight_report_versions (
      report_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      recipe_json TEXT NOT NULL,
      dataset_json TEXT NOT NULL,
      preferences_json TEXT NOT NULL DEFAULT '{}',
      application_message_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(report_id, version),
      FOREIGN KEY(report_id) REFERENCES insight_reports(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS insight_report_sources (
      report_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      email_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      linked_at TEXT NOT NULL,
      superseded_at TEXT,
      FOREIGN KEY(report_id) REFERENCES insight_reports(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_insight_report_sources_email
      ON insight_report_sources(account_id, email_id, active);
    CREATE INDEX IF NOT EXISTS idx_insight_reports_account_updated
      ON insight_reports(account_id, updated_at DESC);
  `);
}

function ensureIncrementalMailCounts(db: Database.Database): void {
  const projections = [
    { source: "mail_messages", target: "mail_account_counts", keys: ["account_id"],
      active: "deleted_at_ms IS NULL", watched: ["account_id", "is_seen", "is_flagged", "deleted_at_ms"],
      values: { total_count: "1", unread_count: "is_seen = 0", flagged_count: "is_flagged = 1" } },
    { source: "mail_folder_memberships", target: "mail_folder_counts", keys: ["folder_id"],
      active: "1", watched: ["folder_id", "is_seen"],
      values: { total_count: "1", unread_count: "is_seen = 0" } },
    { source: "mail_message_system_categories", target: "mail_category_counts", keys: ["account_id", "category_id"],
      active: "1", watched: ["account_id", "category_id", "is_seen"],
      values: { total_count: "1", unread_count: "is_seen = 0" } },
    { source: "mail_message_user_tags", target: "mail_tag_counts", keys: ["account_id", "tag_id"],
      active: "1", watched: ["account_id", "tag_id", "is_seen"],
      values: { total_count: "1", unread_count: "is_seen = 0" } },
  ];
  for (const projection of projections) {
    const { source, target, keys, active, watched } = projection;
    const values = Object.entries(projection.values).filter((entry): entry is [string, string] => entry[1] !== undefined);
    const columns = [...keys, ...values.map(([column]) => column), "row_version"].join(", ");
    // Calibrate legacy counters once; all connections then maintain deltas transactionally.
    db.exec(`DELETE FROM ${target};
      INSERT INTO ${target} (${columns})
      SELECT ${keys.join(", ")}, ${values.map(([, value]) => `SUM(${value})`).join(", ")}, 1
      FROM ${source} WHERE ${active} GROUP BY ${keys.join(", ")};`);
    const qualify = (expression: string, row: "NEW" | "OLD") => expression.replace(
      /\b(is_seen|is_flagged|deleted_at_ms)\b/g, `${row}.$1`,
    );
    const add = `INSERT INTO ${target} (${columns})
      SELECT ${keys.map((key) => `NEW.${key}`).join(", ")},
        ${values.map(([, value]) => `(${qualify(value, "NEW")})`).join(", ")}, 1
      WHERE ${qualify(active, "NEW")}
      ON CONFLICT (${keys.join(", ")}) DO UPDATE SET
        ${values.map(([column]) => `${column} = ${column} + excluded.${column}`).join(", ")},
        row_version = row_version + 1;`;
    const remove = `UPDATE ${target} SET
      ${values.map(([column, value]) => `${column} = ${column} - (${qualify(value, "OLD")})`).join(", ")},
      row_version = row_version + 1
      WHERE ${keys.map((key) => `${key} = OLD.${key}`).join(" AND ")}
        AND (${qualify(active, "OLD")});`;
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${source}_counts_insert AFTER INSERT ON ${source} BEGIN ${add} END;
      CREATE TRIGGER IF NOT EXISTS ${source}_counts_delete AFTER DELETE ON ${source} BEGIN ${remove} END;
      CREATE TRIGGER IF NOT EXISTS ${source}_counts_update AFTER UPDATE OF ${watched.join(", ")} ON ${source}
      WHEN ${watched.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")}
      BEGIN ${remove} ${add} END;
    `);
  }
}
