import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { McpAuditRepository } from "./McpAuditRepository.js";
import { McpHttpTransport } from "./McpHttpTransport.js";
import { McpPublicRegistry } from "./McpPublicRegistry.js";
import { McpSessionManager } from "./McpSessionManager.js";
import { WEMAIL_MCP_PROTOCOL_VERSIONS } from "../../../shared/wemail/mcp.js";

const token = { id: "token", accountId: "a", kind: "legacy" as const, fingerprint: "fingerprint", status: "active" as const, createdAt: new Date().toISOString() };

async function initialize(transport: McpHttpTransport) {
  const post = (body: unknown, session?: string) => transport.fetch(new Request("http://127.0.0.1/mcp", { method: "POST", headers: { authorization: "Bearer valid", "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body) }));
  const response = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: WEMAIL_MCP_PROTOCOL_VERSIONS[0] } });
  const session = response.headers.get("mcp-session-id")!;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  return { post, session };
}

test("transport enforces per-tool rate limits and writes metadata-only audit shapes", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    const audit = new McpAuditRepository(db);
    const transport = new McpHttpTransport({
      authenticator: { authenticate: () => ({ ok: true as const, token }) },
      sessions: new McpSessionManager(),
      audit,
      registry: new McpPublicRegistry({
        sync_mail_account: () => ({ sync: { id: "sync", state: "accepted", phase: "recent", processed: 0, updatedAt: new Date().toISOString() } }),
        search_mail: () => ({ mode: "local", items: [] }),
      }),
    });
    const { post, session } = await initialize(transport);
    const searched = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_mail", arguments: { accountId: "a", query: "TOP-SECRET-BODY" } } }, session);
    assert.equal(((await searched.json()) as any).result.isError, undefined);
    for (let index = 0; index < 10; index += 1) {
      await post({ jsonrpc: "2.0", id: 10 + index, method: "tools/call", params: { name: "sync_mail_account", arguments: { accountId: "a" } } }, session);
    }
    const limited = await post({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "sync_mail_account", arguments: { accountId: "a" } } }, session);
    assert.equal(((await limited.json()) as any).result.structuredContent.error.code, "rate_limited");
    const rows = audit.listRecent(100);
    assert.ok(rows.some((row) => row.outcomeCode === "rate_limited"));
    const serialized = JSON.stringify(rows);
    assert.equal(serialized.includes("TOP-SECRET-BODY"), false);
    assert.equal(rows.find((row) => row.toolName === "search_mail")?.argumentShape.query instanceof Object, true);
  } finally { db.close(); }
});

test("notifications/cancelled aborts the matching in-flight tool call", async () => {
  let aborted = false;
  const transport = new McpHttpTransport({
    authenticator: { authenticate: () => ({ ok: true as const, token }) },
    sessions: new McpSessionManager(),
    registry: new McpPublicRegistry({
      list_mail_accounts: (_input, context) => new Promise((resolve) => {
        context.signal.addEventListener("abort", () => { aborted = true; resolve({ accounts: [] }); }, { once: true });
      }),
    }),
  });
  const { post, session } = await initialize(transport);
  const pending = post({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "list_mail_accounts", arguments: {} } }, session);
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } }, session);
  assert.equal(cancelled.status, 202);
  await pending;
  assert.equal(aborted, true);
});

test("concurrent body reads are bounded and repeated invalid authentication never creates sessions", async () => {
  const sessions = new McpSessionManager({ maxConcurrentCalls: 1 });
  const transport = new McpHttpTransport({
    authenticator: { authenticate: (header) => header === "Bearer valid" ? { ok: true as const, token } : { ok: false as const, status: 401 as const, code: "authentication_required" as const } },
    sessions,
    registry: new McpPublicRegistry({
      get_mail_message: (_input, context) => new Promise((resolve) => context.signal.addEventListener("abort", () => resolve({ message: { id: "m", accountId: "a", subject: "s", snippet: "s", bodyText: "", truncated: false, contentTrust: "untrusted-provider-content" } }), { once: true })),
    }),
  });
  for (let index = 0; index < 20; index += 1) {
    const response = await transport.fetch(new Request("http://127.0.0.1/mcp", { method: "POST", headers: { authorization: "Bearer invalid", "content-type": "application/json" }, body: "{}" }));
    assert.equal(response.status, 401);
  }
  assert.equal(sessions.list().length, 0);
  const { post, session } = await initialize(transport);
  const first = post({ jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "get_mail_message", arguments: { accountId: "a", messageId: "m" } } }, session);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await post({ jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "get_mail_message", arguments: { accountId: "a", messageId: "m" } } }, session);
  assert.equal(((await second.json()) as any).result.structuredContent.error.code, "rate_limited");
  await post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 50 } }, session);
  await first;
});
