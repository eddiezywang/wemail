import { describe, expect, it, vi } from "vitest";
import {
  buildMailChangedRendererPayload,
  buildNotificationBody,
  buildUrgentSecurityNotification,
  registerMailChangedBridge,
  registerMailCredentialInvalidBridge,
} from "./mail-events.js";

describe("mail-events", () => {
  it("truncates long subjects for desktop notifications", () => {
    expect(buildNotificationBody("a".repeat(120))).toBe("a".repeat(120));
    expect(buildNotificationBody("b".repeat(121))).toBe(`${"b".repeat(117)}...`);
  });

  it("promotes only strict security subjects to immediate attention", () => {
    expect(
      buildUrgentSecurityNotification("acct-1", {
        id: "mail-security",
        from: "security@example.test",
        subject: "Suspicious sign-in detected",
      }),
    ).toEqual({
      kind: "actionRequired",
      id: "security:mail-security",
      accountId: "acct-1",
      reason: "security-alert",
      title: "需要及时核验的安全邮件",
      detail: "Suspicious sign-in detected",
      target: {
        kind: "mail",
        accountId: "acct-1",
        messageId: "mail-security",
      },
    });
    expect(
      buildUrgentSecurityNotification("acct-1", {
        id: "mail-news",
        from: "newsletter@example.test",
        subject: "本周安全产品更新",
      }),
    ).toBeNull();
  });

  it("maps mail changed events to the renderer payload", () => {
    expect(
      buildMailChangedRendererPayload({
        accountId: "acct-1",
        origin: "live-idle",
        insertedCount: 2,
        inserted: [
          { id: "m-1", from: "A", subject: "One" },
          { id: "m-2", from: "B", subject: "Two" },
        ],
      }),
    ).toEqual({
      accountId: "acct-1",
      origin: "live-idle",
      insertedCount: 2,
      insertedIds: ["m-1", "m-2"],
    });
  });

  it("publishes typed live-mail facts and renderer events from composition changes", () => {
    const notifications: unknown[] = [];
    const attentionEvents: unknown[] = [];
    const rendererPayloads: Array<{ channel: string; payload: unknown }> = [];
    let unsubscribeCalls = 0;

    const unsubscribe = registerMailChangedBridge({
      onMailChanged: (
        listener: (event: {
          accountId: string;
          origin: "live-idle" | "live-poll";
          insertedCount: number;
          inserted: Array<{ id: string; from: string; subject: string }>;
        }) => void,
      ) => {
        listener({
          accountId: "acct-1",
          origin: "live-poll",
          insertedCount: 2,
          inserted: [
            { id: "m-1", from: "Alpha", subject: "Short" },
            { id: "m-2", from: "Beta", subject: "x".repeat(130) },
          ],
        });
        return () => {
          unsubscribeCalls += 1;
        };
      },
      recordAttention: (event) => attentionEvents.push(event),
      publishNotification: (event) => notifications.push(event),
      sendToRenderer: (channel: string, payload: unknown) =>
        rendererPayloads.push({ channel, payload }),
    });

    expect(notifications).toEqual([
      {
        kind: "liveMail",
        accountId: "acct-1",
        messageId: "m-1",
        sender: "Alpha",
        subject: "Short",
        origin: "live-poll",
        target: {
          kind: "mail",
          accountId: "acct-1",
          messageId: "m-1",
        },
      },
      {
        kind: "liveMail",
        accountId: "acct-1",
        messageId: "m-2",
        sender: "Beta",
        subject: "x".repeat(130),
        origin: "live-poll",
        target: {
          kind: "mail",
          accountId: "acct-1",
          messageId: "m-2",
        },
      },
    ]);
    expect(attentionEvents).toHaveLength(1);
    expect(attentionEvents[0]).toMatchObject({
      accountId: "acct-1",
      origin: "live-poll",
      insertedCount: 2,
    });
    expect(rendererPayloads).toEqual([
      {
        channel: "mail:changed",
        payload: {
          accountId: "acct-1",
          origin: "live-poll",
          insertedCount: 2,
          insertedIds: ["m-1", "m-2"],
        },
      },
    ]);

    unsubscribe();
    expect(unsubscribeCalls).toBe(1);
  });

  it("refreshes the renderer without a desktop notification for manual discovery", () => {
    const publishNotification = vi.fn();
    const sendToRenderer = vi.fn();

    registerMailChangedBridge({
      onMailChanged: (listener) => {
        listener({
          accountId: "acct-1",
          origin: "manual",
          insertedCount: 1,
          inserted: [{ id: "m-1", from: "Alpha", subject: "New" }],
        });
        return () => {};
      },
      publishNotification,
      sendToRenderer,
    });

    expect(publishNotification).not.toHaveBeenCalled();
    expect(sendToRenderer).toHaveBeenCalledWith("mail:changed", {
      accountId: "acct-1",
      origin: "manual",
      insertedCount: 1,
      insertedIds: ["m-1"],
    });
  });

  it("forwards credential failures without provider error details", () => {
    const rendererPayloads: Array<{ channel: string; payload: unknown }> = [];
    const notifications: unknown[] = [];
    const unsubscribe = registerMailCredentialInvalidBridge({
      onMailCredentialInvalid: (listener) => {
        listener({
          accountId: "acct-1",
          code: "MAIL_CREDENTIAL_INVALID",
          stage: "imap.login",
        });
        return vi.fn();
      },
      sendToRenderer: (channel, payload) =>
        rendererPayloads.push({ channel, payload }),
      publishNotification: (event) => notifications.push(event),
    });

    expect(rendererPayloads).toEqual([
      {
        channel: "mail:auth-required",
        payload: {
          accountId: "acct-1",
          code: "MAIL_CREDENTIAL_INVALID",
          stage: "imap.login",
        },
      },
    ]);
    expect(JSON.stringify(rendererPayloads)).not.toContain("password error");
    expect(notifications).toEqual([
      {
        kind: "actionRequired",
        id: "mail-auth:acct-1",
        accountId: "acct-1",
        reason: "mail-auth",
        title: "邮箱需要重新登录",
        detail: "WeMail 暂时无法同步此邮箱，请检查账户设置。",
        target: { kind: "accountSettings", accountId: "acct-1" },
      },
    ]);
    unsubscribe();
  });
});
