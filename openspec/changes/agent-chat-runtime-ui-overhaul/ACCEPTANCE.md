# Acceptance Tracker: agent-chat-runtime-ui-overhaul

## Current Status

- Change status: active
- Planning artifacts: complete
- Implementation: Agent scope complete; repository-wide acceptance blocked by concurrent database cutover
- Stage one: complete
- Stage two: complete
- Final cutover: removal complete; full gate not yet green

Canonical progress is tracked by the checkboxes in `tasks.md`. This file records milestone evidence and must not be marked complete ahead of those tasks.

## Stage One Gate

- [x] New conversation reducer and legacy adapter are covered by regression tests.
- [x] New componentized renderer is available behind the temporary feature flag.
- [x] Reasoning, safe Markdown, safe external links, code copying, tool cards without global expand-all, citations, reorderable queue UI, per-conversation composer drafts, stop, history reload, and smart scrolling pass renderer/browser acceptance.
- [x] Windows desktop build launches without a white screen.
- [x] New UI becomes the default while the old UI remains an emergency fallback.

## Stage Two Gate

- [x] Pi 0.80.6 is integrated only behind the WeMail adapter.
- [x] WeMail AgentEvent v1, structured persistence, snapshots, queue, retry, stop, concurrency, and interruption recovery pass contract and integration tests.
- [x] Deterministic attachment storage, parsers, limits, references, and retention pass tests.
- [x] Confirmation matrix, idempotent writes, pending-operation expiry/navigation, and structured citations pass tests.
- [x] Both local-file and existing-mail attachment intake pass the same canonical storage and message-reference acceptance tests.
- [x] Harness user-learning ledger, retention, preferences, privacy filtering, notifications, and diagnostics pass tests.

## Final Removal Gate

- [x] Old renderer removed.
- [x] Legacy SSE adapter removed.
- [x] Raw Pi event persistence removed.
- [x] Obsolete Agent event/schema paths removed; generic `body_json` remains only as shared channel/message metadata.
- [x] Temporary feature flag removed.
- [x] Incompatible internal Agent data reset verified without affecting mail/account/draft data.
- [x] Final Windows desktop build and non-white-screen evidence attached.

## Verification Evidence

Record commands, screenshots, reports, and known gaps here as implementation progresses.

### 2026-08-02 - Final Agent Cutover Audit

```text
Tasks completed: 10.1-10.8, 11.2-11.10 except repository-wide gate 11.1
Verification commands:
- npm run typecheck
- npm run typecheck:server
- npm run typecheck:desktop
- npm run test:server -- --path server/api/routes/agentRoutes.test.ts
- npm run test:server -- --path server/wemail/agent/AgentRunRepository.test.ts
- npm run test:server -- --path server/wemail/agent/AgentPendingActionRepository.test.ts --path server/wemail/agent/AgentAttachmentStore.test.ts --path server/wemail/agent/AgentLearningLedger.test.ts --path server/wemail/agent/AgentDataReset.test.ts --path server/wemail/agent/AgentRunRepository.test.ts
- npm run test:renderer -- shared/wemail/conversationState.test.ts app/components/agent/AgentConversationThread.test.tsx app/components/AgentPanel.test.tsx
- npm run build:desktop
- npm run verify:full
- npm run test:browser -- --skip-build tests/browser/06-agent-chat.spec.ts
- npm run test:e2e -- --skip-build
Passed:
- Renderer, server, and Electron TypeScript checks
- Agent route regression: 48/48
- Agent persistence/reset/confirmation/attachment/learning controlled tests: 32/32
- Canonical reducer/thread/panel live-history tests: 35/35
- Production renderer + Electron build
- Electron production-renderer health: application launched without a white screen
- Electron login and Automation Center smoke tests
Cutover evidence:
- Canonical conversation-state history endpoint replaces body/event reconstruction
- Live/history parity test covers reasoning, Markdown, tools, citations, and terminal errors
- Durable follow-up create/edit/remove/reorder/resume is server-owned; client duplicate auto-drain removed
- Fresh canonical database contains no agent_events, agent_raw_events, raw_pi_events, events_json, rendered_html, or raw_event_json artifacts
- Legacy renderer, compatibility adapter, raw Pi history, and VITE_WEMAIL_AGENT_UI flag paths are absent
- Controlled Agent reset preserves account, mail, and draft rows
Screenshot:
- workspace/reports/agent-chat-runtime-ui-overhaul/final/desktop-agent-rendered-db-baseline-blocked.png
Known repository-wide blockers:
- The earlier mixed-schema verification failure was removed by the canonical mail-database cutover.
- Browser acceptance cannot compose its test server because the new credential authority and database schema cutover are not yet wired together in the browser harness.
- Electron E2E white-screen health passes; four mail-sync scenarios fail in the same database cutover before Agent behavior is exercised.
- The website astro/tsconfigs/strict warning remains non-fatal; the renderer chunk-size warning is unchanged.
Rollout and rollback:
- Development rollout may clear only internal Agent tables and managed Agent attachments using the tested AgentDataReset path.
- Mail, account, and draft data must not be cleared.
- Back up the complete data directory/SQLite file before rollout if retaining old Agent diagnostics is required.
- Rollback is a code/runtime rollback only; removed incompatible Agent history and raw events are not reconstructed.
Ready to archive: no; keep active until repository-wide browser/desktop gates are green after the database cutover is reconciled.
```

### 2026-07-15 - Stage One Browser and Desktop Acceptance

```text
Tasks completed: 4.2-4.5
Verification commands:
- npm run test:browser -- --skip-build
- npm run test:browser -- --skip-build 02-sync-summary.spec.ts
- npm run test:browser -- --skip-build 06-agent-chat.spec.ts
- npm run test:e2e -- --skip-build
- npm run test:e2e -- --skip-build 02-sync-detail-summary.spec.ts
- npm run typecheck
- npm run typecheck:desktop
Results:
- Browser suite: 16 passed in one clean full run
- Agent browser acceptance: 5 passed
- Electron suite: 6 passed in one clean full run
- Production Electron renderer health: passed; preload bridge and startup log verified; no white screen
- Renderer and Electron TypeScript checks: passed
Durability fixes:
- Production browser fixture is built before acceptance and served with SPA fallback from a dedicated static server
- Browser and Electron fixture mail timestamps are shifted together at runtime, preserving order without aging out of sync windows
- Electron E2E uses an isolated WEMAIL_DATA_DIR and a deterministic IMAP verifier
- better-sqlite3 is rebuilt for Electron and restored for Node by the runner
Screenshots:
- workspace/reports/agent-v2-active-reasoning-queue.png
- workspace/reports/agent-v2-reasoning-markdown-tool.png
- workspace/reports/agent-v2-stopped-paused-queue.png
- workspace/reports/agent-v2-citation-confirmation-error.png
- workspace/reports/electron-production-renderer-health.png
Known gap:
- Midscene semantic assertions are installed and fail fast when their configured vision-model endpoint is unavailable. The local .env.midscene currently points to an offline service at 127.0.0.1:8989; this does not block deterministic Playwright/Electron acceptance.
Ready for next gate: yes
```

### 2026-07-15 - Stage One Componentized UI

```text
Tasks completed: 3.1-3.13, 4.1
Verification commands:
- npm run typecheck
- npm run test:server
- npx vitest run app/components/agent/AgentComposer.test.tsx app/components/agent/AgentConversationThread.test.tsx shared/wemail/conversationState.test.ts
- npx vitest run app/components/AgentPanel.test.tsx app/components/wemail/PendingActionCard.test.tsx
Results:
- TypeScript project references: passed
- Server suite: 1,615 passed, 1 skipped, 0 failed
- Focused renderer/state suites: 46 passed
Covered scenarios:
- Active composer during streaming with visible queued follow-ups
- Queue editing, removal, reordering, automatic continuation, stop-pause, and explicit resume
- Per-conversation unsent draft restoration
- Structured citation popovers, mail navigation, attachment/unavailable states
- Pending-operation count and originating conversation/card navigation
- Resolved confirmation cards retained as read-only history
- Extracted AgentHeader, ConversationThread, UserMessage, AssistantMessage, RunStatus, and Composer
Acceptance infrastructure:
- Playwright Chromium installed under .playwright-browsers
- Browser acceptance must use a freshly built renderer; the Windows React Router dev server did not complete its first SSR request, while the previous port 5173 process was serving a stale build
Ready for next gate: no; fresh production renderer/browser and desktop acceptance remain
```

```text
Date:
Commit:
Tasks completed:
Verification commands:
Desktop artifact/path:
Screenshots/reports:
Known gaps:
Ready for next gate: yes/no
```

### 2026-07-14 - Work Package 1 Baseline and Contracts

```text
Tasks completed: 1.1-1.6
Verification commands:
- npm run typecheck:server
- node --import tsx --test server/wemail/agent/AgentProtocol.test.ts server/wemail/agent/AgentLegacyBaseline.test.ts server/wemail/agent/AgentDataReset.test.ts server/api/routes/agentRoutes.test.ts server/wemail/agent/AgentConversationRepository.test.ts server/wemail/agent/AgentPendingActionRepository.test.ts
- npx vitest run app/components/AgentPanel.test.tsx app/queries/agentConversations.test.tsx app/components/wemail/AgentActionConfirmDialog.test.tsx --reporter=verbose
- start-wemail-desktop.ps1 -ProjectRoot <repo-root> -Rebuild
Results:
- Server focused tests: 73 passed
- Renderer focused tests: 33 passed
- Desktop renderer: HTTP 200
- Desktop startup log: loadURL-done + ready
- Desktop PID: 11764
- Renderer PID: 37772
- Startup log: C:\Users\eddiewang\AppData\Roaming\wemail\data\startup.log
Known gaps: Vite reports existing oversized chunks; no baseline failure.
Ready for next gate: yes
```

### 2026-07-14 - Conversation State and Legacy Adapter

```text
Tasks completed: 2.1-2.5
Verification commands:
- npm run typecheck
- npx vitest run shared/wemail/conversationState.test.ts app/components/AgentPanel.test.tsx --reporter=verbose
- npx vitest run shared/wemail/conversationState.test.ts --reporter=verbose
Results:
- Canonical reducer + legacy adapter tests: 9 passed
- Combined reducer/current AgentPanel regression tests: 28 passed
- Full TypeScript project references: passed
Covered scenarios:
- Interleaved reasoning/tool/text ordering
- Tool partial/final lifecycle
- Duplicate and stale sequence rejection
- Deterministic replay ordering
- Citations, confirmations, attachments, and follow-up reordering
- Partial content on failure and user stop
- Legacy live stream mapping
- Legacy persisted history reconstruction through the same reducer
- Legacy pending confirmation and termination mapping
Ready for next gate: yes; task 2.6 remains for the new UI feature flag
```

### 2026-07-14 - V2 Thread Feature Flag and First Components

```text
Tasks completed: 2.6, 3.2, 3.5
Feature flag:
- Default: legacy
- Environment opt-in: VITE_AGENT_UI_V2=true
- Local acceptance override: localStorage['wemail.agent-ui-version'] = 'v2' | 'legacy'
Verification commands:
- npm run typecheck
- npx vitest run app/lib/agent-ui-version.test.ts shared/wemail/conversationState.test.ts app/components/AgentPanel.test.tsx --reporter=verbose
- npx vitest run app/components/agent/AgentConversationThread.test.tsx app/lib/agent-ui-version.test.ts shared/wemail/conversationState.test.ts --reporter=verbose
Results:
- Feature flag, canonical reducer, current AgentPanel regression: 33 passed
- V2 thread, reasoning, stable tool card, flag, reducer: 15 passed
Implementation notes:
- Legacy and v2 are driven from the same live legacy SSE through the compatibility adapter.
- Persisted legacy history is reconstructed into the same ConversationState used by live v2 rendering.
- Successful tools are individually collapsed; there is no global expand-all control.
- Remaining component extraction, tool renderer registry, composer queue UI, citations, and full desktop acceptance remain pending.
Ready for next gate: yes
```

### 2026-07-14 - Safe Markdown and Tool Renderer Registry

```text
Tasks completed: 3.3, 3.4, 3.6
Verification commands:
- npm run typecheck
- npx vitest run app/components/agent/AgentMarkdown.test.tsx app/components/agent/AgentToolRendererRegistry.test.tsx app/components/agent/AgentConversationThread.test.tsx --reporter=verbose
Results: 9 passed
Coverage:
- Raw script and remote Markdown image blocking
- Desktop safe-link bridge for external links
- Copy-only code controls with download disabled
- Tool renderer lookup and GenericToolCard fallback
- Successful read tools collapsed by default
- Failed tools expanded with actionable errors
- Mail search/read, draft, confirmation, attachment, automation/WeCLI, and allowance invoice renderer mappings
- No user-facing global expand-all control
Ready for next gate: yes
```

<!-- End of acceptance evidence. -->
