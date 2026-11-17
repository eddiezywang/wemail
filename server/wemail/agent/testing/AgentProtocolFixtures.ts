import type { WemailAgentEvent } from "../../../../shared/wemail/agentProtocol.js";

const base = {
  schemaVersion: 1 as const,
  conversationId: "conv-fixture",
  runId: "run-fixture",
  timestamp: "2026-07-14T12:00:00.000Z",
};

function event<T extends Omit<WemailAgentEvent, keyof typeof base | "sequence">>(
  sequence: number,
  value: T,
): WemailAgentEvent {
  return { ...base, sequence, ...value } as WemailAgentEvent;
}

export const normalCompletionFixture: WemailAgentEvent[] = [
  event(0, { type: "run_started" }),
  event(1, {
    type: "message_started",
    messageId: "msg-assistant",
    role: "assistant",
  }),
  event(2, {
    type: "text_started",
    messageId: "msg-assistant",
    partId: "text-1",
  }),
  event(3, {
    type: "text_delta",
    messageId: "msg-assistant",
    partId: "text-1",
    delta: "Hello",
  }),
  event(4, {
    type: "text_completed",
    messageId: "msg-assistant",
    partId: "text-1",
    text: "Hello",
  }),
  event(5, { type: "message_completed", messageId: "msg-assistant" }),
  event(6, { type: "run_settled" }),
];

export const toolLifecycleFixture: WemailAgentEvent[] = [
  event(0, { type: "run_started" }),
  event(1, {
    type: "tool_call_started",
    toolCallId: "tool-1",
    toolName: "search_mail",
  }),
  event(2, { type: "tool_args_delta", toolCallId: "tool-1", delta: "{\"q\":" }),
  event(3, {
    type: "tool_args_completed",
    toolCallId: "tool-1",
    input: { q: "budget" },
  }),
  event(4, { type: "tool_execution_started", toolCallId: "tool-1" }),
  event(5, {
    type: "tool_execution_updated",
    toolCallId: "tool-1",
    summary: "Found 1 result",
  }),
  event(6, {
    type: "tool_execution_completed",
    toolCallId: "tool-1",
    output: { count: 1 },
  }),
  event(7, { type: "run_settled" }),
];

export const failureFixture: WemailAgentEvent[] = [
  event(0, { type: "run_started" }),
  event(1, {
    type: "run_failed",
    code: "provider_unavailable",
    message: "Provider unavailable",
    retryable: true,
  }),
];

export const retryFixture: WemailAgentEvent[] = [
  event(0, { type: "retry_started", attempt: 1, maxAttempts: 2 }),
  event(1, {
    type: "retry_scheduled",
    attempt: 1,
    delayMs: 1_000,
    reason: "rate_limited",
  }),
  event(2, { type: "retry_completed", attempt: 1 }),
];

export const stoppedFixture: WemailAgentEvent[] = [
  event(0, { type: "run_state_changed", state: "stopping" }),
  event(1, { type: "run_stopped", reason: "user_requested" }),
];

export const pendingConfirmationFixture: WemailAgentEvent[] = [
  event(0, {
    type: "confirmation_requested",
    confirmation: {
      id: "confirm-1",
      actionType: "send",
      description: "Send draft",
      riskLevel: "high",
      parameters: { draftId: "draft-1" },
      expiresAt: "2026-07-14T12:10:00.000Z",
      idempotencyKey: "idem-1",
      status: "pending",
    },
  }),
];

export const interruptedFixture: WemailAgentEvent[] = [
  event(0, { type: "run_started" }),
  event(1, { type: "run_state_changed", state: "interrupted" }),
];

export const agentProtocolFixtures = {
  normalCompletion: normalCompletionFixture,
  toolLifecycle: toolLifecycleFixture,
  failure: failureFixture,
  retry: retryFixture,
  stopped: stoppedFixture,
  pendingConfirmation: pendingConfirmationFixture,
  interrupted: interruptedFixture,
} as const;
