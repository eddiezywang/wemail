import type { NotificationTarget } from "../../shared/wemail/notifications.js";

type MailTarget = Extract<NotificationTarget, { kind: "mail" }>;

export type NotificationActivation =
  | { action: "open"; target: NotificationTarget }
  | { action: "markRead"; target: MailTarget };

export function encodeNotificationActivation(
  action: NotificationActivation["action"],
  target: NotificationTarget,
): string {
  return `wemail:${encodeURIComponent(JSON.stringify({ action, target }))}`;
}

export function parseNotificationActivation(
  input: string,
): NotificationActivation | null {
  if (!input.startsWith("wemail:")) return null;
  try {
    const parsed = JSON.parse(
      decodeURIComponent(input.slice("wemail:".length)),
    ) as { action?: unknown; target?: unknown };
    const target = parseTarget(parsed.target);
    if (!target) return null;
    if (parsed.action === "open") {
      return { action: "open", target };
    }
    if (parsed.action === "markRead" && target.kind === "mail") {
      return { action: "markRead", target };
    }
    return null;
  } catch {
    return null;
  }
}

export async function routeNotificationActivation(
  activation: NotificationActivation,
  dependencies: {
    showWindow: () => void;
    sendToRenderer: (
      channel: "notification:navigate",
      target: NotificationTarget,
    ) => void;
    markRead: (accountId: string, messageId: string) => Promise<unknown>;
  },
): Promise<{ ok: true } | { ok: false; reason: "mark-read-failed" }> {
  if (activation.action === "markRead") {
    try {
      await dependencies.markRead(
        activation.target.accountId,
        activation.target.messageId,
      );
    } catch {
      return { ok: false, reason: "mark-read-failed" };
    }
  }
  dependencies.showWindow();
  dependencies.sendToRenderer("notification:navigate", activation.target);
  return { ok: true };
}

function parseTarget(input: unknown): NotificationTarget | null {
  if (!isRecord(input) || !isSafeId(input.accountId)) return null;
  if (input.kind === "mail" && isSafeId(input.messageId)) {
    return {
      kind: "mail",
      accountId: input.accountId,
      messageId: input.messageId,
    };
  }
  if (input.kind === "pendingAction" && isSafeId(input.actionId)) {
    return {
      kind: "pendingAction",
      accountId: input.accountId,
      actionId: input.actionId,
    };
  }
  if (input.kind === "accountSettings") {
    return {
      kind: "accountSettings",
      accountId: input.accountId,
    };
  }
  if (input.kind === "applicationMessage" && isSafeId(input.messageId)) {
    return {
      kind: "applicationMessage",
      accountId: input.accountId,
      messageId: input.messageId,
    };
  }
  return null;
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
