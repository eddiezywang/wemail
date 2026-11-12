import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createMailDatabase } from "../database/Database.js";
import { DirectoryRepository } from "./DirectoryRepository.js";
import { DirectoryService } from "./DirectoryService.js";
import { TEST_DIRECTORY_PINYIN } from "./DirectoryPinyin.test-support.js";
import { randomUUID } from "node:crypto";
import { MailDatabaseWriter } from "../database/MailDatabaseWriter.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMailDatabase } from "../database/Database.js";

function setup() {
  const db = createMailDatabase(":memory:", { safeIntegers: false });
  insertCanonicalTestAccount(db, { id: "acct-1", email: "me@corp.example" });
  const repository = new DirectoryRepository(db, () => "2026-01-02T00:00:00.000Z", TEST_DIRECTORY_PINYIN);
  repository.replaceSnapshot(
    "acct-1",
    [
      { id: "root/a", name: "支付平台部", path: "科技事业部/支付平台部", childCount: 0 },
      { id: "root/b", name: "零售平台部", path: "科技事业部/零售平台部", childCount: 0 },
    ],
    [
      { id: "u1", name: "张三", email: "zhangsan1@corp.example", aliases: [], departmentId: "root/a", departmentPath: "科技事业部/支付平台部", title: "开发工程师" },
      { id: "u2", name: "张三", email: "zhangsan2@corp.example", aliases: ["zs2@corp.example"], departmentId: "root/b", departmentPath: "科技事业部/零售平台部", title: "产品经理" },
    ],
  );
  return { db, repository };
}

test("staged directory snapshots publish only complete ordered chunks and preserve old data on rollback", () => {
  const { db, repository } = setup();
  const writer = new MailDatabaseWriter(db, { pinyin: TEST_DIRECTORY_PINYIN });
  const identity = { accountId: "acct-1", snapshotId: randomUUID() };
  const commit = () => writer.writeDirectory({ operation: "commitSnapshot", ...identity });
  try {
    writer.writeDirectory({ operation: "beginSnapshot", ...identity, departmentCount: 0, contactCount: 1 });
    assert.throws(commit, /incomplete/);
    assert.equal(repository.countContacts("acct-1", ""), 2);
    const chunk = { operation: "appendSnapshot" as const, ...identity, sequence: 0,
      departments: [], contacts: [{ id: "new", name: "徐伟", email: "new@corp.example", aliases: [] }] };
    writer.writeDirectory(chunk);
    assert.throws(() => writer.writeDirectory(chunk), /invalid-chunk/);
    writer.writeDirectory({ operation: "abortSnapshot", accountId: "acct-1", snapshotId: randomUUID() });
    db.exec(`CREATE TRIGGER reject_directory_contact BEFORE UPDATE ON directory_snapshot_heads
      BEGIN SELECT RAISE(ABORT, 'directory-test-failure'); END;`);
    assert.throws(commit, /directory-test-failure/);
    assert.equal(repository.countContacts("acct-1", ""), 2);
    assert.equal(repository.searchContacts("acct-1", "zhang").length, 2);
    db.exec("DROP TRIGGER reject_directory_contact");
    commit();
    assert.equal(repository.countContacts("acct-1", ""), 1);
    assert.equal(repository.searchContacts("acct-1", "xuwei")[0]?.id, "new");
  } finally { db.close(); }
});

test("a newer snapshot session rejects stale publication and unknown accounts", () => {
  const { db, repository } = setup();
  const writer = new MailDatabaseWriter(db, { pinyin: TEST_DIRECTORY_PINYIN });
  const first = { accountId: "acct-1", snapshotId: randomUUID() };
  const second = { accountId: "acct-1", snapshotId: randomUUID() };
  try {
    for (const identity of [first, second]) writer.writeDirectory({
      operation: "beginSnapshot", ...identity, departmentCount: 0, contactCount: 0,
    });
    assert.throws(() => writer.writeDirectory({ operation: "commitSnapshot", ...first }), /replaced/);
    assert.equal(repository.countContacts("acct-1", ""), 2);
    writer.writeDirectory({ operation: "abortSnapshot", ...second });
    assert.throws(() => writer.writeDirectory({ operation: "commitSnapshot", ...second }), /expired/);
    assert.throws(() => writer.writeDirectory({ operation: "beginSnapshot", accountId: "missing",
      snapshotId: randomUUID(), departmentCount: 0, contactCount: 0 }), /account-not-found/);
  } finally { db.close(); }
});

test("an expired snapshot cannot replace the last committed directory", () => {
  const { db } = setup();
  let now = new Date("2026-01-02T00:00:00.000Z");
  const repository = new DirectoryRepository(db, () => now.toISOString(), TEST_DIRECTORY_PINYIN);
  const identity = { accountId: "acct-1", snapshotId: randomUUID() };
  try {
    repository.write({ operation: "beginSnapshot", ...identity, departmentCount: 0, contactCount: 0 });
    now = new Date(now.getTime() + 300_000);
    assert.throws(() => repository.write({ operation: "commitSnapshot", ...identity }), /expired/);
    assert.equal(repository.countContacts("acct-1", ""), 2);
  } finally { db.close(); }
});

test("publication switches metadata without inserting or deleting contact rows", () => {
  const { db, repository } = setup();
  const identity = { accountId: "acct-1", snapshotId: randomUUID() };
  try {
    repository.write({ operation: "beginSnapshot", ...identity, departmentCount: 0, contactCount: 1 });
    repository.write({ operation: "appendSnapshot", ...identity, sequence: 0, departments: [], contacts: [
      { id: "new", name: "New", email: "new@corp.example", aliases: [] },
    ] });
    assert.equal(repository.countContacts("acct-1", ""), 2);
    db.exec(`CREATE TRIGGER forbid_contact_insert BEFORE INSERT ON directory_contacts BEGIN SELECT RAISE(ABORT, 'bulk-insert'); END;
      CREATE TRIGGER forbid_contact_delete BEFORE DELETE ON directory_contacts BEGIN SELECT RAISE(ABORT, 'bulk-delete'); END;`);
    repository.write({ operation: "commitSnapshot", ...identity });
    repository.write({ operation: "commitSnapshot", ...identity });
    assert.equal(repository.countContacts("acct-1", ""), 1);
    assert.equal(repository.findByEmail("acct-1", "zhangsan1@corp.example"), null);
    assert.equal(db.prepare("SELECT COUNT(*) FROM directory_contacts").pluck().get(), 3);
  } finally { db.close(); }
});

test("snapshot staging survives reopening and old reader transactions remain consistent through cleanup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-directory-snapshot-"));
  const filename = path.join(directory, "mail.sqlite");
  let db = createMailDatabase(filename, { safeIntegers: false });
  let reader: ReturnType<typeof openMailDatabase> | undefined;
  try {
    insertCanonicalTestAccount(db, { id: "acct-1" });
    let repository = new DirectoryRepository(db, undefined, TEST_DIRECTORY_PINYIN);
    repository.replaceSnapshot("acct-1", [], [{ id: "old", name: "Old", email: "old@corp.example", aliases: [] }]);
    const identity = { accountId: "acct-1", snapshotId: randomUUID() };
    repository.write({ operation: "beginSnapshot", ...identity, departmentCount: 0, contactCount: 2 });
    repository.write({ operation: "appendSnapshot", ...identity, sequence: 0, departments: [], contacts: [
      { id: "one", name: "New", email: "one@corp.example", aliases: [] },
    ] });
    db.close();
    db = openMailDatabase(filename, { safeIntegers: false });
    repository = new DirectoryRepository(db, undefined, TEST_DIRECTORY_PINYIN);
    assert.equal(repository.findByEmail("acct-1", "one@corp.example"), null);
    repository.write({ operation: "appendSnapshot", ...identity, sequence: 1, departments: [], contacts: [
      { id: "two", name: "New", email: "two@corp.example", aliases: [] },
    ] });
    reader = openMailDatabase(filename, { readonly: true, safeIntegers: false });
    const query = new DirectoryRepository(reader, undefined, TEST_DIRECTORY_PINYIN);
    reader.transaction(() => {
      assert.equal(query.countContacts("acct-1", ""), 1);
      repository.write({ operation: "commitSnapshot", ...identity });
      repository.write({ operation: "cleanupSnapshots" });
      assert.equal(query.findByEmail("acct-1", "old@corp.example")?.id, "old");
      assert.equal(query.countContacts("acct-1", ""), 1);
    })();
    assert.equal(query.countContacts("acct-1", ""), 2);
    assert.equal(query.findByEmail("acct-1", "old@corp.example"), null);
  } finally { reader?.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("snapshot cleanup bounds each table and preserves active and unexpired staging rows", () => {
  const { db, repository } = setup();
  try {
    repository.replaceSnapshot("acct-1", [], Array.from({ length: 205 }, (_, index) => ({
      id: String(index), name: "Old", email: `${index}@corp.example`, aliases: [],
    })));
    repository.replaceSnapshot("acct-1", [], [{ id: "active", name: "Active", email: "active@corp.example", aliases: [] }]);
    const identity = { accountId: "acct-1", snapshotId: randomUUID() };
    repository.write({ operation: "beginSnapshot", ...identity, departmentCount: 0, contactCount: 1 });
    repository.write({ operation: "appendSnapshot", ...identity, sequence: 0, departments: [], contacts: [
      { id: "staging", name: "Staging", email: "staging@corp.example", aliases: [] },
    ] });
    const physicalCount = () => Number(db.prepare("SELECT COUNT(*) FROM directory_contacts").pluck().get());
    const before = physicalCount();
    assert.equal(repository.write({ operation: "cleanupSnapshots" }), 100);
    assert.equal(before - physicalCount(), 100);
    while (repository.write({ operation: "cleanupSnapshots" }) === 100) {}
    assert.equal(physicalCount(), 2);
    assert.equal(repository.findByEmail("acct-1", "active@corp.example")?.id, "active");
    assert.equal(repository.findByEmail("acct-1", "staging@corp.example"), null);
    assert.equal(db.prepare("SELECT COUNT(*) FROM directory_contacts_fts").pluck().get(), 2);
  } finally { db.close(); }
});

test("pinyin migration is bounded to one hundred contacts per writer request", () => {
  const { db, repository } = setup();
  try {
    repository.replaceSnapshot("acct-1", [], Array.from({ length: 205 }, (_, index) => ({
      id: String(index), name: "徐伟", email: `test-${index}@corp.example`, aliases: [],
    })));
    db.exec("UPDATE directory_contacts SET pinyin_index_version = 0");
    const writer = new MailDatabaseWriter(db, { pinyin: TEST_DIRECTORY_PINYIN });
    assert.deepEqual(Array.from({ length: 4 }, () => writer.writeDirectory({
      operation: "indexPinyinBatch", accountId: "acct-1",
    })), [100, 100, 5, 0]);
    assert.equal(repository.searchContacts("acct-1", "xuwei", { limit: 300 }).length, 205);
  } finally { db.close(); }
});

test("directory initialization waits for remote batches and never falls back after writer failure", async () => {
  const { db, repository } = setup();
  let calls = 0;
  let warmed = false;
  repository.write = () => { throw new Error("main-thread write"); };
  const service = new DirectoryService({
    repository, accounts: { getCurrentAccount: () => ({ id: "acct-1", emailAddress: "me@corp.example" }) } as never,
    secrets: { getSecret: () => "secret" } as never,
    clientFactory: () => ({ warmup: async () => { warmed = true; } }) as never,
    mailDatabase: { async writeDirectory(input) {
      assert.equal(input.operation, "indexPinyinBatch");
      calls += 1;
      if (calls === 1) return 100;
      throw new Error("writer unavailable");
    } },
  });
  try {
    await assert.rejects(service.initialize("acct-1"), /writer unavailable/);
    assert.equal(calls, 2);
    assert.equal(warmed, false);
  } finally { db.close(); }
});

test("directory refresh publishes availability only after asynchronous snapshot commit", async () => {
  const { db, repository } = setup();
  const persist = repository.write.bind(repository);
  repository.write = () => { throw new Error("main-thread write"); };
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const committing = new Promise<void>((resolve) => { entered = resolve; });
  const available: string[] = [];
  const service = new DirectoryService({
    repository, accounts: { getCurrentAccount: () => ({ id: "acct-1", emailAddress: "me@corp.example" }) } as never,
    secrets: { getSecret: () => "secret" } as never,
    internalDomain: "@corp.example",
    clientFactory: () => ({
      getDirectories: async () => [{ id: "department", name: "Department", childCount: 0 }],
      listContacts: async () => ({ contacts: [{ "@id": "new", true_name: "徐伟", email: "new@corp.example" }] }),
    }) as never,
    mailDatabase: { async writeDirectory(input) {
      if (input.operation === "replaceSnapshot") { entered(); await gate; }
      return persist(input);
    } },
  });
  service.onSnapshotAvailable((accountId) => available.push(accountId));
  try {
    const refreshing = service.refresh("acct-1");
    await committing;
    assert.equal(repository.countContacts("acct-1", ""), 2);
    assert.deepEqual(available, []);
    release();
    assert.equal((await refreshing).state, "completed");
    assert.equal(repository.countContacts("acct-1", ""), 1);
    assert.deepEqual(available, ["acct-1"]);
  } finally { release(); db.close(); }
});

test("directory domain reads remain read-only and preserve account and page scope", () => {
  const { db, repository } = setup();
  try {
    db.defaultSafeIntegers(true);
    db.pragma("query_only = ON");
    const page = repository.read({ operation: "searchContacts", accountId: "acct-1", query: "张三", options: { limit: 1 } });
    assert.ok(page && "contacts" in page);
    assert.equal(page.contacts.length, 1);
    assert.equal(page.total, 2);
    assert.equal(repository.read({ operation: "getContact", accountId: "other", idOrEmail: "zhangsan1@corp.example" }), null);
    assert.equal((repository.read({ operation: "listDepartments", accountId: "acct-1" }) as Array<{ childCount: number }>)[0]?.childCount, 0);
    assert.doesNotThrow(() => JSON.stringify(repository.read({ operation: "getStatus", accountId: "acct-1" })));
    assert.throws(() => repository.read({ operation: "searchContacts", accountId: "acct-1", query: "", options: { limit: 1_001 } }));
  } finally { db.close(); }
});

test("configured directory readers never fall back to main-thread SQL on failure", async () => {
  const { db, repository } = setup();
  repository.read = () => { throw new Error("main-thread read"); };
  const service = new DirectoryService({ repository, accounts: {} as never, secrets: {} as never,
    mailDatabase: { async readDirectory() { throw new Error("reader unavailable"); } },
  });
  try {
    await assert.rejects(service.getStatus("acct-1"), /reader unavailable/);
    await assert.rejects(service.getContact("acct-1", "u1"), /reader unavailable/);
    await assert.rejects(service.listDepartments("acct-1"), /reader unavailable/);
    await assert.rejects(service.resolveRecipients("acct-1", ["张三"]), /reader unavailable/);
    await assert.rejects(service.searchContacts("acct-1", "张三"), /reader unavailable/);
  } finally { db.close(); }
});

test("refresh status is running while the initial asynchronous status write is pending", async () => {
  const { db, repository } = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let firstWrite = true;
  const service = new DirectoryService({ repository,
    accounts: { getCurrentAccount: () => ({ id: "acct-1", emailAddress: "me@corp.example" }) } as never,
    secrets: { getSecret: () => "secret" } as never,
    internalDomain: "@corp.example",
    clientFactory: () => ({ getDirectories: async () => { throw new Error("offline"); } }) as never,
    mailDatabase: { async writeDirectory(input) {
      if (firstWrite) { firstWrite = false; await gate; }
      return repository.write(input);
    } },
  });
  try {
    const completion = service.refresh("acct-1");
    assert.equal((await service.getStatus("acct-1")).state, "running");
    release();
    assert.equal((await completion).state, "failed");
    assert.equal((await service.getStatus("acct-1")).state, "failed");
  } finally { release(); db.close(); }
});

test("directory repository supports Chinese, pinyin, and alias lookup", () => {
  const { db, repository } = setup();
  assert.equal(repository.searchContacts("acct-1", "张三").length, 2);
  assert.equal(repository.searchContacts("acct-1", "zhang").length, 2);
  assert.equal(repository.searchContacts("acct-1", "zs").length, 2);
  assert.equal(repository.searchContacts("acct-1", "支付 张三").length, 1);
  assert.equal(repository.findByEmail("acct-1", "ZS2@corp.example")?.id, "u2");
  assert.deepEqual(
    repository.findNamesByEmails("acct-1", ["ZHANGSAN2@corp.example", "missing@corp.example"]),
    new Map([["zhangsan2@corp.example", "张三"]]),
  );
  db.close();
});

test("directory repository paginates contacts and reports matching totals", () => {
  const { db, repository } = setup();
  assert.equal(repository.countContacts("acct-1", ""), 2);
  assert.equal(repository.countContacts("acct-1", "", { departmentId: "root/a" }), 1);
  assert.deepEqual(
    repository.searchContacts("acct-1", "", { limit: 1, offset: 1 }).map((contact) => contact.id),
    ["u2"],
  );
  assert.equal(repository.countContacts("acct-1", "张三"), 2);
  assert.equal(repository.countContacts("acct-1", "支付 张三"), 1);
  db.close();
});

test("directory repository honors page sizes above the legacy 100-item limit", () => {
  const { db, repository } = setup();
  repository.replaceSnapshot(
    "acct-1",
    [],
    Array.from({ length: 250 }, (_, index) => ({
      id: `user-${index}`,
      name: `User ${index}`,
      email: `user-${index}@corp.example`,
      aliases: [],
    })),
  );
  assert.equal(repository.searchContacts("acct-1", "", { limit: 250 }).length, 250);
  db.close();
});

test("directory repository includes descendant department contacts without changing exact filtering", () => {
  const { db, repository } = setup();
  repository.replaceSnapshot(
    "acct-1",
    [
      { id: "root", name: "武汉研发中心", path: "武汉研发中心", childCount: 2 },
      { id: "root/a", parentId: "root", name: "开发一室", path: "武汉研发中心/开发一室", childCount: 1 },
      { id: "root/b", parentId: "root", name: "开发二室", path: "武汉研发中心/开发二室", childCount: 0 },
      { id: "root/a/team", parentId: "root/a", name: "平台组", path: "武汉研发中心/开发一室/平台组", childCount: 0 },
      { id: "other", name: "其他中心", path: "其他中心", childCount: 0 },
    ],
    [
      { id: "u-root", name: "中心负责人", email: "root@corp.example", aliases: [], departmentId: "root" },
      { id: "u-a", name: "开发甲", email: "a@corp.example", aliases: [], departmentId: "root/a" },
      { id: "u-team", name: "平台乙", email: "team@corp.example", aliases: [], departmentId: "root/a/team" },
      { id: "u-b", name: "开发丙", email: "b@corp.example", aliases: [], departmentId: "root/b" },
      { id: "u-other", name: "其他员工", email: "other@corp.example", aliases: [], departmentId: "other" },
    ],
  );

  assert.deepEqual(
    repository.searchContacts("acct-1", "", { departmentId: "root" }).map((contact) => contact.id),
    ["u-root"],
  );
  const descendants = { departmentId: "root", includeDescendants: true };
  assert.deepEqual(
    repository.searchContacts("acct-1", "", descendants).map((contact) => contact.id).sort(),
    ["u-a", "u-b", "u-root", "u-team"],
  );
  assert.equal(repository.countContacts("acct-1", "", descendants), 4);
  const firstDevelopmentPage = repository.searchContacts("acct-1", "开发", {
    ...descendants,
    limit: 1,
  });
  const secondDevelopmentPage = repository.searchContacts("acct-1", "开发", {
    ...descendants,
    limit: 1,
    offset: 1,
  });
  assert.deepEqual(
    [...firstDevelopmentPage, ...secondDevelopmentPage].map((contact) => contact.id).sort(),
    ["u-a", "u-b"],
  );
  assert.equal(repository.countContacts("acct-1", "开发", descendants), 2);
  assert.equal(repository.countContacts("acct-1", "", {
    departmentId: "missing",
    includeDescendants: true,
  }), 0);
  db.close();
});

test("directory descendant scope terminates if the current snapshot contains a cycle", () => {
  const { db, repository } = setup();
  repository.replaceSnapshot(
    "acct-1",
    [
      { id: "a", parentId: "b", name: "A", path: "A", childCount: 1 },
      { id: "b", parentId: "a", name: "B", path: "A/B", childCount: 1 },
    ],
    [
      { id: "u-a", name: "Alice", email: "alice@corp.example", aliases: [], departmentId: "a" },
      { id: "u-b", name: "Bob", email: "bob@corp.example", aliases: [], departmentId: "b" },
    ],
  );

  assert.equal(repository.countContacts("acct-1", "", {
    departmentId: "a",
    includeDescendants: true,
  }), 2);
  db.close();
});

test("directory full snapshot replacement does not accumulate prior contacts or departments", () => {
  const { db, repository } = setup();
  repository.replaceSnapshot(
    "acct-1",
    [{ id: "new", name: "新部门", path: "新部门", childCount: 0 }],
    [{ id: "new-user", name: "新员工", email: "new@corp.example", aliases: [], departmentId: "new" }],
  );

  while (repository.write({ operation: "cleanupSnapshots" }) === 100) {}
  const departmentCount = db.prepare(
    "SELECT COUNT(*) AS total FROM directory_departments WHERE account_id = ?",
  ).get("acct-1") as { total: number };
  const contactCount = db.prepare(
    "SELECT COUNT(*) AS total FROM directory_contacts WHERE account_id = ?",
  ).get("acct-1") as { total: number };
  const ftsCount = db.prepare(
    "SELECT COUNT(*) AS total FROM directory_contacts_fts WHERE account_id = ?",
  ).get("acct-1") as { total: number };
  assert.equal(departmentCount.total, 1);
  assert.equal(contactCount.total, 1);
  assert.equal(ftsCount.total, 1);
  assert.equal(repository.findByEmail("acct-1", "zhangsan1@corp.example"), null);
  db.close();
});

test("directory descendant query uses department and contact indexes", () => {
  const { db } = setup();
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    WITH RECURSIVE department_scope(id) AS (
      SELECT id
      FROM directory_active_departments
      WHERE account_id = ? AND id = ?

      UNION

      SELECT child.id
      FROM department_scope parent
      CROSS JOIN directory_active_departments child
      WHERE child.account_id = ? AND child.parent_id = parent.id
    )
    SELECT c.*
    FROM directory_active_contacts c
    WHERE c.account_id = ?
      AND c.department_id IN (SELECT id FROM department_scope)
    ORDER BY c.name
    LIMIT ? OFFSET ?
  `).all("acct-1", "root/a", "acct-1", "acct-1", 50, 0) as Array<{ detail: string }>;
  const details = plan.map((row) => row.detail).join("\n");

  assert.match(details, /idx_directory_departments_parent/);
  assert.match(details, /idx_directory_contacts_department/);
  db.close();
});

test("directory repository lists only direct child departments", () => {
  const { db, repository } = setup();
  repository.replaceSnapshot(
    "acct-1",
    [
      { id: "root", name: "corp.example", path: "corp.example", childCount: 2 },
      { id: "root/a", parentId: "root", name: "科技事业群", path: "corp.example/科技事业群", childCount: 1 },
      { id: "root/b", parentId: "root", name: "个人金融事业群", path: "corp.example/个人金融事业群", childCount: 0 },
      { id: "root/a/one", parentId: "root/a", name: "开发一室", path: "corp.example/科技事业群/开发一室", childCount: 0 },
    ],
    [],
  );

  assert.deepEqual(repository.listDepartments("acct-1").map((department) => department.id), ["root"]);
  assert.deepEqual(
    repository.listDepartments("acct-1", "root").map((department) => department.id),
    ["root/b", "root/a"],
  );
  assert.deepEqual(
    repository.listDepartments("acct-1", "root/a").map((department) => department.id),
    ["root/a/one"],
  );
  db.close();
});

test("directory repository backfills pinyin indexes for existing contacts once", () => {
  const { db, repository } = setup();
  db.prepare(`
    UPDATE directory_contacts
    SET name = CASE id WHEN 'u1' THEN '徐伟' ELSE 'Evan Xu' END,
        full_pinyin = '',
        pinyin_initials = '',
        pinyin_index_version = 0
    WHERE account_id = 'acct-1'
  `).run();
  db.prepare("DELETE FROM directory_contacts_fts WHERE account_id = 'acct-1'").run();
  db.prepare(`
    INSERT INTO directory_contacts_fts (account_id, contact_id, search_text)
    SELECT account_id, id, name || ' ' || email
    FROM directory_contacts WHERE account_id = 'acct-1'
  `).run();

  assert.equal(repository.searchContacts("acct-1", "xuwei").length, 0);
  assert.equal(repository.ensurePinyinIndex("acct-1"), 2);
  assert.equal(repository.searchContacts("acct-1", "xuwei")[0]?.id, "u1");
  assert.equal(repository.searchContacts("acct-1", "xw")[0]?.id, "u1");
  assert.deepEqual(
    db.prepare(`
      SELECT id, full_pinyin, pinyin_initials, pinyin_index_version
      FROM directory_contacts WHERE account_id = 'acct-1' ORDER BY id
    `).all(),
    [
      { id: "u1", full_pinyin: "xuwei", pinyin_initials: "xw", pinyin_index_version: 1 },
      { id: "u2", full_pinyin: "", pinyin_initials: "", pinyin_index_version: 1 },
    ],
  );
  assert.equal(repository.ensurePinyinIndex("acct-1"), 0);
  db.close();
});

test("directory repository incrementally indexes remote English-name matches", () => {
  const { db, repository } = setup();
  repository.upsertContacts("acct-1", [{
    id: "evanxu@corp.example",
    name: "evanxu(徐自然)",
    email: "evanxu@corp.example",
    aliases: [],
    departmentPath: "corp.example/个人金融事业群/财富产品部/综合理财产品室",
    searchTerms: ["evan", "xuziran"],
  }]);

  const [contact] = repository.searchContacts("acct-1", "evan", { limit: 8 });
  assert.equal(contact?.email, "evanxu@corp.example");
  assert.equal(repository.findByEmail("acct-1", "EVANXU@corp.example")?.name, "evanxu(徐自然)");
  db.close();
});

test("directory service prewarms once and falls back to incrementally cached contacts", async () => {
  const { db, repository } = setup();
  let warmups = 0;
  let failSearch = false;
  const client = {
    warmup: async () => { warmups += 1; },
    autoMatch: async () => {
      if (failSearch) throw new Error("offline");
      return [{
        "@type": "U",
        true_name: "evanxu(徐自然)",
        nick_name: "evan",
        email: "evanxu@corp.example",
        location: "corp.example/个人金融事业群/财富产品部/综合理财产品室",
      }];
    },
  };
  const service = new DirectoryService({
    repository,
    accounts: {
      getCurrentAccount: () => ({ id: "acct-1", emailAddress: "me@corp.example" }),
    } as never,
    secrets: { getSecret: () => "secret" } as never,
    internalDomain: "@corp.example",
    clientFactory: () => client as never,
  });

  const availableSnapshots: string[] = [];
  service.onSnapshotAvailable((accountId) => availableSnapshots.push(accountId));
  await service.initialize("acct-1");
  assert.equal(warmups, 1);
  assert.deepEqual(availableSnapshots, ["acct-1"]);
  const online = await service.searchContacts("acct-1", "evan", { limit: 8 });
  assert.equal(online.remoteAvailable, true);
  assert.equal(online.total, 1);
  assert.equal(online.contacts[0]?.email, "evanxu@corp.example");

  failSearch = true;
  const cached = await service.searchContacts("acct-1", "evan", { limit: 8 });
  assert.equal(cached.remoteAvailable, true);
  assert.equal(cached.total, 1);
  assert.equal(cached.contacts[0]?.email, "evanxu@corp.example");

  const unavailable = await service.searchContacts("acct-1", "not-in-cache", { limit: 8 });
  assert.equal(unavailable.remoteAvailable, false);
  assert.equal(unavailable.total, 0);
  assert.equal(unavailable.contacts.length, 0);
  db.close();
});

test("directory service keeps local pinyin matches local", async () => {
  const { db, repository } = setup();
  let remoteSearches = 0;
  const service = new DirectoryService({
    repository,
    accounts: {
      getCurrentAccount: () => ({ id: "acct-1", emailAddress: "me@corp.example" }),
    } as never,
    secrets: { getSecret: () => "secret" } as never,
    internalDomain: "@corp.example",
    clientFactory: () => ({
      autoMatch: async () => {
        remoteSearches += 1;
        return [];
      },
    }) as never,
  });

  assert.equal((await service.searchContacts("acct-1", "zhangsan", { limit: 8 })).contacts.length, 2);
  assert.equal((await service.searchContacts("acct-1", "zs", { limit: 8 })).contacts.length, 2);
  assert.equal(remoteSearches, 0);
  db.close();
});

test("directory service returns, deduplicates, and caches remote pinyin matches", async () => {
  const { db, repository } = setup();
  let remoteSearches = 0;
  const service = new DirectoryService({
    repository,
    accounts: {
      getCurrentAccount: () => ({ id: "acct-1", emailAddress: "me@corp.example" }),
    } as never,
    secrets: { getSecret: () => "secret" } as never,
    internalDomain: "@corp.example",
    clientFactory: () => ({
      autoMatch: async (query: string) => {
        remoteSearches += 1;
        assert.equal(query, "xuwei");
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [
          { "@type": "U", true_name: "colinxu(徐伟)", email: "colinxu@corp.example" },
          { "@type": "U", true_name: "colinxu(徐伟)", email: "COLINXU@corp.example" },
        ];
      },
    }) as never,
  });

  const [first, concurrent] = await Promise.all([
    service.searchContacts("acct-1", "xuwei", { limit: 8 }),
    service.searchContacts("acct-1", "xuwei", { limit: 8 }),
  ]);
  assert.equal(remoteSearches, 1);
  assert.deepEqual(first.contacts.map((contact) => contact.email), ["colinxu@corp.example"]);
  assert.deepEqual(concurrent.contacts.map((contact) => contact.email), ["colinxu@corp.example"]);
  assert.equal(repository.searchContacts("acct-1", "xuwei")[0]?.email, "colinxu@corp.example");
  assert.equal((await service.searchContacts("acct-1", "xw", { limit: 8 })).contacts[0]?.email, "colinxu@corp.example");
  assert.equal(remoteSearches, 1);
  db.close();
});

test("directory service backfills local pinyin before a failed Coremail warmup", async () => {
  const { db, repository } = setup();
  db.prepare(`
    UPDATE directory_contacts
    SET name = '徐伟', full_pinyin = '', pinyin_initials = '', pinyin_index_version = 0
    WHERE account_id = 'acct-1' AND id = 'u1'
  `).run();
  db.prepare("DELETE FROM directory_contacts_fts WHERE account_id = 'acct-1' AND contact_id = 'u1'").run();
  db.prepare(`
    INSERT INTO directory_contacts_fts (account_id, contact_id, search_text)
    VALUES ('acct-1', 'u1', '徐伟 xuwei1@corp.example')
  `).run();
  const service = new DirectoryService({
    repository,
    accounts: {
      getCurrentAccount: () => ({ id: "acct-1", emailAddress: "me@corp.example" }),
    } as never,
    secrets: { getSecret: () => "secret" } as never,
    internalDomain: "@corp.example",
    clientFactory: () => ({
      warmup: async () => { throw new Error("offline"); },
    }) as never,
  });

  await assert.rejects(() => service.initialize("acct-1"), /offline/);
  assert.equal(repository.searchContacts("acct-1", "xw")[0]?.id, "u1");
  db.close();
});

test("directory recipient resolution never guesses between duplicate names", async () => {
  const { db, repository } = setup();
  const service = new DirectoryService({
    repository,
    accounts: {} as never,
    secrets: {} as never,
  });
  const [ambiguous, exact, external] = await service.resolveRecipients("acct-1", [
    "张三",
    "zhangsan1@corp.example",
    "outside@example.com",
  ]);
  assert.equal(ambiguous?.status, "ambiguous");
  assert.equal(ambiguous?.status === "ambiguous" ? ambiguous.candidates.length : 0, 2);
  assert.equal(exact?.status, "exact");
  assert.deepEqual(external, { input: "outside@example.com", status: "external", email: "outside@example.com" });
  db.close();
});

test("directory service triggers a background refresh on initialize when no snapshot exists", async () => {
  const db = createMailDatabase(":memory:", { safeIntegers: false });
  insertCanonicalTestAccount(db, { id: "acct-1", email: "me@corp.example" });
  const repository = new DirectoryRepository(db, () => "2026-01-02T00:00:00.000Z", TEST_DIRECTORY_PINYIN);
  const refreshCalls: string[] = [];
  const service = new DirectoryService({
    repository,
    accounts: {
      getCurrentAccount: () => ({ id: "acct-1", emailAddress: "me@corp.example" }),
    } as never,
    secrets: { getSecret: () => "secret" } as never,
    internalDomain: "@corp.example",
    clientFactory: () => ({ warmup: async () => {} }) as never,
  });
  service.refresh = async (id) => {
    refreshCalls.push(id);
    return repository.getStatus(id);
  };

  await service.initialize("acct-1");

  // First mailbox entry with no prior snapshot kicks off a backfill.
  assert.deepEqual(refreshCalls, ["acct-1"]);
  db.close();
});

test("directory service does not refresh on initialize when a snapshot already exists", async () => {
  const { db, repository } = setup();
  const refreshCalls: string[] = [];
  const service = new DirectoryService({
    repository,
    accounts: {
      getCurrentAccount: () => ({ id: "acct-1", emailAddress: "me@corp.example" }),
    } as never,
    secrets: { getSecret: () => "secret" } as never,
    internalDomain: "@corp.example",
    clientFactory: () => ({ warmup: async () => {} }) as never,
  });
  service.refresh = async (id) => {
    refreshCalls.push(id);
    return repository.getStatus(id);
  };

  await service.initialize("acct-1");

  // Already synced — no backfill on subsequent entries.
  assert.deepEqual(refreshCalls, []);
  db.close();
});
