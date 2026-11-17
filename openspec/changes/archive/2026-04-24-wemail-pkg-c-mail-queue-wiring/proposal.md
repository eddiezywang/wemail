## Why

Package B delivers mail into the local DB but does nothing with it. The whole WeMail intelligence pipeline is built around a durable, resumable job queue, and Handoff §2 requires that new mail MUST flow through it (Hard rule: "不要绕过队列"). This package connects mail sync to the queue and introduces the `MailIntelligenceBus` / `MailIntelligenceProcessor` seam that Packages E/F/G will plug into.

## What Changes

- Modify `server/api/routes/mailRoutes.ts` so sync/test-sync endpoints return the created job ids alongside messages.
- Modify `server/wemail/queue/JobRepository.ts` and `server/wemail/queue/QueueRunner.ts` so the runner pulls pending jobs from DB, dispatches to registered processors, and survives restarts.
- Add `server/wemail/intelligence/MailIntelligenceBus.ts` — processor registry and dispatch surface.
- Add `server/wemail/intelligence/MailIntelligenceProcessor.ts` — the processor interface (id, job kind, `handle(job, context)` contract) that Packages E/F/G implement.
- On every new mail insert, enqueue three jobs: `summary`, `tags`, `replyDraft`.
- Allow the processor registry to be empty (no-op) while still persisting jobs.

## Capabilities

### New Capabilities
- `mail-queue-wiring`: connects mail sync to the durable queue and defines the processor registration contract used by intelligence packages.

### Modified Capabilities
- (none)

## Dependencies

- Upstream OpenSpec changes: **Package B** (`wemail-pkg-b-imap-smtp-sync`) — provides the "new mail" event and `DB Service mail API`.
- Transitively depends on Package A (account context).
- Downstream consumers: Packages D, E, F, G, H, J all depend on this wiring existing.

## Constraints

Hard constraints from Handoff §2 that this change MUST honor:

- Electron + single account + IMAP/SMTP.
- LLM: OpenAI-compatible + Anthropic Messages (processors not implemented here).
- Built-in agent is PI (not Claude Code).
- WeCLI: auto-approve `ls/list` only; everything else needs confirmation; all audited.
- Logout MUST NOT wipe local DB (queue rows survive logout).
- **New mail → durable queue** (the central rule this package enforces).
- Summary retry ≤ 2.
- One fixed summary prompt.
- Agent may draft but never auto-send.
- No mail body in logs.
- Phase one is Windows-only, but shared logic stays cross-platform.

## Impact

- Code: `server/api/routes/mailRoutes.ts`, `server/wemail/queue/*`, `server/wemail/intelligence/{MailIntelligenceBus,MailIntelligenceProcessor}.ts`.
- DB: `mail_jobs` table already exists; this change drives real inserts into it.
- API: sync/test-sync responses now include created job ids.
- Dependencies: no new npm packages.
