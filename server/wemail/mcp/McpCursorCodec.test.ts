import assert from "node:assert/strict";
import test from "node:test";
import type { SecretStore } from "../security/SecretStore.js";
import { McpCursorCodec } from "./McpCursorCodec.js";

class Secrets implements SecretStore {
  values = new Map<string, string>();
  saveSecret(key: string, value: string) { this.values.set(key, value); }
  getSecret(key: string) { return this.values.get(key); }
  deleteSecret(key: string) { this.values.delete(key); }
  isEncryptionAvailable() { return true; }
}

test("cursor survives codec restart and returns its bound position", () => {
  const secrets = new Secrets();
  const now = () => new Date("2026-07-22T00:00:00Z");
  const first = new McpCursorCodec(secrets, now);
  const cursor = first.encode({ accountId: "a", tool: "list_mail_messages", filters: { folder: "INBOX" }, order: "received_desc", position: { receivedAt: "x", id: "1" } });
  const restarted = new McpCursorCodec(secrets, now);
  assert.deepEqual(restarted.decode(cursor, { accountId: "a", tool: "list_mail_messages", filters: { folder: "INBOX" }, order: "received_desc" }), { receivedAt: "x", id: "1" });
});

test("cursor rejects tamper, expiry, account, query, tool and order mismatch", () => {
  const secrets = new Secrets();
  let now = new Date("2026-07-22T00:00:00Z");
  const codec = new McpCursorCodec(secrets, () => now, 1000);
  const expected = { accountId: "a", tool: "list_mail_messages" as const, filters: { folder: "INBOX" }, order: "received_desc" };
  const cursor = codec.encode({ ...expected, position: { id: "1" } });
  const invalid = [
    `${cursor}x`,
    [cursor, { ...expected, accountId: "b" }],
    [cursor, { ...expected, filters: { folder: "Sent" } }],
    [cursor, { ...expected, tool: "list_mail_drafts" as const }],
    [cursor, { ...expected, order: "asc" }],
  ] as const;
  for (const item of invalid) {
    const [value, binding] = typeof item === "string" ? [item, expected] : item;
    assert.throws(() => codec.decode(value, binding), /Invalid cursor/);
  }
  now = new Date("2026-07-22T00:00:02Z");
  assert.throws(() => codec.decode(cursor, expected), /Invalid cursor/);
});
