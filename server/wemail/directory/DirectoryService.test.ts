import assert from "node:assert/strict";
import test from "node:test";
import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import { createMailDatabase } from "../database/Database.js";
import { DirectoryRepository } from "./DirectoryRepository.js";
import { DirectoryService } from "./DirectoryService.js";
import { TEST_DIRECTORY_PINYIN } from "./DirectoryPinyin.test-support.js";

function setup() {
  const db = createMailDatabase(":memory:", { safeIntegers: false });
  insertCanonicalTestAccount(db, { id: "acct-internal", email: "me@corp.example" });
  insertCanonicalTestAccount(db, { id: "acct-external", email: "foo@gmail.com" });
  const repository = new DirectoryRepository(
    db,
    () => "2026-01-02T00:00:00.000Z",
    TEST_DIRECTORY_PINYIN,
  );
  return { db, repository };
}

test("external-account directory search and refresh never touch credentials or the enterprise client", async () => {
  const { db, repository } = setup();
  const factoryInputs: unknown[] = [];
  const secretReads: string[] = [];
  const service = new DirectoryService({
    repository,
    accounts: {
      getCurrentAccount: () => ({ id: "acct-external", emailAddress: "foo@gmail.com" }),
    } as never,
    secrets: {
      getSecret: (key: string) => {
        secretReads.push(key);
        return "gmail-imap-password";
      },
    } as never,
    internalDomain: "@corp.example",
    // The factory must never run for a non-matching account: reaching it
    // would mean the foreign mailbox credential was handed onward.
    clientFactory: (input) => {
      factoryInputs.push(input);
      throw new Error("enterprise client must not be created for external accounts");
    },
  });
  try {
    const search = await service.searchContacts("acct-external", "张三", { limit: 8 });
    assert.equal(search.remoteAvailable, false);
    assert.equal(search.contacts.length, 0);

    const refreshStatus = await service.refresh("acct-external");
    assert.equal(refreshStatus.state, "failed");
    assert.equal(refreshStatus.errorCode, "directory-not-configured");

    const [validation] = await service.validateRecipients("acct-external", ["bar@corp.example"]);
    assert.equal(validation?.status, "unavailable");
    assert.equal(validation?.status === "unavailable" ? validation.reason : undefined, "directory-not-configured");

    assert.deepEqual(factoryInputs, []);
    assert.deepEqual(secretReads, []);
  } finally { db.close(); }
});

test("accounts on the configured edition domain reach the enterprise client with the stored credential", async () => {
  const { db, repository } = setup();
  const factoryInputs: Array<{ username: string; password: string }> = [];
  const service = new DirectoryService({
    repository,
    accounts: {
      getCurrentAccount: () => ({ id: "acct-internal", emailAddress: "me@corp.example" }),
    } as never,
    secrets: { getSecret: () => "secret-password" } as never,
    internalDomain: "@corp.example",
    clientFactory: (input) => {
      factoryInputs.push(input);
      return { warmup: async () => {} } as never;
    },
  });
  try {
    await service.warmup("acct-internal");
    await service.warmup("acct-internal");
    assert.deepEqual(factoryInputs, [
      { username: "me@corp.example", password: "secret-password" },
    ]);
  } finally { db.close(); }
});

test("a factory without an edition domain stays closed for every account", async () => {
  const { db, repository } = setup();
  let factoryCalls = 0;
  const service = new DirectoryService({
    repository,
    accounts: {
      getCurrentAccount: () => ({ id: "acct-internal", emailAddress: "me@corp.example" }),
    } as never,
    secrets: { getSecret: () => "secret-password" } as never,
    // Misconfiguration guard: an injected client factory without the edition
    // domain must default to deny, not silently serve any mailbox.
    clientFactory: () => {
      factoryCalls += 1;
      return { warmup: async () => {} } as never;
    },
  });
  try {
    const status = await service.refresh("acct-internal");
    assert.equal(status.state, "failed");
    assert.equal(status.errorCode, "directory-not-configured");
    assert.equal(factoryCalls, 0);
  } finally { db.close(); }
});

test("recipient internal/external semantics follow the injected edition domain only", async () => {
  const { db, repository } = setup();
  repository.replaceSnapshot(
    "acct-internal",
    [],
    [{ id: "u1", name: "张三", email: "zhangsan@corp.example", aliases: [] }],
  );
  const service = new DirectoryService({
    repository,
    accounts: {} as never,
    secrets: {} as never,
    internalDomain: "@corp.example",
  });
  try {
    const resolutions = await service.resolveRecipients("acct-internal", [
      "zhangsan@corp.example",
      "stranger@corp.example",
      "stranger@gmail.com",
    ]);
    assert.equal(resolutions[0]?.status, "exact");
    assert.equal(resolutions[1]?.status, "not_found");
    assert.deepEqual(resolutions[2], { input: "stranger@gmail.com", status: "external", email: "stranger@gmail.com" });
  } finally { db.close(); }
});

test("without a configured directory no address is treated as internal", async () => {
  const { db, repository } = setup();
  const service = new DirectoryService({
    repository,
    accounts: {} as never,
    secrets: {} as never,
  });
  try {
    // Open edition: the enterprise domain default must be gone, so an
    // unknown enterprise-looking address resolves as external, not
    // "not_found" (which used to force enterprise directory lookups).
    const [external] = await service.resolveRecipients("acct-internal", ["stranger@corp.example"]);
    assert.deepEqual(external, { input: "stranger@corp.example", status: "external", email: "stranger@corp.example" });
    const [validation] = await service.validateRecipients("acct-internal", ["stranger@corp.example"]);
    assert.equal(validation?.status, "external");
  } finally { db.close(); }
});

test("open edition without a directory module: refresh reports not-configured, tables exist but stay empty", async () => {
  const { db, repository } = setup();
  const secretReads: string[] = [];
  const service = new DirectoryService({
    repository,
    accounts: {
      getCurrentAccount: () => ({ id: "acct-internal", emailAddress: "me@corp.example" }),
    } as never,
    secrets: {
      getSecret: (key: string) => {
        secretReads.push(key);
        return "imap-password";
      },
    } as never,
    // No clientFactory and no internalDomain: the open edition default.
    // A module-less build must never reach a mailbox credential either.
  });
  try {
    const status = await service.refresh("acct-internal");
    assert.equal(status.state, "failed");
    assert.equal(status.errorCode, "directory-not-configured");
    assert.equal((await service.getStatus("acct-internal")).errorCode, "directory-not-configured");
    assert.deepEqual(await service.listDepartments("acct-internal"), []);
    assert.equal((await service.searchContacts("acct-internal", "", { limit: 1 })).total, 0);
    // The directory tables remain part of the open schema (v15), but a
    // module-less build never writes any contacts, departments or snapshots.
    for (const table of ["directory_contacts", "directory_departments", "directory_snapshots"]) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      assert.equal(row.n, 0, `${table} must be empty`);
    }
    assert.deepEqual(secretReads, []);
  } finally { db.close(); }
});
