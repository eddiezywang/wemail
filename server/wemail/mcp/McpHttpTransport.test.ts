import assert from "node:assert/strict";
import test from "node:test";
import { WEMAIL_MCP_PROTOCOL_VERSIONS, WEMAIL_MCP_V1_TOOL_NAMES } from "../../../shared/wemail/mcp.js";
import { MCP_DEFAULT_MAX_REQUEST_BYTES, McpHttpTransport, startMcpHttpServer } from "./McpHttpTransport.js";
import { McpPublicRegistry } from "./McpPublicRegistry.js";
import { McpSessionManager } from "./McpSessionManager.js";

const TOKEN = { id: "token-1", accountId: "account-1", kind: "legacy" as const, fingerprint: "fp", status: "active" as const, createdAt: new Date(0).toISOString() };
function harness(limits?: { maxRequestBytes?: number }) {
  const sessions = new McpSessionManager();
  const transport = new McpHttpTransport({
    authenticator: { authenticate: (header) => header === "Bearer valid" ? { ok: true as const, token: TOKEN } : { ok: false as const, status: 401 as const, code: "authentication_required" as const } },
    sessions,
    registry: new McpPublicRegistry({ list_mail_accounts: () => ({ accounts: [] }) }),
    limits,
  });
  const post = (body: unknown, session?: string, authorization = "Bearer valid") => transport.fetch(new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: { authorization, "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify(body),
  }));
  return { sessions, transport, post };
}

test("an already aborted request does not invoke its tool handler", async () => {
  const sessions = new McpSessionManager();
  const session = sessions.create(TOKEN.id, "2025-11-25");
  sessions.markInitialized(session.id, TOKEN.id);
  let calls = 0;
  const transport = new McpHttpTransport({
    authenticator: { authenticate: () => ({ ok: true as const, token: TOKEN }) },
    sessions,
    registry: new McpPublicRegistry({ list_mail_accounts: () => { calls += 1; return { accounts: [] }; } }),
  });
  const controller = new AbortController();
  controller.abort();
  const response = await transport.fetch(new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: { authorization: "Bearer valid", "content-type": "application/json", "mcp-session-id": session.id },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_mail_accounts", arguments: {} } }),
    signal: controller.signal,
  }));
  assert.equal(calls, 0);
  assert.ok((await response.json() as { error?: unknown }).error);
  assert.equal(sessions.get(session.id, TOKEN.id)?.inFlightCalls, 0);
});

test("authentication happens before JSON-RPC parsing", async () => {
  const { transport } = harness();
  const response = await transport.fetch(new Request("http://127.0.0.1/mcp", { method: "POST", body: "not-json" }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
});

test("initialize, initialized notification, tools list and call form a stateful flow", async () => {
  const { post } = harness();
  const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: WEMAIL_MCP_PROTOCOL_VERSIONS[0] } });
  assert.equal(initialized.status, 200);
  const session = initialized.headers.get("mcp-session-id");
  assert.ok(session);
  const premature = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, session);
  assert.equal(((await premature.json()) as any).error.code, -32600);
  const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  assert.equal(notification.status, 202);
  const listed = await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, session);
  const tools = ((await listed.json()) as any).result.tools;
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), WEMAIL_MCP_V1_TOOL_NAMES);
  assert.ok(tools.every((tool: any) => Object.values(tool.annotations).every((value) => typeof value === "boolean")));
  const called = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_mail_accounts", arguments: {} } }, session);
  assert.deepEqual(((await called.json()) as any).result.structuredContent, { accounts: [] });
});

test("Origin validation allows native and loopback clients and rejects untrusted browser origins before authentication", async () => {
  const { transport } = harness();
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: WEMAIL_MCP_PROTOCOL_VERSIONS[0] } });
  for (const origin of ["http://localhost:5173", "https://127.0.0.1:4443", "http://[::1]:5173"]) {
    const response = await transport.fetch(new Request("http://127.0.0.1/mcp", {
      method: "POST", headers: { authorization: "Bearer valid", origin }, body: payload,
    }));
    assert.equal(response.status, 200, origin);
  }
  for (const origin of ["https://attacker.example", "null", "not-an-origin", "http://localhost.example:5173"]) {
    const response = await transport.fetch(new Request("http://127.0.0.1/mcp", {
      method: "POST", headers: { authorization: "Bearer valid", origin }, body: payload,
    }));
    assert.equal(response.status, 403, origin);
    assert.equal(((await response.json()) as any).error.code, "origin_forbidden");
  }
  const unauthenticatedEvil = await transport.fetch(new Request("http://127.0.0.1/mcp", {
    method: "POST", headers: { origin: "https://attacker.example" }, body: payload,
  }));
  assert.equal(unauthenticatedEvil.status, 403);
});

test("declared and streaming request bodies are bounded before JSON parsing", async () => {
  assert.equal(MCP_DEFAULT_MAX_REQUEST_BYTES, 40 * 1024 * 1024);
  const { transport } = harness({ maxRequestBytes: 16 });
  const declared = await transport.fetch(new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: { authorization: "Bearer valid", "content-length": "17" },
    body: "{}",
  }));
  assert.equal(declared.status, 413);
  assert.equal(((await declared.json()) as any).error.code, "request_too_large");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("1234567890"));
      controller.enqueue(encoder.encode("abcdefghij"));
      controller.close();
    },
  });
  const streamed = await transport.fetch(new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: { authorization: "Bearer valid" },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" }));
  assert.equal(streamed.status, 413);
  assert.equal(((await streamed.json()) as any).error.code, "request_too_large");
});

test("unsupported protocols and unadvertised methods return JSON-RPC errors", async () => {
  const { post } = harness();
  const unsupported = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(((await unsupported.json()) as any).error.code, -32602);
  const initialized = await post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: WEMAIL_MCP_PROTOCOL_VERSIONS[0] } });
  const session = initialized.headers.get("mcp-session-id")!;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  const unknown = await post({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} }, session);
  assert.equal(((await unknown.json()) as any).error.code, -32601);
});

test("session is bearer-bound and DELETE terminates it", async () => {
  const { post, transport } = harness();
  const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: WEMAIL_MCP_PROTOCOL_VERSIONS[0] } });
  const session = initialized.headers.get("mcp-session-id")!;
  const wrongBearer = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session, "Bearer wrong");
  assert.equal(wrongBearer.status, 401);
  const deleted = await transport.fetch(new Request("http://127.0.0.1/mcp", { method: "DELETE", headers: { authorization: "Bearer valid", "mcp-session-id": session } }));
  assert.equal(deleted.status, 200);
});

test("listener rejects non-loopback binding and can use an ephemeral loopback port", async () => {
  const { transport } = harness();
  await assert.rejects(() => startMcpHttpServer({ transport, host: "0.0.0.0" }), /loopback/);
  const server = await startMcpHttpServer({ transport, port: 0 });
  try {
    assert.equal(server.host, "127.0.0.1");
    assert.ok(server.port > 0);
  } finally {
    await server.close();
  }
});

test("protocol responses keep JSON/content/session semantics across concurrent sessions and restart", async () => {
  const { post, transport } = harness();
  const first = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: WEMAIL_MCP_PROTOCOL_VERSIONS[0] } });
  const second = await post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: WEMAIL_MCP_PROTOCOL_VERSIONS[0] } });
  const firstSession = first.headers.get("mcp-session-id")!;
  const secondSession = second.headers.get("mcp-session-id")!;
  assert.notEqual(firstSession, secondSession);
  assert.match(first.headers.get("content-type") ?? "", /application\/json/);
  const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, firstSession);
  assert.equal(initialized.status, 202);
  assert.equal(await initialized.text(), "");
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, secondSession);
  const listed = await transport.fetch(new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: { authorization: "Bearer valid", "content-type": "application/json", accept: "text/event-stream, application/json", "mcp-session-id": firstSession },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
  }));
  assert.match(listed.headers.get("content-type") ?? "", /application\/json/);
  assert.ok(Array.isArray(((await listed.json()) as any).result.tools));

  const server = await startMcpHttpServer({ transport, port: 0 });
  const stablePort = server.port;
  await server.close();
  const restarted = await startMcpHttpServer({ transport, port: stablePort });
  try {
    assert.equal(restarted.port, stablePort);
  } finally {
    await restarted.close();
  }
});
