import assert from "node:assert/strict";
import test from "node:test";
import { createMcpComposition } from "./McpComposition.js";
import { WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME } from "./McpToolCatalog.js";
import { validateMcpSchema } from "./McpSchemaValidator.js";
import type { McpToolInvocationContext } from "./McpDomainAdapters.js";
import type { MailDatabase } from "../database/Database.js";
import type { MailReceiptHealth } from "../../../shared/wemail/mailSync.js";

// Regression guard: when the Mail Core job row is `cancelled`, the sync-status
// projection must stay within the declared WemailMcpSyncState contract
// ("accepted" | "shared" | "running" | "completed" | "failed"). `cancelled` is
// not a declared state, so it maps onto `failed` with errorCode `sync_cancelled`.

// Fake DB whose mail_jobs lookup returns a cancelled job row.
const cancelledJobRow = { state: "cancelled", error: null };
const fakeDb = {
  prepare: (_sql: string) => ({
    // The only prepared read in this path is the mail_jobs lookup; anything
    // else gets an empty shell so McpSettingsService / idempotency reconcile
    // still construct cleanly.
    get: () => cancelledJobRow,
    all: () => [],
    run: () => ({ changes: 0 }),
  }),
  transaction: (fn: (ctx: unknown) => unknown) => (ctx: unknown) => fn(ctx),
} as unknown as MailDatabase;

const secrets = { getSecret: () => undefined, saveSecret: () => undefined } as any;
const accounts = { listAccounts: () => [], getCurrentAccount: () => null } as any;
const mailDatabase = { getMailSnapshot: async () => { throw new Error("unused"); }, listFolders: async () => [] } as any;

const context: McpToolInvocationContext = {
  accountId: "acct-1",
  tokenId: "token-1",
  sessionHash: "session-1",
  signal: new AbortController().signal,
};

test("cancelled Mail Core job maps onto a declared sync state, not `cancelled`", async () => {
  const mcp = createMcpComposition({
    db: fakeDb,
    secrets,
    accounts,
    mailDatabase,
    getProvider: () => undefined,
    refreshMail: async () => ({ status: "queued", jobId: 42 }) as any,
  });
  try {
    const start = await mcp.registry.call("sync_mail_account", { accountId: "acct-1" }, context);
    assert.equal(start.isError, undefined, "sync_mail_account must succeed");
    const syncId = (start.structuredContent as any).sync.id;

    const status = await mcp.registry.call("get_mail_sync_status", { syncId }, context);
    assert.equal(status.isError, undefined, "get_mail_sync_status must not surface internal_error");
    const sync = (status.structuredContent as any).sync;

    // The projection must never emit the undeclared `cancelled` state.
    assert.notEqual(sync.state, "cancelled", "cancelled is not a declared WemailMcpSyncState");
    assert.equal(sync.state, "failed", "cancelled job maps onto the declared `failed` state");
    assert.equal(sync.errorCode, "sync_cancelled", "errorCode distinguishes cancellation from a real failure");

    // And the projected output must validate against the tool's output schema.
    const schema = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("get_mail_sync_status")!.outputSchema;
    assert.deepEqual(validateMcpSchema(schema, status.structuredContent), []);
  } finally {
    mcp.close();
  }
});

test("MCP refresh tracks its receipt version rather than the reused durable job state", async () => {
  let version = 2;
  const receipt: MailReceiptHealth = {
    runtimeId: "runtime", generation: 1, requestedVersion: 2, completedVersion: 1, failedVersion: 0,
    stage: "provider", activeStartedAt: 1, lastProgressAt: 1, lastSuccessfulCheckAt: 1,
    lastCommittedAt: 1, nextCheckAt: null, nextRetryAt: null, consecutiveFailures: 0, lastError: null,
  };
  const mcp = createMcpComposition({
    db: fakeDb, secrets, accounts, mailDatabase, getProvider: () => undefined,
    refreshMail: async () => ({ status: "queued", jobId: 42, receiptVersion: version, runtimeId: "runtime" }),
    getMailReceipt: () => receipt,
  });
  const start = async () => {
    const result = await mcp.registry.call("sync_mail_account", { accountId: "acct-1" }, context);
    assert.equal(result.isError, undefined);
    return (result.structuredContent as any).sync;
  };
  const status = async (syncId: string) => {
    const result = await mcp.registry.call("get_mail_sync_status", { syncId }, context);
    assert.equal(result.isError, undefined);
    return (result.structuredContent as any).sync;
  };
  try {
    const first = await start();
    assert.equal(first.state, "running");
    receipt.completedVersion = 2;
    assert.equal((await status(first.id)).state, "completed");
    version = 3;
    receipt.runtimeId = "old-cached-runtime";
    receipt.observedAt = 1;
    const second = await start();
    assert.equal(second.state, "running", "an earlier completion must not complete a new request sharing job 42");
    receipt.runtimeId = "runtime";
    receipt.observedAt = Date.now() + 100;
    receipt.failedVersion = 3;
    assert.equal((await status(second.id)).state, "failed");
    receipt.runtimeId = "replacement";
    assert.equal((await status(second.id)).errorCode, "sync_runtime_replaced");
  } finally { mcp.close(); }
});

test("MCP refresh reports submission failures instead of claiming acceptance", async () => {
  for (const rejects of [true, false]) {
    const mcp = createMcpComposition({
      db: fakeDb, secrets, accounts, mailDatabase, getProvider: () => undefined,
      refreshMail: async () => {
        if (rejects) throw new Error("core unavailable");
        return { status: "account-unavailable" };
      },
    });
    try {
      const result = await mcp.registry.call("sync_mail_account", { accountId: "acct-1" }, context);
      assert.equal(result.isError, undefined);
      const sync = (result.structuredContent as any).sync;
      assert.equal(sync.state, "failed");
      const status = await mcp.registry.call("get_mail_sync_status", { syncId: sync.id }, context);
      assert.equal((status.structuredContent as any).sync.errorCode, rejects ? "sync_request_failed" : "sync_account_unavailable");
    } finally { mcp.close(); }
  }
});
