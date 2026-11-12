## Why

Phase one commits to clear local-data retention policies and a safe application logger that never captures mail bodies. Without a retention job, the mail cache, attachments, WeCLI audit log, and app logs grow unbounded; without a disciplined logger, body text can leak into logs. This package adds both, plus any missing `SecretStore` pieces deferred from Package A.

## What Changes

- Add `server/wemail/security/DataRetentionService.ts` — scheduled cleanup of expired mail bodies, attachments, app logs, and WeCLI audit logs.
- Add (or finalize) `server/wemail/security/SecretStore.ts` — only if not already delivered by Package A.
- Add `server/wemail/telemetry/AppLogger.ts` — centralized logger that refuses to record mail body content.
- Modify `server/wemail/db/schema.ts` — ensure tables have `created_at` / `expires_at` semantics required by retention.

Phase-one retention windows:

- Mail body cache: 30 days.
- Attachment cache: 30 days.
- App logs: 30 days.
- WeCLI audit logs: 30 days.
- Tag feedback rules: long-term (not purged).
- Draft feedback Markdown: long-term (not purged).

## Capabilities

### New Capabilities
- `retention-logger-cleanup`: centralized retention job, safe application logger, and scheduled cleanup of expired local data.

### Modified Capabilities
- (none)

## Dependencies

- Upstream OpenSpec changes: **all other packages** (A–G, I–K). Retention must be aware of every store it cleans, and the logger is consumed by every package.
- Conceptual consumer: every other package that logs.

## Constraints

Hard constraints from Handoff §2 that this change MUST honor:

- Electron + single account + IMAP/SMTP.
- LLM: OpenAI-compatible + Anthropic Messages.
- Built-in agent is PI (not Claude Code).
- WeCLI: auto-approve `ls/list` only; everything else needs confirmation; all audited (audit logs are retained 30 days).
- **Logout MUST NOT wipe local DB** — retention cleans *expired* rows, never everything on logout.
- New mail → durable queue; summary retry ≤ 2.
- One fixed summary prompt.
- Agent may draft but never auto-send.
- **No mail body in logs** (enforced by `AppLogger`).
- Windows-only phase one, but logic stays cross-platform.

## Impact

- Code: `server/wemail/security/DataRetentionService.ts`, `server/wemail/security/SecretStore.ts` (finalize), `server/wemail/telemetry/AppLogger.ts`, `server/wemail/db/schema.ts`.
- DB: adds retention-related columns and indexes if missing.
- Dependencies: no new runtime dependencies.
