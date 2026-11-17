import type {
  ActionRequiredNotificationEvent,
  LiveMailNotificationEvent,
  NotificationEvent,
  NotificationContentMode,
  NotificationPreferences,
  NotificationTarget,
} from "../../shared/wemail/notifications.js";
import {
  LiveMailAggregator,
  type AggregatedLiveMail,
} from "./live-mail-aggregator.js";
import { decideNotification } from "./notification-policy.js";
import {
  encodeNotificationActivation,
  type NotificationActivation,
} from "./notification-activation.js";
import {
  buildWindowsToastXml,
  type DesktopNotificationActivationHandlers,
  type DesktopNotificationOptions,
  type DesktopNotificationResult,
} from "./notifications.js";

interface DeliveryLedger {
  has(key: string): boolean;
  record(key: string): void;
}

export type NotificationOutcomeReason =
  | "queued"
  | "delivered"
  | "category-disabled"
  | "not-live"
  | "target-resolved"
  | "duplicate"
  | "unsupported"
  | "show-failed";

export interface NotificationOutcome {
  kind: NotificationEvent["kind"];
  reason: NotificationOutcomeReason;
  origin?: LiveMailNotificationEvent["origin"];
  count: number;
}

export class NotificationCoordinator {
  private readonly getPreferences: () => NotificationPreferences;
  private readonly iconPath?: string;
  private readonly ledger: DeliveryLedger;
  private readonly show: (
    options: DesktopNotificationOptions,
    handlers?: DesktopNotificationActivationHandlers,
  ) => DesktopNotificationResult;
  private readonly onActivate: (activation: NotificationActivation) => void;
  private readonly isTargetResolved: (
    event: ActionRequiredNotificationEvent,
  ) => boolean;
  private readonly onOutcome: (outcome: NotificationOutcome) => void;
  private readonly liveMail: LiveMailAggregator;
  private readonly actionAggregationWindowMs: number;
  private readonly pendingActions = new Map<string, ActionRequiredNotificationEvent[]>();
  private readonly actionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: {
    getPreferences: () => NotificationPreferences;
    iconPath?: string;
    ledger: DeliveryLedger;
    show: (
      options: DesktopNotificationOptions,
      handlers?: DesktopNotificationActivationHandlers,
    ) => DesktopNotificationResult;
    onActivate?: (activation: NotificationActivation) => void;
    isTargetResolved?: (
      event: ActionRequiredNotificationEvent,
    ) => boolean;
    onOutcome?: (outcome: NotificationOutcome) => void;
    aggregationWindowMs?: number;
    actionAggregationWindowMs?: number;
  }) {
    this.getPreferences = options.getPreferences;
    this.iconPath = options.iconPath;
    this.ledger = options.ledger;
    this.show = options.show;
    this.onActivate = options.onActivate ?? (() => {});
    this.isTargetResolved = options.isTargetResolved ?? (() => false);
    this.onOutcome = options.onOutcome ?? (() => {});
    this.liveMail = new LiveMailAggregator({
      windowMs: options.aggregationWindowMs,
      onFlush: (batch) => this.deliverLiveMail(batch),
    });
    this.actionAggregationWindowMs = Math.max(0, options.actionAggregationWindowMs ?? 1_200);
  }

  publish(event: NotificationEvent): void {
    if (event.kind === "liveMail") {
      const key = mailDeliveryKey(event);
      if (this.ledger.has(key)) {
        this.report(event, "duplicate");
        return;
      }
      const decision = decideNotification(event, this.getPreferences());
      if (!decision.deliver) {
        this.report(event, decision.reason);
        return;
      }
      this.report(event, "queued");
      this.liveMail.push(event);
      return;
    }

    const key = actionDeliveryKey(event);
    if (this.ledger.has(key)) {
      this.report(event, "duplicate");
      return;
    }
    const decision = decideNotification(event, this.getPreferences(), {
      targetResolved: this.isTargetResolved(event),
    });
    if (!decision.deliver) {
      this.report(event, decision.reason);
      return;
    }

    if (this.actionAggregationWindowMs === 0) {
      this.deliverActions([event]);
      return;
    }
    const groupKey = `${event.accountId}:${event.reason}`;
    const pending = this.pendingActions.get(groupKey) ?? [];
    if (pending.some((candidate) => actionDeliveryKey(candidate) === key)) {
      this.report(event, "duplicate");
      return;
    }
    pending.push(event);
    this.pendingActions.set(groupKey, pending);
    this.report(event, "queued");
    if (!this.actionTimers.has(groupKey)) {
      this.actionTimers.set(groupKey, setTimeout(() => {
        this.actionTimers.delete(groupKey);
        const batch = this.pendingActions.get(groupKey) ?? [];
        this.pendingActions.delete(groupKey);
        this.deliverActions(batch);
      }, this.actionAggregationWindowMs));
    }
  }

  dispose(): void {
    this.liveMail.dispose();
    for (const timer of this.actionTimers.values()) clearTimeout(timer);
    this.actionTimers.clear();
    this.pendingActions.clear();
  }

  private deliverActions(batch: ActionRequiredNotificationEvent[]): void {
    const events = batch.filter((event) => {
      if (this.ledger.has(actionDeliveryKey(event))) {
        this.report(event, "duplicate");
        return false;
      }
      const decision = decideNotification(event, this.getPreferences(), {
        targetResolved: this.isTargetResolved(event),
      });
      if (!decision.deliver) {
        this.report(event, decision.reason);
        return false;
      }
      return true;
    });
    if (events.length === 0) return;
    const first = events[0]!;
    const single = events.length === 1;
    const contentMode = resolveContentMode(this.getPreferences());
    const actionPresentation = buildActionPresentation(events, contentMode);
    const { title, detail } = actionPresentation;
    const launch = encodeNotificationActivation("open", first.target);
    const decision = decideNotification(first, this.getPreferences());
    if (!decision.deliver) return;
    const toastIconPath = resolveToastIconPath(this.iconPath);
    const actions = [{
      label: events.some((event) => event.reason === "agent-confirmation")
        ? "查看并确认"
        : "查看",
      arguments: launch,
    }];
    let result: DesktopNotificationResult;
    try {
      result = this.show({
        title,
        body: detail,
        ...(toastIconPath ? { icon: toastIconPath } : {}),
        silent: decision.silent,
        urgency: "normal",
        timeoutType: "default",
        avatarText: events.some((event) => event.reason === "agent-confirmation") ? "\u2713" : "!",
        accent: "amber",
        actionButtons: actions,
        toastXml: buildWindowsToastXml({
          title,
          lines: [detail],
          icon: toastIconPath,
          launch,
          actions,
          silent: decision.silent,
        }),
      }, {
        onClick: () => this.onActivate({ action: "open", target: first.target }),
        onAction: (index) => {
          if (index === 0) this.onActivate({ action: "open", target: first.target });
        },
      });
    } catch {
      this.report(first, "show-failed", events.length);
      return;
    }
    if (!result.supported) {
      this.report(first, "unsupported", events.length);
      return;
    }
    if (!result.shown) {
      this.report(first, "show-failed", events.length);
      return;
    }
    for (const event of events) this.ledger.record(actionDeliveryKey(event));
    this.report(first, "delivered", events.length);
  }

  private deliverLiveMail(batch: AggregatedLiveMail): void {
    const preferences = this.getPreferences();
    const messages = batch.messages.filter((event) => {
      if (this.ledger.has(mailDeliveryKey(event))) {
        this.report(event, "duplicate");
        return false;
      }
      const decision = decideNotification(event, preferences);
      if (!decision.deliver) {
        this.report(event, decision.reason);
        return false;
      }
      return true;
    });
    if (messages.length === 0) return;

    const first = messages[0]!;
    const single = messages.length === 1;
    const contentMode = resolveContentMode(preferences);
    const { title, lines } = buildLiveMailPresentation(messages, contentMode);
    const launch = encodeNotificationActivation("open", first.target);
    const actions = single
      ? [
          {
            label: "标为已读",
            arguments: encodeNotificationActivation("markRead", first.target),
          },
          { label: "打开邮件", arguments: launch },
        ]
      : [{ label: "查看邮件", arguments: launch }];
    const decision = decideNotification(first, preferences);
    if (!decision.deliver) return;
    const toastIconPath = resolveToastIconPath(this.iconPath);
    const mailAvatarText = single
      ? initialOf(cleanSender(first.sender))
      : String(messages.length);

    let result: DesktopNotificationResult;
    try {
      result = this.show({
        title,
        body: lines.join("\n"),
        ...(toastIconPath ? { icon: toastIconPath } : {}),
        silent: decision.silent,
        urgency: "normal",
        timeoutType: "default",
        avatarText: mailAvatarText,
        accent: "brand",
        actionButtons: actions,
        toastXml: buildWindowsToastXml({
          title,
          lines,
          icon: toastIconPath,
          launch,
          actions,
          silent: decision.silent,
        }),
      }, {
        onClick: () =>
          this.onActivate({ action: "open", target: first.target }),
        onAction: (index) => {
          if (single && index === 0) {
            this.onActivate({ action: "markRead", target: first.target });
            return;
          }
          if ((single && index === 1) || (!single && index === 0)) {
            this.onActivate({ action: "open", target: first.target });
          }
        },
      });
    } catch {
      this.report(first, "show-failed", messages.length);
      return;
    }
    if (!result.supported) {
      this.report(first, "unsupported", messages.length);
      return;
    }
    if (!result.shown) {
      this.report(first, "show-failed", messages.length);
      return;
    }
    for (const event of messages) {
      this.ledger.record(mailDeliveryKey(event));
    }
    this.report(first, "delivered", messages.length);
  }

  private report(
    event: NotificationEvent,
    reason: NotificationOutcomeReason,
    count = 1,
  ): void {
    this.onOutcome({
      kind: event.kind,
      reason,
      ...(event.kind === "liveMail" ? { origin: event.origin } : {}),
      count,
    });
  }
}

function mailDeliveryKey(event: LiveMailNotificationEvent): string {
  return `mail:${event.accountId}:${event.messageId}`;
}

function actionDeliveryKey(event: ActionRequiredNotificationEvent): string {
  return `action:${event.accountId}:${event.id}`;
}

function cleanSender(sender: string): string {
  return sender.trim() || "未知发件人";
}

function initialOf(sender: string): string {
  // ponytail: first meaningful glyph; covers CJK / latin. Good enough for an avatar badge.
  const match = sender.match(/[\p{L}\p{N}]/u);
  return match ? match[0]!.toUpperCase() : "W";
}

function cleanSubject(subject: string): string {
  const normalized = subject.trim() || "（无主题）";
  return normalized.length > 120
    ? `${normalized.slice(0, 117)}...`
    : normalized;
}

function resolveContentMode(
  preferences: NotificationPreferences,
): NotificationContentMode {
  return preferences.notificationContentMode ?? "full";
}

function buildActionPresentation(
  events: ActionRequiredNotificationEvent[],
  contentMode: NotificationContentMode,
): { title: string; detail: string } {
  if (contentMode === "full") {
    if (events.length === 1) {
      const first = events[0]!;
      return { title: first.title, detail: first.detail };
    }
    return {
      title: `${events.length} 项 Agent 任务需要处理`,
      detail: "返回 WeMail 查看任务状态和后续操作。",
    };
  }
  return {
    title: `${events.length} 项事项需要处理`,
    detail: "打开 WeMail 查看详情并继续处理。",
  };
}

function buildLiveMailPresentation(
  messages: LiveMailNotificationEvent[],
  contentMode: NotificationContentMode,
): { title: string; lines: string[] } {
  const first = messages[0]!;
  const countTitle = `收到 ${messages.length} 封新邮件`;
  if (contentMode === "count-only") {
    return {
      title: countTitle,
      lines: ["打开 WeMail 查看邮件。"],
    };
  }
  if (contentMode === "sender-only") {
    return {
      title: countTitle,
      lines: messages
        .slice(0, 2)
        .map((event) => `来自 ${cleanSender(event.sender)}`),
    };
  }
  if (messages.length === 1) {
    return {
      title: cleanSubject(first.subject),
      lines: [`来自 ${cleanSender(first.sender)}`],
    };
  }
  return {
    title: countTitle,
    lines: messages
      .slice(0, 2)
      .map((event) => `${cleanSender(event.sender)} · ${cleanSubject(event.subject)}`),
  };
}

function resolveToastIconPath(iconPath: string | undefined): string | undefined {
  return iconPath?.replace(/wemail\.ico$/i, "wemail-toast-48.png");
}
