## Why

Packages A–K each landed self-contained, but `electron/main/local-api.ts` boots without injecting any dependencies and `server/api/app.ts` mounts skeleton constants only — so the API returns 503/empty after launch. We need a single composition root that wires the shipped services together and exposes them through the local API. Without it the user-visible app cannot exercise the work already paid for.

## What Changes

- Modify `electron/main/local-api.ts` to call a new `composeApp({dataDir, logsDir})` factory and pass the resulting `AppComposition` to `startLocalApiServer`.
- Add `server/wemail/bootstrap/AppComposition.ts` that wires 13 steps in order:
  1. `WemailDb` from `server/wemail/db/Database.ts` plus migrations.
  2. `FileSecretStore` (Package A).
  3. `createAppLogger` (Package H).
  4. `AccountService` (Package A).
  5. Lazy `ImapSmtpMailProvider` (Package B) — constructed only when an account is logged in.
  6. `DB Service mail API` + `Mail Core sync worker` (Package B).
  7. `LlmClient` from secrets (Package E) — OpenAI-compat or Anthropic, picked by config.
  8. `IntelligenceResultRepository` + `TagFeedbackRuleRepository` (Packages C/F) + `DraftFeedbackLog` (Package G).
  9. `MailIntelligenceBus` + `registerIntelligenceProcessors` (Summary/Tag/ReplyDraft).
  10. `QueueRunner` in bus mode + `start()`.
  11. `AuditLogRepository` + `WecliSkillRuntime` (Package I).
  12. `PiAgentRuntime` + `createMailAgentTools` (Package J).
  13. `DataRetentionService` + `start()` (Package H).
  Returns `{ db, secrets, logger, accountService, mailSync, queue, bus, wecli, agent, retention, stop() }`.
- Modify `server/api/app.ts` `createLocalApiApp` / `startLocalApiServer` to accept the composition and mount real factories: `buildMailRoutes(deps)`, `createIntelligenceApp(deps)`, `buildAgentRoutes(deps)`, `buildSkillRoutes(deps)`, `createAccountApp(deps)`.
- Hot-reload: subscribe to `accountService` login/logout events to rebuild `Mail Core sync worker`'s provider in place.
- Add integration test `server/wemail/bootstrap/AppComposition.integration.test.ts` that composes with injected fakes and verifies the full flow.

## Capabilities

### New Capabilities
- `composition-root`: wiring layer that constructs and lifecycle-manages every wemail service and mounts them on the local API.

### Modified Capabilities
<!-- none -->

## Impact

- Affects `electron/main/local-api.ts`, `server/api/app.ts`, every Package A–K export consumed by the bootstrap.
- No new external dependency. Reuses existing exports — must not duplicate any service.
- Logout must not wipe the database (Handoff §2). Mail bodies must never appear in logs. Cross-platform paths required.

## Dependencies

All of Packages A through K — the composition root consumes their exports:
- A (account + secret store), B (IMAP/SMTP + sync), C (queue + intelligence repo), D (frontend), E (LLM client + summary processor), F (tag processor + feedback rules), G (reply draft + feedback log), H (logger + retention), I (wecli skill runtime + audit log), J (pi agent runtime + mail tools), K (HTTP route factories).

## Constraints

- No mail body content in logs.
- Logout MUST NOT wipe the SQLite DB (Handoff §2).
- Cross-platform: macOS / Linux / Windows path handling.
- Reuse existing exports — do NOT duplicate any service that already lives in Package A–K.

## Acceptance

1. `npm run test:server` — 256+ tests pass, including the new integration suite.
2. `npm run typecheck:server` and `npm run typecheck:desktop` are clean.
3. `npm run build:desktop` is clean.
4. Integration test composes the app, simulates a fake account login, fake IMAP returns one mail, fake LLM returns a summary, and `IntelligenceResultRepository` ends up with one row.
5. Commit message exactly: `feat(bootstrap): compose wemail services into local api`.
