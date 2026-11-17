## Context

`LlmClient` exists (Package E). `replyDraft` jobs are already enqueued (Package C). The reply draft lane additionally needs a classification step and a feedback log whose format is Markdown to keep it human-readable without DB complexity.

## Goals / Non-Goals

**Goals:**

- Classify each message as "needs reply" vs "does not need reply" with a conservative default for mass mail.
- Generate a local draft when a reply is needed; do NOT auto-send.
- Persist draft lifecycle events (`generated`, `accepted`, `edited_and_sent`, `deleted`) into a Markdown file under the user-data dir.
- Expose the draft and verdict via the existing intelligence API, plus draft-action endpoints on mail routes.

**Non-Goals:**

- Auto-send (forbidden).
- Thread-level context beyond the single message + its header fields.
- Structured (DB) analytics of feedback — Markdown is the product choice for phase one.

## Decisions

- **Rules (from Handoff §5.G).** Notification-class mail → usually no reply. Questions / confirmations / back-and-forth → usually reply. Mass mail → conservative (default no reply unless high confidence signals otherwise). These rules live in the fixed prompt.
- **Single fixed prompt.** `replyDraftPrompt.ts` exports `REPLY_DRAFT_SYSTEM`, `REPLY_DRAFT_USER_TEMPLATE`, and `REPLY_DRAFT_SCHEMA` which includes `{ shouldReply: boolean, rationale: string, draft?: { subject, body } }`.
- **Processor writes to `mail_ai_artifacts`.** The draft + verdict are persisted; the renderer reads through `/api/intelligence/messages/:id`.
- **`DraftFeedbackLog`.** Appends a dated Markdown section per event, containing event type, message id, thread reference, and a truncated subject — NEVER the incoming body. Drafts authored by the system MAY include the draft text (it is user-owned, not incoming mail) but we still prefer a short excerpt to keep the log readable.
- **Mail route endpoints.** `POST /api/mail/messages/:id/draft/accept`, `.../draft/edit_and_sent`, `.../draft/delete`. These call `DraftFeedbackLog.append(event)` and update `mail_ai_artifacts`.
- **Reuse of LlmClient.** No new AI client. Upstream interfaces consumed: `MailIntelligenceProcessor` (Package C), `LlmClient` (Package E), `DB Service mail API` (Package B), `MailProvider.sendDraft` (Package B) is called only by the existing reviewed-send path — not by this processor.
- **Agent boundary.** This package never calls SMTP. Send goes through the reviewed-draft path owned by Package B and user action in the renderer.

## Risks / Trade-offs

- **[Risk] Markdown log grows without bound.** → Mitigation: Handoff §5.H keeps this log in long-retention explicitly; consider rotation per-month filename.
- **[Risk] Concurrent writes to a single Markdown file.** → Mitigation: serialize writes through a small async queue or use `fs.promises.appendFile` with a mutex per process.
- **[Risk] Draft content accidentally leaking sensitive info.** → Mitigation: log contains only outbound draft text (user-owned) + metadata; incoming mail body is never written to the log.
- **[Risk] Misclassification auto-decides for the user.** → Mitigation: UI always presents the draft for accept/edit/delete; the processor never triggers send.

## Migration Plan

- Additive. No schema changes required beyond what `mail_ai_artifacts` already supports.
- Rollback: remove the processor, the prompt module, the telemetry file, and revert route additions.

## Open Questions

- Markdown file naming convention (`draft-feedback-YYYY-MM.md` vs single file) — resolved during implementation.
