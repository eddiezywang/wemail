import {
  type AgentJsonValue,
  type WemailAgentArtifact,
  type WemailAgentCitation,
  type WemailAgentConfirmation,
  type WemailAgentEvent,
  type WemailAgentMessageRole,
  type WemailAgentRunState,
} from "./agentProtocol.js";
import type { AgentMessageContext } from "./agent.js";

export type ConversationMessagePart =
  | {
      id: string;
      type: "progress";
      text: string;
      state: "completed";
    }
  | {
      id: string;
      type: "text";
      markdown: string;
      state: "streaming" | "completed" | "stopped" | "failed";
      citationIds: string[];
    }
  | { id: string; type: "tool"; toolCallId: string }
  | { id: string; type: "confirmation"; confirmationId: string }
  | { id: string; type: "artifact"; artifact: WemailAgentArtifact }
  | { id: string; type: "error"; code: string; message: string };

export interface ConversationMessageState {
  id: string;
  runId?: string;
  role: WemailAgentMessageRole;
  state: "streaming" | "completed" | "stopped" | "failed";
  parts: ConversationMessagePart[];
  messageContext?: AgentMessageContext;
  createdAt: string;
  updatedAt: string;
}
export interface ConversationRunState {
  id: string;
  state: WemailAgentRunState;
  lastSequence: number;
  startedAt?: string;
  settledAt?: string;
  error?: { code: string; message: string; retryable: boolean };
}

export interface ConversationToolState {
  toolCallId: string;
  runId: string;
  toolName: string;
  argsText: string;
  input?: Record<string, AgentJsonValue>;
  output?: AgentJsonValue;
  summary?: string;
  state:
    | "receiving_args"
    | "ready"
    | "running"
    | "completed"
    | "failed";
  error?: { code: string; message: string };
}

export interface ConversationFollowupState {
  id: string;
  text: string;
  position: number;
  state: "queued" | "paused" | "removed";
  pauseReason?: "user_stopped" | "application_restarted" | "manual";
}

export interface ConversationAttachmentState {
  id: string;
  name?: string;
  relativePath?: string;
  state: "ready" | "failed";
  error?: { code: string; message: string };
}

export interface ConversationState {
  conversationId: string;
  messageOrder: string[];
  messages: Record<string, ConversationMessageState>;
  runs: Record<string, ConversationRunState>;
  tools: Record<string, ConversationToolState>;
  confirmations: Record<string, WemailAgentConfirmation>;
  citations: Record<string, WemailAgentCitation>;
  followupOrder: string[];
  followups: Record<string, ConversationFollowupState>;
  attachments: Record<string, ConversationAttachmentState>;
}

export function createConversationState(conversationId: string): ConversationState {
  return {
    conversationId,
    messageOrder: [],
    messages: {},
    runs: {},
    tools: {},
    confirmations: {},
    citations: {},
    followupOrder: [],
    followups: {},
    attachments: {},
  };
}

function orderedVisibleFollowups(state: ConversationState): ConversationFollowupState[] {
  return state.followupOrder
    .map((id) => state.followups[id])
    .filter((item): item is ConversationFollowupState => !!item && item.state !== "removed")
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

function replaceFollowups(
  state: ConversationState,
  followups: ConversationFollowupState[],
): ConversationState {
  const normalized = followups.map((item, position) => ({ ...item, position }));
  return {
    ...state,
    followupOrder: normalized.map((item) => item.id),
    followups: {
      ...state.followups,
      ...Object.fromEntries(normalized.map((item) => [item.id, item])),
    },
  };
}

/** Local Stage-One queue operations. The runtime persistence layer uses the
 * equivalent versioned events, while the renderer can already exercise the
 * exact queue semantics without creating a second UI-only model. */
export function queueConversationFollowup(
  state: ConversationState,
  input: { id: string; text: string },
): ConversationState {
  const current = orderedVisibleFollowups(state);
  return replaceFollowups(state, [
    ...current,
    { id: input.id, text: input.text, position: current.length, state: "queued" },
  ]);
}

export function updateConversationFollowup(
  state: ConversationState,
  id: string,
  text: string,
): ConversationState {
  return replaceFollowups(
    state,
    orderedVisibleFollowups(state).map((item) =>
      item.id === id ? { ...item, text } : item,
    ),
  );
}

export function removeConversationFollowup(
  state: ConversationState,
  id: string,
): ConversationState {
  const existing = state.followups[id];
  if (!existing) return state;
  const next = replaceFollowups(
    state,
    orderedVisibleFollowups(state).filter((item) => item.id !== id),
  );
  return {
    ...next,
    followups: {
      ...next.followups,
      [id]: { ...existing, state: "removed" },
    },
  };
}

export function moveConversationFollowup(
  state: ConversationState,
  id: string,
  direction: -1 | 1,
): ConversationState {
  const items = orderedVisibleFollowups(state);
  const index = items.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return state;
  const reordered = [...items];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  return replaceFollowups(state, reordered);
}

export function pauseConversationFollowups(
  state: ConversationState,
  reason: ConversationFollowupState["pauseReason"],
): ConversationState {
  return replaceFollowups(
    state,
    orderedVisibleFollowups(state).map((item) =>
      item.state === "queued" ? { ...item, state: "paused", pauseReason: reason } : item,
    ),
  );
}

export function resumeConversationFollowups(state: ConversationState): ConversationState {
  return replaceFollowups(
    state,
    orderedVisibleFollowups(state).map((item) =>
      item.state === "paused"
        ? { ...item, state: "queued", pauseReason: undefined }
        : item,
    ),
  );
}

export function nextQueuedConversationFollowup(
  state: ConversationState,
): ConversationFollowupState | undefined {
  return orderedVisibleFollowups(state).find((item) => item.state === "queued");
}

export function resolveConversationConfirmation(
  state: ConversationState,
  confirmationId: string,
  status: Exclude<WemailAgentConfirmation["status"], "pending">,
): ConversationState {
  const confirmation = state.confirmations[confirmationId];
  if (!confirmation) return state;
  return {
    ...state,
    confirmations: {
      ...state.confirmations,
      [confirmationId]: { ...confirmation, status },
    },
  };
}

function updateRun(
  state: ConversationState,
  event: WemailAgentEvent,
  patch: Partial<ConversationRunState>,
): ConversationState {
  const current = state.runs[event.runId] ?? {
    id: event.runId,
    state: "queued" as const,
    lastSequence: -1,
  };
  return {
    ...state,
    runs: {
      ...state.runs,
      [event.runId]: { ...current, ...patch, lastSequence: event.sequence },
    },
  };
}

function ensureMessage(
  state: ConversationState,
  input: {
    messageId: string;
    runId?: string;
    role?: WemailAgentMessageRole;
    timestamp: string;
  },
): ConversationState {
  if (state.messages[input.messageId]) return state;
  return {
    ...state,
    messageOrder: [...state.messageOrder, input.messageId],
    messages: {
      ...state.messages,
      [input.messageId]: {
        id: input.messageId,
        runId: input.runId,
        role: input.role ?? "assistant",
        state: "streaming",
        parts: [],
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      },
    },
  };
}

function updateMessage(
  state: ConversationState,
  messageId: string,
  timestamp: string,
  update: (message: ConversationMessageState) => ConversationMessageState,
): ConversationState {
  const existing = state.messages[messageId];
  if (!existing) return state;
  return {
    ...state,
    messages: {
      ...state.messages,
      [messageId]: { ...update(existing), updatedAt: timestamp },
    },
  };
}

function upsertPart(
  parts: ConversationMessagePart[],
  part: ConversationMessagePart,
): ConversationMessagePart[] {
  const index = parts.findIndex((candidate) => candidate.id === part.id);
  if (index < 0) return [...parts, part];
  return parts.map((candidate, candidateIndex) =>
    candidateIndex === index ? part : candidate,
  );
}

function finishStreamingParts(
  state: ConversationState,
  runId: string,
  finalState: "stopped" | "failed",
): ConversationState {
  const messages = Object.fromEntries(
    Object.entries(state.messages).map(([id, message]) => {
      if (message.runId !== runId) return [id, message];
      return [
        id,
        {
          ...message,
          state: finalState,
          parts: message.parts.map((part) => {
            if (
			  part.type === "text" &&
              part.state === "streaming"
            ) {
              return { ...part, state: finalState };
            }
            return part;
          }),
        },
      ];
    }),
  );
  return { ...state, messages };
}

function finishRunTools(
  state: ConversationState,
  runId: string,
  finalState: "completed" | "failed",
  error?: { code: string; message: string },
): ConversationState {
  const tools = Object.fromEntries(
    Object.entries(state.tools).map(([id, tool]) => {
      if (
        tool.runId !== runId ||
        tool.state === "completed" ||
        tool.state === "failed"
      ) {
        return [id, tool];
      }
      return [
        id,
        {
          ...tool,
          state: finalState,
          ...(finalState === "failed" && error ? { error } : {}),
        },
      ];
    }),
  );
  return { ...state, tools };
}

function messageIdFor(event: WemailAgentEvent): string | undefined {
  return event.messageId;
}

export function reduceConversationState(
  state: ConversationState,
  event: WemailAgentEvent,
): ConversationState {
  if (event.conversationId !== state.conversationId) return state;
  const lastSequence = state.runs[event.runId]?.lastSequence ?? -1;
  if (event.sequence <= lastSequence) return state;

  let next = updateRun(state, event, {});
  const messageId = messageIdFor(event);
  const messageBoundEvent =
    event.type === "message_completed" ||
    event.type === "progress_added" ||
    event.type.startsWith("text_") ||
    event.type.startsWith("tool_") ||
    event.type.startsWith("confirmation_") ||
    event.type === "artifact_ready" ||
    event.type === "citation_added" ||
    event.type === "run_failed";
  if (messageId && messageBoundEvent) {
    next = ensureMessage(next, {
      messageId,
      runId: event.runId,
      timestamp: event.timestamp,
    });
  }

  switch (event.type) {
    case "run_started":
      return updateRun(next, event, {
        state: "running",
        startedAt: event.timestamp,
        error: undefined,
      });
    case "run_state_changed":
      return event.state === "settled"
        ? finishRunTools(
            updateRun(next, event, { state: event.state, settledAt: event.timestamp }),
            event.runId,
            "completed",
          )
        : event.state === "failed" || event.state === "stopped" || event.state === "interrupted"
          ? finishRunTools(
              updateRun(next, event, { state: event.state, settledAt: event.timestamp }),
              event.runId,
              "failed",
              { code: event.state, message: event.state === "stopped" ? "操作已停止" : "操作未能完成" },
            )
          : updateRun(next, event, { state: event.state });
    case "run_settled":
      return finishRunTools(
        updateRun(next, event, {
          state: "settled",
          settledAt: event.timestamp,
        }),
        event.runId,
        "completed",
      );
    case "run_stopped":
      return finishRunTools(
        finishStreamingParts(
          updateRun(next, event, { state: "stopped", settledAt: event.timestamp }),
          event.runId,
          "stopped",
        ),
        event.runId,
        "failed",
        { code: "stopped", message: "操作已停止" },
      );
    case "run_failed": {
      let failed = updateRun(next, event, {
        state: "failed",
        settledAt: event.timestamp,
        error: { code: event.code, message: event.message, retryable: event.retryable },
      });
      failed = finishStreamingParts(failed, event.runId, "failed");
      failed = finishRunTools(failed, event.runId, "failed", {
        code: event.code,
        message: event.message,
      });
      if (!messageId) return failed;
      return updateMessage(failed, messageId, event.timestamp, (message) => ({
        ...message,
        parts: upsertPart(message.parts, {
          id: `error:${event.runId}`,
          type: "error",
          code: event.code,
          message: event.message,
        }),
      }));
    }
    case "message_started": {
      if (!messageId) return next;
      return ensureMessage(next, {
        messageId,
        runId: event.runId,
        role: event.role,
        timestamp: event.timestamp,
      });
    }
    case "message_completed":
      return messageId
        ? updateMessage(next, messageId, event.timestamp, (message) => ({
            ...message,
            state: "completed",
          }))
        : next;
    case "progress_added":
      return messageId
        ? updateMessage(next, messageId, event.timestamp, (message) => ({
            ...message,
            parts: upsertPart(message.parts, {
              id: event.partId,
              type: "progress",
              text: event.text,
              state: "completed",
            }),
          }))
        : next;
    case "reasoning_started":
    case "reasoning_delta":
    case "reasoning_completed":
	  // Provider reasoning stays in the diagnostic event stream. It never
	  // becomes renderer conversation state or user-visible audit history.
	  return next;
    case "text_started":
      return messageId
        ? updateMessage(next, messageId, event.timestamp, (message) => ({
            ...message,
            parts: upsertPart(message.parts, {
              id: event.partId,
              type: "text",
              markdown: "",
              state: "streaming",
              citationIds: [],
            }),
          }))
        : next;
    case "text_delta":
      return messageId
        ? updateMessage(next, messageId, event.timestamp, (message) => {
            const current = message.parts.find(
              (part) => part.id === event.partId && part.type === "text",
            );
            return {
              ...message,
              parts: upsertPart(message.parts, {
                id: event.partId,
                type: "text",
                markdown: `${current?.type === "text" ? current.markdown : ""}${event.delta}`,
                state: "streaming",
                citationIds: current?.type === "text" ? current.citationIds : [],
              }),
            };
          })
        : next;
    case "text_completed":
      return messageId
        ? updateMessage(next, messageId, event.timestamp, (message) => {
            const current = message.parts.find(
              (part) => part.id === event.partId && part.type === "text",
            );
            return {
              ...message,
              parts: upsertPart(message.parts, {
                id: event.partId,
                type: "text",
                markdown: event.text,
                state: "completed",
                citationIds: current?.type === "text" ? current.citationIds : [],
              }),
            };
          })
        : next;
    case "artifact_ready":
      return messageId
        ? updateMessage(next, messageId, event.timestamp, (message) => ({
            ...message,
            parts: upsertPart(message.parts, {
              id: event.partId,
              type: "artifact",
              artifact: event.artifact,
            }),
          }))
        : next;
    case "tool_call_started": {
      let withTool: ConversationState = {
        ...next,
        tools: {
          ...next.tools,
          [event.toolCallId]: {
            toolCallId: event.toolCallId,
            runId: event.runId,
            toolName: event.toolName,
            argsText: "",
            state: "receiving_args",
          },
        },
      };
      if (messageId) {
        withTool = updateMessage(withTool, messageId, event.timestamp, (message) => ({
          ...message,
          parts: upsertPart(message.parts, {
            id: `tool:${event.toolCallId}`,
            type: "tool",
            toolCallId: event.toolCallId,
          }),
        }));
      }
      return withTool;
    }
    case "tool_args_delta": {
      const tool = next.tools[event.toolCallId];
      if (!tool) return next;
      return {
        ...next,
        tools: {
          ...next.tools,
          [event.toolCallId]: { ...tool, argsText: tool.argsText + event.delta },
        },
      };
    }
    case "tool_args_completed": {
      const tool = next.tools[event.toolCallId];
      if (!tool) return next;
      return {
        ...next,
        tools: {
          ...next.tools,
          [event.toolCallId]: {
            ...tool,
            argsText: JSON.stringify(event.input),
            input: event.input,
            state: "ready",
          },
        },
      };
    }
    case "tool_execution_started": {
      const tool = next.tools[event.toolCallId];
      if (!tool) return next;
      return {
        ...next,
        tools: {
          ...next.tools,
          [event.toolCallId]: { ...tool, state: "running" },
        },
      };
    }
    case "tool_execution_updated":
    case "tool_execution_completed": {
      const tool = next.tools[event.toolCallId];
      if (!tool) return next;
      return {
        ...next,
        tools: {
          ...next.tools,
          [event.toolCallId]: {
            ...tool,
            ...(event.output !== undefined ? { output: event.output } : {}),
            ...(event.summary !== undefined ? { summary: event.summary } : {}),
            state: event.type === "tool_execution_completed" ? "completed" : "running",
          },
        },
      };
    }
    case "tool_execution_failed": {
      const tool = next.tools[event.toolCallId];
      if (!tool) return next;
      return {
        ...next,
        tools: {
          ...next.tools,
          [event.toolCallId]: {
            ...tool,
            state: "failed",
            error: { code: event.code, message: event.message },
          },
        },
      };
    }
    case "confirmation_requested": {
      let withConfirmation: ConversationState = {
        ...next,
        confirmations: {
          ...next.confirmations,
          [event.confirmation.id]: event.confirmation,
        },
      };
      if (messageId) {
        withConfirmation = updateMessage(
          withConfirmation,
          messageId,
          event.timestamp,
          (message) => ({
            ...message,
            parts: upsertPart(message.parts, {
              id: `confirmation:${event.confirmation.id}`,
              type: "confirmation",
              confirmationId: event.confirmation.id,
            }),
          }),
        );
      }
      return withConfirmation;
    }
    case "confirmation_resolved": {
      const confirmation = next.confirmations[event.confirmationId];
      if (!confirmation) return next;
      return {
        ...next,
        confirmations: {
          ...next.confirmations,
          [event.confirmationId]: { ...confirmation, status: event.status },
        },
      };
    }
    case "followup_queued": {
      const followup = next.followups[event.followupId] ?? {
        id: event.followupId,
        text: "",
        position: event.position,
        state: "queued" as const,
      };
      return normalizeFollowupOrder({
        ...next,
        followups: {
          ...next.followups,
          [event.followupId]: { ...followup, position: event.position, state: "queued" },
        },
      });
    }
    case "followup_updated": {
      const followup = next.followups[event.followupId] ?? {
        id: event.followupId,
        text: "",
        position: event.position,
        state: "queued" as const,
      };
      return normalizeFollowupOrder({
        ...next,
        followups: {
          ...next.followups,
          [event.followupId]: {
            ...followup,
            text: event.text,
            position: event.position,
          },
        },
      });
    }
    case "followup_removed": {
      const followup = next.followups[event.followupId];
      if (!followup) return next;
      return normalizeFollowupOrder({
        ...next,
        followups: {
          ...next.followups,
          [event.followupId]: { ...followup, state: "removed" },
        },
      });
    }
    case "followup_paused": {
      const followup = next.followups[event.followupId];
      if (!followup) return next;
      return {
        ...next,
        followups: {
          ...next.followups,
          [event.followupId]: {
            ...followup,
            state: "paused",
            pauseReason: event.reason,
          },
        },
      };
    }
    case "retry_started":
    case "retry_scheduled":
      return updateRun(next, event, { state: "retrying" });
    case "retry_completed":
      return updateRun(next, event, { state: "running" });
    case "retry_failed":
      return updateRun(next, event, {
        state: "failed",
        error: { code: "retry_failed", message: event.message, retryable: false },
      });
    case "attachment_ready":
      return {
        ...next,
        attachments: {
          ...next.attachments,
          [event.attachmentId]: {
            id: event.attachmentId,
            relativePath: event.relativePath,
            state: "ready",
          },
        },
      };
    case "attachment_failed": {
      const attachmentId = event.attachmentId ?? `failed:${event.name}`;
      return {
        ...next,
        attachments: {
          ...next.attachments,
          [attachmentId]: {
            id: attachmentId,
            name: event.name,
            state: "failed",
            error: { code: event.code, message: event.message },
          },
        },
      };
    }
    case "citation_added": {
      let withCitation: ConversationState = {
        ...next,
        citations: { ...next.citations, [event.citation.id]: event.citation },
      };
      if (!messageId) return withCitation;
      withCitation = updateMessage(
        withCitation,
        messageId,
        event.timestamp,
        (message) => {
          let targetId = event.partId;
          if (!targetId) {
            targetId = [...message.parts]
              .reverse()
              .find((part) => part.type === "text")?.id;
          }
          if (!targetId) return message;
          return {
            ...message,
            parts: message.parts.map((part) =>
              part.id === targetId && part.type === "text"
                ? {
                    ...part,
                    citationIds: part.citationIds.includes(event.citation.id)
                      ? part.citationIds
                      : [...part.citationIds, event.citation.id],
                  }
                : part,
            ),
          };
        },
      );
      return withCitation;
    }
  }
}

function normalizeFollowupOrder(state: ConversationState): ConversationState {
  const followupOrder = Object.values(state.followups)
    .filter((followup) => followup.state !== "removed")
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((followup) => followup.id);
  return { ...state, followupOrder };
}

export function conversationStateFromEvents(
  conversationId: string,
  events: readonly WemailAgentEvent[],
): ConversationState {
  const ordered = [...events].sort((a, b) => {
    if (a.runId === b.runId) return a.sequence - b.sequence;
    const timestampOrder = a.timestamp.localeCompare(b.timestamp);
    return timestampOrder || a.runId.localeCompare(b.runId) || a.sequence - b.sequence;
  });
  return ordered.reduce(reduceConversationState, createConversationState(conversationId));
}
