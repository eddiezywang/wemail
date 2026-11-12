import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../../shared/wemail/agent.js";
import type { WemailAgentEvent } from "../../../shared/wemail/agentProtocol.js";
import {
  createPiV0806ToWemailEventAdapter,
  type PiEventAdapterContext,
} from "./PiEventAdapter.js";

function context(): PiEventAdapterContext {
  let sequence = 0;
  let tick = 0;
  return {
    conversationId: "conversation-1",
    runId: "run-1",
    messageId: "message-1",
    nextSequence: () => sequence++,
    now: () => `2026-08-02T04:00:${String(tick++).padStart(2, "0")}.000Z`,
  };
}

function mapAll(events: readonly unknown[]): WemailAgentEvent[] {
  const adapter = createPiV0806ToWemailEventAdapter();
  const delivery = context();
  return events.flatMap((event) => adapter.map(event, delivery));
}

test("Pi 0.80.6 delivery maps public progress without provider reasoning or raw tool payloads", () => {
  const input: AgentEvent[] = [
    { type: "reasoning_start", contentIndex: 0 },
    { type: "reasoning_delta", contentIndex: 0, text: "Inspecting" },
    { type: "reasoning_end", contentIndex: 0, text: "Inspecting mailbox" },
    { type: "text_start", contentIndex: 1 },
    { type: "text_delta", contentIndex: 1, text: "Working" },
    { type: "tool_call", tool: "list_mail", toolCallId: "call-1", input: { unreadOnly: true } },
    { type: "tool_update", tool: "list_mail", toolCallId: "call-1", output: { count: 1 } },
    { type: "retry_scheduled", attempt: 1, delayMs: 0, reason: "transient" },
    { type: "retry_started", attempt: 1, maxAttempts: 1 },
    { type: "tool_result", tool: "list_mail", toolCallId: "call-1", output: { count: 2 } },
    { type: "retry_completed", attempt: 1 },
    { type: "text_end", contentIndex: 1, text: "Working" },
    { type: "done" },
  ];

  const output = mapAll(input);
  const types = output.map((event) => event.type);
  assert.deepEqual(types.slice(0, 3), [
    "run_started",
    "run_state_changed",
    "message_started",
  ]);
  assert.equal(types.some((type) => type.startsWith("reasoning_")), false);
  assert.ok(types.includes("text_delta"));
  assert.ok(types.includes("tool_execution_started"));
  assert.ok(types.includes("tool_execution_updated"));
  assert.ok(types.includes("tool_execution_completed"));
  assert.ok(types.includes("retry_scheduled"));
  assert.ok(types.includes("retry_started"));
  assert.ok(types.includes("retry_completed"));
  assert.deepEqual(types.slice(-2), ["message_completed", "run_settled"]);
  assert.ok(output.every((event) => event.schemaVersion === 1));
  assert.ok(output.every((event) => event.conversationId === "conversation-1"));
  assert.ok(output.every((event) => event.runId === "run-1"));
  assert.ok(output.every((event, index) => index === 0 || event.sequence > output[index - 1].sequence));
  assert.equal(JSON.stringify(output).includes("Inspecting mailbox"), false);
  const toolUpdate = output.find(
    (event): event is Extract<WemailAgentEvent, { type: "tool_execution_updated" }> =>
      event.type === "tool_execution_updated",
  );
  assert.equal("output" in (toolUpdate ?? {}), false);
});

test("tool failures preserve stable host-owned error codes", () => {
  const output = mapAll([{
    type: "tool_result",
    tool: "publish_design_artifact",
    toolCallId: "call-publish",
    output: { ok: false, code: "dataset-required", error: "dataset-required" },
    isError: true,
  }] satisfies AgentEvent[]);

  const failure = output.find(
    (event): event is Extract<WemailAgentEvent, { type: "tool_execution_failed" }> =>
      event.type === "tool_execution_failed",
  );
  assert.equal(failure?.code, "dataset-required");
  assert.equal(failure?.message, "发布前需要先在本次运行中提取结构化数据。");
});

test("tool argument validation failures do not expose received arguments", () => {
  const output = mapAll([{
    type: "tool_result",
    tool: "publish_design_artifact",
    toolCallId: "call-publish",
    output: {
      ok: false,
      code: "tool_execution_failed",
      error: "Validation failed for tool \"publish_design_artifact\". Received arguments: { accountId: \"acct-private\" }",
    },
    isError: true,
  }] satisfies AgentEvent[]);

  const failure = output.find(
    (event): event is Extract<WemailAgentEvent, { type: "tool_execution_failed" }> =>
      event.type === "tool_execution_failed",
  );
  assert.equal(failure?.code, "tool_arguments_invalid");
  assert.equal(failure?.message, "工具参数格式不符合要求，本次调用失败。");
  assert.equal(JSON.stringify(failure).includes("acct-private"), false);
});

test("tool input projection records artifact handoff presence without payload values", () => {
  const output = mapAll([{
    type: "tool_call",
    tool: "publish_design_artifact",
    toolCallId: "call-publish",
    input: {
      title: "Sensitive report title",
      datasetId: "ds-private",
      autoPivot: true,
    },
  }] satisfies AgentEvent[]);
  const args = output.find(
    (event): event is Extract<WemailAgentEvent, { type: "tool_args_completed" }> =>
      event.type === "tool_args_completed",
  )?.input;
  assert.deepEqual(args, {
    titlePresent: true,
    datasetIdPresent: true,
    autoPivot: true,
  });
});

test("published design artifacts become clickable conversation artifacts", () => {
  const output = mapAll([{
    type: "tool_result",
    tool: "publish_design_artifact",
    toolCallId: "call-publish",
    output: {
      ok: true,
      artifact: {
        artifactId: "artifact-1",
        version: 1,
        kind: "report",
        contentHash: "content-hash",
        title: "监控报告",
        preview: "基于 56 条记录生成",
        applicationMessageId: "message-1",
      },
    },
  }] satisfies AgentEvent[]);

  const ready = output.find(
    (event): event is Extract<WemailAgentEvent, { type: "artifact_ready" }> =>
      event.type === "artifact_ready",
  );
  assert.deepEqual(ready?.artifact, {
    artifactId: "artifact-1",
    version: 1,
    kind: "report",
    contentHash: "content-hash",
    title: "监控报告",
    preview: "基于 56 条记录生成",
    applicationMessageId: "message-1",
  });
});

test("cancelled PI conclusion becomes a stopped terminal run", () => {
  const output = mapAll([
    { type: "conclusion", status: "cancelled", summary: "已取消", reason: "user cancelled" },
    { type: "done" },
  ] satisfies AgentEvent[]);

  assert.ok(output.some((event) => event.type === "run_stopped"));
  assert.equal(output.some((event) => event.type === "run_settled"), false);
  assert.equal(output.at(-1)?.type, "message_completed");
});

test("unknown PI events are diagnosed without forwarding payload details", () => {
  const output = mapAll([
    {
      type: "future_provider_event",
      prompt: "private prompt must not escape",
      authorization: "secret-token",
    },
  ]);

  const failure = output.find(
    (event): event is Extract<WemailAgentEvent, { type: "run_failed" }> =>
      event.type === "run_failed",
  );
  assert.equal(failure?.code, "unsupported_pi_event");
  assert.equal(failure?.retryable, false);
  assert.equal(JSON.stringify(output).includes("private prompt"), false);
  assert.equal(JSON.stringify(output).includes("secret-token"), false);
});

test("pending actions become exact versioned confirmation records", () => {
  const output = mapAll([
    {
      type: "pending_action",
      action: {
        id: "action-1",
        actionType: "send",
        description: "发送邮件",
        toolName: "propose_send_mail",
        inputJson: JSON.stringify({ to: ["a@example.test"], subject: "Hello" }),
        riskReason: "External side effect",
        riskLevel: "high",
      },
    },
  ] satisfies AgentEvent[]);

  const confirmation = output.find(
    (event): event is Extract<WemailAgentEvent, { type: "confirmation_requested" }> =>
      event.type === "confirmation_requested",
  )?.confirmation;
  assert.equal(confirmation?.id, "action-1");
  assert.equal(confirmation?.idempotencyKey, "agent-action:action-1");
  assert.deepEqual(confirmation?.parameters.to, ["a@example.test"]);
});

test("citations are derived from tool result identifiers, not model citation claims", () => {
  const output = mapAll([
    {
      type: "tool_result",
      tool: "search_mail",
      toolCallId: "call-1",
      output: {
        messages: [{ id: "mail-1", subject: "Budget", snippet: "Approved" }],
        attachments: [{ attachmentId: "attachment-1", filename: "budget.pdf" }],
      },
    },
    {
      type: "assistant_text",
      text: "预算已批准 [伪造来源](https://example.invalid)",
      citations: [{ emailId: "model-made-up", tool: "model", path: "markdown" }],
    },
  ] satisfies AgentEvent[]);
  const citations = output.filter(
    (event): event is Extract<WemailAgentEvent, { type: "citation_added" }> =>
      event.type === "citation_added",
  );
  assert.deepEqual(
    citations.map((event) => event.citation.source.kind),
    ["mail", "attachment"],
  );
  assert.equal(JSON.stringify(citations).includes("model-made-up"), false);
  assert.equal(JSON.stringify(citations).includes("example.invalid"), false);
});
