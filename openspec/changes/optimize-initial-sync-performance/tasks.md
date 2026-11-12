## 1. Baseline, Contracts, and Diagnostics

- [x] 1.1 Add shared contracts for startup phases, sync origins, run identity, progress counters, aggregate mail-change events, workload class, and resource-governor state.
- [x] 1.2 Instrument account login, account-scoped construction, recent metadata, historical metadata, body hydration, intelligence recovery, and interactive readiness with metadata-only phase timings.
- [x] 1.3 Add app-wide sampling for Electron process CPU/working set, Node RSS/heap, event-loop delay, queue depth, active provider work, renderer long tasks, and throttle state.
- [x] 1.4 Add a local responsiveness watchdog and diagnostic event schema that excludes subjects, addresses, bodies, attachment content, credentials, absolute user paths, and raw provider payloads.
- [ ] 1.5 Add regression tests that capture the current duplicate bootstrap triggers and historical per-message event fan-out before replacing them.

## 2. Single Startup Coordinator

- [x] 2.1 Implement the account-scoped startup state machine: local-ready, recent-metadata, interactive, historical-metadata, bodies, intelligence, settled, paused, recoverable-failure, and stopped.
- [x] 2.2 Give every startup/sync run a stable identity, single-flight join behavior, cancellation/stop semantics, and observable progress.
- [x] 2.3 Change account lifecycle construction so it creates services without independently launching competing bootstrap work.
- [x] 2.4 Remove the direct initial `api.syncMail()` call from onboarding and make the workbench observe coordinator state.
- [x] 2.5 Change watcher startup so initial cursor establishment joins the coordinator, then transitions to live IDLE/poll reconciliation.
- [x] 2.6 Change LLM settings reload to hot-swap LLM-dependent runtime/processors without rebuilding mail providers, watcher, body worker, or startup coordinator.
- [x] 2.7 Add lifecycle integration tests proving login, onboarding completion, LLM save, manual refresh, and watcher start create no duplicate compatible runs.

## 3. Bootstrap Versus Live Event Semantics

- [x] 3.1 Add explicit `bootstrap`, `historical`, `manual`, `live-idle`, and `live-poll` origins through routes, coordinator, watcher, sync service, and diagnostics.
- [x] 3.2 Suppress desktop notifications, received-mail toasts, and per-message renderer invalidation for bootstrap and historical origins.
- [x] 3.3 Add a bounded mail-change aggregator with a default 300 ms window and bounded renderer payload.
- [x] 3.4 Invalidate email, folder, and category queries at most once per aggregate publication and throttle progress rendering.
- [ ] 3.5 Route inserted-message automation through bounded durable scheduling; require explicit rule opt-in for historical backfill.
- [x] 3.6 Preserve live-mail notification behavior with short-window aggregation and privacy-safe counts.
- [x] 3.7 Add server, Electron bridge, and renderer tests for 100-message historical batches and live arrival bursts.

## 4. Bounded Metadata Pipeline and SQLite Batches

- [x] 4.1 Extend `MailProvider` with a bounded metadata page/iterator contract and provider-owned continuation state.
- [x] 4.2 Implement IMAP paging across folders without accumulating a complete 30-day result or sorting the full result in memory.
- [x] 4.3 Configure a bounded recent interactive slice, initially 50 Inbox envelopes, and background pages of at most 100 messages.
- [x] 4.4 Add durable per-account/per-folder checkpoints with safe UID-validity replacement and restart recovery.
- [ ] 4.5 Add reusable prepared statements and a `DB Service mail API` batch-upsert transaction that atomically commits messages and the corresponding checkpoint.
- [ ] 4.6 Yield and consult resource admission between committed batches; adapt subsequent batch size downward when measured transaction duration exceeds budget.
- [x] 4.7 Preserve idempotency, stored bodies, authoritative flags, folder cursors, and sync-state semantics under the new batch path.
- [x] 4.8 Add provider/service/repository tests for multi-folder paging, sparse UIDs, UID-validity changes, transaction rollback, interruption, resume, and bounded retained batch size.

## 5. Resource Governor and Workload Scheduling

- [x] 5.1 Implement rolling-window resource evaluation with configurable high/low water marks, cooldown, hysteresis, and observable throttle reasons.
- [x] 5.2 Add admission tokens for interactive, live, and background workloads with interactive-first ordering.
- [x] 5.3 Start with provisional packaged-Windows budgets: 10% background CPU target, 20% sync rolling CPU target, 30% sustained CPU suspension threshold, 200 MB first-sync working-set growth budget, and 600 MB app-wide background high-water mark.
- [x] 5.4 Ensure threshold crossings pause new background batches without interrupting an active SQLite transaction or losing checkpoints.
- [x] 5.5 Add deterministic unit tests for CPU/memory/event-loop pressure, hysteresis, cooldown, pause/resume, and interactive priority.
- [x] 5.6 Expose current phase, progress, paused reason, and recoverable error through the local API and shared client types.

## 6. Body and Intelligence Backpressure

- [x] 6.1 Change body priority to user-selected, visible recent unread, other recent unread, recent read, then historical.
- [x] 6.2 Reduce startup background body batches to a configurable 2-5 serial messages and require background resource admission between batches.
- [x] 6.3 Preserve single-flight hydration and allow user-requested body fetches to bypass background delay safely.
- [x] 6.4 Remove synchronous 5,000-message tag recovery scanning from account construction and replace it with paged resumable background scheduling.
- [ ] 6.5 Make summary recovery wait for interactive readiness, scan bounded pages, persist progress, and yield between pages.
- [ ] 6.6 Add intelligence job priority/workload class and default startup historical concurrency to one while preserving normal post-startup ceilings.
- [x] 6.7 Prevent historical insertion from creating an unbounded set of in-process automation or intelligence promises.
- [x] 6.8 Add recovery, priority, concurrency, resource-pause, restart, and no-duplicate-result tests for body and intelligence work.

## 7. Renderer Responsiveness and Progress UX

- [x] 7.1 Render cached messages immediately and show non-blocking startup phase/progress, paused, retrying, and recoverable-failure states.
- [x] 7.2 Reduce the initial list request to 50 rows unless measured evidence justifies a different value.
- [x] 7.3 Virtualize retained mail rows so DOM size is bounded by the viewport rather than loaded infinite-query pages.
- [x] 7.4 Keep list selection, reading cached mail, search input, settings, and composition responsive while background synchronization continues.
- [x] 7.5 Add renderer tests for aggregate updates, progress throttling, virtualized scrolling, selected-message hydration priority, and background failure states.

## 8. Large-Mailbox and Windows Acceptance

- [x] 8.1 Add deterministic mailbox fixtures with at least 5,000 messages, multiple folders, unread/read mixtures, bodies of varied sizes, and attachment metadata without real network access.
- [x] 8.2 Add provider controls for latency, intermittent failure, disconnect, UID-validity change, and application stop after a committed page.
- [ ] 8.3 Add browser/Electron scenarios for first login, cached restart, LLM settings save, partial-run resume, live burst, historical notification suppression, and manual refresh joining active work.
- [ ] 8.4 Run controlled packaged Windows acceptance on documented 4 GB, 8 GB, and 16 GB profiles where available, recording time-to-interactive, CPU, working-set growth, event-loop delay, queue depth, active concurrency, notifications, IPC events, and invalidations.
- [ ] 8.5 Calibrate provisional resource thresholds from acceptance evidence without weakening the workbench responsiveness gate.
- [ ] 8.6 Verify the approved P95 interactive budget, event-loop budget, first-sync memory-growth budget, graceful high-water pause, and automatic low-water resume.
- [ ] 8.7 Run `npm run typecheck`, `npm run test:server`, `npm run test:renderer`, `npm run test:browser`, and the packaged desktop health workflow.
- [x] 8.8 Capture an acceptance report with measured threshold comparisons, remaining limitations, and reproducible commands.
- [x] 8.9 Make the startup coordinator and resource governor unconditional, then remove obsolete direct-bootstrap code and temporary fallback flags.
