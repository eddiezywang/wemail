export interface MailChangedMessage {
  id: string;
  from: string;
  subject: string;
}

export interface MailChangedEvent {
  accountId: string;
  origin: "live-idle" | "live-poll" | "manual";
  insertedCount: number;
  inserted: MailChangedMessage[];
}

export interface MailChangedRendererPayload {
  accountId: string;
  origin: "live-idle" | "live-poll" | "manual";
  insertedCount: number;
  insertedIds: string[];
}

export interface MailCredentialInvalidEvent {
  accountId: string;
  code: "MAIL_CREDENTIAL_INVALID";
  stage: "imap.login";
}

export function buildNotificationBody(subject: string) {
  return subject.length > 120 ? `${subject.slice(0, 117)}...` : subject;
}

export function buildMailChangedRendererPayload(
  event: MailChangedEvent,
): MailChangedRendererPayload {
  return {
    accountId: event.accountId,
    origin: event.origin,
    insertedCount: event.insertedCount,
    insertedIds: event.inserted.map((message) => message.id),
  };
}

export function registerMailChangedBridge({
  onMailChanged,
  recordAttention,
  publishNotification,
  sendToRenderer,
}: {
  onMailChanged: (listener: (event: MailChangedEvent) => void) => () => void;
  recordAttention?: (event: MailChangedEvent) => void;
  publishNotification: (event: NotificationEvent) => void;
  sendToRenderer: (channel: string, payload: MailChangedRendererPayload) => void;
}) {
  return onMailChanged((event) => {
    recordAttention?.(event);
    if (event.origin !== "manual") {
      for (const message of event.inserted) {
        publishNotification({
          kind: "liveMail",
          accountId: event.accountId,
          messageId: message.id,
          sender: message.from,
          subject: message.subject,
          origin: event.origin,
          target: {
            kind: "mail",
            accountId: event.accountId,
            messageId: message.id,
          },
        });
        const securityAttention = buildUrgentSecurityNotification(
          event.accountId,
          message,
        );
        if (securityAttention) publishNotification(securityAttention);
      }
    }

    sendToRenderer("mail:changed", buildMailChangedRendererPayload(event));
  });
}

export function buildUrgentSecurityNotification(
  accountId: string,
  message: MailChangedMessage,
): Extract<NotificationEvent, { kind: "actionRequired" }> | null {
  const subject = message.subject.trim();
  const urgent =
    /\b(?:unrecognized|suspicious)\s+(?:sign[- ]?in|login|activity)\b/i.test(subject) ||
    /\b(?:password|security settings?)\s+(?:was\s+)?changed\b/i.test(subject) ||
    /\baccount\s+(?:compromised|locked)\b/i.test(subject) ||
    /(?:异常|可疑|陌生)(?:登录|活动)|(?:密码|安全设置)已(?:被)?更改|账号(?:被盗|锁定)|安全警报/.test(subject);
  if (!urgent) return null;
  return {
    kind: "actionRequired",
    id: `security:${message.id}`,
    accountId,
    reason: "security-alert",
    title: "需要及时核验的安全邮件",
    detail: buildNotificationBody(subject || "检测到一封安全提醒邮件"),
    target: {
      kind: "mail",
      accountId,
      messageId: message.id,
    },
  };
}

export function registerMailCredentialInvalidBridge({
  onMailCredentialInvalid,
  publishNotification,
  sendToRenderer,
}: {
  onMailCredentialInvalid: (
    listener: (event: MailCredentialInvalidEvent) => void,
  ) => () => void;
  publishNotification: (event: NotificationEvent) => void;
  sendToRenderer: (channel: string, payload: MailCredentialInvalidEvent) => void;
}) {
  return onMailCredentialInvalid((event) => {
    publishNotification({
      kind: "actionRequired",
      id: `mail-auth:${event.accountId}`,
      accountId: event.accountId,
      reason: "mail-auth",
      title: "邮箱需要重新登录",
      detail: "WeMail 暂时无法同步此邮箱，请检查账户设置。",
      target: {
        kind: "accountSettings",
        accountId: event.accountId,
      },
    });
    sendToRenderer("mail:auth-required", event);
  });
}
import type { NotificationEvent } from "../../shared/wemail/notifications.js";
