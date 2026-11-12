## Why

Package A lets WeMail persist an IMAP/SMTP account, but there is still no real data entering the app. This package implements phase one's single most important data path: pull mail via IMAP, normalize it, persist to local SQLite, and send reviewed drafts via SMTP. Without this, every downstream intelligence or UI package has nothing real to operate on.

## What Changes

- Add `server/wemail/mail/MailProvider.ts` — the protocol-agnostic provider interface (`connect / disconnect / syncRecent / getMessage / sendDraft`).
- Add `server/wemail/mail/ImapSmtpMailProvider.ts` — concrete IMAP (`imapflow`) + SMTP (`nodemailer`) implementation, Inbox-only for phase one.
- Add `server/wemail/mail/DB Service mail API.ts` — `upsertMessage / listMessages / getMessageById / findRecentSyncCursor`.
- Add `server/wemail/mail/Mail Core sync worker.ts` — startup sync of recent N messages, new-mail emission, queue job creation (will be wired fully in Package C).
- Add `server/wemail/mail/normalizeMail.ts` — turn IMAP payloads into the shared `MailMessage` DTO.
- Modify `server/wemail/db/schema.ts` and `server/wemail/db/migrations.ts` to add any missing columns required by normalized mail and sync cursor.
- Modify `server/api/routes/mailRoutes.ts` to return repository-backed data from `GET /api/mail/messages` and `GET /api/mail/messages/:id`.

## Capabilities

### New Capabilities
- `mail-sync`: IMAP fetch, SMTP send, local mail persistence, and the MailProvider abstraction used by the intelligence pipeline and agent tools.

### Modified Capabilities
- (none)

## Dependencies

- Upstream OpenSpec changes: **Package A** (`wemail-pkg-a-account-secretstore`) — provides `AccountService` and `SecretStore` so the provider can read IMAP/SMTP credentials.
- Downstream consumers: Package C (queue wiring), Package D (frontend), Package J (agent tools).

## Constraints

Hard constraints from Handoff §2 that this change MUST honor:

- Electron + single account + IMAP/SMTP.
- LLM: OpenAI-compatible + Anthropic Messages (not consumed here).
- Built-in agent is PI (not Claude Code).
- WeCLI: auto-approve `ls/list` only; everything else needs confirmation; all audited.
- Logout MUST NOT wipe local DB.
- New mail → durable queue; summary retry ≤ 2.
- One fixed summary prompt.
- Agent may draft but never auto-send.
- No mail body in logs (normalizer and provider MUST NOT pass bodies to AppLogger).
- Windows-only for phase one, but cross-platform logic preserved.

## Impact

- Code: `server/wemail/mail/*`, `server/wemail/db/{schema,migrations}.ts`, `server/api/routes/mailRoutes.ts`.
- API: `GET /api/mail/messages`, `GET /api/mail/messages/:id`, and a send path invoked from the reviewed draft flow.
- DB: possible additions for sync cursor and normalized headers in `mail_messages` table.
- Dependencies: `imapflow`, `nodemailer` (add if not already present).
