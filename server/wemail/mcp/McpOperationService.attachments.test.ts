import assert from "node:assert/strict";
import test from "node:test";
import { McpOperationService } from "./McpOperationService.js";

const attachment = { id: "attachment-1", filename: "sample.pdf", mimetype: "application/pdf", size: 1, dataBase64: "YQ==" };
const context = { accountId: "account-1", tokenId: "token-1", sessionHash: "session-1" };

test("preparing a send from a draft with attachments fails without creating an operation", () => {
  let created = false;
  const service = new McpOperationService({
    db: {},
    operations: { create: () => { created = true; } },
    mail: { getDraftById: () => ({ accountId: context.accountId, to: [{ email: "test@example.com" }], attachments: [attachment] }) },
    mailDatabase: {}, todos: {}, uploads: { resolve: () => attachment }, getProvider: () => undefined,
  } as unknown as ConstructorParameters<typeof McpOperationService>[0]);
  assert.throws(
    () => service.prepareMailSend({ accountId: context.accountId, mode: "new", draftId: "draft-1" }, context),
    (error: unknown) => (error as { code?: string }).code === "capability_not_supported",
  );
  assert.throws(
    () => service.prepareMailSend({ accountId: context.accountId, mode: "new", to: [{ email: "test@example.com" }], attachments: [{ uploadRef: "upload-1" }] }, context),
    (error: unknown) => (error as { code?: string }).code === "capability_not_supported",
  );
  assert.equal(created, false);
});

test("an older prepared send with attachments cannot enter the outbox", async () => {
  let enqueued = false;
  const operation = { id: "op-1", accountId: context.accountId, operationType: "send", payload: { attachments: [attachment] } };
  const service = new McpOperationService({
    db: {},
    operations: { getOwned: () => operation },
    mail: {}, mailDatabase: { enqueueSend: async () => { enqueued = true; } },
    todos: {}, uploads: {}, getProvider: () => undefined,
  } as unknown as ConstructorParameters<typeof McpOperationService>[0]);
  await assert.rejects(
    () => service.commit(operation.id, "key-1", context.accountId),
    (error: unknown) => (error as { code?: string }).code === "capability_not_supported",
  );
  assert.equal(enqueued, false);
});
