import { describe, expect, it } from "vitest";
import type { ConversationMessagePart } from "../../../shared/wemail/conversationState";
import { buildAgentMessagePresentation } from "./AgentMessagePresentation";

describe("buildAgentMessagePresentation", () => {
  it("preserves the natural narrative order and only groups adjacent tools", () => {
    const parts: ConversationMessagePart[] = [
      { id: "text-before-tool", type: "text", markdown: "结果", state: "completed", citationIds: [] },
      { id: "tool-1", type: "tool", toolCallId: "tool-1" },
      { id: "tool-2", type: "tool", toolCallId: "tool-2" },
      { id: "confirm-1", type: "confirmation", confirmationId: "confirm-1" },
      { id: "text-after-confirm", type: "text", markdown: "确认后结果", state: "completed", citationIds: [] },
      { id: "error-1", type: "error", code: "failed", message: "失败" },
    ];

    const blocks = buildAgentMessagePresentation(parts);

    expect(blocks).toEqual([
      {
        id: "answer:text-before-tool",
        type: "answer",
        part: parts[0],
      },
      {
        id: "tools:tool-1",
        type: "tools",
        parts: [parts[1], parts[2]],
      },
      { id: "anchor:confirm-1", type: "anchor", part: parts[3] },
      {
        id: "answer:text-after-confirm",
        type: "answer",
        part: parts[4],
      },
	  { id: "anchor:error-1", type: "anchor", part: parts[5] },
    ]);
  });
});
