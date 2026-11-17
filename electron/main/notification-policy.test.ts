import { describe, expect, it } from "vitest";
import type { NotificationEvent } from "../../shared/wemail/notifications.js";
import { decideNotification } from "./notification-policy.js";

const quietDefaults = {
  actionRequiredNotifications: true,
  newMailNotifications: false,
  notificationSound: false,
};

const liveMail: NotificationEvent = {
  kind: "liveMail",
  accountId: "acct-1",
  messageId: "mail-1",
  sender: "Alice <alice@example.com>",
  subject: "Quarterly & planning",
  origin: "live-idle",
  target: { kind: "mail", accountId: "acct-1", messageId: "mail-1" },
};

const confirmation: NotificationEvent = {
  kind: "actionRequired",
  id: "confirm-1",
  accountId: "acct-1",
  reason: "agent-confirmation",
  title: "Agent 等待确认",
  detail: "发送邮件给财务",
  target: {
    kind: "pendingAction",
    accountId: "acct-1",
    actionId: "confirm-1",
  },
};

describe("decideNotification", () => {
  it("keeps new-mail quiet by default", () => {
    expect(decideNotification(liveMail, quietDefaults)).toEqual({
      deliver: false,
      reason: "category-disabled",
    });
  });

  it("delivers every genuinely live mail when the user enables mail alerts", () => {
    expect(
      decideNotification(
        { ...liveMail, origin: "live-poll" },
        { ...quietDefaults, newMailNotifications: true },
        { appFocused: true },
      ),
    ).toEqual({ deliver: true, silent: true });
  });

  it("rejects historical or manual mail even when new-mail alerts are enabled", () => {
    for (const origin of ["bootstrap", "historical", "manual"] as const) {
      expect(
        decideNotification(
          { ...liveMail, origin },
          { ...quietDefaults, newMailNotifications: true },
        ),
      ).toEqual({ deliver: false, reason: "not-live" });
    }
  });

  it("delivers unresolved action-required alerts by default with optional sound", () => {
    expect(
      decideNotification(
        confirmation,
        { ...quietDefaults, notificationSound: true },
      ),
    ).toEqual({ deliver: true, silent: false });
  });

  it("suppresses disabled or already-resolved action targets", () => {
    expect(
      decideNotification(confirmation, {
        ...quietDefaults,
        actionRequiredNotifications: false,
      }),
    ).toEqual({ deliver: false, reason: "category-disabled" });
    expect(
      decideNotification(confirmation, quietDefaults, { targetResolved: true }),
    ).toEqual({ deliver: false, reason: "target-resolved" });
  });
});
