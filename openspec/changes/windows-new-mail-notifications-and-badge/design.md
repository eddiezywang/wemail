## Context

The mail-change bridge already receives realtime `live-idle` and `live-poll`
events and forwards them to the notification coordinator. Runtime evidence shows
that new messages are being inserted and dispatched, while no desktop delivery
attempt is logged. The stored preference record still contains only the legacy
`desktopNotifications: false` field, which the current validator maps to
`newMailNotifications: false`; notification policy therefore rejects the event
before Electron invokes the Windows notification API.

The product requirement is different from mailbox unread state. The badge means
"messages received since the user last returned to WeMail", not "all messages
whose IMAP Seen flag is false". That state belongs to the long-lived Electron
main process because mail continues to arrive while the renderer window is
hidden.

## Goals

- Restore expected Windows notifications without overriding a user's explicit
  dedicated new-mail notification choice.
- Give users a visible count of realtime messages received while WeMail is in
  the background.
- Keep historical synchronization, backfill, manual refresh, and hydration
  silent and excluded from the count.
- Make notification suppression and delivery diagnosable from normal bounded
  logs.

## Non-Goals

- Replacing inbox unread counters or changing IMAP read flags.
- Persisting the attention count across a complete application exit.
- Showing synchronization progress.
- Adding macOS dock badges or Linux launcher badges in this change.
- Inferring Windows notification-center authorization through unsupported or
  unreliable APIs.

## Decision

### Main-process attention counter

Add a small `NewMailAttentionController` owned by `electron/main/app.ts`. It
accepts normalized mail-change events and window-attention events and owns one
integer count for the current process session.

For every mail-change event:

1. Ignore origins other than `live-idle` and `live-poll`.
2. Ignore empty insert sets.
3. If the main window is both visible and focused, leave the count at zero.
4. Otherwise add the number of unique inserted message IDs.
5. Refresh all registered badge projections.

The controller defensively deduplicates message IDs for the current unseen
session so reconnects or duplicate bridge delivery cannot inflate the badge.
The deduplication set is cleared with the count.

The count resets only after the window is visible and receives `focus`. A plain
`show` event without focus does not acknowledge messages. Restoring from the
taskbar, choosing `Show WeMail` in the tray, activating a notification, or
second-instance activation all converge on the existing show/focus path and
therefore clear the count once focus is actually observed.

The counter is session-local. A full process exit clears it because WeMail
cannot receive mail while stopped; persisted mailbox unread state remains the
source of truth after a restart.

### Badge projections

On Windows, the taskbar projection calls `BrowserWindow.setOverlayIcon`:

- count zero clears the overlay with `null`;
- counts 1 through 99 render their exact value;
- larger counts render `99+`;
- the accessible description uses Chinese text such as `3 封新邮件`.

The overlay image is generated locally as a deterministic 32-bit native bitmap
and converted with Electron `NativeImage.createFromBitmap`. It uses a
high-contrast dark circular badge with a small embedded bitmap font, white type,
and a transparent background, sized for Windows taskbar overlay rendering. The
projection rejects empty images instead of treating an accepted API call as a
visible badge. No remote image, SVG decoder, or renderer canvas is involved.

The tray module becomes an owned controller rather than a write-once singleton.
It retains the base WeMail icon and can replace it with a deterministic badged
variant. Its tooltip changes from `WeMail` to `WeMail · 3 封新邮件` while the
count is nonzero. On non-Windows platforms the taskbar overlay is omitted; tray
updates remain safe where supported.

Badge projection failures are best-effort and must never interrupt mail receipt
or desktop notification delivery.

### Windows notification identity

Development and packaged builds use the same stable `com.wemail.app`
AppUserModelID. The desktop shell reuses an existing packaged Start Menu
shortcut when it owns that identity; otherwise a development identity shortcut
is created without replacing the packaged shortcut. This keeps Electron's
notification submission identity aligned with the shortcut Windows uses to
authorize toast banners.

### Notification preference migration

Change the default `newMailNotifications` value to `true`.

Validation distinguishes three cases:

- dedicated `newMailNotifications` boolean exists: preserve it exactly;
- only legacy `desktopNotifications: true` exists: migrate to enabled;
- the dedicated field is absent, including legacy
  `desktopNotifications: false`: use the new enabled default.

This treats the previous quiet default as "not yet configured" while retaining
all choices made through the current dedicated switch. Saving preferences writes
the complete modern shape, so migration is naturally one-time.

The notification-sound default remains unchanged. The settings copy is updated
to explain that new-mail alerts are enabled initially and can be disabled.

### Notification and badge independence

The mail-change bridge fans a realtime event into two independent consumers:

- `NotificationCoordinator`, governed by `newMailNotifications` and Windows
  notification support;
- `NewMailAttentionController`, governed only by origin and foreground focus.

Turning off toast notifications does not turn off the badge. Marking a message
read outside WeMail also does not decrement the badge because it is an arrival
counter, not an unread counter.

### Diagnostics

The notification coordinator reports a bounded outcome for every candidate:

- `queued` for an eligible live event entering aggregation;
- `delivered` after Electron accepts the notification;
- `category-disabled` when the dedicated setting is off;
- `not-live` for a suppressed origin;
- `duplicate` for a ledger hit;
- `unsupported` or `show-failed` for the host delivery result.

Logs contain only event kind, origin, reason, count, support state, and bounded
identifier hashes where correlation is needed. They do not contain sender,
subject, body, attachment names, or credentials. Expected decisions are single
structured records and do not require debug mode.

## Alternatives Considered

### Use mailbox unread count

This survives restarts but includes older unseen messages and changes when read
flags synchronize from other clients. It does not represent "since last opened"
and is rejected.

### Maintain the counter in the renderer

This is easy to display but loses events during reloads and places background
desktop behavior in a process that may not be active. Rejected.

### Show only Windows notifications

This offers no persistent signal after a toast expires or when notifications
are disabled at the OS level. Rejected.

## Failure Handling

- Notification delivery failure does not prevent badge increments.
- Badge rendering failure does not prevent notification delivery.
- Missing or destroyed windows defer projection until a window exists.
- A recreated tray immediately receives the controller's current count.
- Focus during an aggregation window clears the badge but does not cancel an
  already eligible Windows notification; the established policy continues to
  notify even while focused.

## Testing

Focused unit tests cover:

- legacy preference records without `newMailNotifications` migrate to enabled;
- explicit dedicated false remains false;
- fresh defaults enable new-mail notifications while sound remains off;
- live background events increment and deduplicate the attention count;
- focused-window arrivals do not create a count;
- manual and non-live events are excluded;
- focus clears the count and both projections;
- taskbar labels cap at `99+` and clear at zero;
- tray tooltip/icon updates track the same count;
- notification outcomes distinguish policy suppression and delivery failure.

Integration tests prove one mail-change event can independently produce a badge
and a Windows notification, and that disabling toast delivery does not suppress
the badge.

## Rollout

1. Land the preference migration and diagnostics with focused tests.
2. Add the main-process controller and deterministic badge renderer.
3. Wire taskbar, tray, window-focus, and mail-change lifecycle events.
4. Run notification, mail-event, preference, tray, and main-process tests plus
   TypeScript typecheck and the production client build.
5. Rebuild and launch the Windows desktop app; accept with a real background
   mail arrival, taskbar/tray badge inspection, focus reset, and Windows toast
   activation.
