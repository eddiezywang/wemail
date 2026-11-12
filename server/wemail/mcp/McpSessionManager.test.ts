import assert from "node:assert/strict";
import { test } from "node:test";
import { McpAuthenticator } from "./McpAuthenticator.js";
import { McpSessionManager } from "./McpSessionManager.js";

test("session is bearer-bound, initialization-gated, and hash-safe", () => {
  const manager = new McpSessionManager();
  const created = manager.create("token-1", "2025-11-25");
  assert.notEqual(created.id, created.sessionHash);
  assert.equal(manager.get(created.id, "other-token"), null);
  assert.throws(
    () => manager.beginCall(created.id, "token-1", "call-1"),
    /not-initialized/,
  );
  manager.markInitialized(created.id, "token-1");
  const call = manager.beginCall(created.id, "token-1", "call-1");
  assert.equal(call.signal.aborted, false);
  manager.endCall(created.id, "call-1");
  assert.equal(manager.get(created.id, "token-1")?.inFlightCalls, 0);
});
test("session enforces concurrency and aborts cancellable calls on termination", () => {
  const manager = new McpSessionManager({ maxConcurrentCalls: 1 });
  const created = manager.create("token-1", "2025-11-25");
  manager.markInitialized(created.id, "token-1");
  const first = manager.beginCall(created.id, "token-1", "call-1");
  assert.throws(
    () => manager.beginCall(created.id, "token-1", "call-2"),
    /concurrency-limit/,
  );
  assert.equal(manager.terminate(created.id), true);
  assert.equal(first.signal.aborted, true);
});

test("token revocation terminates only sessions bound to that token", () => {
  const manager = new McpSessionManager();
  manager.create("token-1", "2025-11-25");
  manager.create("token-1", "2025-11-25");
  manager.create("token-2", "2025-11-25");
  assert.equal(manager.terminateForToken("token-1"), 2);
  assert.equal(manager.list().length, 1);
  assert.equal(manager.list()[0]?.tokenId, "token-2");
});

test("idle cleanup terminates expired sessions", () => {
  let now = new Date("2026-07-22T00:00:00.000Z");
  const manager = new McpSessionManager({
    now: () => now,
    idleTimeoutMs: 1000,
  });
  manager.create("token-1", "2025-11-25");
  now = new Date("2026-07-22T00:00:01.000Z");
  assert.equal(manager.cleanupExpired(), 1);
  assert.equal(manager.list().length, 0);
});

test("authenticator accepts exactly a valid bearer credential", () => {
  const authenticator = new McpAuthenticator({
    verify: (token: string) =>
      token === "valid"
        ? {
            id: "token-1",
            accountId: "acct-1",
            kind: "legacy" as const,
            fingerprint: "fingerprint",
            status: "active" as const,
            createdAt: "2026-07-22T00:00:00.000Z",
          }
        : null,
  });
  assert.equal(authenticator.authenticate("Bearer valid").ok, true);
  assert.equal(authenticator.authenticate("Basic valid").ok, false);
  assert.equal(authenticator.authenticate("Bearer invalid").ok, false);
  assert.equal(authenticator.authenticate(undefined).ok, false);
});
