import { describe, expect, it } from "vitest";
import type { WemailAgentEvent } from "./agentProtocol.js";
import {
  conversationStateFromEvents,
  createConversationState,
  reduceConversationState,
} from "./conversationState.js";

const base = {
  schemaVersion: 1 as const,
  conversationId: "conv-1",
  runId: "run-1",
  messageId: "message-1",
  timestamp: "2026-07-14T12:00:00.000Z",
};

function event(sequence: number, value: Record<string, unknown>): WemailAgentEvent {
  return { ...base, sequence, ...value } as WemailAgentEvent;
}

describe("ConversationState reducer", () => {
  it("drops provider reasoning while preserving tool and Markdown order", () => {
    const events: WemailAgentEvent[] = [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "reasoning_started", partId: "reasoning-1" }),
      event(3, { type: "reasoning_delta", partId: "reasoning-1", delta: "Search" }),
      event(4, { type: "reasoning_completed", partId: "reasoning-1", text: "Search" }),
      event(5, {
        type: "tool_call_started",
        toolCallId: "tool-1",
        toolName: "search_mail",
      }),
      event(6, {
        type: "tool_args_completed",
        toolCallId: "tool-1",
        input: { query: "budget" },
      }),
      event(7, { type: "tool_execution_started", toolCallId: "tool-1" }),
      event(8, {
        type: "tool_execution_updated",
        toolCallId: "tool-1",
        summary: "Found 1 result",
      }),
      event(9, {
        type: "tool_execution_completed",
        toolCallId: "tool-1",
        output: { count: 1 },
      }),
      event(10, { type: "text_started", partId: "text-1" }),
      event(11, { type: "text_delta", partId: "text-1", delta: "## Result" }),
      event(12, { type: "text_completed", partId: "text-1", text: "## Result" }),
      event(13, { type: "message_completed" }),
      event(14, { type: "run_settled" }),
    ];

    const state = conversationStateFromEvents("conv-1", events);

    expect(state.messages["message-1"].parts.map((part) => part.type)).toEqual([
      "tool",
      "text",
    ]);
    expect(state.tools["tool-1"]).toMatchObject({
      state: "completed",
      input: { query: "budget" },
      output: { count: 1 },
    });
    expect(state.runs["run-1"].state).toBe("settled");
  });

  it("ignores duplicate and stale sequence numbers", () => {
    const started = reduceConversationState(
      createConversationState("conv-1"),
      event(0, { type: "run_started" }),
    );
    const once = reduceConversationState(
      started,
      event(1, { type: "message_started", role: "assistant" }),
    );
    const duplicate = reduceConversationState(
      once,
      event(1, { type: "message_started", role: "user" }),
    );

    expect(duplicate).toBe(once);
    expect(duplicate.messages["message-1"].role).toBe("assistant");
  });

  it("sorts replay events deterministically per run", () => {
    const state = conversationStateFromEvents("conv-1", [
      event(3, { type: "text_completed", partId: "text-1", text: "Complete" }),
      event(0, { type: "run_started" }),
      event(2, { type: "text_started", partId: "text-1" }),
      event(1, { type: "message_started", role: "assistant" }),
    ]);

    expect(state.messages["message-1"].parts[0]).toMatchObject({
      type: "text",
      markdown: "Complete",
      state: "completed",
    });
  });

  it("tracks citations, confirmations, attachments, and reorderable follow-ups", () => {
    const state = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "text_started", partId: "text-1" }),
      event(3, {
        type: "citation_added",
        partId: "text-1",
        citation: { id: "citation-1", source: { kind: "mail", emailId: "mail-1" } },
      }),
      event(4, {
        type: "confirmation_requested",
        confirmation: {
          id: "confirm-1",
          actionType: "archive",
          description: "Archive mail",
          riskLevel: "medium",
          parameters: { emailId: "mail-1" },
          expiresAt: "2026-07-14T12:10:00.000Z",
          idempotencyKey: "idem-1",
          status: "pending",
        },
      }),
      event(5, { type: "attachment_ready", attachmentId: "attachment-1", relativePath: "a/content" }),
      event(6, { type: "followup_queued", followupId: "followup-a", position: 1 }),
      event(7, { type: "followup_updated", followupId: "followup-a", position: 1, text: "A" }),
      event(8, { type: "followup_queued", followupId: "followup-b", position: 0 }),
      event(9, { type: "followup_updated", followupId: "followup-b", position: 0, text: "B" }),
    ]);

    expect(state.citations["citation-1"].source).toMatchObject({ emailId: "mail-1" });
    expect(state.messages["message-1"].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "confirmation", confirmationId: "confirm-1" }),
      ]),
    );
    expect(state.attachments["attachment-1"].state).toBe("ready");
    expect(state.followupOrder).toEqual(["followup-b", "followup-a"]);
  });

  it("preserves partial content and marks it failed", () => {
    const state = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "text_started", partId: "text-1" }),
      event(3, { type: "text_delta", partId: "text-1", delta: "Partial" }),
      event(4, {
        type: "run_failed",
        code: "network",
        message: "Disconnected",
        retryable: true,
      }),
    ]);

    expect(state.messages["message-1"].parts[0]).toMatchObject({
      type: "text",
      markdown: "Partial",
      state: "failed",
    });
    expect(state.messages["message-1"].parts[1]).toMatchObject({
      type: "error",
      code: "network",
    });
  });

  it("finishes orphaned tool states when their run terminates", () => {
    const failed = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "tool_call_started", toolCallId: "tool-1", toolName: "search_mail" }),
      event(3, { type: "tool_args_completed", toolCallId: "tool-1", input: { query: "budget" } }),
      event(4, { type: "tool_execution_started", toolCallId: "tool-1" }),
      event(5, { type: "run_failed", code: "network", message: "Disconnected", retryable: true }),
    ]);
    expect(failed.tools["tool-1"]).toMatchObject({
      state: "failed",
      error: { code: "network", message: "Disconnected" },
    });

    const settled = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "tool_call_started", toolCallId: "tool-1", toolName: "search_mail" }),
      event(3, { type: "tool_execution_started", toolCallId: "tool-1" }),
      event(4, { type: "run_settled" }),
    ]);
    expect(settled.tools["tool-1"].state).toBe("completed");
  });

  it("does not retain provider reasoning when a run is stopped", () => {
    const state = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "reasoning_started", partId: "reasoning-1" }),
      event(3, { type: "reasoning_delta", partId: "reasoning-1", delta: "Working" }),
      event(4, { type: "run_state_changed", state: "stopping" }),
      event(5, { type: "run_stopped", reason: "user_requested" }),
    ]);

    expect(state.runs["run-1"].state).toBe("stopped");
	expect(state.messages["message-1"].parts).toEqual([]);
  });
});
