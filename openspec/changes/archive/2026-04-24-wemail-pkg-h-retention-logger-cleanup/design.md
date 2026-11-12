## Context

Every other package creates or uses local state: mail bodies, attachments, intelligence results, audit logs, application logs, feedback rules, Markdown drafts. This package provides the centralized retention job and the safe logger used by all the rest.

## Goals / Non-Goals

**Goals:**

- A scheduled `DataRetentionService` (runs on app start + daily) that deletes rows older than the per-table retention window.
- An `AppLogger` API used by every package for structured logs, with a hard guarantee that mail body text is rejected at the API boundary.
- Optional: finalize `SecretStore` if Package A left phase-one stub unfinished.
- Schema support for retention: `created_at` on every relevant table; an index to make the cleanup query cheap.

**Non-Goals:**

- Cross-device sync or backup.
- User-configurable retention windows (phase one is fixed).
- Rotating external log sinks — logs are local files only.

## Decisions

- **Retention windows hardcoded in a constants module.** Mail bodies / attachments / app logs / wecli audit logs = 30 days. Tag feedback + draft feedback Markdown = long-term (excluded from cleanup).
- **`DataRetentionService.run()` is idempotent.** Safe to invoke on every startup. Uses `WHERE created_at < NOW() - INTERVAL 30 DAY`-style predicates (SQLite equivalent via `datetime('now','-30 days')`).
- **`AppLogger` API.** `log(level, event, meta)` where `meta` is a typed object with allow-listed keys (message ids, counts, durations, codes). A development-mode assertion rejects any `meta` value string that looks body-ish (length > 200, or keys named `body / content / rfc822`). Alternative rejected: a free-form `info(message, any)` — too easy to leak.
- **No separate handlers per package.** Every package imports `AppLogger` from `server/wemail/telemetry/AppLogger.ts`. Upstream interfaces consumed (for retention): `DB Service mail API`, `JobRepository`, `AuditLogRepository` (Package I), raw DB for app_logs table.
- **Retention preserves logout contract.** The job's predicates are time-based only. Logout never invokes retention; retention never treats "logged out" as a signal to purge more. This preserves Handoff §2's "logout does not wipe local DB".
- **SecretStore finalization.** If Package A shipped the placeholder form, this package MAY upgrade it to use Electron `safeStorage` properly. If Package A already fully delivered, this package's scope reduces to retention + logger.

## Risks / Trade-offs

- **[Risk] Retention deletes mail the user just read.** → Mitigation: "read" state has its own retention; phase-one fixed policy is documented in UI release notes; future enhancement is a user toggle.
- **[Risk] Logger overhead.** → Mitigation: `log(level, event, meta)` is synchronous and light; file sink is buffered.
- **[Risk] Developer accidentally bypasses AppLogger (uses `console.log`).** → Mitigation: ESLint rule or code review; not enforced by this package but recommended.
- **[Risk] Retention job runs during heavy sync.** → Mitigation: use transactions with chunked deletes.

## Migration Plan

- Additive migrations for `created_at` if any relevant table lacks it.
- Rollback: disable the retention scheduler; logger can fall back to `console.log`.

## Open Questions

- Frequency: once per startup + once per 24h, or cron-style interval — pick "startup + daily interval" for phase one.
