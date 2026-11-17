## Why

Smart tags are the second intelligence lane and the first one with a feedback loop: when a user rejects a tag, similar future mail should reflect that preference. This package delivers the `TagProcessor`, the phase-one built-in tag list, and the local feedback-rule learning mechanism that adjusts tag confidence for sender/subject-similar mail.

## What Changes

- Add `server/wemail/ai/prompts/tagPrompt.ts` — fixed prompt that returns tag suggestions over the phase-one built-in tag vocabulary.
- Add `server/wemail/intelligence/processors/TagProcessor.ts` — reads mail via `DB Service mail API`, calls `LlmClient` (reused from Package E), applies feedback rules to filter/demote suggestions, persists results into `mail_ai_artifacts`.
- Modify `server/wemail/db/schema.ts` and `server/wemail/db/migrations.ts` — ensure `mail_tag_feedback_rules` has the columns needed (sender pattern, subject pattern, tag, action, confidence delta).
- Modify `server/api/routes/intelligenceRoutes.ts` — expose accept/reject endpoints that persist feedback rules, and include final tag decisions in the message intelligence response.
- Phase-one built-in tags: 通知, 待回复, 发布, 告警, 日报, 需求, 会议, 审批.

## Capabilities

### New Capabilities
- `tag-processor-feedback`: smart-tag generation, accept/reject feedback persistence, and rule-based demotion on sender/subject-similar mail.

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
- Logout MUST NOT wipe local DB; feedback rules survive logout.
- New mail → durable queue; summary retry ≤ 2 (tag retry policy inherits the same cap).
- One fixed summary prompt (summary specifically; tags use their own fixed prompt module).
- Agent may draft but never auto-send.
- No mail body in logs.
- Windows-only phase one, but logic stays cross-platform.

## Impact

- Code: `server/wemail/ai/prompts/tagPrompt.ts`, `server/wemail/intelligence/processors/TagProcessor.ts`, `server/wemail/db/*`, `server/api/routes/intelligenceRoutes.ts`.
- DB: additions to `mail_tag_feedback_rules` schema if columns are missing.
- API: tag suggestion payloads + accept/reject endpoints.
- Dependencies: none new.
