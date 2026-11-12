import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SecretStore } from "../security/SecretStore.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { McpAccessTokenService } from "./McpAccessTokenService.js";
import { McpAuditRepository } from "./McpAuditRepository.js";
import { McpIdempotencyRepository } from "./McpIdempotencyRepository.js";
import { McpPreparedOperationRepository } from "./McpPreparedOperationRepository.js";

class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  saveSecret(key: string, value: string) {
    this.values.set(key, value);
  }
  getSecret(key: string) {
    return this.values.get(key);
  }
  deleteSecret(key: string) {
    this.values.delete(key);
  }
  isEncryptionAvailable() {
    return true;
  }
}

function seedAccount(db: ReturnType<typeof openOrCreateMailDatabase>, id = "acct-1") {
  insertCanonicalTestAccount(db, { id: id, email: `${id}@example.com`, displayName: "Test" });
}

function canonicalAccountExists(db: ReturnType<typeof openOrCreateMailDatabase>) {
  // The canonical schema hard-deletes accounts (no soft-delete column); the
  // production wiring resolves existence through the account directory, which
  // lists every row in mail_accounts.
  return (accountId: string) => db.prepare(
    "SELECT 1 FROM mail_accounts WHERE public_id = ?",
  ).get(accountId) !== undefined;
}

test("canonical schema creates MCP tables without a migration ledger", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    const tables = new Set(
      (db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mcp_%'")
        .all() as Array<{ name: string }>).map((row) => row.name),
    );
    for (const name of [
      "mcp_access_tokens",
      "mcp_prepared_operations",
      "mcp_idempotency_reservations",
      "mcp_audit_events",
      "mcp_settings",
    ]) {
      assert.ok(tables.has(name), `missing ${name}`);
    }
    assert.equal(
      db.prepare("SELECT value FROM db_meta WHERE key = 'schema_version'").pluck().get(),
      "6",
    );
    const portColumn = (
      db.prepare("PRAGMA table_info(mcp_settings)").all() as Array<{
        name: string;
        dflt_value: string | null;
      }>
    ).find((column) => column.name === "port");
    assert.equal(portColumn?.dflt_value, "43129");
    const bodyLimitColumn = (
      db.prepare("PRAGMA table_info(mcp_settings)").all() as Array<{
        name: string;
        dflt_value: string | null;
      }>
    ).find((column) => column.name === "max_body_characters");
    assert.equal(bodyLimitColumn?.dflt_value, "20000");
  } finally {
    db.close();
  }
});

test("canonical MCP settings persist across restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-mcp-port-"));
  const filename = path.join(directory, "wemail.sqlite");
  try {
    const first = openOrCreateMailDatabase(filename);
    first.prepare(`
      INSERT INTO mcp_settings (id, enabled, port, max_body_characters, updated_at)
      VALUES ('default', 1, 43129, 50000, '2026-07-22T00:00:00.000Z')
    `).run();
    first.close();

    const reopened = openOrCreateMailDatabase(filename);
    try {
      assert.deepEqual(
        reopened.prepare(
          "SELECT enabled, port, max_body_characters FROM mcp_settings WHERE id = 'default'",
        ).get(),
        { enabled: 1, port: 43129, max_body_characters: 50000 },
      );
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical MCP verifier metadata survives restart while failed transactions roll back", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-mcp-restart-"));
  const filename = path.join(directory, "wemail.sqlite");
  const secrets = new MemorySecretStore();
  let plaintext = "";
  try {
    const first = openOrCreateMailDatabase(filename);
    seedAccount(first);
    const tokens = new McpAccessTokenService({ db: first, secrets, accountExists: canonicalAccountExists(first) });
    plaintext = tokens.create("acct-1").token;
    const operations = new McpPreparedOperationRepository(first);
    assert.throws(() => first.transaction(() => {
      operations.create({ id: "rolled-back", accountId: "acct-1", operationType: "send", payload: {}, payloadHash: "hash", preview: "preview", expiresAt: "2099-01-01T00:00:00.000Z" });
      throw new Error("rollback");
    })(), /rollback/);
    assert.equal(operations.get("rolled-back"), null);
    first.close();

    const reopened = openOrCreateMailDatabase(filename);
    try {
      const restartedTokens = new McpAccessTokenService({ db: reopened, secrets, accountExists: canonicalAccountExists(reopened) });
      assert.equal(restartedTokens.verify(plaintext)?.accountId, "acct-1");
      assert.equal(reopened.prepare("SELECT value FROM db_meta WHERE key = 'schema_version'").pluck().get(), "6");
    } finally { reopened.close(); }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("access token plaintext is returned once and only verifier material persists", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const secrets = new MemorySecretStore();
  seedAccount(db);
  const service = new McpAccessTokenService({
    db,
    secrets,
    accountExists: canonicalAccountExists(db),
    now: () => new Date("2026-07-22T01:00:00.000Z"),
  });
  try {
    const created = service.create("acct-1");
    assert.match(created.token, /^wmcp_/);
    assert.equal(service.verify(created.token)?.id, created.id);
    assert.equal(service.verify(`${created.token}wrong`), null);
    const row = db
      .prepare("SELECT * FROM mcp_access_tokens WHERE id = ?")
      .get(created.id) as Record<string, unknown>;
    assert.ok(!JSON.stringify(row).includes(created.token));
    assert.ok(!JSON.stringify([...secrets.values.values()]).includes(created.token));
    assert.ok(!("token" in row));
    assert.equal(service.getActiveForAccount("acct-1")?.fingerprint, created.fingerprint);
    assert.equal(service.getActiveForAccount("acct-1")?.kind, "legacy");
    assert.ok(!("token" in service.getActiveForAccount("acct-1")!));
  } finally {
    db.close();
  }
});

test("managed credential can coexist with a legacy credential without persisting plaintext", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const secrets = new MemorySecretStore();
  seedAccount(db);
  const service = new McpAccessTokenService({ db, secrets, accountExists: canonicalAccountExists(db) });
  try {
    const legacy = service.create("acct-1");
    const candidate = service.prepareManaged("acct-1");
    const managedPlaintext = candidate.created.token;
    const managed = candidate.commit();
    assert.equal(service.verify(legacy.token)?.kind, "legacy");
    assert.equal(service.verify(managedPlaintext)?.kind, "managed");
    assert.equal(service.getActiveManagedForAccount("acct-1")?.id, managed.id);
    assert.deepEqual(
      service.listActiveLegacyForAccount("acct-1").map((token) => token.id),
      [legacy.id],
    );
    const rows = db.prepare(
      "SELECT id, credential_kind, verifier_hash FROM mcp_access_tokens ORDER BY credential_kind",
    ).all();
    assert.equal(JSON.stringify(rows).includes(managedPlaintext), false);
    assert.equal(JSON.stringify(rows).includes(legacy.token), false);
  } finally {
    db.close();
  }
});

test("managed candidate is inactive until commit and abort leaves no verifier secret", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const secrets = new MemorySecretStore();
  seedAccount(db);
  const service = new McpAccessTokenService({ db, secrets, accountExists: canonicalAccountExists(db) });
  try {
    const candidate = service.prepareManaged("acct-1");
    assert.equal(service.getActiveManagedForAccount("acct-1"), null);
    assert.equal(service.verify(candidate.created.token), null);
    assert.equal(secrets.values.size, 0);
    candidate.abort();
    assert.equal(secrets.values.size, 0);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM mcp_access_tokens").get() as { count: number }).count,
      0,
    );
  } finally {
    db.close();
  }
});

test("rotation revokes the previous token and terminates its sessions", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const secrets = new MemorySecretStore();
  const revoked: string[] = [];
  seedAccount(db);
  const service = new McpAccessTokenService({
    db,
    secrets,
    accountExists: canonicalAccountExists(db),
    onTokenRevoked: (id) => revoked.push(id),
  });
  try {
    const first = service.create("acct-1");
    const second = service.rotate("acct-1");
    assert.notEqual(first.token, second.token);
    assert.equal(service.verify(first.token), null);
    assert.equal(service.verify(second.token)?.id, second.id);
    assert.deepEqual(revoked, [first.id]);
    assert.equal(service.listForAccount("acct-1").filter((row) => row.status === "active").length, 1);
  } finally {
    db.close();
  }
});

test("account token revocation removes secret material", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const secrets = new MemorySecretStore();
  seedAccount(db);
  const service = new McpAccessTokenService({ db, secrets, accountExists: canonicalAccountExists(db) });
  try {
    const created = service.create("acct-1");
    assert.ok(secrets.values.size > 0);
    assert.equal(service.revokeForAccount("acct-1"), 1);
    assert.equal(service.verify(created.token), null);
    assert.equal(secrets.values.size, 0);
  } finally {
    db.close();
  }
});

test("prepared operation approval binds account, payload hash, and expiry", () => {
  const db = openOrCreateMailDatabase(":memory:");
  seedAccount(db);
  let now = new Date("2026-07-22T02:00:00.000Z");
  const repository = new McpPreparedOperationRepository(db, () => now);
  try {
    repository.create({
      id: "op-1",
      accountId: "acct-1",
      operationType: "send",
      payload: { subject: "Hello" },
      payloadHash: "hash-1",
      preview: "Send one message",
      expiresAt: "2026-07-22T02:10:00.000Z",
    });
    assert.throws(
      () => repository.approve({ id: "op-1", accountId: "acct-1", payloadHash: "changed", approvalEventId: "approval-1" }),
      /operation-payload-mismatch/,
    );
    const approved = repository.approve({
      id: "op-1",
      accountId: "acct-1",
      payloadHash: "hash-1",
      approvalEventId: "approval-1",
    });
    assert.equal(approved.state, "approved");
    assert.equal(approved.approvalEventId, "approval-1");

    repository.create({
      id: "op-expired",
      accountId: "acct-1",
      operationType: "mail_action",
      payload: { action: "archive" },
      payloadHash: "hash-2",
      preview: "Archive one message",
      expiresAt: "2026-07-22T02:01:00.000Z",
    });
    now = new Date("2026-07-22T02:02:00.000Z");
    assert.throws(
      () => repository.approve({ id: "op-expired", accountId: "acct-1", payloadHash: "hash-2", approvalEventId: "approval-2" }),
      /operation-expired/,
    );
    assert.equal(repository.get("op-expired")?.state, "expired");
  } finally {
    db.close();
  }
});

test("idempotency reservation returns retained state and rejects key reuse", () => {
  const db = openOrCreateMailDatabase(":memory:");
  seedAccount(db);
  const operations = new McpPreparedOperationRepository(db);
  const reservations = new McpIdempotencyRepository(db);
  try {
    for (const id of ["op-1", "op-2"]) {
      operations.create({
        id,
        accountId: "acct-1",
        operationType: "mail_action",
        payload: { id },
        payloadHash: `payload-${id}`,
        preview: id,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    }
    const first = reservations.reserve({ accountId: "acct-1", operationId: "op-1", keyHash: "key-1", payloadHash: "payload-op-1" });
    const repeat = reservations.reserve({ accountId: "acct-1", operationId: "op-1", keyHash: "key-1", payloadHash: "payload-op-1" });
    const conflict = reservations.reserve({ accountId: "acct-1", operationId: "op-2", keyHash: "key-1", payloadHash: "payload-op-2" });
    assert.equal(first.status, "created");
    assert.equal(repeat.status, "existing");
    assert.equal(conflict.status, "conflict");
    const settled = reservations.setState(first.reservation.id, "succeeded", { code: "sent", summary: { messageId: "m-1" } });
    assert.equal(settled.dispatchState, "succeeded");
    assert.deepEqual(settled.resultSummary, { messageId: "m-1" });
  } finally {
    db.close();
  }
});

test("startup reconciliation retries only pre-dispatch reservations and marks dispatching outcomes unknown", () => {
  const db = openOrCreateMailDatabase(":memory:");
  seedAccount(db);
  const operations = new McpPreparedOperationRepository(db);
  const reservations = new McpIdempotencyRepository(db);
  try {
    for (const id of ["safe", "uncertain"]) {
      operations.create({ id, accountId: "acct-1", operationType: "mail_action", payload: { id }, payloadHash: id, preview: id, expiresAt: "2099-01-01T00:00:00.000Z" });
      operations.transition(id, "committing");
    }
    const safe = reservations.reserve({ accountId: "acct-1", operationId: "safe", keyHash: "safe-key", payloadHash: "safe" });
    const uncertain = reservations.reserve({ accountId: "acct-1", operationId: "uncertain", keyHash: "uncertain-key", payloadHash: "uncertain" });
    assert.equal(safe.status, "created");
    assert.equal(uncertain.status, "created");
    reservations.setState(uncertain.reservation.id, "dispatching");
    const reconciled = reservations.reconcileStartup();
    assert.deepEqual(reconciled, { safeToRetry: 1, outcomeUnknown: 1 });
    assert.equal(operations.get("safe")?.state, "approved");
    assert.equal(operations.get("uncertain")?.state, "outcome_unknown");
  } finally { db.close(); }
});

test("MCP audit repository stores only the supplied metadata shape", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const audit = new McpAuditRepository(db, () => new Date("2026-07-22T03:00:00.000Z"));
  try {
    const event = audit.append({
      tokenFingerprint: "abcd1234",
      sessionHash: "session-hash",
      toolName: "list_mail_messages",
      accountId: "acct-1",
      riskClass: "read",
      argumentShape: { accountId: "string", pageSize: "number" },
      durationMs: 12.9,
      outcomeCode: "ok",
      responseBytes: 4096,
    });
    assert.equal(event.durationMs, 12);
    assert.deepEqual(event.argumentShape, { accountId: "string", pageSize: "number" });
    assert.equal(audit.listRecent()[0]?.id, event.id);
    assert.equal(audit.deleteBefore("2026-07-23T00:00:00.000Z"), 1);
  } finally {
    db.close();
  }
});
