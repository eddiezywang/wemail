## 1. Bus and processor interface

- [x] 1.1 Write failing unit test for `MailIntelligenceBus.registerProcessor` + `dispatch`: registered processor is called; unregistered kind returns a safe "no processor" result.
- [x] 1.2 Create `server/wemail/intelligence/MailIntelligenceProcessor.ts` with the processor interface.
- [x] 1.3 Create `server/wemail/intelligence/MailIntelligenceBus.ts`; run tests until green.

## 2. Job repository enhancements

- [x] 2.1 Write failing unit test: `JobRepository.enqueueForMessage(messageId)` inserts exactly three rows (`summary`, `tags`, `replyDraft`), idempotent under re-insert.
- [x] 2.2 Modify `server/wemail/queue/JobRepository.ts` to add `enqueueForMessage`, claim/lease, and status transitions (`pending`/`in_flight`/`done`/`failed`).
- [x] 2.3 Add UNIQUE constraint on `(message_id, kind)` via a new migration; ensure existing migrations stay idempotent.

## 3. QueueRunner

- [x] 3.1 Write failing unit test: runner claims pending jobs, dispatches via bus, marks `done` on success, increments `attempts` and stores `last_error` on failure.
- [x] 3.2 Write failing unit test: expired leases from simulated crash become `pending` again on startup.
- [x] 3.3 Modify `server/wemail/queue/QueueRunner.ts` to implement the above.

## 4. Wire sync → queue

- [x] 4.1 Write failing integration test: inserting a new message via `Mail Core sync worker` (or a direct `DB Service mail API.upsertMessage`) produces three pending `mail_jobs` rows.
- [x] 4.2 Modify `server/api/routes/mailRoutes.ts` so sync / test-sync responses include the created job ids.
- [x] 4.3 Run integration tests until green.

## 5. Safety

- [x] 5.1 Write test asserting job payload rows never contain mail body text or attachment bytes.
- [x] 5.2 Write test that a dispatch with no registered processor does not throw and does not lose the job.

## 6. Verification

- [x] 6.1 Run `npm run test:server` — must pass.
- [x] 6.2 Run `npm run typecheck:server` — must pass.
- [x] 6.3 Run `npm run typecheck:desktop` — must pass.
- [x] 6.4 Run `npm run build:desktop` — must pass.
- [x] 6.5 Confirm new code has unit tests for bus, repository, runner, and wiring.
- [x] 6.6 Confirm no violations of Handoff §6 hard rules (queue is not bypassed, no body in logs, no business logic in Electron main).
- [x] 6.7 Commit with the exact Handoff §5.C message: `git commit -m "feat(queue): wire synced mail into intelligence jobs"`.
