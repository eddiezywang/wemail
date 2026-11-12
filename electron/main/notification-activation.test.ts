import { describe, expect, it, vi } from "vitest";
import type { NotificationTarget } from "../../shared/wemail/notifications.js";
import {
  encodeNotificationActivation,
  parseNotificationActivation,
  routeNotificationActivation,
} from "./notification-activation.js";

const mailTarget: NotificationTarget = {
  kind: "mail",
  accountId: "acct-1",
  messageId: "mail-1",
};

describe("notification activation", () => {
  it("round-trips allowed open and mark-read actions", () => {
    const open = encodeNotificationActivation("open", mailTarget);
    const markRead = encodeNotificationActivation("markRead", mailTarget);

    expect(parseNotificationActivation(open)).toEqual({
      action: "open",
      target: mailTarget,
    });
    expect(parseNotificationActivation(markRead)).toEqual({
      action: "markRead",
      target: mailTarget,
    });
  });

  it("rejects external URLs, malformed payloads, and privileged actions", () => {
    expect(parseNotificationActivation("https://example.com")).toBeNull();
    expect(parseNotificationActivation("wemail:not-json")).toBeNull();
    expect(
      parseNotificationActivation(
        `wemail:${encodeURIComponent(
          JSON.stringify({ action: "approve", target: mailTarget }),
        )}`,
      ),
    ).toBeNull();
    expect(
      parseNotificationActivation(
        `wemail:${encodeURIComponent(
          JSON.stringify({
            action: "markRead",
            target: {
              kind: "pendingAction",
              accountId: "acct-1",
              actionId: "confirm-1",
            },
          }),
        )}`,
      ),
    ).toBeNull();
  });

  it("restores the window and sends a typed renderer route", async () => {
    const showWindow = vi.fn();
    const sendToRenderer = vi.fn();

    const result = await routeNotificationActivation(
      { action: "open", target: mailTarget },
      {
        showWindow,
        sendToRenderer,
        markRead: vi.fn(),
      },
    );

    expect(result).toEqual({ ok: true });
    expect(showWindow).toHaveBeenCalledOnce();
    expect(sendToRenderer).toHaveBeenCalledWith(
      "notification:navigate",
      mailTarget,
    );
  });

  it("marks mail read before navigating and rejects other mark-read targets", async () => {
    const calls: string[] = [];
    const markRead = vi.fn(async () => {
      calls.push("mark");
    });
    const sendToRenderer = vi.fn(() => {
      calls.push("navigate");
    });

    await routeNotificationActivation(
      { action: "markRead", target: mailTarget },
      { showWindow: vi.fn(), sendToRenderer, markRead },
    );

    expect(markRead).toHaveBeenCalledWith("acct-1", "mail-1");
    expect(calls).toEqual(["mark", "navigate"]);
  });
});
