import { insertCanonicalTestAccount } from "../../wemail/database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentRuntime,
  AgentTool,
} from "../../wemail/agent/AgentRuntime.js";
import {
  PiAgentRuntime,
  type AgentPlanner,
  type PlannerDecision,
  type PlannerStepInput,
} from "../../wemail/agent/PiAgentRuntime.js";
import { buildAgentRoutes } from "./agentRoutes.js";
import { openOrCreateMailDatabase } from "../../wemail/database/Database.js";
import { AgentConversationRepository } from "../../wemail/agent/AgentConversationRepository.js";
import { AgentPendingActionRepository, type AgentPendingActionRow } from "../../wemail/agent/AgentPendingActionRepository.js";
import type { AgentActionExecutor } from "../../wemail/agent/AgentActionExecutor.js";
import type { AgentPendingAction } from "../../../shared/wemail/intelligence.js";
import type { EmailIntelligenceState } from "../../../shared/wemail/intelligence.js";
import type { WemailAgentEvent } from "../../../shared/wemail/agentProtocol.js";
import { AgentRunRepository } from "../../wemail/agent/AgentRunRepository.js";
import { AgentEventPersistence } from "../../wemail/agent/AgentEventPersistence.js";
import { AgentRunCoordinator } from "../../wemail/agent/AgentRunCoordinator.js";

function scripted(decisions: PlannerDecision[]): AgentPlanner {
  let i = 0;
  return {
    async step() {
      const d = decisions[i] ?? { kind: "final", text: "no more" };
      i += 1;
      return d;
    },
  };
}

const probe: AgentTool = {
  name: "probe",
  description: "echo",
  inputSchema: { type: "object" },
  async handler(input) {
    return { got: input };
  },
};

function makeApp(decisions: PlannerDecision[]) {
  const runtime = new PiAgentRuntime({ planner: scripted(decisions) });
  runtime.registerTool(probe);
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({ runtime }));
  return app;
}

function makeIntelligenceState(
  overrides: Partial<EmailIntelligenceState> = {},
): EmailIntelligenceState {
  return {
    emailId: "msg-1",
    summary: { status: "skipped" },
    tags: { status: "skipped" },
    replyDecision: { status: "skipped" },
    replyDraft: { status: "skipped" },
    ...overrides,
  };
}

function makeSuggestionsAppWithIntelligence(input: {
  state: EmailIntelligenceState;
  envelope: {
    id: string;
    subject: string;
    from: string;
    snippet: string;
    folder: string;
    attachments?: Array<{ id?: string; filename?: string; mimetype?: string }>;
  } | null;
}) {
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      mailDatabase: {
        async getIntelligenceState() {
          return input.state;
        },
        async getMailSnapshot() {
          const envelope = input.envelope;
          return {
            message: envelope ? {
              id: envelope.id,
              accountId: "account-1",
              folder: envelope.folder,
              messageId: `<${envelope.id}@example.test>`,
              from: { email: envelope.from },
              to: [],
              cc: [],
              bcc: [],
              replyTo: [],
              subject: envelope.subject,
              snippet: envelope.snippet,
              bodyText: "",
              bodyHtml: "",
              attachments: envelope.attachments ?? [],
              receivedAt: new Date().toISOString(),
              flags: { seen: false, flagged: false, answered: false, draft: false },
              headers: {},
              sync: { uid: 1, uidValidity: 1, internalDate: new Date().toISOString() },
            } : null,
            bodyState: "ready",
            invoiceDetected: false,
            invoiceStatus: null,
          };
        },
      } as any,
    }),
  );
  return app;
}

test("GET /api/agent/tools lists registered tools", async () => {
  const app = makeApp([{ kind: "final", text: "x" }]);
  const res = await app.request("/api/agent/tools");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    tools: Array<{ name: string }>;
  };
  assert.equal(body.ok, true);
  assert.equal(body.tools.length, 2);
  assert.equal(body.tools[0].name, "probe");
  assert.equal(body.tools[1].name, "terminate_execution");
});

test("POST /api/agent/chat (JSON) returns versioned events terminating in run_settled", async () => {
  const app = makeApp([
    { kind: "tool_call", tool: "probe", input: { a: 1 } },
    { kind: "final", text: "all-done" },
  ]);
  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userText: "hello" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    events: Array<{ type: string }>;
  };
  assert.equal(body.ok, true);
  const types = body.events.map((e) => e.type);
  assert.deepEqual(types, [
    "run_started",
    "run_state_changed",
    "message_started",
    "tool_call_started",
    "tool_args_completed",
    "tool_execution_started",
    "tool_execution_completed",
    "text_started",
    "text_completed",
    "message_completed",
    "run_settled",
  ]);
});

test("POST /api/agent/chat (SSE) streams events", async () => {
  const app = makeApp([{ kind: "final", text: "bye" }]);
  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({ userText: "hi" }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /event-stream/);
  const text = await res.text();
  assert.match(text, /event: run_started/);
  assert.match(text, /event: text_completed/);
  assert.match(text, /event: run_settled/);
  assert.doesNotMatch(text, /event: assistant_text/);
});

test("POST /api/agent/chat preserves Pi deltas and persists structured final parts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-stream-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  const conversations = new AgentConversationRepository(
    db,
    () => "2026-07-13T12:00:00.000Z",
  );
  const runtime: AgentRuntime = {
    registerTool() {},
    listTools() {
      return [];
    },
    async *run() {
      yield { type: "text_start", contentIndex: 0 };
      yield { type: "text_delta", contentIndex: 0, text: "我先查询最近邮件。" };
      yield { type: "text_end", contentIndex: 0, text: "我先查询最近邮件。" };
      yield {
        type: "tool_call",
        tool: "search_emails",
        toolCallId: "call-1",
        input: { dateRange: "last_7_days" },
      };
      yield {
        type: "tool_result",
        tool: "search_emails",
        toolCallId: "call-1",
        output: { count: 2 },
      };
      yield { type: "reasoning_start", contentIndex: 0 };
      yield { type: "reasoning_delta", contentIndex: 0, text: "整理" };
      yield { type: "reasoning_delta", contentIndex: 0, text: "邮件重点" };
      yield { type: "reasoning_end", contentIndex: 0, text: "整理邮件重点" };
      yield { type: "text_start", contentIndex: 1 };
      yield { type: "text_delta", contentIndex: 1, text: "## 邮件总结" };
      yield { type: "text_delta", contentIndex: 1, text: "\n\n" };
      yield { type: "text_delta", contentIndex: 1, text: "- 第一项\n" };
      yield {
        type: "text_end",
        contentIndex: 1,
        text: "## 邮件总结\n\n- 第一项\n",
      };
      yield { type: "done" };
    },
  };
  const runs = new AgentRunRepository(db);
  const eventPersistence = new AgentEventPersistence(runs);
  const runCoordinator = new AgentRunCoordinator(runs);
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({
    runtime,
    conversations,
    runs,
    eventPersistence,
    runCoordinator,
  }));

  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      userText: "总结最近邮件",
      sessionId: "conv-structured",
    }),
  });

  assert.equal(res.status, 200);
  const streamText = await res.text();
  assert.match(streamText, /"delta":"\\n\\n"/);
  // Provider reasoning deltas are diagnostic-only: they must never reach the
  // client stream (PiEventAdapter drops reasoning_* by design).
  assert.doesNotMatch(streamText, /reasoning/);
  const assistant = conversations
    .listMessages("conv-structured")
    .find((message) => message.role === "assistant");
  assert.ok(assistant);
  assert.equal(
    assistant.body.text,
    "我先查询最近邮件。\n\n## 邮件总结\n\n- 第一项\n",
  );
  assert.equal(assistant.body.parts, undefined);
  assert.equal(assistant.body.events, undefined);
  const restored = runs.loadConversationState("conv-structured");
  assert.ok(restored.messages[assistant.id]?.parts.length);
  const stored = db.prepare(
    "SELECT markdown_source, parts_json FROM agent_messages WHERE id = ?",
  ).get(assistant.id) as { markdown_source: string; parts_json: string };
  assert.equal(
    stored.markdown_source,
    "我先查询最近邮件。\n\n## 邮件总结\n\n- 第一项\n",
  );
  assert.doesNotMatch(stored.parts_json, /text_delta|reasoning_delta/);
  const storedRun = db.prepare(
    "SELECT state FROM agent_runs WHERE conversation_id = ?",
  ).get("conv-structured") as { state: string };
  assert.equal(storedRun.state, "settled");
});

test("POST /api/agent/chat (SSE) maps progress and terminal failure to versioned events", async () => {
  const app = makeApp([
    {
      kind: "tool_call",
      tool: "terminate_execution",
      input: { reason: "No focused email" },
      callReason: "Need focused email context",
    },
  ]);
  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({ userText: "reply" }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: progress_added/);
  assert.match(text, /Need focused email context/);
  assert.match(text, /event: run_failed/);
  // Tool input args are projected to a public-safe whitelist: the
  // terminate_execution `reason` argument must not leak into the stream.
  assert.doesNotMatch(text, /No focused email/);
  assert.match(text, /event: message_completed/);
  assert.doesNotMatch(text, /event: terminate/);
});

test("POST /api/agent/chat persists a terminal failure as an explicit final conclusion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-conclusion-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  const conversations = new AgentConversationRepository(
    db,
    () => "2026-07-20T12:00:00.000Z",
  );
  const runtime: AgentRuntime = {
    registerTool() {},
    listTools() {
      return [];
    },
    async *run() {
      yield {
        type: "tool_call",
        tool: "enterprise_cli",
        input: { command: "upload" },
      };
      yield {
        type: "tool_result",
        tool: "enterprise_cli",
        output: { ok: false, error: "CLI 未安装" },
        isError: true,
      };
      yield {
        type: "conclusion",
        status: "failed",
        summary: "本次执行未完成。",
        reason: "当前电脑未安装所需的企业 CLI。",
        nextAction: "请先安装 CLI，然后重新执行。",
      };
      yield { type: "terminate", reason: "terminal tool failure" };
      yield { type: "done" };
    },
  };
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({ runtime, conversations }));

  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      userText: "执行上传",
      sessionId: "conv-terminal-conclusion",
    }),
  });

  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: run_failed/);
  const assistant = conversations
    .listMessages("conv-terminal-conclusion")
    .find((message) => message.role === "assistant");
  assert.ok(assistant);
  assert.equal(
    assistant.body.text,
    [
      "执行结果：失败",
      "失败原因：当前电脑未安装所需的企业 CLI。",
      "建议：请先安装 CLI，然后重新执行。",
    ].join("\n\n"),
  );
});

test("POST /api/agent/chat rejects missing userText", async () => {
  const app = makeApp([{ kind: "final", text: "x" }]);
  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("POST /api/agent/chat persists conversation, messages, and email context", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-routes-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  const conversations = new AgentConversationRepository(db, () => "2026-04-24T12:00:00.000Z");
  const runtime = new PiAgentRuntime({ planner: scripted([{ kind: "final", text: "noted" }]) });
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({ runtime, conversations }));

  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userText: "summarize this",
      context: { emailId: "acct-1:INBOX:1:10" },
      emailId: "acct-1:INBOX:1:10",
      attachedMail: {
        subject: "补光灯067",
        sender: "SHDR Lost & Found",
        receivedAt: "2026-06-01T07:52:17.000Z",
      },
    }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { conversationId: string };
  const messages = conversations.listMessages(body.conversationId);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "user");
  const userBody = messages[0]!.body as {
    context: { emailId: string };
    attachedMail: { subject: string; sender: string };
  };
  assert.equal(userBody.context.emailId, "acct-1:INBOX:1:10");
  assert.deepEqual(userBody.attachedMail, {
    subject: "补光灯067",
    sender: "SHDR Lost & Found",
    receivedAt: "2026-06-01T07:52:17.000Z",
  });
  assert.equal(messages[1]!.role, "assistant");

  const listed = await app.request("/api/agent/conversations");
  assert.equal(((await listed.json()) as { conversations: unknown[] }).conversations.length, 1);
});

test("POST /api/agent/chat persists @-attached mails, dropping invalid and duplicate entries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-routes-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  const conversations = new AgentConversationRepository(db, () => "2026-04-24T12:00:00.000Z");
  const runtime = new PiAgentRuntime({ planner: scripted([{ kind: "final", text: "noted" }]) });
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({ runtime, conversations }));

  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userText: "compare these",
      attachedMails: [
        { emailId: "acct-1:INBOX:1:10", subject: "补光灯067", sender: "SHDR Lost & Found" },
        { emailId: "acct-1:INBOX:1:10", subject: "补光灯067", sender: "SHDR Lost & Found" },
        { emailId: "acct-1:INBOX:1:11", subject: "月度发票核对" },
        { sender: "no subject entry" },
        "not an object",
      ],
    }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { conversationId: string };
  const messages = conversations.listMessages(body.conversationId);
  const userBody = messages[0]!.body as {
    attachedMails: { emailId?: string; subject: string }[];
  };
  assert.deepEqual(userBody.attachedMails, [
    { emailId: "acct-1:INBOX:1:10", subject: "补光灯067", sender: "SHDR Lost & Found" },
    { emailId: "acct-1:INBOX:1:11", subject: "月度发票核对" },
  ]);
});

test("POST /api/agent/chat with persist false does not store conversation history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-routes-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  const conversations = new AgentConversationRepository(db, () => "2026-04-24T12:00:00.000Z");
  const runtime = new PiAgentRuntime({ planner: scripted([{ kind: "final", text: "rewritten" }]) });
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({ runtime, conversations }));

  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userText: "rewrite selected text",
      persist: false,
    }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { conversationId?: string };
  assert.equal(body.conversationId, undefined);
  assert.equal(conversations.list().length, 0);
});

test("GET /api/agent/suggestions returns deterministic email-scoped suggestions", async () => {
  const app = makeApp([{ kind: "final", text: "x" }]);

  const res = await app.request(
    "/api/agent/suggestions?accountId=acct-1&emailId=acct-1%3AINBOX%3A1%3A10",
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    suggestions: Array<{ id: string; label: string; prompt: string }>;
  };
  assert.equal(body.ok, true);
  assert.equal(body.suggestions.length, 3);
  assert.deepEqual(
    body.suggestions.map((s) => s.id),
    ["summarize-email", "draft-reply", "extract-todos"],
  );
  assert.equal(body.suggestions[0]!.prompt, "总结这封邮件，列出重点和风险。");
  for (const suggestion of body.suggestions) {
    assert.doesNotMatch(suggestion.prompt, /emailId|tool:|path:|acct-1:INBOX:1:10/);
  }
});

test("POST /api/agent/chat redacts internal citation fields from assistant output", async () => {
  const app = makeApp([
    {
      kind: "final",
      text: "邮件已找到。\n（emailId: acct-1:INBOX:1:10, tool: summarize_mail, path: summary.headline）",
    },
  ]);
  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userText: "总结" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { events: WemailAgentEvent[] };
  const assistantEvent = body.events.find(
    (event): event is Extract<WemailAgentEvent, { type: "text_completed" }> =>
      event.type === "text_completed",
  );
  assert.equal(assistantEvent?.text, "邮件已找到。");
  assert.doesNotMatch(JSON.stringify(body.events), /emailId|summarize_mail|path:/);
});

test("GET /api/agent/suggestions does not restore fixed account shortcuts without a home action service", async () => {
  const app = makeApp([{ kind: "final", text: "x" }]);

  const res = await app.request("/api/agent/suggestions?accountId=acct-1");

  assert.equal(res.status, 200);
  const body = (await res.json()) as { suggestions: Array<{ id: string }> };
  assert.deepEqual(body.suggestions, []);
});

test("GET /api/agent/suggestions delegates mailbox home to contextual suggestion service", async () => {
  const requests: Array<{ accountId: string; timezone: string }> = [];
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      homeSuggestions: {
        getSuggestions(request: { accountId: string; timezone: string }) {
          requests.push(request);
          return {
            suggestions: [{
              id: "today-actions",
              label: "处理今天尚未回复的平台待办",
              prompt: "处理推荐范围内的平台待办。",
              emailIds: ["mail-1", "mail-2"],
            }],
            contextLine: "今天有 8 封新邮件，其中 2 封建议优先处理。",
            source: "rules" as const,
            candidateFingerprint: "fingerprint-1",
            refreshPending: true,
          };
        },
      } as never,
    }),
  );

  const res = await app.request(
    "/api/agent/suggestions?accountId=acct-1&timezone=Asia%2FShanghai",
  );
  assert.equal(res.status, 200);
  assert.deepEqual(requests, [{ accountId: "acct-1", timezone: "Asia/Shanghai" }]);
  assert.deepEqual(await res.json(), {
    ok: true,
    suggestions: [{
      id: "today-actions",
      label: "处理今天尚未回复的平台待办",
      prompt: "处理推荐范围内的平台待办。",
      emailIds: ["mail-1", "mail-2"],
    }],
    contextLine: "今天有 8 封新邮件，其中 2 封建议优先处理。",
    source: "rules",
    candidateFingerprint: "fingerprint-1",
    refreshPending: true,
  });
});

test("GET /api/agent/suggestions returns semantic home actions with discovery and execution scope", async () => {
  const requestedAccountIds: string[] = [];
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      getHomeActionSuggestions: async (accountId) => {
        requestedAccountIds.push(accountId);
        return {
          suggestions: [{
            id: "aggregate-alerts-24h",
            label: "汇总过去 24 小时的系统告警",
            prompt: "汇总过去 24 小时全部系统告警。",
            kind: "aggregate",
            discovery: {
              emailIds: ["alert-1", "alert-2"],
              primaryWindow: "24h",
              mailState: "unread",
            },
            executionScope: {
              mode: "query",
              query: {
                receivedWithin: "24h",
                mailState: "all",
                folder: "inbox",
                category: "notification",
              },
            },
          }],
          contextLine: "发现 1 项可以继续处理的邮件行动。",
          source: "rules",
          candidateFingerprint: "fp-1",
          refreshPending: false,
        };
      },
    }),
  );

  const res = await app.request("/api/agent/suggestions?accountId=acct-2");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    contextLine?: string;
    source: string;
    candidateFingerprint: string;
    refreshPending: boolean;
    suggestions: Array<Record<string, unknown>>;
  };

  assert.deepEqual(requestedAccountIds, ["acct-2"]);
  assert.equal(body.contextLine, "发现 1 项可以继续处理的邮件行动。");
  assert.equal(body.source, "rules");
  assert.equal(body.candidateFingerprint, "fp-1");
  assert.equal(body.refreshPending, false);
  assert.deepEqual(body.suggestions[0]?.discovery, {
    emailIds: ["alert-1", "alert-2"],
    primaryWindow: "24h",
    mailState: "unread",
  });
});

test("GET /api/agent/suggestions rejects account ids outside the active account", async () => {
  let providerCalled = false;
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      getActiveAccountId: () => "acct-1",
      getHomeActionSuggestions: async () => {
        providerCalled = true;
        return {
          suggestions: [],
          source: "rules",
          candidateFingerprint: "fp",
          refreshPending: false,
        };
      },
    }),
  );

  const res = await app.request("/api/agent/suggestions?accountId=acct-2");
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: "cross-account-suggestions",
  });
  assert.equal(providerCalled, false);
});

test("GET /api/agent/suggestions uses focused invoice context before generic fallback", async () => {
  const app = makeSuggestionsAppWithIntelligence({
    state: makeIntelligenceState({
      summary: {
        status: "succeeded",
        result: {
          type: "summary",
          schemaVersion: 2,
          intent: "invoice",
          attention: "know",
          displayMode: "one_line",
          headline: "湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。",
          bullets: ["湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。"],
          actionItems: [],
          urgency: "low",
        },
      },
    }),
    envelope: {
      id: "acct-1:INBOX:1:10",
      subject: "湖北电信电子发票",
      from: "info@hb-189.cn",
      snippet: "您有一张电子发票，请查收附件。",
      folder: "INBOX",
      attachments: [
        {
          id: "att-1",
          filename: "26427000000526378227.pdf",
          mimetype: "application/pdf",
        },
      ],
    },
  });

  const res = await app.request(
    "/api/agent/suggestions?accountId=acct-1&emailId=acct-1%3AINBOX%3A1%3A10",
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    suggestions: Array<{ id: string; label: string; prompt: string }>;
  };
  assert.equal(body.ok, true);
  // P2.6: the invoice-upload suggestion is an edition module capability; the
  // open route falls back to the generic suggestions (the module-aware
  // ordering coverage runs in the edition overlay's suite).
  assert.ok(!body.suggestions.some((s) => s.id === "upload-allowance-invoice"));
  assert.ok(body.suggestions.length > 0);
  for (const suggestion of body.suggestions) {
    assert.doesNotMatch(suggestion.prompt, /emailId|tool:|path:|acct-1:INBOX:1:10/);
  }
});

test("endpoints return 503 when runtime is unwired", async () => {
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({}));
  const tools = await app.request("/api/agent/tools");
  assert.equal(tools.status, 503);
  const chat = await app.request("/api/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userText: "x" }),
  });
  assert.equal(chat.status, 503);
});

function makeConversationApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-convo-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  let n = 0;
  const conversations = new AgentConversationRepository(db, () => {
    n += 1;
    return new Date(Date.UTC(2026, 3, 24, 12, n)).toISOString();
  });
  const runtime = new PiAgentRuntime({
    planner: scripted([{ kind: "final", text: "ack" }]),
  });
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({ runtime, conversations }));
  return { app, conversations };
}

test("PATCH /api/agent/conversations/:id renames", async () => {
  const { app, conversations } = makeConversationApp();
  const created = conversations.ensureConversation({
    id: "conv-x",
    accountId: "acct-1",
  });

  const res = await app.request(`/api/agent/conversations/${created.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: " Tax planning  " }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    conversation: { title: string };
  };
  assert.equal(body.ok, true);
  assert.equal(body.conversation.title, "Tax planning");
  assert.equal(conversations.get("conv-x")?.title, "Tax planning");
});

test("PATCH rejects empty + oversized titles", async () => {
  const { app, conversations } = makeConversationApp();
  conversations.ensureConversation({ id: "conv-x" });

  const empty = await app.request("/api/agent/conversations/conv-x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "   " }),
  });
  assert.equal(empty.status, 400);

  const tooLong = await app.request("/api/agent/conversations/conv-x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "x".repeat(81) }),
  });
  assert.equal(tooLong.status, 400);

  const missing = await app.request("/api/agent/conversations/no-such", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "ok" }),
  });
  assert.equal(missing.status, 404);
});

test("POST pin + unpin toggles pinned_at and persists across list", async () => {
  const { app, conversations } = makeConversationApp();
  conversations.ensureConversation({ id: "conv-pin", title: "Pinned thread" });

  const pinned = await app.request("/api/agent/conversations/conv-pin/pin", {
    method: "POST",
  });
  assert.equal(pinned.status, 200);
  assert.ok(conversations.get("conv-pin")?.pinnedAt);

  const list = (await (
    await app.request("/api/agent/conversations")
  ).json()) as { conversations: { id: string; pinnedAt?: string }[] };
  const row = list.conversations.find((c) => c.id === "conv-pin");
  assert.ok(row?.pinnedAt, "pinnedAt should appear in list payload");

  const unpinned = await app.request(
    "/api/agent/conversations/conv-pin/unpin",
    { method: "POST" },
  );
  assert.equal(unpinned.status, 200);
  assert.equal(conversations.get("conv-pin")?.pinnedAt, undefined);

  const missing = await app.request(
    "/api/agent/conversations/no-such/pin",
    { method: "POST" },
  );
  assert.equal(missing.status, 404);
});

test("GET /conversations supports search and accountId filters", async () => {
  const { app, conversations } = makeConversationApp();
  conversations.ensureConversation({
    id: "c1",
    accountId: "acct-1",
    title: "Quarterly review",
  });
  conversations.ensureConversation({
    id: "c2",
    accountId: "acct-1",
    title: "Tax planning",
  });
  conversations.ensureConversation({
    id: "c3",
    accountId: "acct-2",
    title: "Quarterly checkin",
  });

  const searched = (await (
    await app.request("/api/agent/conversations?search=quarterly")
  ).json()) as { conversations: { id: string }[] };
  assert.deepEqual(
    searched.conversations.map((c) => c.id).sort(),
    ["c1", "c3"],
  );

  const scoped = (await (
    await app.request("/api/agent/conversations?accountId=acct-1")
  ).json()) as { conversations: { id: string }[] };
  assert.deepEqual(
    scoped.conversations.map((c) => c.id).sort(),
    ["c1", "c2"],
  );

  const both = (await (
    await app.request(
      "/api/agent/conversations?search=quarterly&accountId=acct-1",
    )
  ).json()) as { conversations: { id: string }[] };
  assert.deepEqual(both.conversations.map((c) => c.id), ["c1"]);
});

test("POST archive + unarchive toggles archived_at and filters list", async () => {
  const { app, conversations } = makeConversationApp();
  conversations.ensureConversation({ id: "conv-keep", title: "Keep" });
  conversations.ensureConversation({ id: "conv-archive", title: "Archive me" });

  const archived = await app.request(
    "/api/agent/conversations/conv-archive/archive",
    { method: "POST" },
  );
  assert.equal(archived.status, 200);
  assert.ok(conversations.get("conv-archive")?.archivedAt);

  const list = (await (
    await app.request("/api/agent/conversations")
  ).json()) as { conversations: { id: string }[] };
  assert.deepEqual(
    list.conversations.map((c) => c.id),
    ["conv-keep"],
  );

  const listAll = (await (
    await app.request("/api/agent/conversations?includeArchived=1")
  ).json()) as { conversations: { id: string; archivedAt?: string }[] };
  assert.equal(listAll.conversations.length, 2);

  const unarchived = await app.request(
    "/api/agent/conversations/conv-archive/unarchive",
    { method: "POST" },
  );
  assert.equal(unarchived.status, 200);
  assert.equal(conversations.get("conv-archive")?.archivedAt, undefined);

  const missing = await app.request(
    "/api/agent/conversations/no-such/archive",
    { method: "POST" },
  );
  assert.equal(missing.status, 404);
});

function makePendingActionsApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-pa-routes-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  // Satisfy the FK on agent_pending_actions.conversation_id.
  db.prepare(
    `INSERT INTO agent_conversations (id, account_id, title, created_at, updated_at)
     VALUES ('conv-1', 'acct-1', 'Test conversation', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  const pendingActions = new AgentPendingActionRepository({
    db,
    now: () => "2026-04-26T10:00:00.000Z",
  });
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({ pendingActions }));
  return { app, pendingActions };
}

test("GET /pending-actions returns camelCase records with stored riskLevel", async () => {
  const { app, pendingActions } = makePendingActionsApp();
  pendingActions.insert({
    id: "pa-route-1",
    conversationId: "conv-1",
    actionType: "send",
    description: "Send the quarterly report",
    inputJson: '{"actionType":"send"}',
    riskReason: "send is high-risk",
    riskLevel: "high",
  });

  const res = await app.request("/api/agent/pending-actions?conversationId=conv-1");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; actions: AgentPendingAction[] };
  assert.equal(body.ok, true);
  assert.equal(body.actions.length, 1);
  const [action] = body.actions;
  assert.equal(action.id, "pa-route-1");
  assert.equal(action.actionType, "send");
  assert.equal(action.description, "Send the quarterly report");
  assert.equal(action.inputJson, '{"actionType":"send"}');
  assert.equal(action.riskReason, "send is high-risk");
  assert.equal(action.toolName, "propose_action");
  assert.equal(action.riskLevel, "high");
});

test("GET /pending-actions falls back to derived riskLevel for legacy NULL rows", async () => {
  const { app, pendingActions } = makePendingActionsApp();
  // No riskLevel passed — column is NULL on disk (legacy row).
  pendingActions.insert({
    id: "pa-route-2",
    conversationId: "conv-1",
    actionType: "archive",
    description: "Archive newsletter",
    inputJson: '{"actionType":"archive"}',
    riskReason: "archive is high-risk",
  });

  const res = await app.request("/api/agent/pending-actions?conversationId=conv-1");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; actions: AgentPendingAction[] };
  assert.equal(body.actions.length, 1);
  // archive -> derived "medium"
  assert.equal(body.actions[0].riskLevel, "medium");
});

function makePendingActionsAppWithExecutor(
  executor?: AgentActionExecutor,
  runtime?: AgentRuntime,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-pa-exec-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  db.prepare(
    `INSERT INTO agent_conversations (id, account_id, title, created_at, updated_at)
     VALUES ('conv-1', 'acct-1', 'Test conversation', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  const pendingActions = new AgentPendingActionRepository({
    db,
    now: () => "2026-04-26T10:00:00.000Z",
  });
  const conversations = new AgentConversationRepository(
    db,
    () => "2026-04-26T10:00:00.000Z",
  );
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({ pendingActions, conversations, actionExecutor: executor, runtime }),
  );
  return { app, pendingActions, conversations };
}

function confirmedActionBody(repo: AgentPendingActionRepository, id: string): string {
  const row = repo.getById(id);
  assert.ok(row);
  return JSON.stringify({
    status: "confirmed",
    idempotencyKey: row.idempotency_key,
    parameters: JSON.parse(row.displayed_parameters_json ?? row.input_json),
  });
}

test("POST /pending-actions/:id/resolve confirmed without executor returns 501", async () => {
  const { app, pendingActions } = makePendingActionsAppWithExecutor();
  pendingActions.insert({
    id: "pa-noexec",
    conversationId: "conv-1",
    actionType: "delete",
    description: "Delete spam",
    inputJson: '{"actionType":"delete"}',
    riskReason: "delete is high-risk",
  });
  const res = await app.request("/api/agent/pending-actions/pa-noexec/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: confirmedActionBody(pendingActions, "pa-noexec"),
  });
  assert.equal(res.status, 501);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "action-execution-not-wired");
  // Row must remain pending — confirm must never be a silent no-op.
  const stillPending = pendingActions.getById("pa-noexec");
  assert.equal(stillPending?.status, "pending");
});

test("POST /pending-actions/:id/resolve legacy allowance upload confirms to not-wired without the edition module", async () => {
  // P2.6: the durable upload executor is an edition module. In the open
  // edition a legacy upload_allowance_invoices pending action (e.g. written
  // by an internal build) still resolves — it fails closed with the
  // not-wired family instead of executing, and the row stays untouched.
  const { app, pendingActions } = makePendingActionsAppWithExecutor();
  pendingActions.insert({
    id: "pa-upload-legacy",
    conversationId: "conv-1",
    actionType: "upload_allowance_invoices",
    description: "上传 2 个附件到发票平台",
    inputJson: '{"items":[{"emailId":"m","attachmentId":"a"}]}',
    riskReason: "upload is medium-risk",
  });

  const res = await app.request("/api/agent/pending-actions/pa-upload-legacy/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: confirmedActionBody(pendingActions, "pa-upload-legacy"),
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "durable-action-execution-unavailable");
  assert.equal(pendingActions.getById("pa-upload-legacy")?.status, "pending");
});

test("POST /pending-actions/:id/resolve confirmed runs executor before resolving", async () => {
  const seen: Array<{ action: AgentPendingActionRow; accountId?: string }> = [];
  const executor: AgentActionExecutor = {
    async execute(action, context?: { accountId?: string }) {
      seen.push({ action, accountId: context?.accountId });
      return {
        ok: true,
        summary: "已完成：Archive newsletter",
      };
    },
  };
  const { app, pendingActions, conversations } = makePendingActionsAppWithExecutor(executor);
  pendingActions.insert({
    id: "pa-ok",
    conversationId: "conv-1",
    actionType: "archive",
    description: "Archive newsletter",
    inputJson: '{"actionType":"archive"}',
    riskReason: "archive is medium-risk",
  });
  const res = await app.request("/api/agent/pending-actions/pa-ok/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: confirmedActionBody(pendingActions, "pa-ok"),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    execution: { ok: boolean; summary: string };
  };
  assert.equal(body.execution.ok, true);
  assert.equal(body.execution.summary, "已完成：Archive newsletter");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action.id, "pa-ok");
  assert.equal(seen[0].accountId, "acct-1");
  assert.equal(pendingActions.getById("pa-ok")?.status, "confirmed");
  const messages = conversations.listMessages("conv-1");
  assert.equal(messages.at(-2)?.role, "assistant");
  assert.match(String(messages.at(-2)?.body.text), /已确认，开始执行：Archive newsletter/);
  assert.equal(messages.at(-1)?.role, "assistant");
  assert.match(String(messages.at(-1)?.body.text), /已完成：Archive newsletter/);
  assert.doesNotMatch(String(messages.at(-1)?.body.text), /pa-ok|archive/);
});

test("POST /pending-actions/:id/resolve confirmed runs continuation when action requests it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-pa-cont-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1", email: "a@x.com" });
  db.prepare(
    `INSERT INTO agent_conversations (id, account_id, title, created_at, updated_at)
     VALUES ('conv-1', 'acct-1', 'Test conversation', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  const pendingActions = new AgentPendingActionRepository({
    db,
    now: () => "2026-04-26T10:00:00.000Z",
  });
  const conversations = new AgentConversationRepository(
    db,
    () => "2026-04-26T10:00:00.000Z",
  );
  pendingActions.insert({
    id: "pa-cont",
    conversationId: "conv-1",
    actionType: "run_wecli_command",
    description: "上传 1 个 PDF 发票附件到发票平台",
    inputJson: JSON.stringify({
      items: [{ emailId: "mail-1", attachmentId: "att-1" }],
      continuation: {
        scenario: "allowance_monthly_invoice",
        nextGoal: "upload_done_then_query_wallet_and_plan",
      },
    }),
    riskReason: "upload is medium-risk",
  });
  const executor: AgentActionExecutor = {
    async execute() {
      return {
        ok: true,
        summary: "上传完成：1 个附件已上传到发票平台。",
        successCount: 1,
        failureCount: 0,
        items: [{ filename: "发票.pdf", ok: true }],
      };
    },
  };
  let seen: PlannerStepInput | undefined;
  const runtime = new PiAgentRuntime({
    planner: {
      async step(input) {
        seen = input;
        return { kind: "final", text: "我会继续查询卡包和账期状态。" };
      },
    },
  });
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({ pendingActions, conversations, actionExecutor: executor, runtime }),
  );

  const res = await app.request("/api/agent/pending-actions/pa-cont/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: confirmedActionBody(pendingActions, "pa-cont"),
  });

  assert.equal(res.status, 200);
  assert.equal(seen?.userText, "继续完成已确认操作后的后续流程");
  assert.equal(seen?.context?.continuationScenario, "allowance_monthly_invoice");
  assert.deepEqual((seen?.context?.confirmedAction as { actionType?: string })?.actionType, "run_wecli_command");
  assert.equal((seen?.context?.executionSummary as { successCount?: number })?.successCount, 1);
  const messages = conversations.listMessages("conv-1");
  assert.match(String(messages.at(-1)?.body.text), /继续查询卡包和账期状态/);
});

test("POST /pending-actions/:id/resolve confirmed does not continue after total failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-pa-no-cont-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1", email: "a@x.com" });
  db.prepare(
    `INSERT INTO agent_conversations (id, account_id, title, created_at, updated_at)
     VALUES ('conv-1', 'acct-1', 'Test conversation', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  const pendingActions = new AgentPendingActionRepository({
    db,
    now: () => "2026-04-26T10:00:00.000Z",
  });
  const conversations = new AgentConversationRepository(
    db,
    () => "2026-04-26T10:00:00.000Z",
  );
  const executor: AgentActionExecutor = {
    async execute() {
      return {
        ok: false,
        summary: "上传未完成：成功 0 个，失败 1 个。",
        successCount: 0,
        failureCount: 1,
        items: [{ filename: "发票.pdf", ok: false, stderr: "bad args" }],
      };
    },
  };
  let called = false;
  const runtime = new PiAgentRuntime({
    planner: {
      async step() {
        called = true;
        return { kind: "final", text: "should not run" };
      },
    },
  });
  pendingActions.insert({
    id: "pa-total-fail",
    conversationId: "conv-1",
    actionType: "run_wecli_command",
    description: "上传 1 个 PDF 发票附件到发票平台",
    inputJson: JSON.stringify({
      items: [{ emailId: "mail-1", attachmentId: "att-1" }],
      continuation: {
        scenario: "allowance_monthly_invoice",
        nextGoal: "upload_done_then_query_wallet_and_plan",
      },
    }),
    riskReason: "upload is medium-risk",
  });
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({ pendingActions, conversations, actionExecutor: executor, runtime }),
  );

  const res = await app.request("/api/agent/pending-actions/pa-total-fail/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: confirmedActionBody(pendingActions, "pa-total-fail"),
  });

  assert.equal(res.status, 500);
  assert.equal(called, false);
});

test("POST /pending-actions/:id/resolve confirmed does not continue after partial failure", async () => {
  let called = false;
  const runtime = new PiAgentRuntime({
    planner: {
      async step() {
        called = true;
        return { kind: "final", text: "should not run" };
      },
    },
  });
  const { app, pendingActions } = makePendingActionsAppWithExecutor({
    async execute() {
      return {
        ok: false,
        summary: "上传未完成：成功 1 个，失败 1 个。",
        successCount: 1,
        failureCount: 1,
        items: [{ filename: "失败.pdf", ok: false }],
      };
    },
  }, runtime);
  pendingActions.insert({
    id: "pa-partial-fail",
    conversationId: "conv-1",
    actionType: "run_wecli_command",
    description: "上传 2 个附件到发票平台",
    inputJson: JSON.stringify({
      items: [{ emailId: "mail-1", attachmentId: "att-1" }],
      continuation: { scenario: "allowance_monthly_invoice", nextGoal: "query" },
    }),
    riskReason: "upload is medium-risk",
  });

  const res = await app.request("/api/agent/pending-actions/pa-partial-fail/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: confirmedActionBody(pendingActions, "pa-partial-fail"),
  });

  assert.equal(res.status, 500);
  assert.equal(called, false);
  assert.equal(pendingActions.getById("pa-partial-fail")?.status, "confirmed");
});

test("POST /pending-actions/:id/resolve confirmed persists a concise execution trace", async () => {
  const executor: AgentActionExecutor = {
    async execute() {
      return {
        ok: true,
        summary: "上传完成：1 个附件已上传到发票平台。",
        items: [
          {
            filename: "发票.pdf",
            ok: true,
            command: "wecli allowance upload --file <staged-file>",
            stdout: '{"uploaded":1}',
            stderr: "warning: duplicate ignored",
          } as any,
        ],
      };
    },
  };
  const { app, pendingActions, conversations } = makePendingActionsAppWithExecutor(executor);
  pendingActions.insert({
    id: "pa-trace",
    conversationId: "conv-1",
    actionType: "run_wecli_command",
    description: "上传 1 个附件到发票平台",
    inputJson: '{"items":[]}',
    riskReason: "upload is medium-risk",
  });

  const res = await app.request("/api/agent/pending-actions/pa-trace/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: confirmedActionBody(pendingActions, "pa-trace"),
  });

  assert.equal(res.status, 200);
  const messages = conversations.listMessages("conv-1");
  const finalText = String(messages.at(-1)?.body.text);
  assert.match(finalText, /上传完成/);
  assert.match(finalText, /发票\.pdf：已完成/);
  assert.doesNotMatch(finalText, /命令：|stdout：|stderr：|wecli|staged-file/);
});

test("POST /pending-actions/:id/resolve confirmed keeps the row pending when execution returns failure", async () => {
  const executor: AgentActionExecutor = {
    async execute() {
      return {
        ok: false,
        summary: "上传未完成：成功 1 个，失败 1 个。",
        items: [
          {
            filename: "发票.pdf",
            ok: true,
            command: "wecli allowance upload C:\\staged\\发票.pdf",
            stdout: "{\"uploaded\":1}",
          },
          {
            filename: "发票.zip",
            ok: false,
            exitCode: 1,
            error: "wecli-nonzero-exit",
            command: "wecli allowance upload C:\\staged\\发票.zip",
            stderr: "ERROR: unsupported file type: .zip",
          },
        ],
      };
    },
  };
  const { app, pendingActions, conversations } = makePendingActionsAppWithExecutor(executor);
  pendingActions.insert({
    id: "pa-upload-fail",
    conversationId: "conv-1",
    actionType: "run_wecli_command",
    description: "上传 1 个附件到发票平台",
    inputJson: '{"items":[]}',
    riskReason: "upload is medium-risk",
  });

  const res = await app.request("/api/agent/pending-actions/pa-upload-fail/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: confirmedActionBody(pendingActions, "pa-upload-fail"),
  });

  assert.equal(res.status, 500);
  const body = (await res.json()) as {
    ok: boolean;
    error: string;
    execution: { ok: boolean; summary: string };
  };
  assert.equal(body.ok, false);
  assert.equal(body.error, "action-execution-failed");
  assert.equal(body.execution.ok, false);
  assert.match(body.execution.summary, /上传未完成/);
  assert.equal(pendingActions.getById("pa-upload-fail")?.status, "confirmed");
  const messages = conversations.listMessages("conv-1");
  assert.equal(messages.at(-1)?.role, "assistant");
  const finalText = String(messages.at(-1)?.body.text);
  assert.match(finalText, /上传未完成：成功 1 个，失败 1 个/);
  assert.match(finalText, /文件类型或格式不被支持/);
  assert.match(finalText, /失败项/);
  assert.match(finalText, /发票\.pdf：已完成/);
  assert.match(finalText, /发票\.zip：失败/);
  assert.doesNotMatch(finalText, /命令：|stdout：|stderr：|wecli|C:\\staged/);
  assert.doesNotMatch(finalText, /登录或授权|网络\/VPN|权限/);
  assert.doesNotMatch(finalText, /pa-upload-fail|upload_allowance_invoices|emailId|tool|path/);
});

test("POST /pending-actions/:id/resolve rejected appends a conversation trace", async () => {
  const { app, pendingActions, conversations } = makePendingActionsAppWithExecutor();
  pendingActions.insert({
    id: "pa-reject-trace",
    conversationId: "conv-1",
    actionType: "upload_allowance_invoices",
    description: "上传 2 个附件到发票平台",
    inputJson: '{"items":[]}',
    riskReason: "upload is medium-risk",
  });

  const res = await app.request(
    "/api/agent/pending-actions/pa-reject-trace/resolve",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    },
  );

  assert.equal(res.status, 200);
  assert.equal(pendingActions.getById("pa-reject-trace")?.status, "rejected");
  const messages = conversations.listMessages("conv-1");
  assert.equal(messages.at(-1)?.role, "assistant");
  assert.match(String(messages.at(-1)?.body.text), /已取消/);
  assert.match(String(messages.at(-1)?.body.text), /上传 2 个附件到发票平台/);
  assert.doesNotMatch(String(messages.at(-1)?.body.text), /pa-reject-trace|upload_allowance_invoices/);
});

test("POST /api/agent/chat passes recent conversation context into the runtime", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-context-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  const conversations = new AgentConversationRepository(
    db,
    () => "2026-04-26T10:00:00.000Z",
  );
  conversations.ensureConversation({ id: "conv-context", accountId: "acct-1" });
  conversations.addMessage({
    conversationId: "conv-context",
    role: "user",
    body: { text: "帮我上传这封邮件的发票附件" },
  });
  conversations.addMessage({
    conversationId: "conv-context",
    role: "assistant",
    body: { text: "已找到 2 个附件，等待你确认。" },
  });
  let seen: PlannerStepInput | undefined;
  const runtime = new PiAgentRuntime({
    planner: {
      async step(input) {
        seen = input;
        return { kind: "final", text: "继续处理" };
      },
    },
  });
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({ runtime, conversations }));

  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "conv-context",
      accountId: "acct-1",
      userText: "继续",
    }),
  });

  assert.equal(res.status, 200);
  const recent = seen?.context?.recentConversation as Array<{ text?: string }> | undefined;
  assert.ok(Array.isArray(recent));
  assert.ok(recent.some((item) => item.text?.includes("帮我上传这封邮件")));
  assert.ok(recent.some((item) => item.text?.includes("已找到 2 个附件")));
});

test("POST /pending-actions/:id/resolve confirmed keeps the row pending and appends trace if executor throws", async () => {
  const executor: AgentActionExecutor = {
    async execute() {
      throw new Error("imap timeout");
    },
  };
  const { app, pendingActions, conversations } = makePendingActionsAppWithExecutor(executor);
  pendingActions.insert({
    id: "pa-fail",
    conversationId: "conv-1",
    actionType: "delete",
    description: "Delete spam",
    inputJson: '{"actionType":"delete"}',
    riskReason: "delete is high-risk",
  });
  const res = await app.request("/api/agent/pending-actions/pa-fail/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: confirmedActionBody(pendingActions, "pa-fail"),
  });
  assert.equal(res.status, 500);
  const body = (await res.json()) as {
    ok: boolean;
    error: string;
    detail: string;
    execution: { ok: boolean; summary: string };
  };
  assert.equal(body.error, "action-execution-failed");
  assert.match(body.detail, /imap timeout/);
  assert.equal(body.execution.ok, false);
  assert.match(body.execution.summary, /执行失败/);
  assert.equal(pendingActions.getById("pa-fail")?.status, "confirmed");
  const messages = conversations.listMessages("conv-1");
  assert.equal(messages.at(-1)?.role, "assistant");
  assert.match(String(messages.at(-1)?.body.text), /执行失败/);
});

test("POST /pending-actions/:id/resolve rejects cross-account confirm with 403", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-pa-cross-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-A", email: "a@x.com" });
  insertCanonicalTestAccount(db, { id: "acct-B", email: "b@x.com" });
  db.prepare(
    `INSERT INTO agent_conversations (id, account_id, title, created_at, updated_at)
     VALUES ('conv-B', 'acct-B', 'B', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  const pendingActions = new AgentPendingActionRepository({
    db,
    now: () => "2026-04-26T10:00:00.000Z",
  });
  pendingActions.insert({
    id: "pa-B",
    conversationId: "conv-B",
    actionType: "delete",
    description: "delete in B",
    inputJson: "{}",
    riskReason: "delete is high-risk",
  });

  const seen: AgentPendingActionRow[] = [];
  const executor: AgentActionExecutor = {
    async execute(action) {
      seen.push(action);
      return { ok: true, summary: "已完成：delete in B" };
    },
  };
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      pendingActions,
      actionExecutor: executor,
      getActiveAccountId: () => "acct-A",
    }),
  );

  const res = await app.request("/api/agent/pending-actions/pa-B/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "confirmed" }),
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "cross-account-action");
  assert.equal(seen.length, 0);
  // Row must still be pending — no resolve happened.
  assert.equal(pendingActions.getById("pa-B")?.status, "pending");
});

test("POST /pending-actions/:id/resolve rejects orphan action when active account is wired", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-pa-orphan-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  const pendingActions = new AgentPendingActionRepository({
    db,
    now: () => "2026-04-26T10:00:00.000Z",
  });
  pendingActions.insert({
    id: "pa-orphan",
    actionType: "delete",
    description: "delete orphan",
    inputJson: "{}",
    riskReason: "delete is high-risk",
  });

  const seen: AgentPendingActionRow[] = [];
  const executor: AgentActionExecutor = {
    async execute(action) {
      seen.push(action);
      return { ok: true, summary: "已完成：delete orphan" };
    },
  };
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      pendingActions,
      actionExecutor: executor,
      getActiveAccountId: () => "acct-A",
    }),
  );

  const res = await app.request("/api/agent/pending-actions/pa-orphan/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "confirmed" }),
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "cross-account-action");
  assert.equal(seen.length, 0);
  assert.equal(pendingActions.getById("pa-orphan")?.status, "pending");
});

test("POST /pending-actions/:id/resolve still works for the active account", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-pa-active-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-A", email: "a@x.com" });
  db.prepare(
    `INSERT INTO agent_conversations (id, account_id, title, created_at, updated_at)
     VALUES ('conv-A', 'acct-A', 'A', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  const pendingActions = new AgentPendingActionRepository({
    db,
    now: () => "2026-04-26T10:00:00.000Z",
  });
  pendingActions.insert({
    id: "pa-A",
    conversationId: "conv-A",
    actionType: "archive",
    description: "archive in A",
    inputJson: "{}",
    riskReason: "archive is medium-risk",
  });
  const executor: AgentActionExecutor = {
    async execute() {
      return { ok: true, summary: "已完成：archive in A" };
    },
  };
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      pendingActions,
      actionExecutor: executor,
      getActiveAccountId: () => "acct-A",
    }),
  );
  const res = await app.request("/api/agent/pending-actions/pa-A/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: confirmedActionBody(pendingActions, "pa-A"),
  });
  assert.equal(res.status, 200);
  assert.equal(pendingActions.getById("pa-A")?.status, "confirmed");
});

test("GET /pending-actions delegates reads to DB Service with account scope", async () => {
  let requested: unknown;
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({
    getActiveAccountId: () => "acct-A",
    mailDatabase: {
      getMailSnapshot: async () => { throw new Error("unexpected snapshot"); },
      getIntelligenceState: async () => { throw new Error("unexpected intelligence"); },
      listPendingActions: async (params) => { requested = params; return []; },
    },
  }));
  const res = await app.request("/api/agent/pending-actions?conversationId=conv-A");
  assert.equal(res.status, 200);
  assert.deepEqual(requested, { accountId: "acct-A", conversationId: "conv-A" });
  assert.deepEqual(await res.json(), { ok: true, actions: [] });
  requested = undefined;
  const invalid = await app.request(`/api/agent/pending-actions?conversationId=${"x".repeat(501)}`);
  assert.equal(invalid.status, 400);
  assert.equal(requested, undefined);
});

test("GET /pending-actions returns a retryable failure without synchronous fallback", async () => {
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({
    getActiveAccountId: () => "acct-A",
    mailDatabase: {
      getMailSnapshot: async () => { throw new Error("unexpected snapshot"); },
      getIntelligenceState: async () => { throw new Error("unexpected intelligence"); },
      listPendingActions: async () => { throw new Error("worker unavailable"); },
    },
  }));
  const res = await app.request("/api/agent/pending-actions");
  assert.equal(res.status, 503);
  assert.equal((await res.json() as { ok: boolean }).ok, false);
});

test("GET /pending-actions scopes to active account when no conversationId given", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-pa-listactive-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-A", email: "a@x.com" });
  insertCanonicalTestAccount(db, { id: "acct-B", email: "b@x.com" });
  db.prepare(
    `INSERT INTO agent_conversations (id, account_id, title, created_at, updated_at)
     VALUES ('conv-A', 'acct-A', 'A', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_conversations (id, account_id, title, created_at, updated_at)
     VALUES ('conv-B', 'acct-B', 'B', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  const pendingActions = new AgentPendingActionRepository({
    db,
    now: () => "2026-04-26T10:00:00.000Z",
  });
  pendingActions.insert({
    id: "pa-A",
    conversationId: "conv-A",
    actionType: "delete",
    description: "in A",
    inputJson: "{}",
    riskReason: "delete is high-risk",
  });
  pendingActions.insert({
    id: "pa-B",
    conversationId: "conv-B",
    actionType: "delete",
    description: "in B",
    inputJson: "{}",
    riskReason: "delete is high-risk",
  });
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      pendingActions,
      getActiveAccountId: () => "acct-A",
    }),
  );
  const res = await app.request("/api/agent/pending-actions");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { actions: Array<{ id: string }> };
  assert.deepEqual(body.actions.map((a) => a.id), ["pa-A"]);
});

test("GET /pending-actions with conversationId does not leak another active account", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-pa-listconv-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-A", email: "a@x.com" });
  insertCanonicalTestAccount(db, { id: "acct-B", email: "b@x.com" });
  db.prepare(
    `INSERT INTO agent_conversations (id, account_id, title, created_at, updated_at)
     VALUES ('conv-A', 'acct-A', 'A', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_conversations (id, account_id, title, created_at, updated_at)
     VALUES ('conv-B', 'acct-B', 'B', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  const pendingActions = new AgentPendingActionRepository({
    db,
    now: () => "2026-04-26T10:00:00.000Z",
  });
  pendingActions.insert({
    id: "pa-B",
    conversationId: "conv-B",
    actionType: "delete",
    description: "in B",
    inputJson: "{}",
    riskReason: "delete is high-risk",
  });
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      pendingActions,
      getActiveAccountId: () => "acct-A",
    }),
  );

  const res = await app.request("/api/agent/pending-actions?conversationId=conv-B");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { actions: Array<{ id: string }> };
  assert.deepEqual(body.actions, []);
});

test("POST /pending-actions/:id/resolve rejected works without executor", async () => {
  const { app, pendingActions } = makePendingActionsAppWithExecutor();
  pendingActions.insert({
    id: "pa-rejected",
    conversationId: "conv-1",
    actionType: "send",
    description: "Send report",
    inputJson: '{"actionType":"send"}',
    riskReason: "send is high-risk",
  });
  const res = await app.request(
    "/api/agent/pending-actions/pa-rejected/resolve",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    },
  );
  assert.equal(res.status, 200);
  assert.equal(pendingActions.getById("pa-rejected")?.status, "rejected");
});

// ── Mail Curator manual trigger (Route C / WP J.8) ───────────────────

import type { CuratorScheduler } from "../../wemail/agent/CuratorScheduler.js";
import type { CuratorScheduleResult } from "../../wemail/agent/CuratorScheduler.js";

function fakeScheduler(handler: (accountId: string) => Promise<CuratorScheduleResult | null>): CuratorScheduler {
  return {
    async triggerManual(accountId: string) {
      return handler(accountId);
    },
  } as unknown as CuratorScheduler;
}

test("POST /curator/run returns 503 when curator is unwired", async () => {
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({}));
  const res = await app.request("/api/agent/curator/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct-1" }),
  });
  assert.equal(res.status, 503);
});

test("POST /curator/run returns 400 when no accountId resolvable", async () => {
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      curator: fakeScheduler(async () => null),
      getActiveAccountId: () => undefined,
    }),
  );
  const res = await app.request("/api/agent/curator/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 400);
});

test("POST /curator/run uses explicit accountId from body", async () => {
  const seen: string[] = [];
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      curator: fakeScheduler(async (accountId) => {
        seen.push(accountId);
        return {
          accountId,
          reason: "manual",
          summary: {
            accountId,
            reason: "manual",
            startedAt: "2026-04-29T10:00:00Z",
            durationMs: 12,
            iterations: 1,
            tokensUsed: 0,
            bytesWritten: 0,
            filesWritten: ["style/voice.md"],
            errors: [],
          },
        };
      }),
    }),
  );
  const res = await app.request("/api/agent/curator/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct-from-body" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; accountId: string; reason: string };
  assert.equal(body.ok, true);
  assert.equal(body.accountId, "acct-from-body");
  assert.equal(body.reason, "manual");
  assert.deepEqual(seen, ["acct-from-body"]);
});

test("POST /curator/run rejects explicit accountId outside the active account", async () => {
  const seen: string[] = [];
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      curator: fakeScheduler(async (accountId) => {
        seen.push(accountId);
        return null;
      }),
      getActiveAccountId: () => "acct-active",
    }),
  );
  const res = await app.request("/api/agent/curator/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct-other" }),
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "cross-account-curator-run");
  assert.deepEqual(seen, []);
});

test("POST /curator/run falls back to active account when body omits accountId", async () => {
  const seen: string[] = [];
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      curator: fakeScheduler(async (accountId) => {
        seen.push(accountId);
        return {
          accountId,
          reason: "manual",
          summary: {
            accountId,
            reason: "manual",
            startedAt: "2026-04-29T10:00:00Z",
            durationMs: 5,
            iterations: 0,
            tokensUsed: 0,
            bytesWritten: 0,
            filesWritten: [],
            errors: [],
          },
        };
      }),
      getActiveAccountId: () => "acct-active",
    }),
  );
  const res = await app.request("/api/agent/curator/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["acct-active"]);
});

test("POST /curator/run returns null summary when scheduler skips run", async () => {
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      curator: fakeScheduler(async () => null),
      getActiveAccountId: () => "acct-active",
    }),
  );
  const res = await app.request("/api/agent/curator/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; summary: unknown };
  assert.equal(body.ok, true);
  assert.equal(body.summary, null);
});

test("POST /curator/run returns 500 with detail when scheduler throws", async () => {
  const app = new Hono();
  app.route(
    "/api/agent",
    buildAgentRoutes({
      curator: fakeScheduler(async () => {
        throw new Error("llm provider down");
      }),
      getActiveAccountId: () => "acct-active",
    }),
  );
  const res = await app.request("/api/agent/curator/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 500);
  const body = (await res.json()) as { ok: boolean; error: string; detail: string };
  assert.equal(body.error, "curator-run-failed");
  assert.match(body.detail, /llm provider down/);
});

test("confirmed action rejects changed parameters and executes one time per idempotency key", async () => {
  let executions = 0;
  const { app, pendingActions } = makePendingActionsAppWithExecutor({
    async execute() {
      executions += 1;
      return { ok: true, summary: "archived" };
    },
  });
  pendingActions.insert({
    id: "pa-idempotent",
    conversationId: "conv-1",
    actionType: "archive",
    description: "Archive mail-1",
    inputJson: JSON.stringify({ emailId: "mail-1" }),
    parameters: { emailId: "mail-1" },
    idempotencyKey: "idem-route-1",
    expiresAt: "2026-04-26T10:15:00.000Z",
    riskReason: "Mailbox mutation",
  });
  const changed = await app.request("/api/agent/pending-actions/pa-idempotent/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      status: "confirmed",
      idempotencyKey: "idem-route-1",
      parameters: { emailId: "mail-2" },
    }),
  });
  assert.equal(changed.status, 400);
  assert.equal(executions, 0);

  const exactBody = confirmedActionBody(pendingActions, "pa-idempotent");
  const first = await app.request("/api/agent/pending-actions/pa-idempotent/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: exactBody,
  });
  const retry = await app.request("/api/agent/pending-actions/pa-idempotent/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: exactBody,
  });
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(executions, 1);
  assert.equal((await retry.json() as { duplicate?: boolean }).duplicate, true);
});

test("persisted followups execute in order after explicit resume", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-followups-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  const conversations = new AgentConversationRepository(db);
  conversations.ensureConversation({ id: "conv-followup", accountId: "account-1" });
  const prompts: string[] = [];
  const runtime: AgentRuntime = {
    registerTool() {},
    listTools() { return []; },
    async *run(input) {
      prompts.push(input.userText);
      yield { type: "assistant_text", text: `完成：${input.userText}` };
      yield { type: "conclusion", status: "succeeded", summary: "完成" };
      yield { type: "done" };
    },
  };
  const runs = new AgentRunRepository(db);
  const eventPersistence = new AgentEventPersistence(runs);
  const runCoordinator = new AgentRunCoordinator(runs);
  const blocker = await runCoordinator.acquire({
    conversationId: "conv-followup",
    runId: "blocking-run",
  });
  const app = new Hono();
  app.route("/api/agent", buildAgentRoutes({
    runtime,
    conversations,
    runs,
    eventPersistence,
    runCoordinator,
  }));

  for (const text of ["第一条", "第二条"]) {
    const response = await app.request("/api/agent/conversations/conv-followup/followups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, accountId: "account-1" }),
    });
    assert.equal(response.status, 202);
  }
  const queued = runs.listFollowups("conv-followup");
  const edit = await app.request(
    `/api/agent/conversations/conv-followup/followups/${queued[0].id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "第一条（已编辑）" }),
    },
  );
  assert.equal(edit.status, 200);
  const reorder = await app.request(
    `/api/agent/conversations/conv-followup/followups/${queued[1].id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ position: 0 }),
    },
  );
  assert.equal(reorder.status, 200);
  assert.deepEqual(runs.listFollowups("conv-followup").map((item) => item.text), [
    "第二条",
    "第一条（已编辑）",
  ]);
  assert.deepEqual(prompts, []);

  blocker.release();
  const resume = await app.request(
    "/api/agent/conversations/conv-followup/followups/resume",
    { method: "POST" },
  );
  assert.equal(resume.status, 200);
  for (let index = 0; index < 100; index += 1) {
    if (runs.listFollowups("conv-followup").every((item) => item.state === "completed")) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(prompts, ["第二条", "第一条（已编辑）"]);
  assert.deepEqual(
    runs.listFollowups("conv-followup").map((item) => item.state),
    ["completed", "completed"],
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
