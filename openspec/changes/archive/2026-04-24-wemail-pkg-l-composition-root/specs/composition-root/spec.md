## ADDED Requirements

### Requirement: Compose wemail services at app startup

The system SHALL expose a single `composeApp({dataDir, logsDir})` factory in `server/wemail/bootstrap/AppComposition.ts` that constructs every Package A–K service in a fixed order and returns an `AppComposition` object containing `{ db, secrets, logger, accountService, mailSync, queue, bus, wecli, agent, retention, stop() }`. The Electron main process SHALL invoke this factory exactly once during boot and pass the result to `startLocalApiServer`.

#### Scenario: Successful composition
- **WHEN** `composeApp` is called with a valid `dataDir` and `logsDir`
- **THEN** it SHALL instantiate `WemailDb` and run migrations, then construct `FileSecretStore`, `createAppLogger`, `AccountService`, `DB Service mail API`, `Mail Core sync worker`, `LlmClient`, intelligence and feedback repositories, `MailIntelligenceBus` with registered processors, `QueueRunner`, `AuditLogRepository`, `WecliSkillRuntime`, `PiAgentRuntime`, and `DataRetentionService`, and return a composition handle whose `stop()` tears every subsystem down in reverse order

#### Scenario: Lazy mail provider until login
- **WHEN** `composeApp` runs but no account is logged in
- **THEN** `ImapSmtpMailProvider` SHALL NOT be constructed
- **AND** on a subsequent `accountService` login event the provider SHALL be constructed and wired into `Mail Core sync worker` in place

### Requirement: Mount real HTTP routes

The local API SHALL mount real route factories from Package K using the composition handle: `buildMailRoutes(deps)`, `createIntelligenceApp(deps)`, `buildAgentRoutes(deps)`, `buildSkillRoutes(deps)`, and `createAccountApp(deps)`. No endpoint SHALL return a 503 skeleton after composition completes.

#### Scenario: API serves real data after boot
- **WHEN** the Electron app has booted and `composeApp` has resolved
- **THEN** requests to mail, intelligence, agent, skill, and account routes SHALL be handled by their real factories using the composition handle

### Requirement: Logout preserves data

Account logout SHALL disconnect live providers and clear in-memory secrets but MUST NOT delete the SQLite database file or wipe stored mail, intelligence, feedback, or audit records.

#### Scenario: Logout then re-login
- **WHEN** a user logs out and logs back in
- **THEN** previously synced mail and intelligence rows SHALL still be present in the database

### Requirement: No mail body in logs

The composition root and every service it wires SHALL ensure that mail body content never appears in log output at any level.

#### Scenario: Sync produces a mail with body
- **WHEN** `Mail Core sync worker` ingests a message whose body contains arbitrary text
- **THEN** no log line emitted by the composed app SHALL contain that body text
