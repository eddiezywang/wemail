## 1. Bootstrap module

- [x] 1.1 Create `server/wemail/bootstrap/` directory with an `index.ts` barrel
- [x] 1.2 Add `server/wemail/bootstrap/AppComposition.ts` skeleton exporting `composeApp({dataDir, logsDir, overrides?})` and an `AppComposition` type

## 2. Wire services in order

- [x] 2.1 Construct `WemailDb` and run migrations
- [x] 2.2 Construct `FileSecretStore` (Package A)
- [x] 2.3 Construct `createAppLogger` (Package H)
- [x] 2.4 Construct `AccountService` (Package A)
- [x] 2.5 Define a lazy holder for `ImapSmtpMailProvider` (Package B); do not construct at boot
- [x] 2.6 Construct `DB Service mail API` + `Mail Core sync worker` (Package B) with the lazy provider reference
- [x] 2.7 Construct `LlmClient` from secrets (Package E), branching OpenAI-compat vs Anthropic by config
- [x] 2.8 Construct `IntelligenceResultRepository`, `TagFeedbackRuleRepository`, `DraftFeedbackLog` (Packages C/F/G)
- [x] 2.9 Construct `MailIntelligenceBus` and call `registerIntelligenceProcessors` for Summary/Tag/ReplyDraft
- [x] 2.10 Construct `QueueRunner` in bus mode and call `start()`
- [x] 2.11 Construct `AuditLogRepository` + `WecliSkillRuntime` (Package I)
- [x] 2.12 Construct `PiAgentRuntime` and `createMailAgentTools` (Package J)
- [x] 2.13 Construct `DataRetentionService` (Package H) and call `start()`

## 3. Lifecycle and events

- [x] 3.1 Return `{ db, secrets, logger, accountService, mailSync, queue, bus, wecli, agent, retention, stop() }`
- [x] 3.2 Implement `stop()` to tear down subsystems in reverse order
- [x] 3.3 Subscribe to `accountService` login event: build `ImapSmtpMailProvider` and rebind on `Mail Core sync worker`
- [x] 3.4 Subscribe to `accountService` logout event: disconnect provider, clear the holder, do NOT touch DB

## 4. Local API wiring

- [x] 4.1 Modify `server/api/app.ts` `createLocalApiApp` / `startLocalApiServer` to accept an `AppComposition`
- [x] 4.2 Mount `buildMailRoutes(deps)`, `createIntelligenceApp(deps)`, `buildAgentRoutes(deps)`, `buildSkillRoutes(deps)`, `createAccountApp(deps)` with the composition
- [x] 4.3 Modify `electron/main/local-api.ts` to call `composeApp({dataDir, logsDir})` and pass the result to `startLocalApiServer`

## 5. Tests

- [x] 5.1 Add `server/wemail/bootstrap/AppComposition.integration.test.ts`
- [x] 5.2 Compose the app using fake account, fake IMAP (returning one mail), and fake LLM (returning one summary)
- [x] 5.3 Assert `IntelligenceResultRepository` has one row after the pipeline drains
- [x] 5.4 Assert `stop()` tears down cleanly (no hanging handles)

## 6. Verification

- [x] 6.1 `npm run test:server` passes (256+ tests, new integration suite included)
- [x] 6.2 `npm run typecheck:server` and `npm run typecheck:desktop` are clean
- [x] 6.3 `npm run build:desktop` is clean
- [x] 6.4 Integration test compose → fake login → fake IMAP 1 mail → fake LLM summary → `IntelligenceResultRepository` row present
- [x] 6.5 No §6 hard-rule violation (no mail body in logs; logout does not wipe DB; cross-platform paths; no duplicated services)
- [x] 6.6 Commit message exactly: `feat(bootstrap): compose wemail services into local api`
