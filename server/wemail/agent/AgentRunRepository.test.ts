import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConversationState, reduceConversationState } from "../../../shared/wemail/conversationState.js";
import type { WemailAgentEvent } from "../../../shared/wemail/agentProtocol.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { createMailDatabase } from "../database/Database.js";
import { AgentConversationRepository } from "./AgentConversationRepository.js";
import { AgentEventPersistence } from "./AgentEventPersistence.js";
import { AgentRunRepository, toolExecutionById } from "./AgentRunRepository.js";

type EventPayload = WemailAgentEvent extends infer Event
  ? Event extends WemailAgentEvent
    ? Omit<Event, "schemaVersion" | "conversationId" | "runId" | "messageId" | "sequence" | "timestamp">
    : never
  : never;

function event(
  sequence: number,
  payload: EventPayload,
): WemailAgentEvent {
  return {
    schemaVersion: 1,
    conversationId: "conv-1",
    runId: "run-1",
    messageId: "message-1",
    sequence,
    timestamp: `2026-08-02T00:00:0${sequence}.000Z`,
    ...payload,
  } as WemailAgentEvent;
}

function fixture() {
  const db = openOrCreateMailDatabase(":memory:");
  const conversations = new AgentConversationRepository(db, () => "2026-08-02T00:00:00.000Z");
  conversations.ensureConversation({ id: "conv-1", accountId: "account-1" });
  const repository = new AgentRunRepository(db, () => "2026-08-02T00:00:00.000Z");
  return { db, conversations, repository };
}

test("structured Agent tables are installed for canonical database creation", () => {
  const { db } = fixture();
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  for (const name of [
    "agent_runs",
    "agent_tool_executions",
    "agent_followup_queue",
    "agent_citations",
    "agent_attachments",
    "agent_attachment_refs",
    "agent_user_behavior_events",
    "agent_user_preferences",
  ]) {
    assert.equal(tables.has(name), true, name);
  }
  const messageColumns = new Set(
    (db.prepare("PRAGMA table_info(agent_messages)").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  assert.equal(messageColumns.has("parts_json"), true);
  assert.equal(messageColumns.has("markdown_source"), true);
  db.close();
});

test("structured Agent tables are installed in a new canonical desktop database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-canonical-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  const runTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'",
  ).get() as { name: string } | undefined;
  const messageColumns = new Set(
    (db.prepare("PRAGMA table_info(agent_messages)").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  assert.equal(runTable?.name, "agent_runs");
  assert.equal(messageColumns.has("parts_json"), true);
  const tableNames = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  for (const obsolete of ["agent_events", "agent_raw_events", "raw_pi_events"]) {
    assert.equal(tableNames.has(obsolete), false, obsolete);
  }
  for (const obsolete of ["events_json", "rendered_html", "raw_event_json"]) {
    assert.equal(messageColumns.has(obsolete), false, obsolete);
  }
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("attention view is account isolated and keeps active, recent failure, and paused queue state", () => {
  const { db, conversations, repository } = fixture();
  conversations.ensureConversation({ id: "conv-other", accountId: "account-2" });
  repository.createRun({ id: "run-active", conversationId: "conv-1", messageId: "msg-active", state: "running" });
  repository.createRun({ id: "run-failed", conversationId: "conv-1", messageId: "msg-failed", state: "queued" });
  repository.createRun({ id: "run-other", conversationId: "conv-other", messageId: "msg-other", state: "running" });
  db.prepare(
    "UPDATE agent_runs SET state = 'failed', settled_at = ?, updated_at = ? WHERE id = 'run-failed'",
  ).run("2026-08-02T00:01:00.000Z", "2026-08-02T00:01:00.000Z");
  repository.enqueueFollowup({ conversationId: "conv-1", text: "later" });
  db.prepare("UPDATE agent_followup_queue SET state = 'paused' WHERE conversation_id = 'conv-1'").run();

  const attention = repository.listAttention("account-1", "2026-08-01T23:00:00.000Z");
  assert.deepEqual(attention.active.map((run) => run.id), ["run-active"]);
  assert.deepEqual(attention.failed.map((run) => run.id), ["run-failed"]);
  assert.deepEqual(attention.pausedConversationIds, ["conv-1"]);
  db.close();
});

test("event persistence stores structured snapshots without raw delta history", () => {
  const { db, repository } = fixture();
  let nowMs = 0;
  const persistence = new AgentEventPersistence(repository, () => nowMs);
  const events: WemailAgentEvent[] = [
    event(0, { type: "run_started" }),
    event(1, { type: "message_started", role: "assistant" }),
    event(2, { type: "text_started", partId: "text-1" }),
    event(3, { type: "text_delta", partId: "text-1", delta: "你" }),
    event(4, { type: "text_delta", partId: "text-1", delta: "好" }),
    event(5, { type: "text_completed", partId: "text-1", text: "你好" }),
    event(6, { type: "message_completed" }),
    event(7, { type: "run_settled" }),
  ];
  for (const item of events) {
    persistence.record(item);
    nowMs += item.type === "text_delta" ? 100 : 1;
  }
  persistence.flushMessage("conv-1", "message-1");

  const row = db.prepare(
    "SELECT body_json, parts_json, markdown_source FROM agent_messages WHERE id = ?",
  ).get("message-1") as { body_json: string; parts_json: string; markdown_source: string };
  assert.equal(row.markdown_source, "你好");
  assert.equal(row.body_json.includes("text_delta"), false);
  assert.equal(row.body_json.includes('"parts"'), false);
  assert.equal(row.parts_json.includes("你好"), true);
  assert.equal(repository.getRun("run-1")?.state, "settled");
  const restored = repository.loadConversationState("conv-1");
  assert.equal(restored.runs["run-1"]?.state, "settled");
  assert.deepEqual(restored.messages["message-1"]?.parts, [
    {
      id: "text-1",
      type: "text",
      markdown: "你好",
      state: "completed",
      citationIds: [],
    },
  ]);
  db.close();
});

test("live canonical projection matches restored reasoning, Markdown, tools, citations, and errors", () => {
  const { db, repository } = fixture();
  const persistence = new AgentEventPersistence(repository, () => 1_000, 0);
  const events: WemailAgentEvent[] = [
    event(0, { type: "run_started" }),
    event(1, { type: "message_started", role: "assistant" }),
    event(2, { type: "reasoning_started", partId: "reasoning-1" }),
    event(3, { type: "reasoning_delta", partId: "reasoning-1", delta: "检查邮件" }),
    event(4, { type: "reasoning_completed", partId: "reasoning-1", text: "检查邮件" }),
    event(5, { type: "tool_call_started", toolCallId: "tool-1", toolName: "mail_search" }),
    event(6, { type: "tool_args_completed", toolCallId: "tool-1", input: { query: "合同" } }),
    event(7, { type: "tool_execution_started", toolCallId: "tool-1" }),
    event(8, { type: "tool_execution_completed", toolCallId: "tool-1", summary: "找到 1 封" }),
    event(9, { type: "text_started", partId: "text-1" }),
    event(10, { type: "text_completed", partId: "text-1", text: "**结果**" }),
    event(11, {
      type: "citation_added",
      partId: "text-1",
      citation: { id: "citation-1", source: { kind: "mail", emailId: "mail-1" } },
    }),
    event(12, { type: "message_completed" }),
    event(13, {
      type: "run_failed",
      code: "provider_unavailable",
      message: "服务暂时不可用",
      retryable: true,
    }),
  ];
  events.forEach((item) => persistence.record(item));
  persistence.flushMessage("conv-1", "message-1");

  const live = persistence.getState("conv-1");
  const restored = repository.loadConversationState("conv-1");
  assert.deepEqual(restored.messages["message-1"]?.parts, live.messages["message-1"]?.parts);
  assert.equal(restored.runs["run-1"]?.state, live.runs["run-1"]?.state);
  assert.deepEqual(restored.tools["tool-1"], live.tools["tool-1"]);
  assert.deepEqual(restored.citations["citation-1"], live.citations["citation-1"]);
  db.close();
});

test("duplicate and out-of-order run events are ignored", () => {
  const { db, repository } = fixture();
  repository.createRun({
    id: "run-1",
    conversationId: "conv-1",
    messageId: "message-1",
    state: "running",
  });
  assert.equal(repository.recordEvent(event(3, { type: "run_state_changed", state: "running" })), true);
  assert.equal(repository.recordEvent(event(3, { type: "run_failed", code: "duplicate", message: "bad", retryable: false })), false);
  assert.equal(repository.recordEvent(event(2, { type: "run_failed", code: "old", message: "bad", retryable: false })), false);
  assert.equal(repository.getRun("run-1")?.state, "running");
  assert.equal(repository.getRun("run-1")?.lastSequence, 3);
  db.close();
});

test("tool lifecycle is projected by toolCallId", () => {
  const { db, repository } = fixture();
  const persistence = new AgentEventPersistence(repository);
  for (const item of [
    event(0, { type: "run_started" }),
    event(1, { type: "tool_call_started", toolCallId: "tool-1", toolName: "mail_search" }),
    event(2, { type: "tool_args_completed", toolCallId: "tool-1", input: { query: "invoice" } }),
    event(3, { type: "tool_execution_started", toolCallId: "tool-1" }),
    event(4, { type: "tool_execution_completed", toolCallId: "tool-1", summary: "找到 2 封" }),
  ] as WemailAgentEvent[]) persistence.record(item);
  assert.deepEqual(toolExecutionById(db, "tool-1"), {
    toolCallId: "tool-1",
    runId: "run-1",
    toolName: "mail_search",
    input: { query: "invoice" },
    state: "completed",
    summary: "找到 2 封",
    startedAt: "2026-08-02T00:00:03.000Z",
    endedAt: "2026-08-02T00:00:04.000Z",
  });
  db.close();
});

test("terminal runs settle unfinished persisted tools", () => {
  const { db, repository } = fixture();
  const persistence = new AgentEventPersistence(repository);
  for (const item of [
    event(0, { type: "run_started" }),
    event(1, { type: "tool_call_started", toolCallId: "tool-1", toolName: "wecli_run" }),
    event(2, { type: "tool_args_completed", toolCallId: "tool-1", input: {} }),
    event(3, { type: "tool_execution_started", toolCallId: "tool-1" }),
    event(4, { type: "run_failed", code: "agent_no_progress", message: "任务没有完成", retryable: false }),
  ] as WemailAgentEvent[]) persistence.record(item);

  assert.deepEqual(toolExecutionById(db, "tool-1"), {
    toolCallId: "tool-1",
    runId: "run-1",
    toolName: "wecli_run",
    input: {},
    state: "failed",
    summary: "任务没有完成",
    errorCode: "agent_no_progress",
    startedAt: "2026-08-02T00:00:03.000Z",
    endedAt: "2026-08-02T00:00:04.000Z",
  });
  db.close();
});

test("startup reconciliation interrupts unfinished runs and pauses followups", () => {
  const { db, repository } = fixture();
  repository.createRun({
    id: "run-1",
    conversationId: "conv-1",
    messageId: "message-1",
    state: "running",
  });
  const queued = repository.enqueueFollowup({ conversationId: "conv-1", text: "再总结附件" });
  const result = repository.reconcileStartup();
  assert.deepEqual(result.interruptedRunIds, ["run-1"]);
  assert.deepEqual(result.pausedFollowupIds, [queued.id]);
  assert.equal(repository.getRun("run-1")?.state, "interrupted");
  assert.equal(repository.getFollowup(queued.id)?.state, "paused");
  db.close();
});

test("followups retain insertion order and require explicit resume after pause", () => {
  const { db, repository } = fixture();
  const first = repository.enqueueFollowup({ conversationId: "conv-1", text: "first" });
  const second = repository.enqueueFollowup({ conversationId: "conv-1", text: "second" });
  assert.deepEqual(repository.listFollowups("conv-1").map((item) => item.id), [first.id, second.id]);
  repository.pauseFollowups("conv-1", "user_stopped");
  assert.equal(repository.nextQueuedFollowup("conv-1"), null);
  assert.equal(repository.resumeFollowups("conv-1"), 2);
  assert.equal(repository.nextQueuedFollowup("conv-1")?.id, first.id);
  db.close();
});

test("queued followups can be edited and reordered durably", () => {
  const { db, repository } = fixture();
  const first = repository.enqueueFollowup({ conversationId: "conv-1", text: "first" });
  const second = repository.enqueueFollowup({ conversationId: "conv-1", text: "second" });
  assert.equal(repository.updateFollowupText(first.id, " updated ")?.text, "updated");
  assert.deepEqual(
    repository.moveFollowup(second.id, 0)?.map((item) => item.id),
    [second.id, first.id],
  );
  assert.deepEqual(
    repository.listFollowups("conv-1").map((item) => ({ text: item.text, position: item.position })),
    [
      { text: "second", position: 0 },
      { text: "updated", position: 1 },
    ],
  );
  repository.setFollowupState(first.id, "running");
  assert.equal(repository.updateFollowupText(first.id, "too late"), null);
  assert.equal(repository.moveFollowup(first.id, 0), null);
  db.close();
});

test("shared reducer independently rejects the same duplicate sequence", () => {
  const first = event(0, { type: "run_started" });
  const failed = event(0, { type: "run_failed", code: "duplicate", message: "bad", retryable: false });
  const state = reduceConversationState(createConversationState("conv-1"), first);
  const duplicate = reduceConversationState(state, failed);
  assert.equal(duplicate.runs["run-1"]?.state, "running");
});
