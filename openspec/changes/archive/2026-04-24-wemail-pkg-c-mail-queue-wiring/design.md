## Context

The baseline already includes a queue skeleton (`server/wemail/queue/JobRepository.ts`, `QueueRunner.ts`) and the `mail_jobs` table. Nothing inserts real jobs; nothing executes them. Package B emits a "new mail" event. This package closes the loop.

## Goals / Non-Goals

**Goals:**

- Every new mail message upserted by `DB Service mail API` produces exactly one `summary`, one `tags`, and one `replyDraft` row in `mail_jobs`.
- `QueueRunner` repeatedly claims pending jobs from the DB and dispatches them through `MailIntelligenceBus`.
- Restarting the app resumes pending jobs (durable queue) without duplicates.
- `MailIntelligenceBus` exposes `registerProcessor(kind, processor)` so Packages E/F/G can register.
- `MailIntelligenceProcessor` is a stable interface: `{ kind, handle(job, ctx) => Promise<Result> }`.

**Non-Goals:**

- The actual summary / tag / draft logic (Packages E, F, G).
- Cross-kind dependencies (e.g. "tags runs after summary") — phase one treats the three kinds as independent.
- Distributed queue semantics — single-process only.

## Decisions

- **Bus owns dispatch, Runner owns scheduling.** `QueueRunner` picks up rows, marks them in-flight with a lease, and calls `MailIntelligenceBus.dispatch(job)`. The bus looks up the registered processor by `job.kind`. If no processor is registered, the bus returns a "skipped / no processor" result and the job goes back to pending or to a terminal "skipped" state — implementer chooses but must document.
- **Three jobs per new mail.** Created atomically with the mail upsert (or in the same event handler, before the event resolves). Keys include `messageId + kind` with a UNIQUE constraint so re-sync never duplicates.
- **Retry semantics live on the job row.** `attempts`, `max_attempts`, `last_error`. Package E will set `max_attempts=2` for summary jobs to satisfy the "≤ 2 retries" rule, but this package provides the machinery.
- **Shared types reused.** `shared/wemail/queue.ts` (JobKind, Job, JobStatus), `shared/wemail/intelligence.ts`. Upstream `DB Service mail API` from Package B is consumed; downstream packages implement the `MailIntelligenceProcessor` interface defined here.
- **No mail body passed through the bus payload.** Jobs carry `messageId` only; processors re-fetch body from `DB Service mail API` as needed. Keeps logs safe and job rows small.

## Risks / Trade-offs

- **[Risk] Empty processor registry silently discards work.** → Mitigation: log a warning (without body) when a job runs with no processor, keep rows pending so later startup with processors drains the backlog.
- **[Risk] Race between mail upsert and job insert on crash.** → Mitigation: perform both inside a single SQLite transaction.
- **[Risk] Runaway retries fill the DB.** → Mitigation: per-kind `max_attempts` defaults; terminal `failed` status after exhaustion.
- **[Risk] Queue lease leaks on crash.** → Mitigation: lease expiry timestamp; startup reaps expired leases back to pending.

## Migration Plan

- Additive only. If `mail_jobs` lacks `(message_id, kind)` UNIQUE, add it via a migration.
- Rollback: revert the route and queue changes; drop the new bus/processor files.

## Open Questions

- Whether "skipped / no processor" is a terminal status or a retry — recommend terminal with ability to re-enqueue on startup if a processor later registers.
