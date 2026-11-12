## Context

WeMail currently runs a mixed database architecture. Electron can start a DB Service over either `wemail.sqlite` or `obsolete candidate database`; Mail Core still owns a writable legacy repository; candidate writes are asynchronous mirrors; Renderer detail hydration still polls; the local API reports legacy worker state while Electron delegates work to Mail Core; and account credentials are written through Electron safeStorage but read by Mail Core from a separate file store. The useful candidate implementation proves the DB Service and reader-lane direction, but its migration and compatibility machinery is unnecessary for a demo with no production users.

The current app also demonstrates two operational defects the replacement must remove. First, an interactive body job can be prioritized but cannot preempt or bypass an already running background transfer in the same account worker. Second, the resource governor observes one process while the Electron process tree consumes materially more memory. The replacement therefore treats database ownership, network scheduling, renderer invalidation, credentials, observability, and memory pressure as one runtime design rather than independent patches.

The cutover is intentionally destructive to local demo data. Development may use multiple implementation commits on an isolated branch, but the merged runtime SHALL never support a mixed old/new mode.

## Goals / Non-Goals

**Goals:**

- Make `wemail.sqlite` the only application database and DB Service the only process that opens it.
- Remove all runtime historical/candidate selection, migration, dual-write, mirror, compatibility, and fallback behavior.
- Keep Electron Main, DB gateway, Mail Core control, Renderer, and AI control event loops free of SQL and bounded CPU work.
- Serialize writes through one Writer Thread while isolating detail, list, search, and aggregate reads.
- Guarantee that user-opened bodies and user mutations have reserved network and scheduler capacity.
- Drive durable work from enqueue, completion, connectivity, credential, resource, and next-due events rather than periodic business polling.
- Bound every batch, transaction, queue, retry budget, RPC, result, cache, and memory consumer.
- Use Electron safeStorage as the only mailbox credential authority.
- Serve Renderer state exclusively from committed local data and exact commit-version events.
- Provide one truthful cross-process health and performance model.

**Non-Goals:**

- Preserving or migrating current demo database rows, files, queues, AI artifacts, drafts, or account configuration.
- Supporting a rollback to the removed database implementation after merge.
- Adding another desktop runtime, remote database, SQLCipher, or cloud synchronization service.
- Downloading all attachments or raw MIME during initial synchronization.
- Making AI, automation, or search indexing prerequisites for displaying a mail message.
- Maintaining standalone runtime paths that bypass DB Service for desktop mail reads or writes.

## Decisions

### 1. Perform a destructive greenfield cutover

The canonical file remains `wemail.sqlite`. A developer cutover command stops WeMail, removes the old database/WAL/SHM and managed mail blobs, clears orphaned mailbox credential references, and creates the canonical schema. Normal startup accepts exactly the canonical schema and fails with an actionable demo-reset message on mismatch; it never opens an old schema or another database path.

This is preferred over migration because there are no production users to protect and migration code would permanently retain two identities, two repositories, and a rollback authority. The superseded database change is removed rather than amended.

### 2. Use an acyclic process dependency graph

Electron Main supervises DB Service, Mail Core, Bot Core, and lazy AI workers. Renderer, Mail Core, local API adapters, Bot Core, and AI workers are clients of DB Service. DB Service never calls them synchronously; it only publishes one-way post-commit and health events. Main distributes ports and credentials but never proxies long business requests.

The graph is deliberately acyclic so no component can hold a request while synchronously calling back into its caller. Every RPC carries a request ID, trace ID, deadline, cancellation signal where meaningful, response-size cap, and bounded queue admission.

### 3. Give DB Service exclusive SQLite ownership

The SQL-free gateway routes typed methods to one Writer Thread, one reserved Detail Reader, two List Readers, one Search Reader, and one Aggregate/Maintenance Reader. Connections are never shared between threads. Readers are read-only and `query_only`; only Writer has a read-write connection.

WAL permits readers and Writer to progress concurrently. Reader transactions are statement-scoped. Interactive statements have deadlines; an overdue reader is terminated and recreated without restarting DB Service or another lane. Persistent `SQLITE_BUSY` is treated as an ownership defect and fails fast rather than hiding behind multi-second waits.

Writer transactions normally stop after 25 message mutations or 20 ms of active transaction time. Imports commit bounded batches and yield. Passive WAL checkpoints run only under idle admission and cannot issue a foreground-blocking full checkpoint.

### 4. Make the canonical schema narrow and transactional

Canonical messages are distinct from account/folder/UID instances. Narrow list metadata, normalized addresses and headers, message content/body state, attachments, external blobs, memberships, counters, FTS, jobs, outbox, drafts, remote mutations, AI artifacts, and commit changes use separate tables. Large attachment and raw MIME bytes live in managed blob storage with checksum and reference metadata, not hot SQLite rows or ordinary IPC responses.

Every Writer transaction allocates one monotonic commit version and writes bounded `db_changes` rows. Memberships, counters, body state, FTS state, job completion, and local-first mutations change in the same transaction as their source fact. Renderer and workers observe only post-commit events.

### 5. Use one event-driven durable scheduler

All body, synchronization, remote mutation, indexing, intelligence, automation, attachment, and maintenance work uses one durable job contract. A job has an idempotency key, account and optional folder scope, priority, state, attempt budget, lease, next due time, failure class, and explicit terminal/retry policy.

The scheduler performs one startup recovery scan, keeps ready work in bounded in-memory queues, and maintains a min-heap for future `next_due_at` values. Enqueue, promotion, completion, connectivity recovery, credential replacement, resource recovery, and the single nearest-due timer wake it. A drain turn is capped by job count and 10-20 ms of scheduler CPU before yielding. Empty queues perform no claim query and create no business interval.

Priority is P0 interactive, P1 adjacent prefetch, P2 realtime metadata, P3 recent background, and P4 history/indexing/AI/maintenance. Weighted fairness prevents starvation, but interactive capacity is reserved. Existing idempotent work is promoted rather than duplicated. Passive reads reuse terminal work; only an explicit retry or changed remote/content revision revives it.

### 6. Separate account network roles

Each active account has a realtime session for IDLE/change observation, an interactive transfer session for user-opened bodies and user mutations, and at most one background transfer session for history and prefetch, subject to provider connection limits. When only two sessions are allowed, background work is cooperatively abortable and requeued without consuming an attempt when P0 arrives.

No account worker exposes a single `activeWorkId` shared by realtime, interactive, and background roles. Per-role concurrency is bounded, and global provider/account limits apply backpressure before work is claimed.

### 7. Classify failure and retry centrally

Authentication failures immediately open an account circuit breaker and perform no automatic retry until a credential generation changes. Rate limiting honors Retry-After or uses jittered exponential backoff. Connection failures share one account reconnect schedule. Protocol failures get at most two automatic attempts, locator repair gets one, and confirmed missing content is terminal until explicit retry or remote revision. No mail job has a 100-attempt default.

Retry timestamps are durable. A circuit breaker pauses related work without creating one timer per job. Recovery wakes the scheduler once. Attempt and concurrency budgets prevent a reconnect or restart from releasing a large retry wave.

### 8. Make safeStorage the sole credential authority

Electron Main owns the ElectronSecretStore. Database account rows store only a credential reference and generation. Main delivers an ephemeral credential envelope over a trusted MessagePort when starting or reloading an account runtime. Mail Core and account workers keep it only in memory and never read `secrets.json`.

Updating credentials persists safeStorage first, increments the generation, closes old account sessions, clears the authentication circuit breaker, and starts a fresh account runtime. Secrets never enter logs, crash reports, SQLite, Renderer, job payloads, or exported diagnostics.

### 9. Serve Renderer from committed local state without polling

Renderer queries DB Service directly through preload-scoped typed ports. Opening a message immediately reads local metadata. A ready body is rendered from the detail lane; a missing body atomically ensures/promotes the durable body job and renders only a body placeholder. After Writer commits content, a `mail-content-changed` event containing message ID, state, and commit version causes an exact local refetch. No body polling interval remains.

Renderer caches are normalized into summary-by-ID, bounded ordered view IDs, bounded detail LRU, and counters. Rapid selection cancels or ignores stale detail work. Lists are virtualized and keyset-paginated. MIME parsing, charset conversion, sanitization, and expensive content preparation occur outside Renderer; iframe rendering is sandboxed, remote images are controlled, and resize work is frame-batched.

### 10. Govern the entire Electron process tree

Electron Main aggregates process metrics, while each utility process publishes heap, event-loop lag, queue, active work, and lane state. Admission uses total private memory plus per-process signals rather than one process's working set. Initial budgets are: reading P95 below 500 MB private memory, background sync P95 below 600 MB, and a 650 MB hard pressure threshold on the reference Windows device.

Pressure shedding stops AI and attachment prefetch first, pauses history next, shrinks Renderer caches, releases idle providers/workers, and preserves P0 plus realtime metadata. Hysteresis prevents oscillation. Bot and AI workers are lazy and idle-reaped.

### 11. Use one authoritative health and trace model

Legacy body worker and watcher status fields are removed. Health reports DB lanes, Writer queue, account role sessions, circuit breakers, durable queue counts, current work, next due time, last successful metadata/body activity, event-loop lag, restart counts, and whole-process memory. User-visible status derives from this same model.

An open-mail trace spans click, detail query, ensure/promotion, claim, IMAP fetch, parse, Writer queue, commit, change event, local refetch, and iframe paint. Metrics report P50/P95/P99 and queue versus handler time.

### 12. Merge only as a complete runtime cutover

Implementation occurs on one isolated branch with dependency-ordered internal commits. The branch may temporarily be incomplete, but `main` is not switched until the canonical database, credential broker, scheduler, account role separation, renderer events, health model, reset tooling, and acceptance gates all pass. Merge deletes the old implementation and activates the replacement in the same change; no feature flag exposes mixed operation.

## Risks / Trade-offs

- [Destructive reset surprises developers] -> Make the cutover explicit, stop all repository processes first, print exact deleted demo paths, and never delete on ordinary startup.
- [Large cross-cutting change is difficult to review] -> Keep dependency-ordered commits and capability-focused tests while preserving one atomic runtime cutover at merge.
- [One Writer becomes a throughput bottleneck] -> Use narrow indexed writes, bounded transactions, queue metrics, priority admission, and batch coalescing without adding another writer.
- [Too many reader threads increase memory] -> Keep readers as worker threads in one utility process, apply per-lane cache limits, and remove idle/redundant legacy processes before raising lane counts.
- [Interactive IMAP session exceeds provider limits] -> Detect provider capabilities and fall back to two roles with cooperative background cancellation and short bounded commands.
- [Event loss leaves stale Renderer state] -> Persist commit versions/change rows; a client reconnects from its last version or performs a bounded invalidation if outside retention.
- [A single safeStorage broker makes Main security-critical] -> Keep the API minimal, port-scoped, non-renderer-accessible, redacted, generation-bound, and covered by credential rotation tests.
- [Deleting compatibility code breaks non-desktop local API modes] -> Route every supported mode through the same DB Service client contract or explicitly remove unsupported standalone mail access; do not retain a second repository.
- [Memory budgets vary by machine] -> Treat stated values as reference-device acceptance plus adaptive ratios, while retaining hard concurrency and cache bounds on every device.

## Cutover Plan

1. Build and verify the replacement on an isolated branch without changing the active `main` runtime.
2. Stop repository Electron, Renderer, Mail Core, DB Service, Bot, and helper processes.
3. Run the explicit demo reset to remove old database/WAL/SHM, managed mail blobs, stale mail job state, and orphaned mailbox credentials.
4. Start the canonical runtime, create `wemail.sqlite`, and require account re-login.
5. Verify DB Service is the only database owner and all mail reads/writes use typed ports.
6. Execute concurrency, fault, resource, rapid-interaction, authentication, retry-storm, and latency acceptance.
7. Merge the branch only after all acceptance gates pass; no superseded migration task may be applied.

There is no database rollback path by design. Source rollback remains possible by reverting the code change and resetting demo data again.

## Open Questions

- Which providers require a two-session rather than three-session account profile? The runtime will support both, but the initial provider capability table must be finalized during implementation.
- Should raw MIME be retained by default or only for messages requiring reparsing/debugging? The blob contract supports either policy; the initial retention default must be selected before acceptance.
- Which existing standalone local API entry points remain supported after all mail access is forced through DB Service? Any unsupported mode must be explicitly removed rather than silently falling back.
