# Windows Notification System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a quiet-by-default Windows notification system for WeMail, with separately controlled action-required and live-mail notifications, native Windows Toast XML, safe deep links, live-mail aggregation, historical-sync suppression, and the approved saddle-orange envelope/W icon.

**Architecture:** Electron main owns a single `NotificationCoordinator`. Producers publish typed facts; policy reads durable business preferences; live mail is buffered per account for two seconds; the coordinator renders privacy-safe Windows Toast XML and records bounded delivery keys. Renderer code receives only typed activation routes and keeps historical sync as one in-app progress/summary experience. The server remains the source of durable preferences and mail sync origin semantics.

**Tech Stack:** TypeScript, React 19, Electron 41, Vitest, React Testing Library, Node test, SQLite, SVG/PNG/ICO assets.

## Global Constraints

- Preserve the current white sealed-envelope geometry. The negative-space upper seam is the W; do not draw an additional W glyph.
- Use classic saddle orange (`#D65A24`) with restrained highlight/shadow and warm ivory (`#FFF9F0`).
- Windows notification content is sender + subject for mail; never include body preview, provider errors, credentials, or risky action parameters.
- `actionRequiredNotifications` defaults to `true`; `newMailNotifications` defaults to `false`.
- When live-mail notifications are enabled, do not filter by importance, VIP, AI score, category, or app focus.
- Historical/startup/backfill mail must never create per-message Windows notifications.
- Toast buttons may navigate or mark mail read, but must never approve/send/delete/install directly.
- Keep checked-in source TypeScript authoritative. Do not hand-edit generated build output.

---

## Task 1: Split and migrate notification preferences

**Files:**

- Modify: `server/wemail/settings/BusinessPreferenceService.ts`
- Test: `server/wemail/settings/BusinessPreferenceService.test.ts`
- Modify: `app/hooks/useUserPreferences.ts`
- Test: `app/hooks/useUserPreferences.test.ts`

- [x] Write server tests proving defaults are action-required ON, new-mail OFF, sound OFF.
- [x] Write a migration test proving legacy `desktopNotifications: true` becomes `newMailNotifications: true` without changing action-required’s default.
- [x] Run the focused server test and confirm it fails:

  `node --import tsx --test server/wemail/settings/BusinessPreferenceService.test.ts`

- [x] Replace the public `desktopNotifications` preference with:

  ```ts
  actionRequiredNotifications: boolean;
  newMailNotifications: boolean;
  notificationSound: boolean;
  ```

- [x] Make `validateBusinessPreferences` accept the legacy field only as a read-time fallback:

  ```ts
  newMailNotifications: bool(
    "newMailNotifications",
    bool("desktopNotifications", false),
  )
  ```

- [x] Add renderer-store tests for localStorage migration and API hydration.
- [x] Update `BUSINESS_KEYS`, defaults, serialization, and reset behavior.
- [x] Run focused preference tests and confirm they pass.
- [x] Commit:

  `git commit -am "feat: split Windows notification preferences"`

## Task 2: Add the dedicated notification settings surface

**Files:**

- Modify: `app/hooks/useUIStore.ts`
- Modify: `app/components/settings/SettingsDialog.tsx`
- Modify: `app/components/settings/settingsNavigation.ts`
- Add: `app/components/settings/sections/NotificationsSection.tsx`
- Test: `app/components/settings/SettingsDialog.test.tsx`
- Modify: `app/services/api.ts`
- Modify: `electron/preload/index.ts`
- Modify: `electron/main/ipc.ts`

- [x] Add failing UI tests for a primary “通知” section with:

  - “需要处理的事项” enabled by default.
  - “新邮件” disabled by default.
  - “通知声音” independent from category switches.
  - Copy explaining sender + subject privacy.
  - A button that opens Windows notification settings through the desktop bridge.

- [x] Add `"notifications"` to `SettingsSection`, make legacy `notifications` resolve there, and add a bell navigation item.
- [x] Implement `NotificationsSection` using the existing settings row/switch visual language.
- [x] Add `openWindowsNotificationSettings()` to the preload contract and `app/services/api.ts` window typing.
- [x] Add an IPC handler that opens `ms-settings:notifications` only on Windows and returns a typed supported/unsupported result.
- [x] Run:

  `npx vitest run app/components/settings/SettingsDialog.test.tsx electron/main/ipc.test.ts`

- [x] Commit:

  `git commit -am "feat: add notification settings"`

## Task 3: Define notification contracts, policy, and privacy-safe Toast XML

**Files:**

- Add: `shared/wemail/notifications.ts`
- Add: `electron/main/notification-policy.ts`
- Add: `electron/main/notification-policy.test.ts`
- Modify: `electron/main/notifications.ts`
- Modify: `electron/main/notifications.test.ts`

- [x] Add typed producer facts:

  ```ts
  type NotificationEvent =
    | { kind: "liveMail"; accountId: string; messageId: string; sender: string; subject: string; origin: "live-idle" | "live-poll" }
    | { kind: "actionRequired"; id: string; reason: "agent-confirmation" | "mail-auth" | "send-failure" | "automation-failure"; title: string; detail: string; target: NotificationTarget };
  ```

- [x] Add typed targets for `mail`, `pendingAction`, `accountSettings`, and `applicationMessage`.
- [x] Write policy tests for disabled categories, all-mail behavior, focus independence, sound, historical-origin rejection, and resolved-target suppression.
- [x] Implement a pure `decideNotification` function; producers must not inspect preferences.
- [x] Write XML tests that cover escaping `& < > " '`, sender/subject-only mail content, saddle-orange icon attribution, silent audio, and safe action arguments.
- [x] Replace the title/body wrapper with a native options renderer using Electron’s `toastXml`, `urgency`, `timeoutType`, and sound controls. Electron 41 does not expose Windows tag/group fields, so stable grouping is owned by the coordinator and aggregator.
- [x] Keep a simple fallback title/body path for non-Windows or unsupported custom Toast XML.
- [x] Run:

  `npx vitest run electron/main/notification-policy.test.ts electron/main/notifications.test.ts`

- [x] Commit:

  `git add shared/wemail/notifications.ts electron/main && git commit -m "feat: add notification policy and Windows Toast renderer"`

## Task 4: Add per-account aggregation and bounded delivery ledger

**Files:**

- Add: `electron/main/live-mail-aggregator.ts`
- Add: `electron/main/live-mail-aggregator.test.ts`
- Add: `electron/main/notification-ledger.ts`
- Add: `electron/main/notification-ledger.test.ts`

- [x] Use fake timers to specify a two-second, per-account aggregation window.
- [x] Test one message => sender + subject.
- [x] Test multiple messages => count plus first two sender/subject previews.
- [x] Test separate accounts never coalesce and a later burst reuses the same stable group key.
- [x] Implement an account-scoped aggregator with `flush(accountId)` and `dispose()`.
- [x] Specify a bounded ledger keyed by stable event identity, with TTL and maximum-entry pruning.
- [x] Store the ledger as an atomic JSON file under Electron `userData`; corrupt/missing files must fail open without blocking notifications.
- [x] Test dedupe, expiry, pruning, and corrupt-file recovery.
- [x] Run:

  `npx vitest run electron/main/live-mail-aggregator.test.ts electron/main/notification-ledger.test.ts`

- [x] Commit:

  `git add electron/main/live-mail-aggregator* electron/main/notification-ledger* && git commit -m "feat: aggregate and deduplicate desktop notifications"`

## Task 5: Introduce the central coordinator and remove direct delivery

**Files:**

- Add: `electron/main/notification-coordinator.ts`
- Add: `electron/main/notification-coordinator.test.ts`
- Modify: `electron/main/mail-events.ts`
- Modify: `electron/main/mail-events.test.ts`
- Modify: `electron/main/app.ts`
- Modify: `app/hooks/useMailEvents.ts`
- Test: `app/hooks/useMailEvents.test.ts`

- [x] Write coordinator tests for preference lookup, focus independence, grouping, dedupe, unsupported Windows notification API, and sound selection.
- [x] Implement `NotificationCoordinator.publish(event)` as the only native-notification entry point.
- [x] Change `registerMailChangedBridge` to publish typed live-mail facts and still send renderer cache-invalidation payloads.
- [x] Route credential-invalid events as action-required facts without provider error details.
- [x] Remove the renderer Sonner “收到 N 封新邮件” toast.
- [x] Remove the startup “Desktop shell is ready” Windows notification.
- [x] Instantiate and dispose one coordinator in `electron/main/app.ts`, backed by the same durable business-preferences service as the local endpoint and a ledger in Electron `userData`.
- [x] Run:

  `npx vitest run electron/main/notification-coordinator.test.ts electron/main/mail-events.test.ts app/hooks/useMailEvents.test.ts`

- [x] Commit:

  `git commit -am "feat: centralize Windows notification delivery"`

## Task 6: Add safe notification activation routing

**Files:**

- Add: `electron/main/notification-activation.ts`
- Add: `electron/main/notification-activation.test.ts`
- Modify: `electron/main/notifications.ts`
- Modify: `electron/main/app.ts`
- Modify: `electron/preload/index.ts`
- Modify: `app/services/api.ts`
- Add: `app/hooks/useNotificationNavigation.ts`
- Modify: `app/root.tsx`
- Modify: `app/components/AgentPanel.tsx`

- [x] Test parsing rejects unknown actions, external URLs, malformed IDs, and privileged direct approvals.
- [x] Test `open` routes restore/focus the main window and emit a typed renderer navigation event.
- [x] Test `markRead` calls the existing local mail API and then routes to the mail.
- [x] Wire Electron notification `click` and `action` events into the typed router; close/timeout intentionally performs no navigation.
- [x] Add a preload listener for `notification:navigate`; renderer navigation maps:

  - mail => open/select `/mail/:id` using the existing route semantics.
  - pending action => open Agent panel and set `wemail.pending-action-target`.
  - account settings => open settings/account.
  - application message => navigate to `/notifications` with selected id.

- [x] Publish a typed action-required fact when an Agent confirmation is first received; use the confirmation id as the dedupe key.
- [x] Run:

  `npx vitest run electron/main/notification-activation.test.ts app/components/AgentPanel.test.tsx`

- [x] Commit:

  `git add electron app shared && git commit -m "feat: route safe notification actions"`

## Task 7: Finish historical-sync aggregation and completion summary

**Files:**

- Modify: `shared/wemail/startup.ts`
- Modify: `server/wemail/performance/StartupSyncCoordinator.ts`
- Modify: `server/wemail/performance/StartupSyncCoordinator.test.ts`
- Modify: `app/routes/_workbench.tsx`
- Modify: `app/routes/_workbench.test.tsx`

- [x] Reuse the existing stable startup `runId` and accumulated inserted/updated/processed totals; no contract extension was necessary.
- [x] Test that interactive/startup/historical work produces progress and one settled summary, while `live-idle`/`live-poll` remains outside that session.
- [x] Preserve current `Mail Core sync worker` historical notification suppression tests.
- [x] Replace the transient progress-only strip with:

  - one progress row while running/paused;
  - one dismissible completion summary when the session settles;
  - no per-message Sonner or Windows notifications.

- [x] Persist the last acknowledged sync-session id in renderer localStorage so reload does not replay the completion summary.
- [x] Run:

  `node --import tsx --test server/wemail/performance/StartupSyncCoordinator.test.ts server/wemail/mail/Mail Core sync worker.test.ts`

  `npx vitest run app/routes/_workbench.test.tsx`

- [x] Commit:

  `git commit -am "feat: aggregate historical sync status"`

## Task 8: Produce and wire the approved icon family

**Files:**

- Add: `electron/assets/wemail-icon.svg`
- Modify: `electron/assets/wemail-256.png`
- Modify: `electron/assets/wemail.ico`
- Modify: packaging icon paths only if the existing paths do not already reference these files
- Add: `scripts/render-wemail-icon.mjs`
- Test: `tests/scripts/wemail-icon.test.mjs`

- [x] Add a deterministic SVG master with a rounded saddle-orange tile and the original sealed-envelope geometry.
- [x] Make the upper negative-space W seam wider and the lower triangle seams thinner.
- [x] Add a render script that generates antialiased PNG sizes and a multi-resolution ICO from the SVG master.
- [x] Add tests for required PNG/ICO dimensions, alpha, and package references.
- [x] Render the icon family and visually inspect the critical 16, 24, 32, and 256 px sizes; all ICO frames share the same SVG render.
- [x] Run:

  `node --test tests/scripts/wemail-icon.test.mjs`

  `npm run test:packaging`

- [x] Commit:

  `git add electron/assets scripts tests/scripts && git commit -m "feat: refine WeMail saddle-orange icon"`

## Task 9: Verify, update OpenSpec, and package-check

**Files:**

- Modify: `openspec/changes/unify-automation-application-messages/tasks.md`

- [x] Run focused notification tests:

  `npx vitest run electron/main/notifications.test.ts electron/main/notification-policy.test.ts electron/main/live-mail-aggregator.test.ts electron/main/notification-ledger.test.ts electron/main/notification-coordinator.test.ts electron/main/notification-activation.test.ts electron/main/mail-events.test.ts app/hooks/useMailEvents.test.ts app/components/settings/SettingsDialog.test.tsx`

- [x] Run server tests:

  `npm run test:server`

- [x] Run renderer/Electron tests:

  `npm run test:renderer`

- [x] Run all type checks:

  `npm run typecheck:server`

  `npm run typecheck:desktop`

  `npm run typecheck`

- [x] Build desktop:

  `npm run build:desktop`

- [x] Validate the OpenSpec change:

  `openspec validate unify-automation-application-messages --strict`

- [x] Mark OpenSpec tasks 10.1–10.6 and 10.8–10.10 complete only where the implementation and evidence satisfy them.
- [ ] Manually accept on Windows:

  - Action-required defaults on; new-mail defaults off.
  - New-mail enabled shows sender + subject even while WeMail is focused.
  - Two messages inside two seconds aggregate.
  - Initial historical sync shows only in-app progress and one summary.
  - “标为已读” and “打开” work; no risky action executes from Toast.
  - Icon remains legible at taskbar and Toast sizes; no unwanted blue ring.

- [ ] Review `git diff --check`, `git status --short`, and the final diff for unrelated files or secrets.
- [ ] Commit remaining task evidence and push the branch.

## Plan Self-Review

- Every approved notification category, default, privacy rule, aggregation rule, and activation restriction maps to a test task.
- The plan uses existing live-origin semantics instead of inventing importance classification.
- Historical synchronization remains an in-app session and cannot enter the native coordinator.
- The icon is deterministic and packageable, not a one-off preview.
- No task contains placeholder file names, undefined “helper” work, or unsafe direct approval actions.
- Shared contracts flow from `shared/` to Electron and renderer without importing Electron into server code.
