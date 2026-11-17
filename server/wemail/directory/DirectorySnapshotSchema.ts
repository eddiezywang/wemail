import type { MailDatabase } from "../database/Database.js";

export function ensureDirectorySnapshotSchema(db: MailDatabase): void {
  const columns = db.pragma("table_info(directory_contacts)") as Array<{ name: string }>;
  if (columns.some((column) => column.name === "snapshot_id")) return;
  db.exec(`
    ALTER TABLE directory_contacts RENAME TO directory_contacts_legacy;
    ALTER TABLE directory_departments RENAME TO directory_departments_legacy;
    ALTER TABLE directory_contacts_fts RENAME TO directory_contacts_fts_legacy;
    DROP INDEX idx_directory_contacts_email;
    DROP INDEX idx_directory_contacts_department;
    DROP INDEX idx_directory_departments_parent;
    CREATE TABLE directory_contacts (
      storage_id INTEGER PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES mail_accounts(public_id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL DEFAULT 'legacy', id TEXT NOT NULL,
      name TEXT NOT NULL, email TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]',
      department_id TEXT, department_path TEXT, title TEXT, full_pinyin TEXT,
      mobile TEXT, company_phone TEXT, synced_at TEXT NOT NULL,
      pinyin_initials TEXT NOT NULL DEFAULT '', pinyin_index_version INTEGER NOT NULL DEFAULT 0,
      UNIQUE(account_id, snapshot_id, id)
    );
    INSERT INTO directory_contacts (
      account_id, id, name, email, aliases_json, department_id, department_path,
      title, full_pinyin, mobile, company_phone, synced_at, pinyin_initials, pinyin_index_version
    ) SELECT account_id, id, name, email, aliases_json, department_id, department_path,
      title, full_pinyin, mobile, company_phone, synced_at, pinyin_initials, pinyin_index_version
      FROM directory_contacts_legacy;
    CREATE UNIQUE INDEX idx_directory_contacts_email
      ON directory_contacts(account_id, snapshot_id, email COLLATE NOCASE);
    CREATE INDEX idx_directory_contacts_lookup ON directory_contacts(account_id, email COLLATE NOCASE, snapshot_id);
    CREATE INDEX idx_directory_contacts_department ON directory_contacts(account_id, department_id, snapshot_id);
    CREATE INDEX idx_directory_contacts_pinyin ON directory_contacts(account_id, pinyin_index_version, snapshot_id);
    CREATE TABLE directory_departments (
      account_id TEXT NOT NULL REFERENCES mail_accounts(public_id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL DEFAULT 'legacy', id TEXT NOT NULL, parent_id TEXT,
      name TEXT NOT NULL, path TEXT NOT NULL, child_count INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL, PRIMARY KEY(account_id, snapshot_id, id)
    );
    INSERT INTO directory_departments(account_id, id, parent_id, name, path, child_count, synced_at)
      SELECT account_id, id, parent_id, name, path, child_count, synced_at FROM directory_departments_legacy;
    CREATE INDEX idx_directory_departments_parent ON directory_departments(account_id, snapshot_id, parent_id);
    CREATE VIRTUAL TABLE directory_contacts_fts USING fts5(
      account_id UNINDEXED, contact_id UNINDEXED, search_text, tokenize='trigram'
    );
    -- FTS UNINDEXED columns cannot support a keyed join; materialize once to avoid a scan per contact.
    CREATE TEMP TABLE directory_legacy_search (
      account_id TEXT NOT NULL, contact_id TEXT NOT NULL, search_text TEXT,
      PRIMARY KEY(account_id, contact_id)
    ) WITHOUT ROWID;
    INSERT INTO directory_legacy_search
      SELECT account_id, contact_id, GROUP_CONCAT(search_text, ' ')
      FROM directory_contacts_fts_legacy
      WHERE account_id IS NOT NULL AND contact_id IS NOT NULL GROUP BY account_id, contact_id;
    INSERT INTO directory_contacts_fts(rowid, account_id, contact_id, search_text)
      SELECT c.storage_id, c.account_id, c.id, COALESCE(f.search_text,
        c.name || ' ' || c.email || ' ' || c.aliases_json || ' ' || COALESCE(c.full_pinyin, '') || ' ' || c.pinyin_initials)
      FROM directory_contacts c LEFT JOIN directory_legacy_search f
        ON f.account_id = c.account_id AND f.contact_id = c.id;
    DROP TABLE temp.directory_legacy_search;
    DROP TABLE directory_contacts_fts_legacy;
    DROP TABLE directory_contacts_legacy;
    DROP TABLE directory_departments_legacy;
    CREATE TRIGGER directory_contacts_delete_fts AFTER DELETE ON directory_contacts BEGIN
      DELETE FROM directory_contacts_fts WHERE rowid = OLD.storage_id;
    END;
    CREATE TABLE directory_snapshots (
      account_id TEXT NOT NULL REFERENCES mail_accounts(public_id) ON DELETE CASCADE,
      id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active', 'staging', 'retired')),
      department_count INTEGER NOT NULL DEFAULT 0, contact_count INTEGER NOT NULL DEFAULT 0,
      received_departments INTEGER NOT NULL DEFAULT 0, received_contacts INTEGER NOT NULL DEFAULT 0,
      sequence INTEGER NOT NULL DEFAULT 0, expires_at_ms INTEGER,
      PRIMARY KEY(account_id, id)
    );
    CREATE INDEX idx_directory_snapshots_state ON directory_snapshots(state, expires_at_ms, account_id, id);
    CREATE UNIQUE INDEX idx_directory_snapshots_active ON directory_snapshots(account_id) WHERE state = 'active';
    CREATE UNIQUE INDEX idx_directory_snapshots_staging ON directory_snapshots(account_id) WHERE state = 'staging';
    CREATE TABLE directory_snapshot_heads (
      account_id TEXT PRIMARY KEY REFERENCES mail_accounts(public_id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL
    );
    INSERT INTO directory_snapshots(account_id, id, state)
      SELECT public_id, 'legacy', 'active' FROM mail_accounts;
    INSERT INTO directory_snapshot_heads(account_id, snapshot_id)
      SELECT public_id, 'legacy' FROM mail_accounts;
    CREATE VIEW directory_active_contacts AS SELECT c.* FROM directory_contacts c
      WHERE c.snapshot_id = COALESCE((SELECT h.snapshot_id FROM directory_snapshot_heads h WHERE h.account_id = c.account_id), 'legacy');
    CREATE VIEW directory_active_departments AS SELECT d.* FROM directory_departments d
      WHERE d.snapshot_id = COALESCE((SELECT h.snapshot_id FROM directory_snapshot_heads h WHERE h.account_id = d.account_id), 'legacy');
  `);
}
