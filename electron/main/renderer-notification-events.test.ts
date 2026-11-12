import { describe, expect, it } from "vitest";
import {
  buildAgentConfirmationNotification,
  buildAgentRunNotification,
} from "./renderer-notification-events.js";

describe("buildAgentConfirmationNotification", () => {
  it("builds a bounded action-required fact from a pending Agent confirmation", () => {
    expect(
      buildAgentConfirmationNotification({
        accountId: "acct-1",
        actionId: "confirm-1",
        description: "发送邮件给财务",
      }),
    ).toEqual({
      kind: "actionRequired",
      id: "confirm-1",
      accountId: "acct-1",
      reason: "agent-confirmation",
      title: "Agent 等待确认",
      detail: "有一项操作需要你返回 WeMail 查看并确认。",
      target: {
        kind: "pendingAction",
        accountId: "acct-1",
        actionId: "confirm-1",
      },
    });
  });

  it("rejects malformed identifiers and never exposes renderer-controlled detail", () => {
    expect(
      buildAgentConfirmationNotification({
        accountId: "",
        actionId: "confirm-1",
        description: "Send",
      }),
    ).toBeNull();
    expect(
      buildAgentConfirmationNotification({
        accountId: "acct-1",
        actionId: "confirm-\n1",
        description: "Send",
      }),
    ).toBeNull();
    expect(
      buildAgentConfirmationNotification({
        accountId: "acct-1",
        actionId: "confirm-1",
        description: "x".repeat(300),
      })?.detail,
    ).toBe("有一项操作需要你返回 WeMail 查看并确认。");
  });

  it("builds privacy-safe failure notifications with exact run targets", () => {
    expect(buildAgentRunNotification({
      accountId: "acct-1",
      conversationId: "conversation-1",
      runId: "run-1",
      state: "failed",
      prompt: "private prompt",
    })).toMatchObject({
      reason: "agent-failure",
      detail: "任务未能完成。返回 WeMail 查看错误和重试选项。",
      target: { kind: "agentRun", conversationId: "conversation-1", runId: "run-1" },
    });
  });
});
