import type { MailSyncOrigin } from "./startup.js";

export type NotificationTarget =
  | { kind: "mail"; accountId: string; messageId: string }
  | { kind: "pendingAction"; accountId: string; actionId: string }
  | { kind: "agentRun"; accountId: string; conversationId: string; runId?: string }
  | { kind: "accountSettings"; accountId: string }
  | { kind: "applicationMessage"; accountId: string; messageId: string };

export interface LiveMailNotificationEvent {
  kind: "liveMail";
  accountId: string;
  messageId: string;
  sender: string;
  subject: string;
  origin: MailSyncOrigin;
  target: Extract<NotificationTarget, { kind: "mail" }>;
}

export interface ActionRequiredNotificationEvent {
  kind: "actionRequired";
  id: string;
  accountId: string;
  reason:
    | "agent-confirmation"
    | "agent-failure"
    | "agent-paused"
    | "mail-auth"
    | "send-failure"
    | "automation-failure"
    | "automation-result"
    | "security-alert";
  title: string;
  detail: string;
  target: NotificationTarget;
}

export type NotificationEvent =
  | LiveMailNotificationEvent
  | ActionRequiredNotificationEvent;

/**
 * Controls how much mailbox content may leave the app window in an OS toast.
 * `full` is the default so users can identify incoming mail at a glance.
 * Enterprise environments can still choose `count-only` because Windows may
 * surface notifications on the lock screen.
 */
export type NotificationContentMode =
  | "full"
  | "sender-only"
  | "count-only";

export interface NotificationPreferences {
  actionRequiredNotifications: boolean;
  newMailNotifications: boolean;
  notificationSound: boolean;
  notificationContentMode?: NotificationContentMode;
}

export type NotificationDecision =
  | { deliver: true; silent: boolean }
  | {
      deliver: false;
      reason: "category-disabled" | "not-live" | "target-resolved";
    };

/**
 * Content rendered by the self-drawn notification overlay window
 * (electron/main/notification-window.ts). Mirrors the subset of the native
 * toast options the overlay can render; `actions` are the same buttons the
 * coordinator embeds in the Windows toast XML.
 */
export interface CustomNotificationPayload {
  title?: string;
  body?: string;
  icon?: string;
  actions: Array<{ label: string; arguments: string }>;
  /** Short glyph rendered inside the sender avatar (initial / count / check).
   * When omitted the overlay falls back to the WeMail brand mark. */
  avatarText?: string;
  /** Left accent bar color. Defaults to the WeMail brand orange. */
  accent?: "brand" | "amber";
}
