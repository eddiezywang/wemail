import assert from "node:assert/strict";
import test from "node:test";
import { createMcpComposition } from "./McpComposition.js";
import type { McpToolInvocationContext } from "./McpDomainAdapters.js";
import type { MailDatabase } from "../database/Database.js";
import type { MailSnapshotResult } from "../../../shared/wemail/mailCoreProtocol.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import type { EmailIntelligenceState } from "../../../shared/wemail/intelligence.js";
import type { DirectoryContactSearchResult } from "../../../shared/wemail/directory.js";
import type { ConversationState } from "../../../shared/wemail/conversationState.js";

// Minimal fake DB: every statement returns empty results. This satisfies the
// McpSettingsService / McpIdempotencyRepository constructor reads without
// needing a real SQLite handle.
const fakeDb = {
  prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }),
  transaction: (fn: (ctx: unknown) => unknown) => (ctx: unknown) => fn(ctx),
} as unknown as MailDatabase;

const secrets = { getSecret: () => undefined, saveSecret: () => undefined, get: () => undefined, set: () => undefined, delete: () => undefined } as any;
const accounts = { listAccounts: () => [], getCurrentAccount: () => null } as any;
const mailDatabase = {
  getMailSnapshot: async (_id: string): Promise<MailSnapshotResult> => { throw new Error("not stubbed"); },
  listFolders: async () => [],
} as any;

const context: McpToolInvocationContext = {
  accountId: "acct-1",
  tokenId: "token-1",
  sessionHash: "session-1",
  signal: new AbortController().signal,
};

function buildComposition(overrides: Record<string, unknown> = {}) {
  return createMcpComposition({
    db: fakeDb,
    secrets,
    accounts,
    mailDatabase,
    getProvider: () => undefined,
    ...overrides,
  } as any);
}

test("MCP draft writes reject attachments rather than silently dropping them", async () => {
  let writes = 0;
  const attachment = { id: "attachment-1", filename: "sample.pdf", mimetype: "application/pdf", size: 1, dataBase64: "YQ==" };
  const { registry, close } = buildComposition({
    mail: {
      getDraftById: () => ({ id: "draft-1", accountId: context.accountId, to: [], cc: [], bcc: [], attachments: [attachment] }),
      saveDraft: async () => { writes += 1; },
      updateDraft: async () => { writes += 1; },
    },
  });
  try {
    const upload = await registry.call("upload_mail_attachment", {
      accountId: context.accountId, filename: "sample.pdf", mimeType: "application/pdf", size: 1, dataBase64: "YQ==",
    }, context);
    assert.equal(upload.isError, undefined);
    const uploadRef = upload.structuredContent.uploadRef;
    const created = await registry.call("create_mail_draft", {
      accountId: context.accountId, mode: "new", attachments: [{ uploadRef }],
    }, context);
    const updated = await registry.call("update_mail_draft", { accountId: context.accountId, draftId: "draft-1" }, context);
    for (const result of [created, updated]) {
      assert.equal(result.isError, true);
      assert.equal((result.structuredContent.error as { code: string }).code, "capability_not_supported");
    }
    assert.equal(writes, 0);
  } finally { close(); }
});

test("get_mail_message honors a configured body limit above the old 20000 ceiling", async () => {
  const bodyText = "x".repeat(25_000);
  const message = {
    id: "mail-1",
    accountId: "acct-1",
    mailboxId: "inbox",
    folderId: "inbox",
    threadId: "thread-1",
    folder: "inbox",
    subject: "Long message",
    from: { email: "sender@example.com" },
    to: [],
    cc: [],
    bcc: [],
    receivedAt: "2026-08-12T00:00:00.000Z",
    snippet: "Long message",
    bodyText,
    attachments: [],
  } as unknown as MailMessage;
  const { registry, settings, close } = buildComposition({
    mailDatabase: { ...mailDatabase, getMailSnapshot: async () => ({ message } as MailSnapshotResult) },
  });
  try {
    const currentSettings = settings.get();
    settings.get = () => ({ ...currentSettings, maxBodyCharacters: 50_000 });
    const result = await registry.call(
      "get_mail_message",
      { accountId: "acct-1", messageId: "mail-1", maxBodyCharacters: 50_000 },
      context,
    );
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    assert.equal((result.structuredContent as any).message.bodyText.length, 25_000);
    assert.equal((result.structuredContent as any).message.truncated, false);
  } finally {
    close();
  }
});

test("get_mail_intelligence dispatches, projects, and validates end-to-end", async () => {
  const state: EmailIntelligenceState = {
    emailId: "mail-1",
    summary: { status: "succeeded", result: { type: "summary", bullets: ["b"], actionItems: [], urgency: "low" } },
    tags: { status: "succeeded", result: { type: "tags", tags: [{ name: "t", confidence: 0.5, source: "ai", tier: "auto" }] } },
    replyDecision: { status: "skipped" },
    replyDraft: { status: "skipped" },
  };
  const message = { id: "mail-1", accountId: "acct-1" } as MailMessage;
  const { registry, close } = buildComposition({
    intelligenceService: {
      getState: async () => state,
      confirmTag: async () => {},
      rejectTag: async () => {},
    },
    mailDatabase: { ...mailDatabase, getMailSnapshot: async () => ({ message } as MailSnapshotResult) },
  });
  try {
    const result = await registry.call("get_mail_intelligence", { accountId: "acct-1", messageId: "mail-1" }, context);
    assert.equal(result.isError, undefined);
    const intelligence = (result.structuredContent as any).intelligence;
    assert.equal(intelligence.emailId, "mail-1");
    assert.equal(intelligence.summary.ready, true);
    assert.equal(intelligence.tags.tagNames[0], "t");
  } finally {
    close();
  }
});

test("get_mail_intelligence rejects a message owned by another account", async () => {
  const message = { id: "mail-1", accountId: "acct-other" } as MailMessage;
  const { registry, close } = buildComposition({
    intelligenceService: { getState: async () => { throw new Error("must not be called"); }, confirmTag: async () => {}, rejectTag: async () => {} },
    mailDatabase: { ...mailDatabase, getMailSnapshot: async () => ({ message } as MailSnapshotResult) },
  });
  try {
    const result = await registry.call("get_mail_intelligence", { accountId: "acct-1", messageId: "mail-1" }, context);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, "message_not_found");
  } finally {
    close();
  }
});

test("get_mail_intelligence rejects account mismatch before any DB read", async () => {
  const { registry, close } = buildComposition({
    intelligenceService: { getState: async () => { throw new Error("must not be called"); }, confirmTag: async () => {}, rejectTag: async () => {} },
    mailDatabase: { ...mailDatabase, getMailSnapshot: async () => { throw new Error("must not be called"); } },
  });
  try {
    const result = await registry.call("get_mail_intelligence", { accountId: "other", messageId: "mail-1" }, context);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, "account_mismatch");
  } finally {
    close();
  }
});

test("search_mail_semantic dispatches and bounds chunks", async () => {
  const { registry, settings, close } = buildComposition({
    semanticSearchService: {
      search: async () => ({
        mode: "semantic",
        chunks: Array.from({ length: 60 }, (_, i) => ({ emailId: `m-${i}`, chunkId: `c-${i}`, score: 0.5, snippet: "s" })),
        totalChunks: 60,
      }),
    },
  });
  try {
    // The bound comes from the MCP page-size setting, not a hard-coded 50.
    // Pin it so the assertion is deterministic on every runtime.
    const currentSettings = settings.get();
    settings.get = () => ({ ...currentSettings, maxPageSize: 50 });
    const result = await registry.call("search_mail_semantic", { accountId: "acct-1", query: "hello" }, context);
    assert.equal((result.structuredContent as any).mode, "semantic");
    assert.equal((result.structuredContent as any).chunks.length, 50, "chunks bounded at 50");
  } finally {
    close();
  }
});

test("ask_mail_question omits answer when no evidence", async () => {
  const { registry, close } = buildComposition({
    mailQaService: {
      answer: async () => ({ hasEvidence: false, claims: [], mode: "lexical", retrievedChunkCount: 0 }),
    },
  });
  try {
    const result = await registry.call("ask_mail_question", { accountId: "acct-1", question: "anything?" }, context);
    const sc = result.structuredContent as any;
    assert.equal(sc.hasEvidence, false);
    assert.ok(!("answer" in sc), "answer must be absent when no evidence");
    assert.ok(!("truncated" in sc), "truncated must be absent when no evidence");
  } finally {
    close();
  }
});

test("record_tag_feedback routes confirm/reject and records caller session", async () => {
  let confirmCalls = 0;
  let rejectCalls = 0;
  let lastCaller: any = null;
  const message = { id: "mail-1", accountId: "acct-1" } as MailMessage;
  const { registry, close } = buildComposition({
    intelligenceService: {
      getState: async () => { throw new Error("unused"); },
      confirmTag: async (_id: string, _tag: string, caller: any) => { confirmCalls++; lastCaller = caller; },
      rejectTag: async (_id: string, _tag: string, caller: any) => { rejectCalls++; lastCaller = caller; },
    },
    mailDatabase: { ...mailDatabase, getMailSnapshot: async () => ({ message } as MailSnapshotResult) },
  });
  try {
    let result = await registry.call("record_tag_feedback", { accountId: "acct-1", messageId: "mail-1", tag: "invoice", action: "confirm" }, context);
    assert.equal((result.structuredContent as any).recorded, true);
    assert.equal(confirmCalls, 1);
    assert.equal(rejectCalls, 0);
    assert.equal(lastCaller.sessionId, "session-1");

    result = await registry.call("record_tag_feedback", { accountId: "acct-1", messageId: "mail-1", tag: "invoice", action: "reject" }, context);
    assert.equal((result.structuredContent as any).action, "reject");
    assert.equal(rejectCalls, 1);
  } finally {
    close();
  }
});

test("record_tag_feedback refuses a message owned by another account", async () => {
  const message = { id: "mail-1", accountId: "acct-other" } as MailMessage;
  const { registry, close } = buildComposition({
    intelligenceService: { getState: async () => { throw new Error("x"); }, confirmTag: async () => { throw new Error("must not be called"); }, rejectTag: async () => { throw new Error("must not be called"); } },
    mailDatabase: { ...mailDatabase, getMailSnapshot: async () => ({ message } as MailSnapshotResult) },
  });
  try {
    const result = await registry.call("record_tag_feedback", { accountId: "acct-1", messageId: "mail-1", tag: "t", action: "reject" }, context);
    assert.equal((result.structuredContent as any).error.code, "message_not_found");
  } finally {
    close();
  }
});

test("list_agent_attention dispatches and reports failureSince", async () => {
  const { registry, close } = buildComposition({
    agentRuns: {
      listAttention: (_acct: string, since: string) => {
        assert.ok(since.endsWith("Z"), "failureSince is an ISO string");
        return { active: [], failed: [], pausedConversationIds: ["conv-paused"] };
      },
      loadConversationState: (_id: string): ConversationState => { throw new Error("unused"); },
    },
  });
  try {
    const result = await registry.call("list_agent_attention", { accountId: "acct-1" }, context);
    const sc = result.structuredContent as any;
    assert.deepEqual(sc.pausedConversationIds, ["conv-paused"]);
    assert.ok(typeof sc.failureSince === "string");
  } finally {
    close();
  }
});

test("get_conversation_state rejects cross-account conversation", async () => {
  const { registry, close } = buildComposition({
    agentRuns: { listAttention: () => ({ active: [], failed: [], pausedConversationIds: [] }), loadConversationState: () => { throw new Error("must not be called"); } },
    pendingActions: { getAccountIdForConversation: () => "acct-other" },
  });
  try {
    const result = await registry.call("get_conversation_state", { accountId: "acct-1", conversationId: "conv-1" }, context);
    assert.equal((result.structuredContent as any).error.code, "account_mismatch");
  } finally {
    close();
  }
});

test("get_conversation_state proceeds when conversation has no owner (null)", async () => {
  const empty = { conversationId: "conv-1", messageOrder: [], messages: {}, runs: {}, tools: {}, confirmations: {}, citations: {}, followupOrder: [], followups: {}, attachments: {} } as ConversationState;
  const { registry, close } = buildComposition({
    agentRuns: { listAttention: () => ({ active: [], failed: [], pausedConversationIds: [] }), loadConversationState: () => empty },
    pendingActions: { getAccountIdForConversation: () => null },
  });
  try {
    const result = await registry.call("get_conversation_state", { accountId: "acct-1", conversationId: "conv-1" }, context);
    assert.equal((result.structuredContent as any).conversation.messageCount, 0);
  } finally {
    close();
  }
});

test("search_directory_contacts strips PII and bounds contacts", async () => {
  const result: DirectoryContactSearchResult = {
    contacts: Array.from({ length: 60 }, (_, i) => ({
      id: `c-${i}`, accountId: "acct-1", name: `N${i}`, email: `n${i}@example.com`, aliases: [],
      mobile: "13800000000", companyPhone: "010-1",
    })),
    total: 60,
    remoteAvailable: true,
  };
  const { registry, settings, close } = buildComposition({
    directoryService: { searchContacts: async () => result },
  });
  try {
    // Keep the fixture inside the catalog's 50-contact output schema: the
    // handler slices to the configured max page size, so pin it explicitly.
    const currentSettings = settings.get();
    settings.get = () => ({ ...currentSettings, maxPageSize: 50 });
    const res = await registry.call("search_directory_contacts", { accountId: "acct-1", query: "N" }, context);
    const sc = res.structuredContent as any;
    assert.equal(sc.contacts.length, 50, "contacts bounded at 50");
    assert.ok(!("mobile" in sc.contacts[0]), "PII mobile stripped");
    assert.ok(!("companyPhone" in sc.contacts[0]), "PII companyPhone stripped");
    assert.equal(sc.total, 60);
  } finally {
    close();
  }
});

test("invalid input is rejected before the handler runs (schema validation)", async () => {
  const { registry, close } = buildComposition({
    semanticSearchService: { search: async () => { throw new Error("must not be called"); } },
  });
  try {
    // query missing → violates required:["accountId","query"]
    const result = await registry.call("search_mail_semantic", { accountId: "acct-1" }, context);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, "invalid_arguments");
  } finally {
    close();
  }
});

test("list_todos strips directoryName from projected mail.from", async () => {
  const todo = {
    id: "todo-1", accountId: "acct-1", emailId: "mail-1", title: "T",
    priority: "medium", done: false, status: "confirmed", source: "mcp",
    createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z",
  } as any;
  const message = {
    id: "mail-1", accountId: "acct-1", subject: "S",
    from: { email: "n@example.com", name: "N", directoryName: "DirN" },
    receivedAt: "2026-08-12T00:00:00.000Z",
  } as MailMessage;
  const { registry, close } = buildComposition({
    todos: { listPage: () => [todo] },
    mail: { getMessageById: () => message },
  });
  try {
    const res = await registry.call("list_todos", { accountId: "acct-1", pageSize: 10 }, context);
    assert.equal(res.isError, undefined, JSON.stringify(res));
    const sc = res.structuredContent as any;
    assert.equal(sc.todos.length, 1);
    assert.deepEqual(sc.todos[0].mail.from, { email: "n@example.com", name: "N" });
    assert.ok(!("directoryName" in sc.todos[0].mail.from), "directoryName must be stripped");
  } finally {
    close();
  }
});
