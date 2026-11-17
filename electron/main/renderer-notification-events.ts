import type { ActionRequiredNotificationEvent } from "../../shared/wemail/notifications.js";

export interface AgentConfirmationNotificationInput {
  accountId: string;
  actionId: string;
  description: string;
}

export function buildAgentConfirmationNotification(
  input: unknown,
): ActionRequiredNotificationEvent | null {
  if (!isRecord(input)) return null;
  if (!isSafeId(input.accountId) || !isSafeId(input.actionId)) return null;
  if (typeof input.description !== "string") return null;
  return {
    kind: "actionRequired",
    id: input.actionId,
    accountId: input.accountId,
    reason: "agent-confirmation",
    title: "Agent 等待确认",
    detail: "有一项操作需要你返回 WeMail 查看并确认。",
    target: {
      kind: "pendingAction",
      accountId: input.accountId,
      actionId: input.actionId,
    },
  };
}

export function buildAgentRunNotification(input: unknown): ActionRequiredNotificationEvent | null {
  if (!isRecord(input)) return null;
  if (!isSafeId(input.accountId) || !isSafeId(input.conversationId) || !isSafeId(input.runId)) return null;
  const state = input.state;
  if (state !== "failed" && state !== "paused") return null;
  return {
    kind: "actionRequired",
    id: `${input.conversationId}:${input.runId}:${state}`,
    accountId: input.accountId,
    reason: state === "failed" ? "agent-failure" : "agent-paused",
    title: state === "failed" ? "Agent 处理失败" : "Agent 已暂停",
    detail: state === "failed"
      ? "任务未能完成。返回 WeMail 查看错误和重试选项。"
      : "任务队列已暂停。返回 WeMail 查看并继续。",
    target: {
      kind: "agentRun",
      accountId: input.accountId,
      conversationId: input.conversationId,
      runId: input.runId,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
