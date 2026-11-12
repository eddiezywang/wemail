## 1. Schema retention support

- [x] 1.1 Write failing migration test ensuring `created_at` exists on `mail_messages` (body cache), attachment cache, `app_logs`, and `wecli_audit_logs`.
- [x] 1.2 Modify `server/wemail/db/schema.ts` and migrations as needed; add indexes to support cleanup queries.

## 2. AppLogger

- [x] 2.1 Write failing unit test for `AppLogger.log` happy path with allow-listed metadata.
- [x] 2.2 Write failing unit test: `AppLogger.log` rejects / strips `meta` with forbidden keys (`body`, `content`, `rfc822`) and oversized strings.
- [x] 2.3 Create `server/wemail/telemetry/AppLogger.ts`.

## 3. DataRetentionService

- [x] 3.1 Write failing unit test: rows older than 30 days are deleted from mail body cache, attachment cache, `app_logs`, `wecli_audit_logs`.
- [x] 3.2 Write failing unit test: `mail_tag_feedback_rules` rows and draft feedback Markdown are untouched.
- [x] 3.3 Write failing unit test: `run()` is idempotent and safe on empty tables.
- [x] 3.4 Create `server/wemail/security/DataRetentionService.ts`; schedule on startup + daily interval.

## 4. SecretStore finalize (optional)

- [x] 4.1 If Package A left only a placeholder, write tests asserting `safeStorage`-backed encryption when available, fallback path otherwise.
- [x] 4.2 Upgrade `server/wemail/security/SecretStore.ts` as needed.

## 5. Safety

- [x] 5.1 Write test: logout does NOT trigger retention run.
- [x] 5.2 Write test: retention never touches `mail_tag_feedback_rules` or the draft feedback Markdown file.

## 6. Verification

- [x] 6.1 Run `npm run test:server` — must pass.
- [x] 6.2 Run `npm run typecheck:server` — must pass.
- [x] 6.3 Run `npm run typecheck:desktop` — must pass.
- [x] 6.4 Run `npm run build:desktop` — must pass.
- [x] 6.5 Confirm new code has unit tests for logger and retention service.
- [x] 6.6 Confirm no violations of Handoff §6 hard rules (no body in logs, logout does not wipe DB, retention is time-based only).
- [x] 6.7 Commit with the exact Handoff §5.H message: `git commit -m "feat(security): add retention and app logging"`.
