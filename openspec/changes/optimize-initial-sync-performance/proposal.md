## Why

New users can reach the workbench while account bootstrap, a 30-day watcher reconciliation, body hydration, intelligence backfill, desktop notifications, query invalidation, and list rendering all compete for resources. The current flow also rebuilds account-scoped mail services after saving LLM settings and explicitly starts another sync when onboarding completes. A large mailbox can therefore create duplicate sync work, thousands of per-message side effects, synchronous SQLite pressure, and large in-memory result sets at the exact moment the product should feel responsive.

This is a product reliability problem, not only a throughput problem. WeMail needs one startup coordinator, bounded and observable background work, progressive mail availability, and acceptance gates that prove the renderer remains interactive on a realistic low-spec Windows device.

## What Changes

- Add a single account-scoped startup coordinator with explicit phases for local readiness, recent metadata, interactive readiness, historical metadata, body hydration, and intelligence backfill.
- Remove independent initial-sync triggers from onboarding, watcher startup, and LLM-setting reloads; account bootstrap becomes idempotent and single-flight.
- Treat historical/bootstrap imports differently from live mail so they do not create per-message desktop notifications, toasts, automation fan-out, IPC messages, or query invalidations.
- Stream metadata through bounded batches instead of accumulating a full 30-day result in memory, and persist each bounded batch through reusable SQLite statements and short transactions.
- Prioritize visible/recent/unread mail bodies and user-requested intelligence while slowing or pausing historical body and AI work under resource pressure.
- Introduce app-wide CPU, memory, event-loop-lag, queue-depth, and sync-phase telemetry with soft throttling and hard suspension thresholds for low-priority work.
- Reduce startup intelligence concurrency and defer existing-mail tag/summary recovery until the workbench is interactive and the resource governor admits background work.
- Coalesce renderer mail-change delivery, lower the initial list payload, and virtualize retained mail rows so background progress does not cause unbounded rerender cost.
- Add deterministic large-mailbox performance fixtures and Windows desktop acceptance for first-login responsiveness, resource ceilings, notification suppression, and recovery after interruption.

## Capabilities

### New Capabilities

- `startup-performance-governance`: Startup phase orchestration, resource budgets, workload admission, telemetry, graceful suspension, and first-login responsiveness guarantees.

### Modified Capabilities

- `mail-sync`: Make bootstrap synchronization single-flight, incremental, bounded, transactional, resumable, and distinct from live-mail notification semantics.
- `mail-queue-wiring`: Defer and throttle historical intelligence work while preserving immediate priority for user-requested and newly arrived mail.
- `e2e-playwright`: Add realistic large-mailbox and low-resource desktop performance acceptance rather than validating only tiny fixtures.

## Impact

- Renderer: onboarding completion, workbench sync state, query invalidation, mail list pagination/virtualization, progress messaging, and performance telemetry hooks.
- Electron main process: mail-change bridge aggregation, notification policy, app-process resource sampling, and startup diagnostics.
- Server: account lifecycle, watcher startup, mail provider streaming, sync coordinator, repository batch writes, body worker scheduling, intelligence recovery scheduling, and queue admission.
- Shared contracts: startup/sync phase state, progress counters, resource-governor state, aggregated mail-change events, and diagnostic metric types.
- Tests: provider/service/repository unit tests, lifecycle integration tests, renderer event-coalescing tests, large-mailbox browser/Electron tests, and resource-budget acceptance reports.
- Data: additive durable sync/checkpoint state may be introduced; existing accounts, mail, intelligence results, drafts, and credentials remain compatible.
