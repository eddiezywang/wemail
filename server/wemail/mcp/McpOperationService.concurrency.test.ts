import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import { McpOperationService } from "./McpOperationService.js";
import { McpPreparedOperationRepository } from "./McpPreparedOperationRepository.js";

test("concurrent commits cannot dispatch the same operation twice", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  insertCanonicalTestAccount(db, { id: "account-1", email: "test@example.com", displayName: "Test" });
  const operations = new McpPreparedOperationRepository(db);
  operations.create({
    id: "op-1", accountId: "account-1", operationType: "mail_action", state: "approved",
    payload: { action: "trash", messageIds: ["mail-1"] }, payloadHash: "hash",
    preview: "Move message", expiresAt: "2999-01-01T00:00:00.000Z",
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const service = new McpOperationService({
    db, operations,
    mail: { moveMessage: async () => { calls += 1; await pending; return true; } },
    mailDatabase: {}, todos: {}, uploads: {}, getProvider: () => undefined,
  } as unknown as ConstructorParameters<typeof McpOperationService>[0]);
  const first = service.commit("op-1", "same-key", "account-1");
  try {
    const duplicate = await service.commit("op-1", "same-key", "account-1");
    assert.equal(duplicate.operation.state, "committing");
    await assert.rejects(() => service.commit("op-1", "different-key", "account-1"), /not available for dispatch/);
    assert.equal(calls, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM mcp_idempotency_reservations").get() as { count: number }).count, 1);
    assert.throws(() => operations.cancel("op-1", "account-1"), /not-cancellable/);
    release();
    assert.equal((await first).operation.state, "succeeded");
    assert.equal((await service.commit("op-1", "same-key", "account-1")).operation.state, "succeeded");
  } finally {
    release();
    await first.catch(() => undefined);
    db.close();
  }
});
