## Why

Phase one must decide whether each message needs a reply and — when it does — generate a local draft that the user can accept, edit, or delete. The agent MUST NOT auto-send. This package adds the `ReplyDraftProcessor` and a Markdown-based feedback log so the team can learn what drafts were kept, edited, or discarded without exposing that data to any external service.

## What Changes

- Add `server/wemail/ai/prompts/replyDraftPrompt.ts` — fixed prompt for "should reply?" and, when yes, "draft a reply".
- Add `server/wemail/intelligence/processors/ReplyDraftProcessor.ts` — queue-driven processor that decides `shouldReply` and, when true, generates a local draft, persisting to `mail_ai_artifacts`.
- Add `server/wemail/telemetry/DraftFeedbackLog.ts` — writes `generated / accepted / edited_and_sent / deleted` events into a local Markdown file.
- Modify `server/api/routes/mailRoutes.ts` — add endpoints for draft accept / edit_and_sent / delete that invoke the feedback log.
- Modify `server/api/routes/intelligenceRoutes.ts` — expose the draft payload and `shouldReply` verdict.

## Capabilities

### New Capabilities
- `replydraft-markdown-feedback`: reply-need classification, local draft generation, and Markdown-backed feedback log for draft lifecycle events.

### Modified Capabilities
- (none)

## Dependencies

- Upstream OpenSpec changes: **Package C** (queue + processor interface) and **Package E** (reuses `LlmClient`).
- Transitively depends on Packages A and B.

## Constraints

Hard constraints from Handoff §2 that this change MUST honor:

- Electron + single account + IMAP/SMTP.
- LLM: OpenAI-compatible + Anthropic Messages (reused from Package E).
- Built-in agent is PI (not Claude Code).
- WeCLI: auto-approve `ls/list` only; everything else needs confirmation; all audited.
- Logout MUST NOT wipe local DB; the Markdown feedback log is long-retention.
- New mail → durable queue; summary retry ≤ 2 (reply draft inherits a retry cap).
- One fixed summary prompt (reply draft uses its own fixed prompt module — still "one fixed prompt per lane").
- **Agent may draft but never auto-send.** (Central rule this package enforces.)
- No mail body in logs; Markdown feedback log may reference draft metadata but MUST NOT include raw incoming mail body.
- Windows-only phase one, but Markdown path / logic stays cross-platform.

## Impact

- Code: `server/wemail/ai/prompts/replyDraftPrompt.ts`, `server/wemail/intelligence/processors/ReplyDraftProcessor.ts`, `server/wemail/telemetry/DraftFeedbackLog.ts`, `server/api/routes/mailRoutes.ts`, `server/api/routes/intelligenceRoutes.ts`.
- Filesystem: a Markdown feedback log under the user-data directory.
- Dependencies: none new.
