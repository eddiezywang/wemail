## Why

WeCLI is the internal productivity CLI the mail agent will rely on. Phase one requires that read-only `ls/list` commands auto-execute while every other command requires user confirmation, and every invocation is audited. This package implements the classifier, the runtime, and the audit log repository behind the existing skill routes.

## What Changes

- Add `server/wemail/skills/WecliTypes.ts` — shared types for command classification and run results.
- Add `server/wemail/skills/WecliCommandClassifier.ts` — classifies a command as `auto` (`ls/list`) or `requires-confirmation` (everything else).
- Add `server/wemail/skills/WecliSkillRuntime.ts` — executes `wecli ... -f json`, persists audit entries, enforces confirmation.
- Add `server/wemail/telemetry/AuditLogRepository.ts` — writes into `wecli_audit_logs`.
- Modify `server/api/routes/skillRoutes.ts` — wire classify / run endpoints to the runtime.
- Modify `app/components/wemail/AgentActionConfirmDialog.tsx` — this package consumes the dialog introduced by Package D.

## Capabilities

### New Capabilities
- `wecli-runtime-audit`: the WeCLI classifier, execution runtime, and audit log.

### Modified Capabilities
- (none)

## Dependencies

- Upstream OpenSpec changes: **Package C** (processor / queue context and the broader server layer). `AgentActionConfirmDialog` is introduced by Package D but this package's server side does not hard-depend on the UI to ship.

## Constraints

Hard constraints from Handoff §2 that this change MUST honor:

- Electron + single account + IMAP/SMTP.
- LLM: OpenAI-compatible + Anthropic Messages.
- Built-in agent is PI (not Claude Code).
- **WeCLI: auto-approve `ls/list` only; everything else needs confirmation; all audited.** (This package enforces the rule.)
- Logout MUST NOT wipe local DB (audit log preserved until retention).
- New mail → durable queue; summary retry ≤ 2.
- One fixed summary prompt.
- Agent may draft but never auto-send.
- No mail body in logs — audit log records command + outcome, not mail content.
- Windows-only phase one, but logic stays cross-platform.

## Impact

- Code: `server/wemail/skills/*`, `server/wemail/telemetry/AuditLogRepository.ts`, `server/api/routes/skillRoutes.ts`, `app/components/wemail/AgentActionConfirmDialog.tsx` (consumer wiring only).
- DB: writes into existing `wecli_audit_logs` table.
- Dependencies: no new runtime dependencies; requires `wecli` on the user's PATH.
