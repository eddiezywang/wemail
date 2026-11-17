## 1. Preference behavior

- [x] 1.1 Change fresh defaults so new-mail Windows notifications are enabled
  while notification sound remains disabled.
- [x] 1.2 Migrate legacy records without a dedicated
  `newMailNotifications` field to the new enabled default.
- [x] 1.3 Preserve an explicitly stored dedicated false value and update focused
  preference tests.
- [x] 1.4 Update notification settings copy without changing the existing
  user-controlled switch.

## 2. New-mail attention state

- [x] 2.1 Add a main-process attention controller that counts unique realtime
  inserted message IDs only while the window is not visible and focused.
- [x] 2.2 Clear the session counter and deduplication set when the visible main
  window receives focus.
- [x] 2.3 Keep attention counting independent from desktop-notification policy.
- [x] 2.4 Add unit tests for origin filtering, focus behavior, deduplication,
  accumulation, and reset.

## 3. Windows and tray projections

- [x] 3.1 Add deterministic local badge-image generation with exact `1–99` and
  capped `99+` labels.
- [x] 3.2 Project the count through the Windows taskbar overlay and clear it at
  zero.
- [x] 3.3 Refactor tray ownership so its icon and tooltip update with the same
  count while preserving show, sync, and quit actions.
- [x] 3.4 Add projection tests, including unsupported-platform and destroyed
  window safety.

## 4. Notification diagnostics

- [x] 4.1 Return or report bounded coordinator outcomes for duplicate,
  non-live, disabled, queued, delivered, unsupported, and failed cases.
- [x] 4.2 Log those outcomes without sender, subject, body, attachment, or
  credential data.
- [x] 4.3 Add focused tests proving policy suppression can be diagnosed without
  enabling debug mode.

## 5. Integration and verification

- [x] 5.1 Wire mail-change events, main-window focus, tray activation, taskbar
  projection, and notification activation through the desktop composition.
- [x] 5.2 Verify disabled Windows toasts still produce a background-mail badge.
- [x] 5.3 Run focused Vitest and Node tests, full TypeScript typecheck, and the
  production client build.
- [ ] 5.4 Rebuild and launch WeMail, then verify a real background arrival shows
  a Windows toast and matching taskbar/tray count that clears on focus.
