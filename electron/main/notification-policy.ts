import type {
  NotificationDecision,
  NotificationEvent,
  NotificationPreferences,
} from "../../shared/wemail/notifications.js";

export function decideNotification(
  event: NotificationEvent,
  preferences: NotificationPreferences,
  context: {
    appFocused?: boolean;
    targetResolved?: boolean;
  } = {},
): NotificationDecision {
  if (context.targetResolved) {
    return { deliver: false, reason: "target-resolved" };
  }

  if (event.kind === "liveMail") {
    if (
      event.origin !== "live-idle" &&
      event.origin !== "live-poll"
    ) {
      return { deliver: false, reason: "not-live" };
    }
    if (!preferences.newMailNotifications) {
      return { deliver: false, reason: "category-disabled" };
    }
  } else if (!preferences.actionRequiredNotifications) {
    return { deliver: false, reason: "category-disabled" };
  }

  return {
    deliver: true,
    silent: !preferences.notificationSound,
  };
}
