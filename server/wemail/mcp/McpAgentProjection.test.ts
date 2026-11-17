import assert from "node:assert/strict";
import test from "node:test";
import { toMcpAgentRun, toMcpConversationSummary } from "./McpComposition.js";
import { WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME } from "./McpToolCatalog.js";
import { validateMcpSchema } from "./McpSchemaValidator.js";
import type { PersistedAgentRun } from "../../../shared/wemail/agentProtocol.js";
import { createConversationState, type ConversationState } from "../../../shared/wemail/conversationState.js";

test("toMcpAgentRun projects only schema-allowed fields", () => {
  const run: PersistedAgentRun = {
    id: "run-1",
    conversationId: "conv-1",
    state: "running",
    lastSequence: 5,
    startedAt: "2026-08-11T10:00:00.000Z",
    errorCode: "boom",
  };
  const projected = toMcpAgentRun(run);
  assert.equal(projected.startedAt, "2026-08-11T10:00:00.000Z");
  assert.equal(projected.errorCode, "boom");
  assert.ok(!("settledAt" in projected), "optional absent fields omitted");
});

test("toMcpConversationSummary bounds arrays and derives errorCode from error.code", () => {
  const state: ConversationState = createConversationState("conv-1");
  // 30 messages, each with a text part.
  for (let i = 0; i < 30; i++) {
    const id = `msg-${i}`;
    state.messageOrder.push(id);
    state.messages[id] = {
      id,
      role: "assistant",
      state: "completed",
      parts: [{ id: `p-${i}`, type: "text", markdown: "x".repeat(700), state: "completed", citationIds: [] }],
      createdAt: "2026-08-11T10:00:00.000Z",
      updatedAt: "2026-08-11T10:00:00.000Z",
    };
  }
  // 30 runs.
  for (let i = 0; i < 30; i++) {
    const id = `run-${i}`;
    state.runs[id] = {
      id,
      state: "failed",
      lastSequence: i,
      startedAt: "2026-08-11T10:00:00.000Z",
      error: { code: `code-${i}`, message: "fail", retryable: false },
    };
  }
  // 30 confirmations.
  for (let i = 0; i < 30; i++) {
    const id = `conf-${i}`;
    state.confirmations[id] = {
      id,
      actionType: "send",
      description: "d".repeat(700),
      riskLevel: "high",
      parameters: {},
      expiresAt: "2026-08-11T11:00:00.000Z",
      idempotencyKey: `key-${i}`,
      status: "pending",
    };
  }

  const projected = toMcpConversationSummary(state);
  assert.equal(projected.messageCount, 30);
  assert.equal(projected.recentMessages.length, 20, "recentMessages capped at 20");
  assert.equal(projected.recentMessages[0].textPreview.length, 500, "textPreview truncated to 500");
  assert.equal(projected.runs.length, 20, "runs capped at 20");
  assert.equal(projected.runs[0].errorCode, "code-0", "errorCode derived from error.code not full object");
  assert.ok(!("error" in projected.runs[0]), "full error object must not leak");
  assert.equal(projected.pendingConfirmations.length, 20, "pendingConfirmations capped at 20");
  assert.equal(projected.pendingConfirmations[0].description.length, 500, "description truncated to 500");

  const schema = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("get_conversation_state")!.outputSchema;
  assert.deepEqual(validateMcpSchema(schema, { conversation: projected }), [], "get_conversation_state output must validate");
});

test("toMcpConversationSummary handles empty state", () => {
  const projected = toMcpConversationSummary(createConversationState("conv-empty"));
  assert.equal(projected.messageCount, 0);
  assert.deepEqual(projected.recentMessages, []);
  const schema = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("get_conversation_state")!.outputSchema;
  assert.deepEqual(validateMcpSchema(schema, { conversation: projected }), []);
});
