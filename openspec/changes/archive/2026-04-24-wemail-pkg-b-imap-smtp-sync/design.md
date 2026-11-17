## Context

The baseline already has an `mail_messages` table and a route skeleton for `/api/mail/*`. There is no IMAP client, no SMTP path, no repository, and no sync service. Package A supplies the account + secret plumbing; this package uses that to actually talk to a real mailbox.

## Goals / Non-Goals

**Goals:**

- One protocol-agnostic `MailProvider` interface consumable by `Mail Core sync worker`, the send-draft flow, and (later) agent tools.
- A concrete IMAP/SMTP implementation using `imapflow` and `nodemailer`, limited to the Inbox, that can authenticate using the `SecretStore`-backed password from Package A.
- A `DB Service mail API` that owns all reads/writes against the `mail_messages` table, plus a sync cursor.
- A `Mail Core sync worker` that, on startup and on demand, pulls recent mail, normalizes it, upserts via the repository, and emits new-message events so Package C can enqueue intelligence jobs.
- Normalized `MailMessage` objects that match `shared/wemail/mail.ts`.

**Non-Goals:**

- Multi-folder, labels, push/IDLE, or partial body streaming (phase two).
- Attachment storage strategy beyond what is already scaffolded.
- Search indexing.

## Decisions

- **`MailProvider` is the seam, not `ImapSmtpMailProvider`.** Consumers (sync service, send flow, agent) depend on the interface from `server/wemail/mail/MailProvider.ts`. Alternative rejected: consumers importing `ImapSmtpMailProvider` directly — locks phase two into IMAP semantics.
- **Normalization lives in one module.** `normalizeMail.ts` converts raw IMAP payloads into the shared `MailMessage` shape. Keeps `ImapSmtpMailProvider` thin and makes normalization unit-testable.
- **Sync cursor is a single row keyed by account id.** `findRecentSyncCursor` returns the last-seen UID / internalDate. Alternative rejected: per-folder cursors — exceeds phase-one scope.
- **`Mail Core sync worker` does not enqueue jobs itself.** It emits a typed "new mail" event; Package C wires that to the queue. Keeps this package focused on I/O.
- **No mail body in logs.** `AppLogger` calls in this module MUST pass only ids, subjects (optional, max 80 chars), or counts. Bodies and attachments never reach logs.
- **Shared types reused:** `shared/wemail/mail.ts` (MailMessage, DraftInput), `shared/wemail/account.ts` (Account). Upstream `AccountService` and `SecretStore` from Package A are consumed through their public APIs only.

## Risks / Trade-offs

- **[Risk] IMAP flakiness and TLS variance across providers.** → Mitigation: wrap `imapflow` connection in a retry-with-backoff, surface typed errors; keep provider interface synchronous-looking so callers have one error path.
- **[Risk] Normalizing mail that contains prompt-injection attempts.** → Mitigation: normalizer preserves raw body but adds structured metadata; downstream prompts (Package E/F/G) are responsible for their own safety boundary.
- **[Risk] Large attachment payloads blowing up memory.** → Mitigation: phase-one fetches headers + text body eagerly, defers full attachment bytes until requested.
- **[Risk] Accidentally logging bodies.** → Mitigation: explicit test that `AppLogger` is never called with body content; review `normalizeMail.ts` for accidental `console.log`.

## Migration Plan

- Schema additions are additive (new columns get sensible defaults / nullable). Migration files extend `server/wemail/db/migrations.ts`.
- Rollback: deleting `server/wemail/mail/*` and reverting route handlers to their skeleton returns to the pre-change state; DB columns remain but unused.

## Open Questions

- Exact `syncRecent` window size (last 50? last 7 days?) — decide during implementation, default 50 messages.
- Whether to store raw RFC822 blob alongside normalized fields — out of phase-one scope.
