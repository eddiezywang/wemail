## Why

Realtime mail receipt currently reaches the renderer, but Windows new-mail
notifications can remain silently disabled by a legacy preference whose default
was `false`. The desktop shell also has no durable foreground-attention model:
when WeMail is minimized or hidden, users cannot see how many messages arrived
since they last returned to the application.

## What Changes

- Make new-mail Windows notifications enabled by default for fresh installs and
  for legacy preference records that have never stored the dedicated
  `newMailNotifications` field.
- Preserve an explicit `newMailNotifications: false` choice.
- Add a main-process pending-new-mail counter that counts only realtime arrivals
  while the main window is not visible and focused.
- Render the count as a Windows taskbar overlay and as a badged tray icon,
  capped visually at `99+`.
- Clear the count whenever the main window becomes visible and focused,
  including activation from the tray or a Windows notification.
- Keep badge counting independent from the Windows notification preference.
- Record bounded notification-policy decisions so support can distinguish a
  disabled category, a non-live event, an unsupported host, and a successful
  delivery without enabling verbose debug logging.

## Impact

- Affected capabilities: new `desktop-new-mail-attention`; existing business
  preference migration and Windows desktop notification behavior.
- Primary paths: `electron/main/app.ts`, `electron/main/tray.ts`, notification
  coordination/policy modules, business preferences, and focused tests.
- No change to IMAP synchronization scheduling, historical import behavior,
  mailbox unread semantics, or renderer inbox badges.
