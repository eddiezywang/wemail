## Why

Phase one's built-in agent is PI — not Claude Code. The agent needs a bounded runtime and a well-defined tool surface so it can read mail, inspect summaries, draft replies, and propose (but not execute) WeCLI mutations. This package introduces the `AgentRuntime` seam, the PI implementation, and the phase-one tool inventory.

## What Changes

- Add `server/wemail/agent/AgentRuntime.ts` — provider-agnostic interface for starting agent sessions and streaming tool calls.
- Add `server/wemail/agent/PiAgentRuntime.ts` — PI-specific implementation.
- Add `server/wemail/agent/MailAgentTools.ts` — phase-one tools: `list_mail`, `read_mail`, `search_mail`, `get_summary`, `draft_reply`, `wecli_query`, `wecli_action_preview`.
- Modify `server/api/routes/agentRoutes.ts` — expose session endpoints backed by the runtime.

## Capabilities

### New Capabilities
- `pi-agent-runtime`: the PI-backed agent runtime and its bounded tool surface.

### Modified Capabilities
- (none)

## Dependencies

- Upstream OpenSpec changes: **Package E** (`LlmClient`), **Package F** (tag state), **Package G** (draft state via `mail_ai_artifacts`), **Package I** (WeCLI runtime for `wecli_query` and `wecli_action_preview`).
- Transitively depends on Packages A, B, C.

## Constraints

Hard constraints from Handoff §2 that this change MUST honor:

- Electron + single account + IMAP/SMTP.
- LLM: OpenAI-compatible + Anthropic Messages.
- **Built-in agent is PI (not Claude Code).** (Central rule this package enforces.)
- WeCLI: auto-approve `ls/list` only; everything else needs confirmation; all audited — the agent's `wecli_action_preview` MUST return plans only, never execute.
- Logout MUST NOT wipe local DB.
- New mail → durable queue; summary retry ≤ 2.
- One fixed summary prompt.
- **Agent may draft but never auto-send.** The `draft_reply` tool writes a local draft; it MUST NOT call SMTP.
- No mail body in logs (agent traces should not dump body either).
- Windows-only phase one, but logic stays cross-platform.

## Impact

- Code: `server/wemail/agent/*`, `server/api/routes/agentRoutes.ts`.
- Dependencies: reuses `LlmClient`, `DB Service mail API`, `WecliSkillRuntime`; no new npm packages.
