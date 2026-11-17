## Why

Packages B and C make mail and intelligence jobs real, but users still see nothing: the existing `EmailPanel` renders mail without summary, tag, or draft surfaces. This package adds the incremental UI on top of the existing React detail view so enterprise users get summary, smart tags, smart drafts, queue state, and an agent confirmation dialog — without redesigning the mailbox.

## What Changes

- Add `app/components/wemail/EmailSummaryCard.tsx` — renders empty / pending / success / failed states for a message's summary.
- Add `app/components/wemail/EmailSmartTags.tsx` — shows AI-suggested + user-accepted tags with accept/reject affordances.
- Add `app/components/wemail/SmartDraftPanel.tsx` — shows generated draft, allows edit, accept, delete.
- Add `app/components/wemail/IntelligenceStatus.tsx` — aggregated per-message job status.
- Add `app/components/wemail/QueueStatusBadge.tsx` — global queue indicator.
- Add `app/components/wemail/AgentActionConfirmDialog.tsx` — the confirmation modal used by Packages I (WeCLI) and J (agent).
- Modify `app/components/EmailPanel.tsx` to slot the new components into the existing detail layout.
- Add `app/queries/intelligence.ts` and `app/queries/queue.ts` for React Query (or equivalent) access to `/api/intelligence/*` and queue status.
- Modify `app/services/api.ts` to expose the new endpoints.
- Add `app/types/wemail.ts` for renderer-scoped types derived from `shared/wemail/*`.
- UI text MUST support Chinese and English.

## Capabilities

### New Capabilities
- `frontend-intelligence-ui`: the desktop renderer surfaces for summary, smart tags, smart drafts, queue status, and agent confirmation.

### Modified Capabilities
- (none)

## Dependencies

- Upstream OpenSpec changes: **Package B** (mail list/detail endpoints must return real data) and **Package C** (intelligence jobs and queue state must be observable).
- The confirm dialog is consumed by Packages I and J but lives here by design.

## Constraints

Hard constraints from Handoff §2 that this change MUST honor:

- Electron + single account + IMAP/SMTP.
- LLM: OpenAI-compatible + Anthropic Messages (not consumed here).
- Built-in agent is PI (not Claude Code).
- WeCLI: auto-approve `ls/list` only; everything else needs confirmation (the confirm dialog is the UI surface for this rule); all audited.
- Logout MUST NOT wipe local DB (UI must not trigger destructive local clears on logout).
- New mail → durable queue; UI reflects queue state but MUST NOT bypass it.
- Summary retry ≤ 2.
- One fixed summary prompt.
- Agent may draft but never auto-send (no "send" button wired into draft generation alone).
- No mail body in logs (renderer telemetry, if any, must not send bodies).
- Windows-only phase one, but components stay cross-platform.

## Impact

- Code: `app/components/wemail/*`, `app/components/EmailPanel.tsx`, `app/queries/*`, `app/services/api.ts`, `app/types/wemail.ts`.
- API consumption: `/api/intelligence/messages/:id`, queue endpoints, draft accept/reject endpoints.
- Dependencies: no new runtime dependencies; uses existing React / query layer.
