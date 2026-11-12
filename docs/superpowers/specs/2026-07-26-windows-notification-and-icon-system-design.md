# WeMail Windows Notification and Icon System Design

**Date:** 2026-07-26
**Status:** Approved design
**Scope:** Windows desktop icon refinement, notification policy, native Toast presentation, routing, aggregation, activation, privacy, and verification

## Problem

WeMail currently has three notification-like surfaces without one shared interruption policy:

- Electron emits a Windows notification directly for each live mail event.
- The renderer emits an additional Sonner toast for the same event.
- Automation and Agent outputs can persist in the application message center and may optionally request desktop delivery.

This creates duplicate alerts, leaves existing notification preferences partially disconnected, and does not clearly distinguish persistent information from events that deserve to interrupt the user. Initial mailbox synchronization also needs a session-level aggregation rule so historical mail cannot produce a burst of individual notifications.

The desktop icon has the right underlying concept but needs a more deliberate brand treatment. Its orange negative-space seam already suggests a `W`; the refinement must strengthen that reading without adding a separate letter or replacing the envelope construction.

## Design Summary

WeMail will use one notification coordinator with two independent delivery policies:

1. **Action required:** enabled by default. It covers states that explicitly wait for user intervention.
2. **New mail:** disabled by default. When enabled, every genuinely live new message is eligible for Windows delivery without importance, VIP, category, or AI filtering.

Eligible events use Windows native Toast notifications even while WeMail is focused. New mail does not also produce an in-app Sonner toast. Business state is always persisted in its owning surface before desktop delivery; a Windows notification is a projection, never the source of truth.

Initial and historical synchronization is not new-mail delivery. It is represented by one in-app synchronization session with one progress state and one final summary.

## Icon Direction

The approved direction preserves the existing icon construction:

- rounded-square orange application tile;
- four existing warm-white envelope regions;
- an orange negative-space seam between those regions;
- a lower upward-pointing triangle that completes the sealed-envelope reading.

No separate `W`, watermark, overlay, additional line, or replacement envelope body will be added.

The negative-space hierarchy will be refined as follows:

- the upper seam that reads as `W` becomes approximately 20–25% wider;
- the two seams bordering the lower triangle become approximately 25–30% narrower;
- the `W` remains symmetrical, with balanced valleys, a centered inner peak, and consistent optical weight;
- the icon remains legible at 16, 20, 24, 32, 48, and 256 pixels.

The approved color direction is classic saddle orange:

- base near `#D65A24`;
- restrained highlight near `#DD682D`;
- restrained shadow near `#C94D20`;
- warm ivory envelope near `#FFF9F0`.

The production asset should use a low-contrast tonal shift rather than a glossy gradient. Dedicated small-size notification artwork should be generated from the same master geometry instead of relying on arbitrary `.ico` downscaling.

## Notification Ownership

### Mail

The mailbox remains the source of truth for mail. A new message updates the inbox, folder counts, and unread state. It is not copied into the application message center.

### Agent, automation, and system state

Agent confirmations, automation results, account problems, and other WeMail-generated information remain in their owning persistent surface:

- Agent confirmations remain in the Agent conversation and pending-action state.
- Automation results may persist in the application message center.
- Send failures remain associated with the affected draft or outbox operation.
- Account authentication problems remain associated with the affected account.

Desktop notification failure must never remove or roll back this state.

## Eligibility Policy

| Event | Persistent surface | Windows delivery |
|---|---|---|
| Agent waiting for confirmation | Agent conversation / pending action | Yes, by default |
| Mail send failure requiring intervention | Draft/outbox state | Yes, by default |
| Mail account authentication invalid | Account recovery state | Yes, by default |
| Automation failure requiring intervention | Application message / run history | Yes, by default |
| Automation success | Application message or run history | No |
| Digest or analysis with no requested action | Application message center | No |
| Live new mail | Inbox | Only when new-mail notifications are enabled |
| Initial or historical synchronization | In-app synchronization session | No |
| Manual refresh or background refresh completion | Existing UI state | No |
| Application startup completion | None | No |

Window focus does not suppress an otherwise eligible Windows notification.

## New-Mail Policy

The new-mail notification preference defaults to off.

When disabled:

- mail updates the inbox and unread counts;
- no Windows notification is emitted;
- no application message is created.

When enabled:

- every message originating from a genuine live IDLE or live-poll event is eligible;
- importance, VIP status, category, smart tag, and AI classification are ignored;
- foreground and background behavior are identical;
- sender and subject are shown;
- body preview is never shown;
- a stable `accountId + messageId` key prevents duplicate delivery.

## Action-Required Policy

Action-required delivery defaults to on.

Eligible cases include:

- Agent confirmation is waiting;
- a send operation failed and the user must retry, edit, or discard;
- mailbox credentials are invalid;
- an automation run failed and cannot continue without user intervention;
- another durable workflow explicitly enters a waiting-for-user state.

Ineligible cases include:

- Agent thinking, tool execution, or ordinary completion;
- successful synchronization;
- successful automation;
- passive digest or analysis completion;
- technical background refresh events.

Action-required notifications expose only a safe summary. Risky mutations cannot be approved from the Windows notification. The notification provides a review action that opens the exact in-app confirmation surface.

## Initial and Historical Synchronization

Initial synchronization, historical backfill, folder rebuilding, and manual full synchronization are modeled as synchronization sessions rather than mail-notification bursts.

Each session has a stable `syncSessionId` and one in-app progress representation:

```text
Starting -> Fetching history -> Applying mailbox state -> Complete
```

Rules:

- historical messages do not enter the live notification aggregator;
- progress updates mutate one existing in-app state;
- completion produces one in-app summary such as “1,280 messages synchronized, 36 unread”;
- the summary is not sent to Windows;
- restart and reconnect resume the same logical session without duplicate summaries;
- a live-delivery watermark distinguishes genuinely new mail arriving while history is still being synchronized;
- mail beyond that watermark follows the ordinary new-mail setting.

## Burst Aggregation

Live mail uses an approximately two-second per-account aggregation window.

- One message produces one sender-and-subject notification.
- Multiple messages produce one aggregate notification with total count and up to two sender-and-subject rows.
- Additional messages update the existing Windows `Tag` and `Group` instead of producing an unbounded stack.
- Different accounts are grouped independently.
- Action-required events are never merged into mail aggregates.
- Repeated updates for the same action-required event replace the existing notification.
- Resolving an action may remove its notification from Notification Center.

The aggregation window is an implementation constant in the first release, not a user-facing preference.

## Native Windows Presentation

WeMail will use Electron custom `toastXml`.

Windows continues to own the outer container, corner radius, background material, animation, Notification Center, accessibility behavior, and Focus Assist integration. WeMail owns only supported Toast content, images, grouping, actions, and activation arguments.

### Single mail

```text
WeMail                                      now
Lin Chen
About next week's product review agenda

[Mark as read]                    [Open mail]
```

### Action required

```text
WeMail · Action required                    now
Agent is waiting for your confirmation
Create a rule: summarize the past 24 hours at 10:00 each day

[Review and confirm]
```

### Mail aggregate

```text
WeMail                                      now
6 new messages
Lin Chen · About next week's product review...
Finance · June invoice status updated...

[Open inbox]
```

The classic saddle-orange WeMail icon appears once in the attribution area. Large decorative branding, body previews, remote images, and arbitrary content are excluded.

## Settings

The Notifications settings surface contains:

- **Action-required reminders** — default on.
- **New-mail notifications** — default off.
- **Notification sound** — default off; when enabled, use the Windows default notification sound.
- **Open Windows notification settings** — opens the OS surface for permissions, sound, Notification Center, and Focus Assist.

Sender and subject are the fixed mail privacy policy for this release. There is no body-preview option.

Existing preference migration is deterministic:

- the current `desktopNotifications` value becomes the initial `newMailNotifications` value;
- the new `actionRequiredNotifications` value defaults to `true`;
- the current `notificationSound` value is preserved;
- migration does not emit a notification or alter Windows-level settings.

The first release does not expose:

- importance or VIP filters;
- AI-based notification eligibility;
- a configurable aggregation delay;
- separate foreground behavior;
- custom quiet hours that duplicate Windows Focus Assist.

## Architecture

### Notification event contract

```ts
type NotificationEvent =
  | {
      kind: "newMail";
      accountId: string;
      messageId: string;
      sender: string;
      subject: string;
      origin: "live-idle" | "live-poll";
    }
  | {
      kind: "actionRequired";
      id: string;
      source: "agent" | "mail" | "automation" | "account";
      title: string;
      safeSummary: string;
      target: NotificationTarget;
    };
```

Producers report facts. They do not construct Toast XML or call Electron `Notification` directly.

### Components

`NotificationCoordinator`

- receives typed notification events;
- evaluates settings and source eligibility;
- sends eligible events through aggregation, rendering, and delivery;
- records delivery outcomes without changing source business state.

`NotificationPolicy`

- applies action-required and new-mail preferences;
- rejects historical and synthetic mail events;
- applies privacy-safe field limits;
- does not use focus, importance, VIP, or AI classification.

`NotificationAggregator`

- batches live mail by account;
- updates Windows tags and groups;
- keeps action-required events independent;
- emits deterministic delivery keys.

`WindowsToastRenderer`

- escapes XML;
- truncates sender, subject, titles, and summaries;
- renders single-mail, aggregate-mail, and action-required templates;
- applies image, sound, tag, group, and activation arguments;
- falls back to a basic title/body notification if custom XML construction fails.

`NotificationActivationRouter`

- restores and focuses the main window;
- selects the owning account;
- routes to mail, inbox, Agent confirmation, account recovery, automation rule, or run history;
- handles actions whose target has already been resolved or removed.

`NotificationDeliveryLedger`

- retains bounded stable delivery keys long enough to survive reconnects and application restarts;
- prevents repeat delivery;
- expires old keys independently of mail retention;
- records failure diagnostics without storing message bodies.

## Activation Rules

- Clicking a mail notification opens the exact account and message.
- `Mark as read` performs only that low-risk mailbox mutation and updates the Toast.
- Clicking an aggregate opens the owning account inbox.
- `Review and confirm` opens the exact Agent conversation and pending confirmation card.
- Authentication alerts open account recovery.
- Automation alerts open the relevant rule or run.
- If the target is resolved or unavailable, WeMail opens the nearest safe owning surface and explains the state.

Sending, deleting, uploading, approving an Agent mutation, or executing another risky operation is not available as a direct Windows action.

## Privacy and Security

- Mail notifications contain sender and subject only.
- Application-message and action-required notifications contain allowlisted safe summaries.
- No mail body, attachment name, arbitrary command, sensitive path, credential detail, or model-generated raw markup is emitted.
- All text is XML-escaped and length-limited before rendering.
- Image sources are trusted local application assets.
- Activation arguments use typed identifiers rather than executable command strings.
- Cross-account activation revalidates account ownership before displaying content.

## Failure and Degraded Behavior

- OS notification permission disabled: source state remains available; WeMail does not repeatedly nag.
- Custom Toast rendering fails: emit a minimal safe native notification when possible.
- Icon loading fails: use the registered application attribution icon.
- Delivery fails: record diagnostics and telemetry; do not roll back source state.
- Deep-link target is missing: open the owning surface and show that the target is unavailable.
- Action is already resolved: open it in resolved state rather than recreating it.
- Focus Assist suppresses presentation: defer to Windows and retain the notification in the OS-managed flow.

## Existing-Code Impact

- Replace direct desktop delivery in `electron/main/mail-events.ts` with typed event publication.
- Remove the duplicate Sonner new-mail toast from `app/hooks/useMailEvents.ts`.
- Remove the startup “Desktop shell is ready” notification.
- Migrate `desktopNotifications` to `newMailNotifications`, add `actionRequiredNotifications` defaulting to on, preserve `notificationSound`, and connect all three to the coordinator.
- Keep ordinary mail out of the application message center.
- Extend application-message desktop projection to use the same coordinator and renderer.
- Register centralized notification activation handling during Electron startup.

## Verification

Automated coverage must include:

- default settings;
- foreground and background delivery;
- all live mail eligible when enabled;
- no importance filtering;
- single-message and burst aggregation;
- independent account groups;
- persistent deduplication across reconnect and restart;
- historical synchronization suppression;
- live mail arrival during historical synchronization;
- one in-app synchronization summary;
- action-required creation, replacement, resolution, and activation;
- sender/subject privacy;
- XML escaping and truncation;
- disabled OS permission;
- custom XML fallback;
- missing and cross-account targets.

Manual Windows acceptance must cover:

- Windows 11 light and dark themes;
- 100%, 125%, 150%, and 200% scaling;
- visible Toast and Notification Center history;
- Focus Assist;
- sound on and off;
- taskbar and attribution icon rendering at small sizes;
- single mail, aggregate mail, Agent confirmation, authentication failure, and resolved-action activation.

## Non-Goals

- Custom-drawn replacement windows for native Toasts.
- Body previews in Windows notifications.
- AI, importance, VIP, sender, folder, or category eligibility filters.
- Copying ordinary mail into the application message center.
- Approving risky actions directly from a Windows notification.
- Reimplementing Windows Focus Assist or Notification Center.
