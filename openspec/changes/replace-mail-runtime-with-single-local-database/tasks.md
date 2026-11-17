## 1. Cutover Boundaries and Canonical Naming

- [x] 1.1 Remove the superseded database change and prevent its migration/activation tasks from being applied.
- [x] 1.2 Inventory every runtime reference to historical, candidate, legacy mail repositories, database fallback, mirror writes, inline SQLite, body polling, and legacy health fields; record the deletion owner for each reference.
- [x] 1.3 Define the canonical module and type names (`MailDatabase`, `MailDatabaseWriter`, `MailDatabaseQueryRepository`, `MailDatabaseService`) with no version suffix.
- [x] 1.4 Add an explicit Windows-safe `reset:demo-data` operation that stops repository processes, resolves exact data targets, removes only old demo database/WAL/SHM and managed mail blobs, and reports that the operation is destructive.
- [x] 1.5 Make normal startup reject an incompatible schema with reset instructions and prove it never migrates, mirrors, renames, or falls back automatically.

## 2. Canonical Database Schema

- [x] 2.1 Promote and rename the useful generated schema/runtime code from `database` into the only production database module and remove schema-kind branching.
- [x] 2.2 Create the canonical schema directly in `wemail.sqlite` without migration inventory, historical snapshots, copy/rebind transforms, or activation metadata.
- [x] 2.3 Implement canonical account, identity, folder, folder-sync-state, and sync-run tables with explicit constraints and indexes.
- [x] 2.4 Implement canonical message identity with stable public IDs, non-unique RFC Message-ID evidence, compatible structural fingerprints, and a no-merge ambiguous fallback.
- [x] 2.5 Implement independent IMAP message instances, folder memberships, UID/UIDVALIDITY/MODSEQ locators, relocation history, and one canonical body per logical message.
- [x] 2.6 Implement narrow message summaries, normalized addresses, references, headers, content/body state, attachments, blob references, and threads without JSON-dependent hot queries.
- [x] 2.7 Implement transactional folder/category/tag memberships and materialized counters using received-time keyset columns.
- [x] 2.8 Implement durable jobs, outbox, local-first remote mutations, drafts, scheduled sends, and SMTP recovery identifiers in the canonical schema.
- [x] 2.9 Implement content-hash-bound AI artifacts, current pointers, automation/Agent references, todos, digests, translations, semantic data, feedback, and required product state without a parallel mail authority.
- [x] 2.10 Implement `db_commits` and bounded `db_changes` with one monotonic commit version per Writer transaction.
- [x] 2.11 Implement FTS5 documents and index state for account, subject, participants, body text, attachment names, and explicitly scoped summary text.
- [ ] 2.12 Implement managed raw-MIME and attachment blob storage with checksum, size, reference count, streaming access, retention, and orphan cleanup.

## 3. Exclusive DB Service Runtime

- [ ] 3.1 Make DB Service the only code path that opens `wemail.sqlite` and remove database handles from Electron Main, Mail Core, local API composition, account workers, Bot Core, AI workers, and Renderer.
- [ ] 3.2 Keep the DB Service gateway SQL-free and validate protocol version, method allowlist, parameters, cursor/filter signature, deadline, cancellation, queue admission, and response-size bounds.
- [ ] 3.3 Implement the only read-write connection in Writer Thread with P0/P1 interactive admission ahead of bounded background batches.
- [ ] 3.4 Enforce Writer transaction limits by mutation count and active time, yield between batches, and publish change events only after commit.
- [ ] 3.5 Complete the isolated Detail Reader for bounded message/thread metadata, content, addresses, headers, attachments, tags, categories, and current artifacts.
- [ ] 3.6 Complete two List Readers for all-mail, folder, category, tag, unread, starred, and thread-scrolling keyset pages with first-page anchors.
- [ ] 3.7 Complete isolated Search and Aggregate Readers for bounded FTS, counters, reconciliation, diagnostics, and idle maintenance.
- [x] 3.8 Set WAL, foreign keys, trusted-schema, query-only readers, bounded SQLite caches, and fast failure for unexpected lock ownership.
- [ ] 3.9 Add per-lane heartbeats, queue/statement timings, timeout termination, isolated recreation, and restart budgets without restarting unrelated lanes or processes.
- [ ] 3.10 Make WAL checkpoint and database maintenance idle-admitted, bounded, cancellable, and incapable of blocking an interactive detail or Writer transaction.
- [ ] 3.11 Add a repository guard that fails when production code outside DB Service imports SQLite connection factories or direct SQL repositories.

## 4. Process Composition and Credentials

- [ ] 4.1 Refactor Electron Main into a lightweight supervisor/credential broker and remove in-process writable database and mail service composition from its event loop.
- [ ] 4.2 Establish the acyclic MessagePort topology for Renderer, Mail Core, local API adapters, Bot Core, and lazy AI workers as DB Service clients.
- [ ] 4.3 Add typed request IDs, trace IDs, deadlines, cancellation, bounded payloads, and one-way post-commit events to every trusted client port.
- [x] 4.4 Implement the Electron safeStorage credential broker with database credential reference/generation metadata and an ephemeral Main-to-Mail-Core credential envelope.
- [x] 4.5 Remove FileSecretStore construction and `secrets.json` mailbox reads from Mail Core, account workers, and intelligence workers.
- [x] 4.6 Make credential rotation commit safeStorage first, increment generation, close old provider sessions, clear the auth circuit breaker, and restart only the affected account runtime.
- [ ] 4.7 Redact credentials and body content from ports, logs, crash reports, telemetry, durable jobs, SQLite rows, and exported diagnostics.
- [ ] 4.8 Make shutdown stop client admission and terminate DB, mail, bot, and AI components in bounded reverse order without waiting indefinitely for callbacks.

## 5. Event-Driven Durable Scheduler

- [ ] 5.1 Consolidate body, metadata, remote mutation, outbox, indexing, intelligence, automation, attachment, and maintenance work behind one durable scheduler contract.
- [x] 5.2 Implement stable idempotency keys, explicit P0-P4 priorities, terminal reuse/revive semantics, leases, attempt budgets, next-due time, and failure classes.
- [ ] 5.3 Replace periodic business queue polling with one startup recovery scan, explicit wake events, a bounded ready queue, a future-job min-heap, and one nearest-due timer.
- [x] 5.4 Cap each scheduler drain by claim count and 10-20 ms of scheduler CPU before yielding.
- [ ] 5.5 Implement weighted fairness with reserved P0 interactive capacity and bounded global, provider, account, role, and Writer concurrency.
- [x] 5.6 Split each account into realtime, interactive-transfer, and background-transfer roles with independent active-work state.
- [ ] 5.7 Add provider capability profiles for three-session and two-session operation, including cooperative background cancellation/requeue without attempt penalty.
- [x] 5.8 Ensure P0 body and mutation work can bypass background backoff and cannot wait behind a historical batch.
- [x] 5.9 Implement authentication circuit breaking with zero automatic credential retries and explicit credential-generation recovery.
- [ ] 5.10 Implement shared jittered connection backoff, Retry-After rate-limit handling, bounded protocol/locator retries, and terminal missing-content behavior.
- [x] 5.11 Remove 100-attempt job defaults and define tested retry budgets for every durable job kind.
- [x] 5.12 Recover expired crash leases in bounded waves and prevent duplicate active work after restart.
- [ ] 5.13 Integrate resource-pressure admission so paused jobs consume no attempts and create no per-job timers.

## 6. Synchronization and Local-First Operations

- [ ] 6.1 Implement new-account startup as folder discovery, bounded recent Inbox metadata commit, local interactivity, realtime observation, historical metadata, and tiered body hydration.
- [x] 6.2 Implement returning-account startup as immediate local reads plus QRESYNC/CONDSTORE/MODSEQ/UIDNext deltas or a bounded fallback window.
- [x] 6.3 Persist metadata batches, cursor state, canonical identities, instances, memberships, counters, commits, and change records through Writer only.
- [x] 6.4 Implement body ensure/promotion, interactive fetch, parse, content-hash calculation, transactional ready/failure state, FTS update, job completion, and post-commit event through one path.
- [x] 6.5 Ensure metadata updates preserve ready content and repeated foreground/background observations produce no duplicate logical body or fetch.
- [ ] 6.6 Implement local-first read, star, move, delete, restore, and related counters in one Writer transaction with idempotent remote mutation reconciliation.
- [x] 6.7 Make reviewed sends, drafts, outbox, scheduled sends, and SMTP recovery use the same canonical Writer and durable scheduler.
- [ ] 6.8 Persist attachment metadata during sync but fetch bytes only through explicit bounded attachment jobs and managed blob streams.
- [ ] 6.9 Start indexing, AI, automation, notification, and other downstream jobs only from committed source versions and never block list/detail visibility.
- [ ] 6.10 Route MCP synchronization through the same account roles, idempotency keys, scheduler admission, checkpoints, health, and pollable operation state.

## 7. Renderer Data and Interaction Performance

- [x] 7.1 Route desktop list, detail, folder, category, search, count, and mutation operations through preload-scoped DB Service clients with no HTTP/direct-repository fallback.
- [x] 7.2 Remove body polling intervals and implement exact `messageId` plus `commitVersion` content refresh from DB Service change events.
- [x] 7.3 Implement change-feed reconnect from the last commit version and bounded invalidation when a client falls outside retained history.
- [ ] 7.4 Normalize Renderer caches into summary-by-ID, bounded ordered view IDs, detail LRU, and counters with explicit retention limits.
- [ ] 7.5 Preserve visible first pages through stale-while-revalidate and apply exact optimistic read/star/count updates followed by commit reconciliation.
- [x] 7.6 Add cancellation/generation protection for rapid message selection, category switching, pagination, and search so stale results cannot overwrite current intent.
- [ ] 7.7 Complete keyset list virtualization with bounded pages, stable row subscriptions, controlled overscan, and no whole-mailbox JS materialization.
- [ ] 7.8 Move MIME parsing, charset conversion, sanitization, highlighting preparation, and expensive body transforms outside the Renderer event loop.
- [ ] 7.9 Bound sandboxed iframe rendering, remote image policy, ResizeObserver updates, inline-image loading, large-content expansion, and blob URL lifetime.
- [x] 7.10 Make missing content affect only the body region while metadata and actions remain interactive.
- [ ] 7.11 Use targeted change application rather than account-wide invalidation for body, membership, counters, summaries, and artifact updates.

## 8. Search, AI, and Maintenance Isolation

- [ ] 8.1 Maintain FTS documents explicitly in Writer transactions and remove wide-table LIKE scans, unbounded candidates, JavaScript deduplication, and post-query limiting.
- [ ] 8.2 Implement anchored time-ordered English and Chinese FTS pages with exact account scope and truthful missing/unindexed-body state.
- [x] 8.3 Bind summaries and other AI artifacts to content hash, processor, prompt, and model versions and update current pointers only for the current source.
- [ ] 8.4 Make AI, automation, semantic, digest, translation, and maintenance workers lazy, independently restartable, queue-bounded, and incapable of opening SQLite.
- [ ] 8.5 Add idle reaping and memory-pressure shutdown for optional workers and background provider sessions.
- [ ] 8.6 Select and document the initial raw-MIME retention policy without coupling message display to raw MIME retention.

## 9. Authoritative Health and Resource Governance

- [ ] 9.1 Replace legacy body worker, watcher, and startup status fields with one health model sourced from DB Service and active Mail Core account roles.
- [ ] 9.2 Aggregate Electron process-tree private memory and CPU in Main and combine it with per-process heap, event-loop, queue, lane, and active-work metrics.
- [ ] 9.3 Implement reference reading, sync, and hard memory thresholds with hysteresis and ordered shedding of AI, attachments, history, caches, idle providers, and optional workers.
- [ ] 9.4 Add restart budgets and degraded circuit states for reader lanes and utility processes to prevent restart storms.
- [ ] 9.5 Implement an end-to-end mail-open trace spanning click, local query, ensure/promotion, claim, provider, parse, Writer queue, commit, event, refetch, and paint.
- [ ] 9.6 Report P50/P95/P99 queue, handler, network, render, heartbeat, restart, and memory metrics without mail content or credential material.
- [ ] 9.7 Make UI diagnostics and support exports consume the same authoritative health model and explicitly identify auth-required, rate-limited, offline, queued, active, and failed-terminal states.

## 10. Remove Historical Runtime Code

- [ ] 10.1 Delete historical database schema/repository/runtime code, the wide `mail_messages` authority, and every direct DB Service mail API production consumer.
- [x] 10.2 Delete candidate suffixes and paths after promotion, including `obsolete candidate database`, `WEMAIL_DATABASE_candidate_PATH`, and schema-kind selection.
- [x] 10.3 Delete database migrators, historical schema snapshots, migration inventory, rebuild/activation scripts, backup/rollback logic, and incomplete-candidate cleanup.
- [ ] 10.4 Delete dual-write/mirror producers and ensure Mail Core completes work only after the canonical Writer commit succeeds.
- [ ] 10.5 Delete legacy Mail Core read workers, old body sync worker, duplicate watcher/background runtime, legacy status projections, and fallback API adapters.
- [ ] 10.6 Delete business queue intervals, one-second body polling, broad account invalidation used as body readiness, and retry timers duplicated per job.
- [ ] 10.7 Delete obsolete secret placeholder mailbox paths and safely remove orphaned legacy mailbox secret files during explicit demo reset.
- [ ] 10.8 Add a source scan acceptance gate that rejects production runtime references to historical/candidate/legacy database fallback, dual write, direct SQLite outside DB Service, and body polling.

## 11. Focused Verification and Acceptance Assets

- [ ] 11.1 Add deterministic fixtures for duplicate/missing RFC Message-ID, multiple instances, UIDVALIDITY changes, identical timestamps, missing/large bodies, inline/large attachments, stale AI artifacts, and interrupted mutations.
- [ ] 11.2 Add a representative 200,000-message-per-account, five-account performance fixture with categories, tags, bodies, attachments, Chinese/English search, jobs, and remote mutations.
- [ ] 11.3 Add focused DB ownership, single-Writer, lane routing, deadline, timeout-restart, WAL concurrency, transaction-budget, keyset, counter, FTS, and commit-event tests.
- [ ] 11.4 Add focused scheduler tests for empty-idle behavior, wake coalescing, promotion, fairness, interactive reservation, two-session preemption, crash leases, retry classification, circuit breaking, and retry-wave backpressure.
- [ ] 11.5 Add focused credential tests proving safeStorage is sole authority, legacy files are ignored, rotation restarts one account, and authentication failure performs no retry storm.
- [ ] 11.6 Add focused Renderer tests for local metadata paint, event-driven body readiness, no polling, normalized cache bounds, stale-request rejection, virtualization, and large-body yielding.
- [ ] 11.7 Add focused health/resource tests for whole-process aggregation, pressure shedding, hysteresis, truthful Mail Core state, lane isolation, and restart budgets.
- [ ] 11.8 Add fault-injection scenarios for database reader stalls, Writer failure, Mail Core crash, Renderer crash, network loss, provider throttling, invalid credentials, large retry populations, and disk/blob failures.
- [ ] 11.9 Add performance collection for list/detail/search SQL, queue/handler/RPC, click-to-paint, event-loop lag, process-tree memory, heartbeat, and restart metrics with P50/P95/P99 output.
- [ ] 11.10 Record approved typecheck, focused test, desktop build, Electron E2E, live account, and performance commands and results in an acceptance report before merge.

## 12. Destructive Demo Cutover and Merge Gate

- [x] 12.1 Confirm exact repository/user-data paths, stop repository processes, and run the explicit destructive demo reset without touching unrelated user files.
- [ ] 12.2 Start from a clean canonical `wemail.sqlite`, re-login the test mailbox through safeStorage, and verify no legacy database or secret file is read.
- [ ] 12.3 Verify new-account phased sync, returning-account incremental sync, offline local reads, interactive body promotion, attachments, local-first mutations, send/outbox, search, AI, and MCP on the canonical runtime.
- [ ] 12.4 Verify rapid category/detail switching plus concurrent history, new mail, search, local mutations, attachment work, and AI does not freeze Renderer or miss control heartbeats.
- [ ] 12.5 Verify list DB P95 below 50 ms, category switch P95 below 100 ms, detail metadata P95 below 100 ms, cached body P95 below 300 ms, P0 claim P95 below 50 ms, and FTS first page P95 below 300 ms.
- [ ] 12.6 Verify reference-device private memory P95 below 500 MB while reading, below 600 MB during sync, and correct pressure response at 650 MB, or document and approve a measured replacement budget.
- [ ] 12.7 Verify zero duplicate active body fetches, zero duplicate canonical body writes, zero empty-queue business polling, zero authentication retry loops, and no unbounded restart/retry wave.
- [ ] 12.8 Confirm all old runtime files and branches are deleted, the replacement is the only supported mode, and no compatibility feature flag remains.
- [ ] 12.9 Merge the complete branch as one runtime cutover only after all required acceptance evidence passes; source rollback requires code revert plus another demo reset, not database rollback.
