import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { buildMcpRoutes } from "./mcpRoutes.js";

function appWith(controller: Record<string, unknown>) {
  const app = new Hono();
  app.route("/api/mcp", buildMcpRoutes(controller as any));
  return app;
}

test("MCP management routes expose state and validate settings", async () => {
  const state = { enabled: false, port: 3129, defaultBodyCharacters: 6000, maxBodyCharacters: 20000, defaultPageSize: 25, maxPageSize: 100 };
  const app = appWith({ view: () => state, configure: async (input: Record<string, unknown>) => ({ ...state, ...input }) });
  const get = await app.request("/api/mcp/state");
  assert.deepEqual(await get.json(), { ok: true, state });
  const invalid = await app.request("/api/mcp/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, port: 70000 }) });
  assert.equal(invalid.status, 400);
  const invalidBodyLimit = await app.request("/api/mcp/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, maxBodyCharacters: 1_000_001 }) });
  assert.equal(invalidBodyLimit.status, 400);
  const invalidRange = await app.request("/api/mcp/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, defaultPageSize: 101, maxPageSize: 100 }) });
  assert.equal(invalidRange.status, 400);
  const valid = await app.request("/api/mcp/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, port: 3130, maxBodyCharacters: 50000, maxRecipients: 500, toolTimeoutSeconds: 120 }) });
  assert.equal(valid.status, 200);
  assert.deepEqual(((await valid.json()) as any).state, { ...state, enabled: true, port: 3130, maxBodyCharacters: 50000, maxRecipients: 500, toolTimeoutSeconds: 120 });
});

test("MCP token and session routes delegate only sanitized identifiers", async () => {
  const calls: string[] = [];
  const app = appWith({
    createToken: () => ({ token: "once" }),
    rotateToken: () => ({ token: "rotated" }),
    revokeToken: () => true,
    resetCredential: () => ({ credentialState: "ready" }),
    terminateSession: (hash: string) => { calls.push(hash); return true; },
  });
  assert.equal((await app.request("/api/mcp/tokens", { method: "POST" })).status, 200);
  assert.equal((await app.request("/api/mcp/tokens/rotate", { method: "POST" })).status, 200);
  assert.equal((await app.request("/api/mcp/tokens/current", { method: "DELETE" })).status, 200);
  assert.equal((await app.request("/api/mcp/credentials/reset", { method: "POST" })).status, 200);
  assert.equal((await app.request("/api/mcp/sessions/not-a-hash", { method: "DELETE" })).status, 400);
  const hash = "a".repeat(24);
  assert.equal((await app.request(`/api/mcp/sessions/${hash}`, { method: "DELETE" })).status, 200);
  assert.deepEqual(calls, [hash]);
});
