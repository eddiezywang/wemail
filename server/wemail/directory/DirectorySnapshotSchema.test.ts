import assert from "node:assert/strict";
import test from "node:test";
import { openMailDatabase } from "../database/Database.js";
import { ensureDirectorySnapshotSchema } from "./DirectorySnapshotSchema.js";
import { DirectoryRepository } from "./DirectoryRepository.js";

test("snapshot migration preserves legacy names, aliases, departments and missing or duplicate FTS entries", () => {
  const db = openMailDatabase(":memory:", { safeIntegers: false });
  try {
    db.pragma("foreign_keys = ON");
    db.exec(`CREATE TABLE mail_accounts(public_id TEXT PRIMARY KEY);
      INSERT INTO mail_accounts VALUES ('account');
      CREATE TABLE directory_contacts(account_id TEXT, id TEXT, name TEXT, email TEXT, aliases_json TEXT,
        department_id TEXT, department_path TEXT, title TEXT, full_pinyin TEXT, mobile TEXT, company_phone TEXT,
        synced_at TEXT, pinyin_initials TEXT, pinyin_index_version INTEGER, PRIMARY KEY(account_id, id));
      CREATE UNIQUE INDEX idx_directory_contacts_email ON directory_contacts(account_id, email);
      CREATE INDEX idx_directory_contacts_department ON directory_contacts(account_id, department_id);
      CREATE TABLE directory_departments(account_id TEXT, id TEXT, parent_id TEXT, name TEXT, path TEXT,
        child_count INTEGER, synced_at TEXT, PRIMARY KEY(account_id, id));
      CREATE INDEX idx_directory_departments_parent ON directory_departments(account_id, parent_id);
      CREATE VIRTUAL TABLE directory_contacts_fts USING fts5(account_id UNINDEXED, contact_id UNINDEXED, search_text, tokenize='trigram');
      INSERT INTO directory_departments VALUES ('account', 'dept', NULL, 'Department', 'Department', 0, 'before');
      INSERT INTO directory_contacts VALUES ('account', 'one', '张三', 'one@example.com', '["alias@example.com"]',
        'dept', 'Department', 'Engineer', 'zhangsan', NULL, NULL, 'before', 'zs', 1);
      INSERT INTO directory_contacts VALUES ('account', 'two', '李四', 'two@example.com', '[]',
        'dept', 'Department', NULL, 'lisi', NULL, NULL, 'before', 'ls', 1);
      INSERT INTO directory_contacts_fts VALUES ('account', 'one', 'old-custom-term');
      INSERT INTO directory_contacts_fts VALUES ('account', 'one', 'another-search-term');`);
    db.transaction(() => ensureDirectorySnapshotSchema(db))();
    const repository = new DirectoryRepository(db);
    assert.equal(repository.findByEmail("account", "alias@example.com")?.name, "张三");
    assert.equal(repository.searchContacts("account", "old-custom-term")[0]?.id, "one");
    assert.equal(repository.searchContacts("account", "another-search-term")[0]?.id, "one");
    assert.equal(repository.searchContacts("account", "lisi")[0]?.id, "two");
    assert.equal(repository.listDepartments("account")[0]?.id, "dept");
    assert.equal(db.prepare("SELECT COUNT(*) FROM directory_contacts_fts").pluck().get(), 2);
    assert.equal(db.prepare("SELECT COUNT(*) FROM sqlite_temp_master WHERE name = 'directory_legacy_search'").pluck().get(), 0);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.deepEqual(db.pragma("quick_check"), [{ quick_check: "ok" }]);
    ensureDirectorySnapshotSchema(db);
    assert.equal(repository.countContacts("account", ""), 2);
    db.prepare("DELETE FROM mail_accounts WHERE public_id = 'account'").run();
    assert.equal(db.prepare("SELECT COUNT(*) FROM directory_contacts_fts").pluck().get(), 0);
  } finally { db.close(); }
});
