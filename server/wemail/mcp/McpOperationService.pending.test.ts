import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import { McpOperationService } from "./McpOperationService.js";
import { McpPreparedOperationRepository } from "./McpPreparedOperationRepository.js";

test("pending limit counts beyond 100 and excludes expired operations", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    insertCanonicalTestAccount(db, { id: "account-1", email: "test@example.com", displayName: "Test" });
    db.prepare(`INSERT INTO mcp_access_tokens
      (id, account_id, secret_key, fingerprint, verifier_salt, verifier_hash, status, created_at)
      VALUES ('token', 'account-1', 'test-key', 'test-fingerprint', 'salt', 'hash', 'active', '2000-01-01T00:00:00.000Z')`).run();
    const operations = new McpPreparedOperationRepository(db);
    for (let i = 0; i < 101; i += 1) {
      operations.create({ id: `op-${i}`, accountId: "account-1", operationType: "mail_action", state: "approved", payload: {}, payloadHash: "hash", preview: "test", expiresAt: "2999-01-01T00:00:00.000Z" });
    }
    operations.create({ id: "expired", accountId: "account-1", operationType: "mail_action", state: "approved", payload: {}, payloadHash: "hash", preview: "test", expiresAt: "2000-01-01T00:00:00.000Z" });
    assert.equal(operations.countPending("account-1"), 101);
    const service = new McpOperationService({
      db, operations, maxPendingOperations: 102,
      mail: { getMessageById: () => ({ id: "mail-1" }) },
      mailDatabase: {}, todos: {}, uploads: {}, getProvider: () => undefined,
    } as unknown as ConstructorParameters<typeof McpOperationService>[0]);
    const prepare = () => service.prepareMailActions(
      { accountId: "account-1", action: "trash", messageIds: ["mail-1"] },
      { accountId: "account-1", tokenId: "token", sessionHash: "session" },
    );
    prepare();
    assert.equal(operations.countPending("account-1"), 102);
    assert.throws(prepare, /Too many pending operations/);
  } finally {
    db.close();
  }
});
