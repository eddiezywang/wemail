# Runtime Deletion Inventory

This inventory is the implementation map for removing the mixed mail runtime. It is intentionally grouped by ownership so each legacy reference has one deletion destination rather than another compatibility adapter.

## Database selection and historical/candidate naming

- **Electron startup owner:** `electron/main/app.ts`, `electron/main/mail-database-supervisor.ts` — remove `WEMAIL_DATABASE_candidate_PATH`, `obsolete candidate database`, schema-kind selection, historical fallback, and conditional producer attachment.
- **DB Service owner:** `electron/db-service/entry.ts`, `reader-entry.ts`, `writer-entry.ts`, `worker-lane.ts`, `shared/wemail/mailDatabaseProtocol.ts` — remove `schemaKind`, legacy readers, disabled historical writer behavior, and versioned bootstrap data.
- **Canonical database owner:** `server/wemail/database/**` — promote useful schema/query/writer code to `server/wemail/database/**`, remove `candidate`/`historical` suffixes, and delete migrators, inventory, source snapshots, and activation validation.
- **Script owner:** obsolete rebuild/snapshot/schema-generation tooling — delete it and retain only canonical schema generation from canonical OpenSpec input.

## Direct SQLite and legacy repository ownership

- **Legacy database owner:** `server/wemail/db/Database.ts`, `server/wemail/db/migrations.ts` — retire the wide-schema runtime after all non-mail product state has a canonical Writer/query command.
- **Legacy mail repository owner:** `server/wemail/mail/DB Service mail API.ts`, `Mail Core sync worker.ts`, `Mail Core send worker.ts`, `SnoozeService.ts`, `server/api/routes/mailRoutes.ts`, mail-facing agent/MCP/automation services — replace direct `DB Service mail API` use with typed DB Service clients and delete the repository.
- **Mail Core owner:** `electron/mail-core/db-writer-entry.ts`, `read-worker-entry.ts`, `account-worker-entry.ts`, `intelligence-worker-entry.ts`, `server/wemail/mail-core/**` — remove every `openWemailDatabase`/`openWemailReadDatabase` call and receive scoped DB Service ports instead.
- **Composition owner:** `server/wemail/bootstrap/**`, `electron/main/local-api.ts` — stop creating or exposing a shared writable database and repository graph on control event loops.
- **Other product repositories:** automation, Agent, MCP, intelligence, todos, digests, channels, settings, directory, telemetry, and retention modules currently typed against `WemailDb` — move their production construction behind canonical DB Service commands/read models before deleting the legacy connection factory.

## Dual writes and mirrors

- **Mail Core producer owner:** `electron/mail-core/mail-database-producer.ts`, `electron/mail-core/entry.ts` — replace post-historical asynchronous metadata/body mirrors with the awaited canonical Writer commit, then delete the mirror producer.
- **Writer completion owner:** `server/wemail/mail-core/MailCoreAccountRuntime.ts` — complete durable jobs only after canonical metadata/body persistence succeeds; never complete a legacy write before an asynchronous mirror.

## Polling and empty work

- **Renderer body owner:** `app/queries/emails.ts` — delete `BODY_POLL_INTERVAL_MS`, `MAX_BODY_POLL_ATTEMPTS`, `bodyPollAttempts`, and fetching-state `refetchInterval`; consume exact commit-version changes.
- **Renderer invalidation owner:** `app/hooks/useMailEvents.ts` and DB event hooks — replace broad account invalidation for body readiness with targeted message/view changes. The 45-second web transport recovery poll is separately evaluated and MUST NOT claim business jobs.
- **Scheduler owners:** `MailCoreAccountRuntime`, `MailCoreBackgroundRuntime`, `CoreMaintenanceCoordinator`, legacy `QueueRunner` — remove `queueTimer`/periodic claim loops and wake from durable enqueue, completion, provider, credential, resource, and one nearest-due timer events.
- **Heartbeat exception:** low-frequency `unref()` heartbeats/resource sampling may remain, but they MUST NOT execute business claims or scans.

## Legacy body, watcher, and health paths

- **Legacy body owner:** `server/wemail/mail/MailBodySyncWorker.ts` and its composition/status routes — delete after canonical account transfer roles own all body work.
- **Legacy read/status owner:** `bodyWorkerState`, watcher/startup projections in `server/api/routes/mailRoutes.ts`, `app/services/api.ts`, and shared DTOs — replace with active Mail Core account-role and DB Service health.
- **Legacy environment owner:** `WEMAIL_MAIL_CORE_LEGACY_READ_WORKERS` and legacy runtime feature branches in Electron/Mail Core startup — delete; the canonical runtime has no compatibility flag.

## Credential split

- **Main credential owner:** `electron/main/electron-secret-store.ts`, `electron/main/app.ts` — remain the sole mailbox secret authority and create versioned ephemeral credential envelopes.
- **Legacy credential owner:** FileSecretStore creation in `electron/mail-core/account-worker-entry.ts`, `entry.ts`, `intelligence-worker-entry.ts` — delete mailbox reads from `secrets.json`; account workers receive credentials in memory.
- **Demo reset owner:** remove only `wemail:account:*:imap-password` and `wemail:account:*:smtp-password` legacy/encrypted entries while preserving unrelated settings/MCP/channel secrets.

## Acceptance scans

Production scans cover `app`, `electron`, `server`, and `shared` and reject:

- `WEMAIL_DATABASE_candidate_PATH`, `obsolete candidate database`, database `schemaKind`, `Databasecandidate`, `MailDatabasecandidate`, `historicalPlatformSchema`;
- direct SQLite connection imports outside the canonical DB Service boundary;
- `DB Service mail API` production consumers;
- `MailBodySyncWorker`, legacy read workers, asynchronous database mirror logs/producers;
- fixed-interval body polling or fixed-interval durable job claims;
- Mail Core mailbox `FileSecretStore` construction;
- legacy worker state presented as authoritative health.
