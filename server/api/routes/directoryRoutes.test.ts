import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectoryRoutes } from "./directoryRoutes.js";
import { createMailDatabase } from "../../wemail/database/Database.js";
import { insertCanonicalTestAccount } from "../../wemail/database/MailDatabase.test-support.js";
import { DirectoryRepository } from "../../wemail/directory/DirectoryRepository.js";
import { DirectoryService } from "../../wemail/directory/DirectoryService.js";

test("directory contacts route forwards descendant department scope", async () => {
  let received: unknown;
  const app = buildDirectoryRoutes({
    getActiveAccountId: () => "acct-1",
    service: {
      searchContacts: async (accountId: string, query: string, options: unknown) => {
        received = { accountId, query, options };
        return { contacts: [], total: 0, remoteAvailable: true };
      },
    } as never,
  });

  const response = await app.request(
    "/contacts?q=&departmentId=root&includeDescendants=true&limit=50&offset=100",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    accountId: "acct-1",
    query: "",
    options: {
      departmentId: "root",
      includeDescendants: true,
      limit: 50,
      offset: 100,
    },
  });
});

test("directory routes await contacts, departments, status and recipient resolution", async () => {
  const service = {
    getStatus: async () => ({ state: "completed" }),
    listDepartments: async () => [{ id: "department" }],
    getContact: async () => ({ id: "contact" }),
    resolveRecipients: async () => [{ input: "name", status: "not_found" }],
  };
  const app = buildDirectoryRoutes({ getActiveAccountId: () => "acct-1", service: service as never });
  assert.deepEqual(await (await app.request("/status")).json(), { ok: true, status: { state: "completed" } });
  assert.deepEqual(await (await app.request("/departments")).json(), { ok: true, departments: [{ id: "department" }] });
  assert.deepEqual(await (await app.request("/contacts/contact")).json(), { ok: true, contact: { id: "contact" } });
  assert.deepEqual(await (await app.request("/recipients/resolve", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: ["name"] }),
  })).json(), { ok: true, resolutions: [{ input: "name", status: "not_found" }] });
});

test("directory reader failures return unavailable without exposing internal errors", async () => {
  const app = buildDirectoryRoutes({ getActiveAccountId: () => "acct-1", service: {
    getContact: async () => { throw new Error("private-database-path"); },
  } as never });
  const response = await app.request("/contacts/contact");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "directory-unavailable" });
});

test("open edition: POST /refresh stays not-configured and DB directory tables stay empty", async () => {
  const db = createMailDatabase(":memory:", { safeIntegers: false });
  insertCanonicalTestAccount(db, { id: "acct-1", email: "me@corp.example" });
  const secretReads: string[] = [];
  const service = new DirectoryService({
    repository: new DirectoryRepository(db),
    accounts: {
      getCurrentAccount: () => ({ id: "acct-1", emailAddress: "me@corp.example" }),
    } as never,
    secrets: {
      getSecret: (key: string) => {
        secretReads.push(key);
        return "imap-password";
      },
    } as never,
    // No clientFactory / internalDomain: the open edition has no enterprise
    // directory module, so refresh must fail closed before reading secrets.
  });
  const app = buildDirectoryRoutes({ getActiveAccountId: () => "acct-1", service });
  try {
    const refresh = await app.request("/refresh", { method: "POST" });
    assert.equal(refresh.status, 200);
    assert.equal((await refresh.json() as { ok: boolean }).ok, true);
    // The refresh is fire-and-forget; wait for the service-side status so the
    // "not-configured" outcome is observed rather than the transient running
    // state the route returns immediately.
    const finalStatus = await service.refresh("acct-1");
    assert.equal(finalStatus.state, "failed");
    assert.equal(finalStatus.errorCode, "directory-not-configured");
    const status = await app.request("/status");
    assert.equal(
      (await status.json() as { status: { errorCode?: string } }).status.errorCode,
      "directory-not-configured",
    );
    for (const table of ["directory_contacts", "directory_departments", "directory_snapshots"]) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      assert.equal(row.n, 0, `${table} must be empty`);
    }
    assert.deepEqual(secretReads, []);
  } finally { db.close(); }
});
