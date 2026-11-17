import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NotificationEvent,
  NotificationPreferences,
} from "../../shared/wemail/notifications.js";
import {
  NotificationCoordinator,
  type NotificationOutcome,
} from "./notification-coordinator.js";
import type {
  DesktopNotificationActivationHandlers,
  DesktopNotificationOptions,
} from "./notifications.js";
import type { NotificationActivation } from "./notification-activation.js";

function liveMail(
  messageId: string,
  sender = "Alice",
  subject = "Subject",
): NotificationEvent {
  return {
    kind: "liveMail",
    accountId: "acct-1",
    messageId,
    sender,
    subject,
    origin: "live-idle",
    target: { kind: "mail", accountId: "acct-1", messageId },
  };
}

function createHarness(
  preferences: NotificationPreferences = {
    actionRequiredNotifications: true,
    newMailNotifications: false,
    notificationSound: false,
  },
  shown = true,
  aggregationWindowMs?: number,
) {
  const resolvedPreferences: NotificationPreferences = { ...preferences };
  const delivered = new Set<string>();
  const shownOptions: DesktopNotificationOptions[] = [];
  const shownHandlers: Array<
    DesktopNotificationActivationHandlers | undefined
  > = [];
  const activations: NotificationActivation[] = [];
  const outcomes: NotificationOutcome[] = [];
  const coordinator = new NotificationCoordinator({
    getPreferences: () => resolvedPreferences,
    iconPath: "D:\\WeMail\\wemail.ico",
    ledger: {
      has: (key) => delivered.has(key),
      record: (key) => delivered.add(key),
    },
    show: (options, handlers) => {
      shownOptions.push(options);
      shownHandlers.push(handlers);
      return { supported: true, shown };
    },
    onActivate: (activation) => {
      activations.push(activation);
    },
    onOutcome: (outcome) => outcomes.push(outcome),
    aggregationWindowMs,
    actionAggregationWindowMs: 0,
  });
  return {
    coordinator,
    delivered,
    shownOptions,
    shownHandlers,
    activations,
    outcomes,
  };
}

describe("NotificationCoordinator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not deliver live mail while the category is disabled", () => {
    const { coordinator, shownOptions, outcomes } = createHarness();

    coordinator.publish(liveMail("mail-1"));
    vi.advanceTimersByTime(2_000);

    expect(shownOptions).toEqual([]);
    expect(outcomes).toEqual([
      {
        kind: "liveMail",
        reason: "category-disabled",
        origin: "live-idle",
        count: 1,
      },
    ]);
  });

  it("delivers one enabled live mail immediately with subject-first content", () => {
    const { coordinator, delivered, shownOptions, outcomes } = createHarness({
      actionRequiredNotifications: true,
      newMailNotifications: true,
      notificationSound: false,
    });

    coordinator.publish(liveMail("mail-1", "Alice", "Quarterly plan"));
    expect(shownOptions).toHaveLength(1);
    expect(shownOptions[0]).toMatchObject({
      title: "Quarterly plan",
      body: "来自 Alice",
      silent: true,
      urgency: "normal",
      timeoutType: "default",
    });
    expect(shownOptions[0]?.toastXml).toContain("Alice");
    expect(shownOptions[0]?.toastXml).toContain("Quarterly plan");
    expect(shownOptions[0]?.toastXml).toContain("wemail-toast-48.png");
    expect(delivered.has("mail:acct-1:mail-1")).toBe(true);
    expect(outcomes).toEqual([
      { kind: "liveMail", reason: "queued", origin: "live-idle", count: 1 },
      {
        kind: "liveMail",
        reason: "delivered",
        origin: "live-idle",
        count: 1,
      },
    ]);
  });

  it("aggregates multiple mail items with only the first two previews", () => {
    const { coordinator, shownOptions } = createHarness(
      {
        actionRequiredNotifications: true,
        newMailNotifications: true,
        notificationSound: false,
      },
      true,
      2_000,
    );

    coordinator.publish(liveMail("mail-1", "Alice", "One"));
    coordinator.publish(liveMail("mail-2", "Bob", "Two"));
    coordinator.publish(liveMail("mail-3", "Carol", "Three"));
    vi.advanceTimersByTime(2_000);

    expect(shownOptions[0]).toMatchObject({
      title: "收到 3 封新邮件",
      body: "Alice · One\nBob · Two",
    });
    expect(shownOptions[0]?.toastXml).not.toContain("Carol");
    expect(shownOptions[0]?.toastXml).not.toContain("Three");
  });

  it("delivers action-required immediately and deduplicates by stable id", () => {
    const { coordinator, shownOptions } = createHarness({
      actionRequiredNotifications: true,
      newMailNotifications: false,
      notificationSound: true,
    });
    const event: NotificationEvent = {
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

    coordinator.publish(event);
    coordinator.publish(event);

    expect(shownOptions).toHaveLength(1);
    expect(shownOptions[0]).toMatchObject({
      title: "Agent 等待确认",
      body: "发送邮件给财务",
      silent: false,
      timeoutType: "default",
    });
    expect(shownOptions[0]?.toastXml).toContain("查看并确认");
    expect(shownOptions[0]?.toastXml).not.toContain("批准");
    expect(shownOptions[0]?.icon).toBe("D:\\WeMail\\wemail-toast-48.png");
    expect(shownOptions[0]?.toastXml).toContain("wemail-toast-48.png");
    expect(shownOptions[0]?.toastXml).not.toContain("wemail.ico");
  });

  it("aggregates action-required events in a short window while retaining stable delivery keys", () => {
    const delivered = new Set<string>();
    const shownOptions: DesktopNotificationOptions[] = [];
    const coordinator = new NotificationCoordinator({
      getPreferences: () => ({
        actionRequiredNotifications: true,
        newMailNotifications: false,
        notificationSound: false,
        notificationContentMode: "full",
      }),
      ledger: {
        has: (key) => delivered.has(key),
        record: (key) => delivered.add(key),
      },
      show: (options) => {
        shownOptions.push(options);
        return { supported: true, shown: true };
      },
      actionAggregationWindowMs: 1_000,
    });
    const makeEvent = (id: string): NotificationEvent => ({
      kind: "actionRequired",
      id,
      accountId: "acct-1",
      reason: "agent-failure",
      title: "Agent 处理失败",
      detail: "返回 WeMail 查看错误。",
      target: { kind: "agentRun", accountId: "acct-1", conversationId: id, runId: id },
    });

    coordinator.publish(makeEvent("run-1"));
    coordinator.publish(makeEvent("run-2"));
    expect(shownOptions).toHaveLength(0);
    vi.advanceTimersByTime(1_000);

    expect(shownOptions).toHaveLength(1);
    expect(shownOptions[0]).toMatchObject({
      title: "2 项 Agent 任务需要处理",
      body: "返回 WeMail 查看任务状态和后续操作。",
    });
    expect(delivered.has("action:acct-1:run-1")).toBe(true);
    expect(delivered.has("action:acct-1:run-2")).toBe(true);
  });

  it("does not record a failed delivery so a later event can retry", () => {
    const { coordinator, delivered, shownOptions, outcomes } = createHarness(
      {
        actionRequiredNotifications: true,
        newMailNotifications: true,
        notificationSound: false,
      },
      false,
    );

    coordinator.publish(liveMail("mail-1"));
    vi.advanceTimersByTime(2_000);
    coordinator.publish(liveMail("mail-1"));
    vi.advanceTimersByTime(2_000);

    expect(shownOptions).toHaveLength(2);
    expect(delivered.size).toBe(0);
    expect(
      outcomes.filter((outcome) => outcome.reason === "show-failed"),
    ).toHaveLength(2);
  });

  it("supports the enterprise-safe count-only presentation when selected", () => {
    const { coordinator, shownOptions } = createHarness({
      actionRequiredNotifications: true,
      newMailNotifications: true,
      notificationSound: false,
      notificationContentMode: "count-only",
    });

    coordinator.publish(liveMail("mail-private", "财务负责人", "薪酬调整名单"));

    expect(shownOptions[0]).toMatchObject({
      title: "收到 1 封新邮件",
      body: "打开 WeMail 查看邮件。",
    });
    expect(shownOptions[0]?.toastXml).not.toContain("财务负责人");
    expect(shownOptions[0]?.toastXml).not.toContain("薪酬调整名单");
  });

  it("reports an unsupported desktop notification host", () => {
    const outcomes: NotificationOutcome[] = [];
    const coordinator = new NotificationCoordinator({
      getPreferences: () => ({
        actionRequiredNotifications: true,
        newMailNotifications: true,
        notificationSound: false,
      }),
      ledger: { has: () => false, record: vi.fn() },
      show: () => ({ supported: false, shown: false }),
      onOutcome: (outcome) => outcomes.push(outcome),
    });

    coordinator.publish(liveMail("mail-1"));
    vi.advanceTimersByTime(2_000);

    expect(outcomes).toContainEqual({
      kind: "liveMail",
      reason: "unsupported",
      origin: "live-idle",
      count: 1,
    });
  });

  it("maps mail click and button indices to open or mark-read activations", () => {
    const { coordinator, shownHandlers, activations } = createHarness({
      actionRequiredNotifications: true,
      newMailNotifications: true,
      notificationSound: false,
    });
    coordinator.publish(liveMail("mail-1"));
    vi.advanceTimersByTime(2_000);

    shownHandlers[0]?.onClick?.();
    shownHandlers[0]?.onAction?.(0);
    shownHandlers[0]?.onAction?.(1);

    expect(activations).toEqual([
      {
        action: "open",
        target: {
          kind: "mail",
          accountId: "acct-1",
          messageId: "mail-1",
        },
      },
      {
        action: "markRead",
        target: {
          kind: "mail",
          accountId: "acct-1",
          messageId: "mail-1",
        },
      },
      {
        action: "open",
        target: {
          kind: "mail",
          accountId: "acct-1",
          messageId: "mail-1",
        },
      },
    ]);
  });
});
