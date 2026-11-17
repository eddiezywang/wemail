# Summary Bulk Retry Queue Recovery Design

## Goal

Guarantee that missing or retryable email summaries begin processing when an
account becomes active and that a Summary Center bulk retry progresses from
`pending` to `running` and terminal states without requiring per-message retry
clicks or an application restart.

## Current Failure

The Summary Center bulk endpoint directly inserts or resets every candidate job
to `pending`. It then returns successfully without confirming that the active
`QueueRunner` was notified or is able to consume the jobs. The current route
test asserts only the database transition to `pending`, so a queue that is
stopped, stalled, or absent still satisfies the test.

Startup summary recovery also treats existing `pending` and `running` rows as
live work. A stale pending row therefore prevents backfill from repairing the
message even when no worker is making progress. This explains the observed
state where thousands of rows remain queued until another lifecycle event makes
the worker active again.

Single-message retry is not a separate execution path. It calls the same bulk
endpoint with one email ID, so its apparent success cannot be used as evidence
that the earlier bulk request established a healthy worker.

## Considered Approaches

### Continue relying on the polling interval

This requires the fewest changes, but it preserves the current failure mode:
repository writes can succeed while no live runner consumes them. It also gives
the route no way to distinguish a healthy queue from a stopped one.

### Add a separate bulk summary processor

A dedicated bulk worker could own pagination, progress, and retry policy. This
would duplicate the existing `QueueRunner`, processor registry, timeout, and
result persistence behavior. It is unnecessary for this bug.

### Add an explicit runner wake contract and stale-work recovery

This is the selected approach. Keep one queue implementation, but expose a
small `wake()` operation that schedules an immediate tick without overlapping
an active tick. Bulk retry calls it after committing all job resets. Startup
reconciliation detects stale pending/running work instead of treating every
non-terminal row as healthy.

## Design

### QueueRunner wake contract

Add an idempotent public `wake()` method to `QueueRunner`:

- it does nothing after the runner has been stopped;
- it coalesces repeated wake requests;
- it never runs two ticks concurrently;
- if called during an active tick, it guarantees one follow-up tick after the
  active tick completes;
- `start()` still performs the startup reclaim and invokes the same wake path.

The interval remains as a fallback. Correctness no longer depends on waiting for
the next interval.

### Bulk retry orchestration

The intelligence route must not know QueueRunner internals. Extend its
dependencies with an optional queue wake callback supplied by app composition.

The route will:

1. resolve retry candidates;
2. reset or insert the jobs inside one repository transaction/batch operation;
3. invoke the wake callback once, after the database update completes;
4. return queued/inserted/reset counts plus whether a worker wake was requested.

Selected-message and all-message retry use the same path.

### Startup backfill and stale pending work

Existing non-terminal jobs are considered live only when they have recent
progress:

- `running` jobs with expired leases are reclaimed by QueueRunner startup;
- `pending` jobs remain eligible for the runner and trigger an immediate wake;
- backfill does not create duplicate rows for pending jobs;
- a configured account always starts and wakes its queue after processors are
  registered;
- recovery logs pending/running counts so a future stall is diagnosable.

This fix does not reset valid attempt budgets or retry terminal configuration
errors automatically.

### Initial account behavior

When an account becomes active and the summary model is configured, historical
summary backfill continues to scan all locally available messages up to the
existing configured maximum. Missing/skipped/recoverable work is enqueued, and
the queue is explicitly woken after each backfill batch that adds work.

Opening the Summary Center is not responsible for creating work. Processing is
an account lifecycle responsibility and begins even if the user never visits
the page.

### UI progress

Keep the existing five-second health polling while pending/running work exists.
The UI should not optimistically mark jobs as running. It reflects persisted
queue state, and the backend wake contract ensures those states begin changing.

The bulk response may display queued counts, but no new progress protocol is
required for this fix.

## Error Handling

- If no queue worker is available, the retry endpoint returns a service error
  instead of claiming that execution was started.
- A wake failure does not roll back successfully persisted jobs, but it is
  logged and returned as an explicit error so the UI can tell the user that the
  jobs were saved but processing did not start.
- Repeated bulk clicks remain idempotent and do not create duplicate
  `(email_id, processor)` rows.
- Queue ticks continue to use existing per-lane timeouts and retry budgets.

## Verification

Add tests that prove behavior rather than only database state:

1. QueueRunner wake coalesces calls and runs a follow-up tick when woken during
   active processing.
2. Bulk retry resets thousands of jobs, invokes wake once, and jobs transition
   through `running` to `succeeded` with a test processor.
3. Selected-message retry uses the same wake path.
4. Account startup with missing summaries enqueues and begins processing without
   opening the Summary Center.
5. Existing pending jobs at startup are consumed rather than skipped forever.
6. Stopped or unavailable runners cause an explicit route error.

Run focused Node tests, server typecheck, the complete server test suite, and a
desktop acceptance launch. During manual acceptance, bulk retry must show a
decreasing pending count and increasing running/succeeded counts without
clicking individual rows.

## Scope

This change does not increase model concurrency, change summary prompts, retry
successful summaries, add distributed workers, or redesign the Summary Center.
It only makes the existing local queue execution contract reliable and
observable.
