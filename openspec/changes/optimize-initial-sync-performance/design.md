## Context

The desktop application hosts the local Hono API, IMAP providers, synchronous `better-sqlite3` repositories, queue runner, and lifecycle composition in the Electron main process. The renderer is a separate process, but API starvation, IPC floods, native notification work, and main-process event-loop stalls still make the application appear frozen.

Today a successful account save synchronously builds account-scoped services and starts the body worker and watcher. The watcher's first connection runs an incremental sync with a 30-day fallback. Saving LLM settings triggers a fresh account transition and creates another set of account-scoped services. Completing onboarding then issues another explicit sync. A sync window may fetch up to 5,000 UIDs per folder in batches of 500 but accumulates normalized messages before returning. Persistence performs per-message synchronous reads and writes. A watcher bootstrap emits one live `new-mail` event per inserted historical message, which can fan out to automation, desktop notifications, IPC, toast messages, and three renderer query invalidations per message.

The body worker already processes a bounded serial batch, but it begins immediately and does not coordinate with startup readiness or global resource pressure. Intelligence startup can scan up to 5,000 messages for tags and 10,000 for summaries, while the queue runs three jobs concurrently. The renderer initially loads 100 rows and retains every infinite-query page without row virtualization.

## Goals / Non-Goals

**Goals:**

- Make account bootstrap and first sync single-flight, idempotent, resumable, and visible as explicit phases.
- Make the workbench interactive before historical synchronization, body hydration, and intelligence recovery consume significant resources.
- Bound network fetch, normalized-message retention, SQLite transaction duration, event fan-out, body hydration, and intelligence concurrency.
- Keep live new-mail latency acceptable while historical work is deliberately slower.
- Apply provisional app-wide CPU and memory guardrails and provide telemetry needed to calibrate them on real devices.
- Prevent historical imports from producing live-mail notifications or per-message renderer refreshes.
- Prove performance with repeatable large-mailbox, slow-provider, interruption, and low-spec desktop scenarios.

**Non-Goals:**

- Synchronizing an entire mailbox before the user can enter the workbench.
- Guaranteeing a fixed wall-clock duration for complete historical sync across all providers and networks.
- Applying an operating-system CPU quota to the Electron main process.
- Moving all mail and intelligence services to a separate process in the first delivery stage.
- Changing SMTP send semantics, deleting existing local mail, or migrating account credentials.

## Decisions

### 1. One startup coordinator owns all initial work

Introduce an account-scoped `StartupSyncCoordinator` (name may vary) with a durable, observable state machine:

`local-ready -> recent-metadata -> interactive -> historical-metadata -> bodies -> intelligence -> settled`

Only the coordinator may initiate bootstrap synchronization. Account lifecycle constructs providers and the coordinator but does not independently start a 30-day reconciliation. Onboarding navigates to the workbench and observes coordinator state rather than calling `/api/mail/sync`. The watcher enters live watch mode only after the coordinator establishes the initial cursor, or joins the same single-flight operation if started concurrently.

Manual refresh remains an explicit user action. It may join an in-flight compatible operation but must not enqueue a duplicate run. Saving LLM settings hot-swaps LLM-dependent services and queue processors without rebuilding mail providers, the body worker, or the watcher.

Alternative considered: keep every current trigger and rely on `Mail Core sync worker` serialization. Rejected because serialization prevents overlapping metadata fetches but still duplicates work and allows body, intelligence, lifecycle, notification, and UI side effects to overlap.

### 2. Interactive readiness precedes historical completeness

The first remote phase fetches only a bounded recent Inbox slice, initially 50 envelopes. It persists and publishes that slice, then marks the workbench interactive. Historical folders and older messages continue in the background through checkpoints. Existing local mail is shown immediately and does not wait for a network connection.

The UI exposes truthful phase and progress information without blocking navigation, reading cached mail, settings, or composition. A failed historical phase does not revoke interactive readiness; it records a recoverable state and resumes with backoff.

### 3. Metadata synchronization is a bounded streaming pipeline

Provider APIs gain a page/iterator contract that yields bounded metadata batches. Initial defaults are 50 messages for the interactive slice and 100 messages for background pages. No stage may retain a whole 30-day multi-folder result in memory merely to sort it. Ordering is delegated to indexed SQLite reads.

Each batch is normalized, written, checkpointed, summarized into counts/ids, and released before fetching the next page. Folder and UID checkpoints make interruption and restart resumable. Provider caps remain safety limits, not allocation targets.

### 4. SQLite writes use short batch transactions

`DB Service mail API` gains a batch-upsert path with prepared statements reused within transactions. A transaction processes at most 100 messages by default and records cursor/checkpoint updates atomically with that batch. The coordinator yields between transactions so timers, API requests, watcher control, and resource sampling can run.

Long all-mailbox transactions are rejected because they improve raw throughput at the cost of responsiveness and crash recovery granularity.

### 5. Bootstrap events and live events have different semantics

Every sync operation carries an origin such as `bootstrap`, `historical`, `live-idle`, `live-poll`, or `manual`. Historical origins produce batch progress events and internal inserted-message references but never live desktop notifications, per-message toasts, or per-message renderer invalidation.

Live origins may notify, but mail-change delivery is coalesced into a bounded event at most once per 300 milliseconds. The bridge sends an aggregate count and bounded id set; the renderer invalidates relevant queries once per aggregate. Notification policy may aggregate multiple live arrivals into one privacy-safe notification.

Automation and intelligence consume a durable bounded queue rather than one untracked promise per inserted message. Historical automation does not run unless a rule explicitly opts into backfill.

### 6. One resource governor admits low-priority work

An app-wide resource governor samples Electron process metrics, Node CPU usage, RSS/heap, event-loop delay, queue depth, and renderer responsiveness. Work is classified as:

- `interactive`: user-selected body fetch, manual action, visible list request;
- `live`: new-mail cursor reconciliation and required notification delivery;
- `background`: historical metadata, background body hydration, tag/summary recovery.

Interactive work is admitted first. Live work remains prompt but bounded. Background work requires an admission token and is paused when a threshold is exceeded.

Provisional Windows targets, measured app-wide and calibrated in acceptance, are:

- workbench interactive within 2 seconds at P95 after onboarding completion when the local API is healthy;
- event-loop delay below 50 ms at P95 and no sustained delay above 200 ms;
- background steady-state CPU at or below 10% of total machine capacity;
- sync rolling CPU at or below 20%, with background admission suspended after a sustained 30% reading;
- first-sync incremental working-set growth below 200 MB;
- background work suspended at an app working-set high-water mark of 600 MB.

Threshold crossings pause admission; they do not kill in-flight transactions or corrupt checkpoints. After a cooldown and low-water confirmation, work resumes. Values are configuration constants with diagnostic visibility, not user-facing tuning knobs in this change.

Alternative considered: apply a Windows hard quota to the Electron main process. Rejected because the quota would also throttle window lifecycle, IPC, and the local API. If workload governance cannot meet acceptance, a later change may move background mail/intelligence work to an Electron utility process and apply process-level controls there.

### 7. Body and intelligence scheduling are priority-aware

Body fetch priority is:

1. the message currently requested by the user;
2. visible recent unread messages;
3. other recent unread messages;
4. recent read messages;
5. historical messages.

During startup, background body batches default to 2-5 serial messages with a governor-controlled delay. User-requested hydration bypasses the background delay but still deduplicates active fetches.

Historical intelligence recovery starts only after interactive readiness and resource admission. Startup concurrency defaults to one job, increasing to the normal ceiling only after startup settles and metrics remain below thresholds. Existing-mail tag and summary scans page through bounded sets, yield between pages, and persist progress. User-requested intelligence and genuinely live mail outrank historical recovery.

### 8. Renderer updates remain bounded

The initial mail-list page is reduced to 50 unless evidence supports a different value. Retained pages use row virtualization so DOM size depends on viewport size, not the number of loaded messages. Aggregated mail events patch or invalidate the cache once per batch. Progress updates are throttled and must not trigger whole-workbench rerenders.

### 9. Diagnostics are metadata-only and phase-oriented

Structured diagnostic records include phase, origin, account hash/id, folder identifier, batch count, duration, cursor/checkpoint, CPU, RSS/heap, event-loop delay, queue depth, throttle reason, and error code. They exclude mail subjects, addresses, bodies, attachment content, credentials, and raw provider payloads.

A watchdog records a local diagnostic marker when the renderer or main event loop misses the responsiveness threshold. Diagnostics support local export but are never uploaded automatically.

## Data Model Direction

Additive state may include:

- one startup/sync run row per account with phase, origin, status, timestamps, and aggregate counts;
- per-account/per-folder checkpoint rows with UID validity, last UID/date, and continuation state;
- optional resource-throttle and last-failure metadata needed for restart diagnostics.

Existing `mail_folder_sync_state` and `mail_sync_state` should be extended or reused where they provide the required atomic checkpoint semantics. Message, intelligence result, account, credential, draft, and feedback data remain intact.

## Risks / Trade-offs

- [Lower background throughput] -> Measure time-to-interactive separately from time-to-settled and allow faster processing only when metrics are healthy.
- [Provider pagination differences] -> Keep provider-specific cursor translation behind `MailProvider` and test UID validity changes, sparse UIDs, and folder switches.
- [A resource governor can oscillate] -> Use rolling windows, separate high/low water marks, minimum pause intervals, and observable throttle reasons.
- [Batch transactions can still block] -> Cap batch size and transaction duration, then adapt the next batch size downward when the measured duration exceeds budget.
- [Aggregating events can hide individual live mail] -> Preserve durable inserted ids internally and use aggregate UI/notification presentation only at the delivery boundary.
- [Hot-swapping LLM services can leave in-flight jobs] -> Drain or version LLM processor delegates independently while keeping mail providers and sync ownership stable.
- [Performance tests can be flaky] -> Use deterministic fixture providers and measure bounded phase durations/operation counts in CI; reserve machine CPU/RSS ceilings for controlled Windows acceptance runs.

## Migration Plan

1. Add telemetry, sync origins, aggregate event contracts, and regression tests around the current behavior.
2. Introduce the startup coordinator and make onboarding, watcher startup, and LLM reload use it behind a temporary feature flag.
3. Suppress historical notification fan-out and coalesce live renderer events.
4. Add streaming provider pages, batch repository transactions, and durable checkpoints.
5. Add resource governor admission to historical metadata, body, and intelligence work.
6. Add list virtualization and truthful sync-progress UI.
7. Run large-mailbox browser and packaged Windows acceptance, calibrate provisional thresholds, and make the coordinator unconditional.
8. Remove obsolete direct bootstrap triggers and the temporary fallback flag.

Rollback before step 7 restores the existing coordinator flag while retaining additive telemetry/checkpoint columns. Rollback must never delete locally synchronized mail. Any partially completed run remains resumable from its last committed checkpoint.

## Open Questions

- The provisional 600 MB app-wide high-water mark must be confirmed on packaged Windows builds across 4 GB, 8 GB, and 16 GB machines.
- Whether utility-process isolation is necessary remains an evidence-based follow-up decision after workload governance acceptance.
