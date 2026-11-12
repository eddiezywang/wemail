import {
  createConversationState,
  reduceConversationState,
  type ConversationState,
} from "../../../shared/wemail/conversationState.js";
import type { WemailAgentEvent } from "../../../shared/wemail/agentProtocol.js";
import type { AgentRunRepository } from "./AgentRunRepository.js";

const STREAM_DELTA_TYPES = new Set<WemailAgentEvent["type"]>([
  "reasoning_delta",
  "text_delta",
  "tool_args_delta",
  "tool_execution_updated",
]);

/**
 * Projects versioned events into durable run/tool rows and throttled message
 * snapshots. Raw token deltas are deliberately not retained.
 */
export class AgentEventPersistence {
  private readonly states = new Map<string, ConversationState>();
  private readonly lastSnapshotAt = new Map<string, number>();

  constructor(
    private readonly repository: AgentRunRepository,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly snapshotIntervalMs = 1_000,
  ) {}

  record(event: WemailAgentEvent): boolean {
    if (!this.repository.recordEvent(event)) return false;
    const current = this.states.get(event.conversationId)
      ?? createConversationState(event.conversationId);
    const next = reduceConversationState(current, event);
    this.states.set(event.conversationId, next);

    if (!event.messageId) return true;
    const message = next.messages[event.messageId];
    if (!message) return true;
    const now = this.nowMs();
    const previous = this.lastSnapshotAt.get(event.messageId) ?? Number.NEGATIVE_INFINITY;
    const semanticBoundary = !STREAM_DELTA_TYPES.has(event.type);
    if (semanticBoundary || now - previous >= this.snapshotIntervalMs) {
      this.repository.persistMessageSnapshot(message);
      this.lastSnapshotAt.set(event.messageId, now);
    }
    return true;
  }

  flushMessage(conversationId: string, messageId: string): void {
    const message = this.states.get(conversationId)?.messages[messageId];
    if (!message) return;
    this.repository.persistMessageSnapshot(message);
    this.lastSnapshotAt.set(messageId, this.nowMs());
  }

  getState(conversationId: string): ConversationState {
    return this.states.get(conversationId) ?? createConversationState(conversationId);
  }
}
