import assert from "node:assert/strict";
import test from "node:test";
import { createMcpComposition } from "./McpComposition.js";
import { WEMAIL_MCP_V1_TOOL_NAMES } from "../../../shared/wemail/mcp.js";
import type { MailDatabase } from "../database/Database.js";

// Regression guard for the MCP live-state incident where `sync_mail_account`
// was reported as `not_implemented` while `list_mail_messages` was available.
// The live-state projection (McpListenerController.view) marks a tool
// `unavailable: "not_implemented"` when `registry.hasHandler(name)` is false.
// Every catalog tool whose handler does not depend on an optional service
// must register unconditionally; this test pins that contract so a future
// refactor cannot silently drop a core handler and have E2E paper over it.

const fakeDb = {
  prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }),
  transaction: (fn: (ctx: unknown) => unknown) => (ctx: unknown) => fn(ctx),
} as unknown as MailDatabase;

const secrets = { getSecret: () => undefined, saveSecret: () => undefined } as any;
const accounts = { listAccounts: () => [], getCurrentAccount: () => null } as any;
const mailDatabase = { getMailSnapshot: async () => { throw new Error("unused"); }, listFolders: async () => [] } as any;

// Catalog tools whose handlers register unconditionally — i.e. they must be
// available even when optional services (mail provider, intelligence, search,
// directory, agent runs) are absent. The sync toolchain is the live-state
// regression target; list/get are pinned alongside as the parity reference.
const UNCONDITIONALLY_AVAILABLE = [
  "list_mail_accounts",
  "list_mail_folders",
  "sync_mail_account",
  "get_mail_sync_status",
  "list_mail_messages",
  "search_mail",
] as const;

test("sync_mail_account and the core mail handlers register without optional services", () => {
  const mcp = createMcpComposition({
    db: fakeDb,
    secrets,
    accounts,
    mailDatabase,
    getProvider: () => undefined,
  });
  try {
    for (const name of UNCONDITIONALLY_AVAILABLE) {
      assert.equal(
        mcp.registry.hasHandler(name),
        true,
        `${name} must register a handler (live-state marks unavailable handlers as not_implemented)`,
      );
    }
  } finally {
    mcp.close();
  }
});

test("every catalog tool name resolves to a definition (catalog/handler name parity)", () => {
  // `hasHandler` is definition.has(name) && handler is a function. Even before
  // checking the function, this catches the inverse drift: a handler wired with
  // a typo'd key that the catalog does not recognise.
  const mcp = createMcpComposition({
    db: fakeDb,
    secrets,
    accounts,
    mailDatabase,
    getProvider: () => undefined,
  });
  try {
    const declared = new Set(mcp.registry.list().map((t) => t.name));
    assert.deepEqual([...declared].sort(), [...WEMAIL_MCP_V1_TOOL_NAMES].slice().sort());
  } finally {
    mcp.close();
  }
});
