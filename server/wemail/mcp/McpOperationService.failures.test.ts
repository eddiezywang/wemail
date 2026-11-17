import assert from "node:assert/strict";
import test from "node:test";
import { McpOperationService } from "./McpOperationService.js";

test("a partially completed batch has an unknown outcome and is not replayed", async () => {
  const operation = {
    id: "op-1", accountId: "account-1", operationType: "mail_action", state: "approved",
    payload: { action: "trash", messageIds: ["mail-1", "mail-2"] }, payloadHash: "hash",
    preview: "Move messages", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2999-01-01T00:00:00Z",
  };
  const calls: string[] = [];
  const service = new McpOperationService({
    db: { transaction: (fn: () => unknown) => fn },
    operations: {
      getOwned: () => operation,
      get: () => operation,
      claimForDispatch: () => {
        if (operation.state !== "approved") return false;
        operation.state = "committing";
        return true;
      },
      transition: (_id: string, state: string) => { operation.state = state; return operation; },
    },
    mail: { moveMessage: async (id: string) => {
      calls.push(id);
      if (id === "mail-2") throw new Error("provider detail must not be persisted");
      return true;
    } },
    mailDatabase: {}, todos: {}, uploads: {}, getProvider: () => undefined,
  } as unknown as ConstructorParameters<typeof McpOperationService>[0]);
  let dispatchState = "reserved";
  let recordedCode = "";
  service.idempotency.reserve = (() => ({
    status: dispatchState === "reserved" ? "created" : "existing",
    reservation: { id: 1, dispatchState },
  })) as unknown as typeof service.idempotency.reserve;
  service.idempotency.setState = ((_id, state, result) => {
    dispatchState = state;
    recordedCode = result?.code ?? "";
    return {} as ReturnType<typeof service.idempotency.setState>;
  }) as typeof service.idempotency.setState;

  const first = await service.commit(operation.id, "key-1", operation.accountId);
  assert.equal(first.operation.state, "outcome_unknown");
  assert.equal(first.operation.retryable, false);
  assert.equal(recordedCode, "outcome_unknown");
  assert.deepEqual(calls, ["mail-1", "mail-2"]);
  const repeated = await service.commit(operation.id, "key-1", operation.accountId);
  assert.equal(repeated.operation.state, "outcome_unknown");
  assert.deepEqual(calls, ["mail-1", "mail-2"]);
});
