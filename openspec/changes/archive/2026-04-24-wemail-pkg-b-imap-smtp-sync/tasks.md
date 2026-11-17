## 1. Provider interface and normalization

- [x] 1.1 Write failing unit test for `normalizeMail` covering subject, from/to, dates, text body, and attachment metadata.
- [x] 1.2 Create `server/wemail/mail/MailProvider.ts` with the `connect / disconnect / syncRecent / getMessage / sendDraft` interface.
- [x] 1.3 Create `server/wemail/mail/normalizeMail.ts`; run test until green.

## 2. IMAP/SMTP implementation

- [x] 2.1 Write failing integration-style test for `ImapSmtpMailProvider` against an `imapflow` mock (fetch list, fetch one, send one).
- [x] 2.2 Create `server/wemail/mail/ImapSmtpMailProvider.ts`; wire `imapflow` for receive and `nodemailer` for send; Inbox-only.
- [x] 2.3 Add retry-with-backoff for `connect`; run tests until green.

## 3. Repository and schema

- [x] 3.1 Write failing unit test for `DB Service mail API.upsertMessage / listMessages / getMessageById / findRecentSyncCursor`.
- [x] 3.2 Modify `server/wemail/db/schema.ts` and `server/wemail/db/migrations.ts` for any additional columns needed (sync cursor row, normalized header fields).
- [x] 3.3 Create `server/wemail/mail/DB Service mail API.ts`; run tests until green.

## 4. Mail Core sync worker

- [x] 4.1 Write failing unit test: `Mail Core sync worker.syncRecent()` inserts new messages, skips existing, updates the cursor, and emits one event per new message.
- [x] 4.2 Create `server/wemail/mail/Mail Core sync worker.ts` consuming `MailProvider` and `DB Service mail API`.
- [x] 4.3 Run tests until green.

## 5. API wiring

- [x] 5.1 Write failing integration test for `GET /api/mail/messages` and `GET /api/mail/messages/:id` returning repository-backed data.
- [x] 5.2 Modify `server/api/routes/mailRoutes.ts` to call the repository; ensure body fields are returned on detail but list endpoint returns only summary fields.
- [x] 5.3 Run tests until green.

## 6. Safety checks

- [x] 6.1 Write test that verifies no `AppLogger` call from `server/wemail/mail/*` includes body or attachment bytes.

## 7. Verification

- [x] 7.1 Run `npm run test:server` — must pass.
- [x] 7.2 Run `npm run typecheck:server` — must pass.
- [x] 7.3 Run `npm run typecheck:desktop` — must pass.
- [x] 7.4 Run `npm run build:desktop` — must pass.
- [x] 7.5 Confirm new code has unit tests covering provider, normalizer, repository, and sync service.
- [x] 7.6 Confirm no violations of Handoff §6 hard rules (no business logic in Electron main, queue not bypassed, no mail body in logs).
- [x] 7.7 Commit with the exact Handoff §5.B message: `git commit -m "feat(mail): add imap smtp sync and local mail storage"`.
