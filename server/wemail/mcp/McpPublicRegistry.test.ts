import assert from "node:assert/strict";
import test from "node:test";
import { McpDomainError } from "./McpErrorMapper.js";
import { McpPublicRegistry } from "./McpPublicRegistry.js";

const context = {
  accountId: "account-1",
  tokenId: "token-1",
  sessionHash: "session-hash",
  signal: new AbortController().signal,
};

test("registry validates input before invoking a public handler", async () => {
  let called = false;
  const registry = new McpPublicRegistry({
    list_mail_folders: () => {
      called = true;
      return { folders: [] };
    },
  });
  const result = await registry.call("list_mail_folders", { accountId: "a", extra: true }, context);
  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent.error as { code: string }).code, "invalid_arguments");
});

test("registry validates output and sanitizes implementation failures", async () => {
  const registry = new McpPublicRegistry({ list_mail_accounts: () => ({ accounts: [{ secret: "leak" }] }) });
  const result = await registry.call("list_mail_accounts", {}, context);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: { code: "internal_error", message: "WeMail could not complete the request.", retryable: false },
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|leak/);
});

test("registry always returns structured content and a concise text fallback", async () => {
  const registry = new McpPublicRegistry({ list_mail_accounts: () => ({ accounts: [] }) });
  const result = await registry.call("list_mail_accounts", {}, context);
  assert.deepEqual(result.structuredContent, { accounts: [] });
  assert.equal(result.content[0]?.text, "list_mail_accounts returned 0 item(s).");
});

test("registry preserves stable domain errors without provider details", async () => {
  const registry = new McpPublicRegistry({
    list_mail_accounts: () => { throw new McpDomainError("provider_error", "IMAP password abc failed", true); },
  });
  const result = await registry.call("list_mail_accounts", {}, context);
  assert.equal((result.structuredContent.error as { code: string }).code, "provider_error");
  assert.doesNotMatch(JSON.stringify(result), /password|abc|IMAP/);
});

test("internal Agent tool names cannot be called through the public registry", async () => {
  const registry = new McpPublicRegistry({});
  for (const internalName of ["shell", "read_file", "configure_llm", "run_automation", "search_workspace"]) {
    const result = await registry.call(internalName, {}, context);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent.error as { code: string }).code, "invalid_request");
  }
});

test("registry rejects oversized serialized responses", async () => {
  const registry = new McpPublicRegistry({
    list_mail_accounts: () => ({
      accounts: Array.from({ length: 300 }, (_, index) => ({
        id: `account-${index}-${"x".repeat(300)}`,
        provider: "imap.example.test",
        email: `user-${index}@example.test`,
        capabilities: {
          schemaVersion: 1,
          folderModel: "folders",
          threading: "synthesized",
          serverSearch: false,
          providerDrafts: false,
          sendAs: false,
          outboundAttachments: true,
          syncMode: "full",
          realtimeMode: "poll",
          maxAttachmentBytes: 26_214_400,
          maxRecipients: 200,
        },
      })),
    }),
  });
  const result = await registry.call("list_mail_accounts", {}, context);
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent.error as { code: string }).code, "response_too_large");
});
