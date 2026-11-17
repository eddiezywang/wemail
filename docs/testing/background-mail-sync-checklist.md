# Background Mail Sync Checklist

Human regression checklist for the background mail sync flow added on
2026-06-13. Run this after any change touching:

- IMAP watch / polling fallback
- Electron tray or window-close behavior
- desktop notifications
- renderer cache invalidation for new mail

Preferred environment: Windows desktop build with a real IMAP account.

## Setup

- [ ] Start from a signed-out or clean profile and log in with a valid IMAP/SMTP account.
- [ ] Verify the inbox loads at least one existing message before background tests begin.
- [ ] Keep one second mailbox or external sender ready to send test mail into the target inbox.

## Close To Tray

- [ ] Click the window close button.
- [ ] Verify the main window disappears, but the app process stays alive.
- [ ] Verify the tray icon remains available.
- [ ] Open the tray menu and confirm `Show WeMail`, `Sync Now`, and `Quit` are present.
- [ ] Click `Show WeMail` and verify the existing window is restored instead of booting a second app instance.

## Push / Watch Path

- [ ] Hide WeMail to tray again.
- [ ] Send one new test email to the logged-in inbox.
- [ ] Verify a desktop notification appears without reopening the app.
- [ ] Reopen WeMail from the tray.
- [ ] Verify the new message is already present in the inbox without pressing Refresh.
- [ ] Open the new message and verify the summary pipeline still runs for that mail after background sync.

## Renderer Refresh

- [ ] Keep WeMail visible on the inbox screen.
- [ ] Send another new test email to the same inbox.
- [ ] Verify the inbox list updates automatically without pressing Refresh.
- [ ] Verify folder counts and inbox category badges update after the new mail arrives.

## Manual Refresh Still Works

- [ ] Click the Refresh button while the app is visible.
- [ ] Verify manual sync still completes successfully.
- [ ] Verify manual refresh does not duplicate the already synced background message in the list.

## Logout / Relogin Safety

- [ ] Log out, then log back into the same account.
- [ ] Send one more new test email.
- [ ] Verify only one desktop notification appears for that mail.
- [ ] Verify the mail appears once in the inbox list, with no duplicate rows caused by repeated listeners.

## Polling Fallback Drill

- [ ] Use a test account or environment where IMAP IDLE can be disabled, interrupted, or made unreliable.
- [ ] Start WeMail and hide it to tray.
- [ ] Force the push-watch path to fail.
- [ ] Send a new test email.
- [ ] Verify the message still arrives after fallback polling runs.
- [ ] Reopen WeMail and confirm the message is present without manual Refresh.

## Stop / Quit Safety

- [ ] With the app hidden to tray, choose `Quit` from the tray menu.
- [ ] Verify the app process exits cleanly.
- [ ] Relaunch the app.
- [ ] Verify the inbox still loads and background sync resumes after login or account restore.

## Failure Drills

- [ ] Disconnect the network while WeMail is hidden to tray.
- [ ] Verify WeMail does not crash.
- [ ] Restore the network.
- [ ] Verify background sync eventually recovers and new mail is received again.

## Verification Notes

- Automated coverage added in this change set:
  - `server/wemail/bootstrap/AppComposition.integration.test.ts`
  - `app/hooks/useDesktopMailEvents.test.tsx`
  - `server/api/routes/mailEventsRoutes.test.ts`
  - `app/hooks/useMailEvents.test.tsx`
- Recommended verification commands:
  - `node --import tsx --test server/api/routes/mailEventsRoutes.test.ts`
  - `npx vitest run app/hooks/useMailEvents.test.tsx`
  - `node --import tsx --test server/wemail/bootstrap/AppComposition.integration.test.ts`
  - `npx vitest run app/hooks/useDesktopMailEvents.test.tsx`
  - `npm run typecheck:desktop`
  - `npm run typecheck`

## Web Verification

- [ ] Open the web app on an inbox view with a logged-in account.
- [ ] Send a new test email to the active inbox.
- [ ] Verify the inbox list updates without clicking Refresh.
- [ ] Verify folder counts and category badges update after the same mail arrives.
- [ ] Switch the browser tab to the background, send another test email, then return to the tab.
- [ ] Verify the page catches up automatically after visibility restore.
- [ ] Simulate or force an SSE disconnect, wait one polling interval, and verify the inbox still refreshes without manual sync.
- [ ] Verify desktop still prefers IPC events and does not depend on the web SSE path.
