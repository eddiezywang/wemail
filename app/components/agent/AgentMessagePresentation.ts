import type { ConversationMessagePart } from "../../../shared/wemail/conversationState";

export type AgentProgressPart = Extract<
  ConversationMessagePart,
  { type: "progress" }
>;

export type AgentToolPart = Extract<
  ConversationMessagePart,
  { type: "tool" }
>;

export type AgentFinalAnswerPart = Extract<
  ConversationMessagePart,
  { type: "text" | "artifact" }
>;

export type AgentTimelineAnchorPart = Extract<
  ConversationMessagePart,
  { type: "confirmation" | "error" }
>;

export type AgentMessagePresentationBlock =
  | {
      id: string;
      type: "progress";
      part: AgentProgressPart;
    }
  | {
      id: string;
      type: "tools";
      parts: AgentToolPart[];
    }
  | {
      id: string;
      type: "answer";
      part: AgentFinalAnswerPart;
    }
  | {
      id: string;
      type: "anchor";
      part: AgentTimelineAnchorPart;
    };

export function buildAgentMessagePresentation(
  parts: readonly ConversationMessagePart[],
): AgentMessagePresentationBlock[] {
  const blocks: AgentMessagePresentationBlock[] = [];
  let adjacentTools: AgentToolPart[] = [];

  const flushTools = () => {
    if (adjacentTools.length === 0) return;
    blocks.push({
      id: `tools:${adjacentTools[0].id}`,
      type: "tools",
      parts: adjacentTools,
    });
    adjacentTools = [];
  };

  for (const part of parts) {
    if (part.type === "tool") {
      adjacentTools.push(part);
      continue;
    }
    flushTools();
    if (part.type === "progress") {
      blocks.push({ id: `progress:${part.id}`, type: "progress", part });
      continue;
    }
    if (part.type === "text" || part.type === "artifact") {
      blocks.push({ id: `answer:${part.id}`, type: "answer", part });
      continue;
    }
    blocks.push({ id: `anchor:${part.id}`, type: "anchor", part });
  }
  flushTools();
  return blocks;
}
