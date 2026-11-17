## Why

WeMail is still a demo, so preserving the current database through a historical-to-candidate migration creates permanent runtime complexity without protecting real user data. The current mixed runtime already exposes the cost of that complexity: two database authorities, legacy fallbacks, asynchronous mirroring, split credential stores, polling-based body refresh, misleading health status, blocked interactive body fetches, and resource governance that cannot see the whole Electron process tree.

This change performs one greenfield cutover to a single local database and a single mail runtime contract. The old demo database is discarded, users sign in again, and no historical/candidate compatibility path remains in production code.

## What Changes

- **BREAKING** Delete the existing demo database and recreate `wemail.sqlite` from the canonical schema; no data migration, backup activation, rollback database, dual-write, or legacy fallback is provided.
- **BREAKING** Remove historical/candidate naming and runtime branches. `MailDatabase` becomes the only database implementation and DB Service becomes the only process allowed to open it.
- Run SQL only in one Writer Thread and isolated Detail, List, Search, and Aggregate Reader Threads behind a SQL-free typed RPC gateway.
- Make Mail Core, Renderer, AI, automation, and local API clients use typed DB Service commands and queries; remove direct repositories and inline SQLite access from their control event loops.
- Replace polling job consumers and one-second body polling with an event-driven durable scheduler, bounded drain budgets, a single next-due timer, post-commit change events, and explicit backpressure.
- Reserve an interactive account transfer lane so user-opened bodies and local-first mutations cannot wait behind historical synchronization.
- Classify retries, add account/provider circuit breakers, cap attempt budgets, apply jittered backoff, honor Retry-After, and prevent authentication and batch retry storms.
- Make Electron `safeStorage` the only secret authority and deliver ephemeral account credentials to Mail Core over a trusted MessagePort; remove the file-backed Mail Core credential path.
- Separate canonical messages from remote IMAP instances, store bodies separately from list metadata, externalize raw MIME/attachment bytes, maintain counters and FTS transactionally, and use anchored keyset pagination.
- Normalize renderer caches, render cached metadata immediately, refresh details from commit-version events, cancel stale interactions, virtualize bounded lists, and isolate expensive body preparation from the renderer event loop.
- Aggregate memory, CPU, queue, heartbeat, and event-loop metrics across the Electron process tree and shed background work before interactive performance degrades.
- Replace legacy sync/body health fields with one authoritative runtime health model.
- Remove the superseded database change; none of its migration or historical-preservation requirements apply after this cutover.

## Capabilities

### New Capabilities

- `single-mail-database`: The only local database schema, DB Service ownership, single-writer/multi-reader lanes, canonical mail storage, blobs, FTS, counters, change feed, bounded queries, and failure isolation.
- `mail-runtime-scheduler`: Event-driven durable work scheduling, interactive reservations, account connection roles, backpressure, retry classification, circuit breakers, and crash recovery without idle polling.
- `mail-renderer-performance`: Local-first detail rendering, normalized bounded caches, exact commit-version invalidation, cancellation, virtualization, body isolation, and renderer latency budgets.
- `mail-runtime-observability`: Authoritative cross-process health, whole-process-tree resource governance, tracing, restart boundaries, memory budgets, and performance acceptance.

### Modified Capabilities

- `account-secretstore`: Electron safeStorage becomes the sole mailbox secret authority and Mail Core receives ephemeral versioned credentials instead of reading a file store.
- `composition-root`: Electron Main becomes a lightweight supervisor and credential broker; application services no longer share an in-process writable database composition.
- `mail-sync`: IMAP synchronization becomes a bounded producer into the single DB Service, with canonical message/instance semantics, phased first sync, incremental old-user sync, and an interactive transfer lane.
- `mail-queue-wiring`: All mail, mutation, intelligence, automation, indexing, and maintenance work uses one event-driven durable scheduler with idempotency and bounded retries.

## Impact

- Removes the current historical database implementation, candidate suffixes, migration inventory/migrators, database path selection, dual-write producer, legacy Mail Core readers/workers, polling body refresh, and legacy health reporting.
- Renames and promotes the useful `server/wemail/database`, `electron/db-service`, and shared database protocol code into the canonical database runtime.
- Changes Electron Main, preload, Mail Core, account workers, local API composition, renderer queries/events, intelligence workers, automation workers, attachments, search, and startup/reset scripts.
- Deletes existing local Demo data and requires mailbox re-login after cutover.
- Introduces no new desktop runtime; Electron remains the only supported shell.
- Requires focused concurrency, crash-recovery, rapid-interaction, large-mailbox, authentication-failure, retry-storm, memory-pressure, and end-to-end latency acceptance before merge.
