## 1. Characterization and Contracts

- [x] 1.1 Add failing composition and synchronization tests that demonstrate historical metadata can currently delay watcher startup or foreground reconciliation
- [x] 1.2 Add shared provider-role, refresh-intent, refresh-result, discovery-origin, and safe synchronization-health contracts
- [x] 1.3 Add route contract tests for an account-scoped refresh request that accepts no mode, day count, or deep flag and can report accepted versus joined work
- [x] 1.4 Preserve compatibility tests for internal callers of the existing `/api/mail/sync` route while removing that strategy selection from the workbench contract

## 2. ImapFlow Protocol Reuse

- [x] 2.1 Extend the minimal ImapFlow adapter types to expose UIDNEXT, optional HIGHESTMODSEQ, STATUS, and mailbox locking without adding a custom IMAP parser
- [x] 2.2 Add provider tests for mailbox status, automatic IDLE ownership, lock release, capability detection, and safe close/error propagation
- [ ] 2.3 Probe and document the production enterprise mail capabilities for IDLE, UIDNEXT, CONDSTORE, QRESYNC, and HIGHESTMODSEQ without recording credentials or mail content
- [ ] 2.4 Enable only the ImapFlow extensions proven reliable by the provider probe and retain the existing bounded fallback for unavailable extensions

## 3. Foreground and Background Provider Roles

- [x] 3.1 Refactor account mail composition to name and inject the existing providers as foreground realtime and background transfer roles
- [x] 3.2 Keep watcher, bounded recent sync, reconnect catch-up, health reconciliation, and manual refresh on the foreground provider
- [x] 3.3 Add a background metadata sync service that uses the existing background provider and the same repository/checkpoint contracts
- [x] 3.4 Coordinate background historical pages, body hydration, requested bodies, and attachments so interactive transfers run before the next background page without adding a third connection
- [x] 3.5 Add concurrency tests proving foreground IDLE reconciliation proceeds while background history is slow and both roles commit idempotent short SQLite transactions

## 4. Startup, Refresh, and Recovery Coordination

- [x] 4.1 Change startup tests and coordination so the foreground watcher starts immediately after the bounded recent cursor is committed
- [x] 4.2 Route historical metadata to the background provider after interactive readiness and keep foreground watching active when history pauses or fails
- [x] 4.3 Implement one coalesced foreground reconciliation operation shared by compatible IDLE, reconnect, startup-recent, and manual refresh requests
- [x] 4.4 Add the semantic refresh API/service method with accepted or joined run identity and bounded status that does not wait for historical repair
- [x] 4.5 Extend cursor health checks with UIDVALIDITY and UIDNEXT signals, safe diagnostics, and bounded background overlap confirmation
- [x] 4.6 Restore a usable recent cursor and re-arm foreground receipt before continuing any confirmed wider recovery window in background pages
- [x] 4.7 Add provider regression tests for empty UID ranges, UIDVALIDITY change, suspected UIDNEXT regression, confirmed gaps, and restart from recovery checkpoints

## 5. Discovery, Automation, and Notification Policy

- [x] 5.1 Introduce an idempotent first-discovery result that is independent from renderer, automation, intelligence, and desktop-notification policy
- [x] 5.2 Preserve live IDLE and reconnect renderer updates, automation eligibility, and bounded notification delivery
- [x] 5.3 Make manual discoveries refresh lists and remain automation-eligible while suppressing redundant desktop notifications
- [x] 5.4 Preserve bounded renderer delivery and notification/automation suppression for historical imports unless a rule opts into backfill
- [x] 5.5 Add regression tests proving each message is enqueued for eligible downstream work at most once across overlapping live, manual, and recovery runs

## 6. Workbench Manual Refresh

- [x] 6.1 Replace the split refresh/dropdown toolbar control with one accessible manual refresh action
- [x] 6.2 Call the semantic refresh method without exposing incremental, deep, or day-window parameters
- [x] 6.3 Drive the icon animation only from the user-requested refresh lifecycle, not React Query fetching or background work
- [x] 6.4 Replace inserted/updated implementation counters with silent success or a brief up-to-date result and retain clear network/credential failure handling
- [x] 6.5 Update renderer tests to cover one control, click coalescing, list/folder/category invalidation, non-technical copy, and credential recovery

## 7. Verification and Rollout

- [x] 7.1 Run focused provider, watcher, sync, route, composition, and renderer suites plus server/desktop typechecks
- [x] 7.2 Add a deterministic slow-history acceptance proving live and manual foreground reconciliation stay responsive during background pages
- [ ] 7.3 Run real enterprise acceptance for sub-10-second IDLE visibility, reconnect catch-up, manual refresh, password recovery, and background historical continuation
- [x] 7.4 Verify exactly two persistent account IMAP providers are used and record connection-limit evidence
- [ ] 7.5 Record whether the enterprise mail server reuses UIDs under unchanged UIDVALIDITY and create a separate local-generation change only if the evidence requires it
- [x] 7.6 Remove obsolete workbench synchronization strategy code after all acceptance gates pass and document the compatibility-route deprecation plan
