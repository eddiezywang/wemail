# WeMail Runtime Resource Optimization Design

**Date:** 2026-07-30

**Status:** Approved

**Runtime:** Electron only

## 1. Objective

Reduce the stable resource footprint of the complete WeMail Electron application without weakening mail reliability, the three-business-worker Mail Core topology, or existing user-visible behavior.

The primary acceptance profile is:

- all Electron processes combined: Private Bytes P95 at or below 600 MiB;
- Mail Core utility process: Private Bytes P95 at or below 250 MiB;
- idle CPU average at or below 3%;
- cached mail metadata first screen P95 at or below 100 ms;
- Snapshot RPC P95 at or below 20 ms with no timeout;
- DB Writer, IMAP, and AI remain the only Mail Core business workers.

Performance acceptance uses one-minute windows, as requested. Each window samples every five seconds, and the final result combines three clean Electron launches to reduce one-run variance.

## 2. Scope

This change covers:

1. resource attribution across all stable Electron process roles;
2. Snapshot query amplification and database read budgets;
3. AI Worker dependency residency and recovery batching;
4. Electron Main and Local API dependency duplication;
5. background IMAP provider lifetime;
6. renderer and GPU long-task reduction after backend targets are met;
7. resource, latency, topology, and fault acceptance automation.

This change does not:

- add, restore, or assume a Tauri or Rust runtime;
- add more Mail Core business workers;
- replace durable queues or the DB Writer ownership model;
- disable GPU acceleration without measured evidence;
- remove product features to meet a memory number;
- claim that a Promise timeout can interrupt synchronous SQLite work.

## 3. Current State and Evidence

The one-minute whole-application sample identified six stable process modules:

| Process role | Private average | Working Set average | CPU average | Threads max | Handles max |
|---|---:|---:|---:|---:|---:|
| Mail Core | 290.4 MiB | 292.0 MiB | 0.75% | 35 | 708 |
| Electron Main and Local API | 182.2 MiB | 214.8 MiB | 3.42% | 79 | 1,350 |
| GPU | 114.4 MiB | 130.6 MiB | 0% | 40 | 994 |
| Renderer | 69.8 MiB | 147.3 MiB | 0% | 32 | 696 |
| Network Utility | 22.0 MiB | 75.0 MiB | 0% | 28 | 707 |
| Crashpad | 18.2 MiB | 60.0 MiB | 0% | 15 | 537 |
| **Total** | **697.1 MiB** | **919.7 MiB** | **4.17%** | **229** | **4,989** |

The existing Mail Core 30-minute report also found:

- Mail Core Working Set P95: 459.8 MiB;
- Mail Core Private peak: 464.1 MiB;
- Mail Core CPU average: 0.15%;
- cached Snapshot P95: 185.3 ms with two one-second timeouts;
- 50-row mail list: 741.3 ms;
- cached successful Snapshot P50: 6.4 ms.

The Chromium trace contains application-visible stalls including:

- layout and style work around 218-226 ms;
- GPU raster and flush work around 212 ms;
- Major GC up to 193 ms;
- mouse-move hit testing and forced layout above 200 ms.

### 3.1 Root causes

The evidence and code structure point to five primary causes.

1. The Local API calls the full `composeApp()` graph. Electron Main can therefore retain Mail, Intelligence, Agent, Automation, MCP, Search, Workspace, Directory, and related repositories even when execution belongs in Mail Core.
2. The AI Worker separately creates Account, Directory, Settings, Workspace, Intelligence, repositories, logging, and Resource Governor objects. It uses the general intelligence composition rather than a worker-specific graph.
3. Snapshot list assembly performs per-message invoice-status lookup after the list and count queries. A 50-row page therefore contains an N+1 query path.
4. SQLite connections have role-level read/write separation, but no explicit per-role page-cache, mmap, result-batch, and connection-lifetime budgets.
5. Foreground and background IMAP providers are constructed together even when no background body or attachment transfer is active.

Renderer and GPU hotspots are real, but they are secondary to the combined Mail Core and Main footprint, which accounts for most mutable Private Bytes.

## 4. Considered Approaches

### 4.1 Incremental runtime slimming — selected

Keep the current Electron topology and Mail Core three-worker contract. Remove dependency duplication and query amplification in independently measurable stages.

Advantages:

- each stage has a feature flag or structural rollback point;
- resource changes can be attributed to one subsystem;
- the existing durability and failure model remains intact;
- estimated savings of 120-220 MiB are sufficient for the target.

Risk:

- thinning Local API boundaries requires careful route classification and RPC contracts.

### 4.2 Hard process-domain decomposition — rejected for this change

Move API, mail, AI, and storage into more independent utility processes.

This improves crash isolation, but adds V8/Chromium process overhead, IPC complexity, and more lifecycle states. It can increase total memory even when module ownership becomes clearer.

### 4.3 Local tuning only — rejected as insufficient

Adjust SQLite pragmas, polling frequency, GC behavior, React rendering, and idle connections without changing composition boundaries.

This is low risk but is expected to save only 30-70 MiB, which does not reliably cover the required reduction from approximately 697 MiB to 600 MiB.

## 5. Target Architecture

```text
Electron Main
├── window, tray, notification, protocol, and lifecycle control
├── preload IPC bridge
├── Mail Core supervisor
└── thin Local API gateway
          │ typed RPC
          ▼
Mail Core utility process
├── Core Snapshot Service
├── Core Maintenance Coordinator
├── DB Writer Worker
├── IMAP Worker
└── AI Worker
```

### 5.1 Ownership rules

Electron Main owns only desktop control-plane concerns. It must not instantiate the complete business composition for Local API routing.

The Local API gateway owns:

- HTTP listener lifecycle;
- authentication and authorization checks;
- request parsing and validation;
- typed request-to-RPC translation;
- response and error translation.

It does not own Mail repositories, intelligence processors, durable job execution, IMAP providers, automation executors, or the full agent graph.

Mail Core owns mail persistence, local snapshots, maintenance, durable jobs, and the three business workers. If an API Worker is enabled, it remains a thin local API isolation layer and is not a business worker. It must not recreate `composeApp()`.

The AI Worker owns only AI job execution dependencies. It must not load unrelated Agent, MCP, desktop automation, digest, design, or UI composition modules.

## 6. Detailed Design

### 6.1 Process-aware measurement

Extend performance collection so each sample contains:

- process ID and stable role;
- Working Set and Private Bytes;
- CPU delta;
- thread and handle count;
- startup phase and active account state;
- for DB Writer, IMAP, and AI: heap, external memory, queue depth, active job kind and age, restart count, restart backoff, and heartbeat age.

Collection begins only after the Electron window, Local API, Mail Core, and account runtime report ready. Reports must keep raw samples rather than only aggregates.

### 6.2 Snapshot query consolidation

Add a batch invoice-status repository operation accepting all message identifiers for one page. `CoreSnapshotService.list()` performs one invoice-status query and maps results by message ID.

The list operation is reduced to bounded stages:

1. retrieve the requested envelope page;
2. retrieve page-level invoice states in one query;
3. retrieve counts only when the client contract requires them;
4. determine the next page using the fetched limit-plus-one row or another single bounded query;
5. assemble summaries without further database access.

Exact counts may use a short-lived cache keyed by normalized account and filter parameters. The cache is invalidated by the relevant mail-change generation. It must not return stale counts across account changes.

Query budgets remain observational for synchronous SQLite. Over-budget operations are logged with kind, normalized filter shape, row count, and elapsed time. No `Promise.race` timeout is presented as query cancellation.

### 6.3 SQLite connection budgets

Every production connection has a declared role:

| Role | Access | Lifetime | Budget behavior |
|---|---|---|---|
| DB Writer | read/write | process lifetime | WAL owner, bounded write cache |
| Snapshot | read-only | process lifetime | small cache, query-only |
| IMAP metadata | read-only/proxy writes | account lifetime | small-to-medium cache, bounded batches |
| AI | read-only/proxy writes | worker lifetime | small cache, bounded body reads |
| Transient diagnostics/reload | read-only | operation lifetime | close immediately after operation |

Implementation will test SQLite `cache_size`, `temp_store`, and `mmap_size` configurations with the real mailbox. The selected defaults are based on measured Private Bytes and latency, not assumed page-cache arithmetic.

All scans use cursor pagination and explicit limits. AI recovery and maintenance batches also cap the number of messages and aggregate body bytes held in one iteration.

### 6.4 Slim AI Worker composition

Introduce `MailCoreIntelligenceComposition`, whose public surface contains only the repositories, LLM runtime, processor factory, durable queue runner, and lifecycle operations required by AI jobs.

Processors load on first use by job kind. A processor module not referenced by queued work is not imported during worker startup. Shared heavyweight contexts are not retained beyond an active job unless a measured bounded cache justifies them.

AI recovery rules:

- bounded jobs per startup batch;
- bounded message bodies and total body bytes per batch;
- event-loop yield between batches;
- no body or model-context loading while the network circuit is open;
- exactly one half-open probe;
- explicit release of prompt, body, attachment metadata, response, and processor-local arrays after finalization.

The existing closed/open/half-open circuit state and durable queue persistence remain authoritative.

### 6.5 Thin desktop Local API

Split the root composition into desktop control plane and execution domains.

`composeDesktopControlPlane()` contains only components required in Electron Main, such as account-state bridging, settings required for desktop presentation, notifications, application lifecycle, and Mail Core supervision.

`composeApiGateway()` creates the listener and route adapters. Routes are classified as:

- desktop-local: safe control-plane operation completed in Main;
- Mail Core query: forwarded to Snapshot or another bounded query RPC;
- Mail Core command: forwarded to the durable command or worker owner;
- unsupported during degraded mode: returns an explicit typed availability error.

Main must not silently fall back to full `composeApp()` after an RPC failure. A temporary environment flag may retain the old composition for rollback during rollout, but it is disabled by default and must be removed after acceptance.

MCP listeners that must remain attached to the desktop process use typed RPC for business execution rather than importing repositories and services into Main.

### 6.6 Lazy background IMAP provider

The account runtime constructs only the foreground realtime provider during normal startup.

The background transfer provider is created when a body, attachment, or bulk-transfer job first needs it. When the background queue is empty for the configured idle period, the provider closes its sockets and releases its provider state. A later job recreates it.

Credential errors from either provider feed the same credential-required state. Closing the background provider must not affect foreground IDLE, cached reads, or account health reporting.

### 6.7 Renderer and GPU optimization

Renderer work begins only after backend memory targets are close enough that UI changes are necessary or trace evidence identifies a user-visible latency gate.

The renderer design uses:

- strict mail-list virtualization;
- delayed rendering for invisible body and attachment sections;
- coalesced scroll, resize, and selection updates;
- no synchronous layout read after DOM write in mouse-move paths;
- bounded context-bridge payloads;
- controlled lifecycle for mail body frames;
- reduced unnecessary compositing layers and large transparent effects.

GPU acceleration remains enabled unless an explicit hardware-specific A/B test shows lower total resource use and equal interaction latency without it.

## 7. Error Handling and Degraded Modes

- IMAP Worker failure: cached list and cached bodies remain readable; supervisor restarts IMAP with backoff.
- AI Worker failure: mail functions remain available; durable AI jobs stay pending and recover after restart.
- DB Writer failure: Mail Core enters read-only degradation; commands fail with typed errors rather than writing through another connection.
- Local API RPC timeout: return a typed timeout or unavailable response; do not instantiate a local full business graph.
- AI network EOF/connectivity failures: open the circuit after the configured consecutive threshold, preserve jobs, allow one half-open probe, close on success.
- IMAP authentication failure: keep the non-dismissible credential repair dialog behavior.
- background IMAP failure: foreground realtime and cached reads remain available.
- shutdown: close providers, timers, database connections, ports, and workers in ownership order.

## 8. Implementation Sequence

Implementation is divided into independently measurable batches.

1. Process-aware resource attribution and reusable one-minute acceptance harness.
2. Snapshot batch metadata queries and count/next-page consolidation.
3. SQLite role budgets and bounded scans.
4. Slim AI Worker composition and lazy processor loading.
5. Thin Electron Main control plane and Local API gateway.
6. Lazy background IMAP provider.
7. Renderer and GPU long-task work only if remaining gates require it.
8. Full regression, fault injection, real Electron acceptance, final report, commit synchronization, and push.

Each batch produces before/after measurements before the next batch begins.

## 9. Acceptance

### 9.1 Measurement protocol

Run two one-minute scenarios after a clean Electron start:

1. stable idle: begin after window ready, Local API ready, Mail Core ready, active account loaded, and initial sync settled;
2. interaction: repeatedly open cached mail, open an uncached mail, return to list, and switch folders.

Sample every five seconds for twelve samples. Repeat the scenarios for three clean launches and compute combined P50, P95, and maximum values. Record the commit, environment, mailbox size, message count, database size, and scenario timestamps.

### 9.2 Resource gates

| Metric | Required result |
|---|---:|
| All Electron processes Private P95 | <= 600 MiB |
| All Electron processes Private max | <= 650 MiB |
| Mail Core Private P95 | <= 250 MiB |
| Mail Core Private max | <= 300 MiB |
| Idle CPU average | <= 3% |
| Idle CPU P95 | <= 6% |
| Handle growth during stable minute | <= 2% |
| Thread behavior | no monotonic growth after ready |
| Unexpected Worker restarts | 0 |

Diagnostic process budgets are:

- Electron Main and Local API P95: 150 MiB;
- Renderer P95: 80 MiB;
- GPU P95: 115 MiB;
- Network Utility P95: 25 MiB;
- Crashpad P95: 20 MiB.

Diagnostic budgets identify regressions; the combined Private and Mail Core budgets are hard gates.

### 9.3 Latency gates

| Scenario | Required result |
|---|---:|
| Snapshot RPC P95 | <= 20 ms, zero timeout |
| 50-row mail list P95 | <= 100 ms |
| Cached mail metadata first screen P95 | <= 100 ms |
| Cached body visible P95 | <= 150 ms |
| Uncached metadata first screen P95 | <= 100 ms |
| Folder switch P95 | <= 150 ms |
| Application-code UI long task | no task above 200 ms |

Uncached body completion is reported separately because it depends on mailbox network conditions and must not block metadata-first rendering.

### 9.4 Topology gates

- DB Writer, IMAP, and AI are the only Mail Core business workers.
- Query Reader, Aggregate Reader, and Background Worker are absent by default.
- Electron Main does not invoke full `composeApp()` for production Local API startup.
- AI Worker does not invoke the general full `composeIntelligence()` graph.
- an optional API Worker is a thin isolation layer and is reported separately;
- each SQLite connection has a declared role and budget;
- background IMAP provider is absent while unused.

### 9.5 Fault acceptance

The final Electron build must demonstrate:

1. killing IMAP Worker does not break cached local reads;
2. killing AI Worker does not break mail list, open, send, or receive paths;
3. DB Writer failure produces read-only degradation;
4. durable queue leases recover after worker restart;
5. Outbox retry does not duplicate a remote side effect;
6. consecutive AI network EOF/connect failures open the circuit and stop high-frequency requests;
7. circuit expiry permits only one half-open probe and success closes the circuit;
8. IMAP authentication failure keeps the credential repair dialog non-dismissible;
9. background IMAP close or failure does not interrupt foreground realtime operation;
10. Local API timeout does not load a fallback full composition in Main.

### 9.6 Build and regression acceptance

Required checks include:

```powershell
npm run typecheck
npm run typecheck:server
npm run typecheck:desktop
npm run test:server
npm run test:renderer
npm run build:desktop
```

Electron acceptance follows the `wemail-desktop-build` workflow and requires:

- a visible application window;
- startup logs containing `loadURL-done`, `ready`, and `mail-core-ready`;
- DB Writer, IMAP, and AI health in ready state;
- real-account list, open, body load, attachment, and send paths;
- no default legacy read or background worker.

## 10. Reporting

The final report includes:

- tested commit and environment;
- mailbox and database scale;
- raw one-minute samples for all three runs;
- per-process and per-worker metrics;
- total and Mail Core resource percentiles;
- mail latency percentiles and timeouts;
- fault acceptance results;
- before/after absolute and percentage differences;
- pass/fail result for every hard gate;
- trace or flamegraph-equivalent hotspot output;
- remaining bottlenecks and follow-up recommendations.

## 11. Rollback and Stop Conditions

Each implementation batch is committed separately and has a focused compatibility switch where a runtime boundary changes.

Do not proceed to the next batch when any of the following occurs:

- Private Bytes increase by more than 5%;
- Snapshot or mail-open P95 regresses by more than 10%;
- a new business Worker or database write owner appears;
- durable queue, Outbox, credential dialog, or read-only degradation acceptance fails;
- Electron Main or AI Worker indirectly reloads the full business composition;
- a required focused test or Electron startup check fails.

The working tree may contain parallel changes. Every commit must stage explicit task files and verify `git diff --cached --name-only` before committing.

## 12. Expected Outcome

The selected architecture is expected to remove 120-220 MiB of mutable Private Bytes:

- SQLite connection and scan budgets: 30-60 MiB;
- slim AI Worker composition: 40-80 MiB;
- thin Electron Main and Local API: 50-90 MiB;
- lazy background IMAP provider: 10-25 MiB;
- renderer and GPU work: 10-25 MiB where required.

These are planning estimates, not acceptance evidence. Only the three-run one-minute Electron measurement determines completion.
