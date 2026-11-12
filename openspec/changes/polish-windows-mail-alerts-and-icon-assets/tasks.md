## 1. Approved icon source and generation

- [x] 1.1 Add the approved raised-apex WeMail source geometry with a boolean-unioned solid center and no overlapping-stroke seam.
- [x] 1.2 Add Micro, Compact, Toast, and Full optical masters with shared palette and documented pixel-grid adjustments.
- [x] 1.3 Extend the icon generator to emit tray 16/20 PNGs, Compact 24/32/40 assets, Toast 48/96/144/192 PNGs, and a multi-frame 16–256 ICO.
- [ ] 1.4 Add deterministic asset validation for dimensions, alpha, ICO frames, hashes, and forbidden light pixels in the center connection.
- [ ] 1.5 Wire generated assets into package metadata, Explorer/shortcut/installer, title/settings UI, tray, taskbar base, and Windows toast identity.

## 2. Windows toast presentation

- [x] 2.1 Change new-mail toast XML to subject-first title and sender supporting text using bounded escaped values.
- [x] 2.2 Remove generic Electron/provider attribution and dynamic sender-avatar presentation from new-mail toasts.
- [ ] 2.3 Add privacy-mode generic copy and guarantee activation arguments contain only opaque target IDs and actions.
- [ ] 2.4 Add `标为已读`, `打开邮件`, and body activation routing with safe degradation when an action is unsupported.
- [ ] 2.5 Add focused notification XML, activation, privacy, escaping, and fallback tests.

## 3. Notification latency

- [x] 3.1 Refactor live-mail aggregation so the first single-message event publishes immediately and only later burst arrivals are coalesced.
- [x] 3.2 Preserve unique-message attention counting and notification deduplication across immediate and burst paths.
- [x] 3.3 Add deterministic timing tests proving single-message submission is targeted within two seconds of discovery.

## 4. Non-IDLE adaptive receipt

- [x] 4.1 Add an explicit foreground receipt strategy selected from ImapFlow capability and health state.
- [x] 4.2 Implement a stable 15-second online polling interval for non-IDLE accounts without slowing down merely because the mailbox is quiet.
- [x] 4.3 Coalesce timer, manual refresh, reconnect, and foreground reconciliation so only one compatible account operation runs.
- [ ] 4.4 Add bounded failure backoff with jitter, lifecycle cleanup, and privacy-safe timing diagnostics.
- [x] 4.5 Add watcher tests for IDLE preference, non-IDLE intervals, backoff/reset transitions, overlap, failure, stop, and restart.

## 5. Verification and Windows acceptance

- [x] 5.1 Run focused Electron tests, server/desktop typechecks, client build, and icon generation checks.
- [ ] 5.2 Rebuild and launch the Windows desktop app and verify no white screen or generic Electron identity.
- [ ] 5.3 Inspect tray, title/settings, taskbar, Explorer/installer, Toast, and numeric badge at 100%, 125%, 150%, and 200% scaling.
- [ ] 5.4 Verify the approved W center contains no white V-shaped seam at every generated size.
- [ ] 5.5 Send real mail to an IDLE-capable account and record discovery-to-toast latency within the two-second application budget.
- [ ] 5.6 Send real mail to a non-IDLE account and verify discovery occurs within one active polling interval plus bounded reconciliation.
- [ ] 5.7 Verify taskbar/tray counts increment while unfocused and clear on focus independently from toast preference.
