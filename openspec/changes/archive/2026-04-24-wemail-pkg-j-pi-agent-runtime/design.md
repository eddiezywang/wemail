## Context

The server has an `agent` route skeleton and a shared `shared/wemail/agent.ts` DTO file. Nothing backs them yet. The agent lane consumes everything the other packages produced: mail store, summaries, tags, drafts, WeCLI.

## Goals / Non-Goals

**Goals:**

- A thin `AgentRuntime` interface so PI can be swapped later.
- `PiAgentRuntime` that bridges `LlmClient` + tool-call loop specific to PI's conventions.
- A fixed tool surface: `list_mail`, `read_mail`, `search_mail`, `get_summary`, `draft_reply`, `wecli_query`, `wecli_action_preview`.
- Strict boundary: agent never sends mail; agent never executes non-query WeCLI.
- Session endpoints that the renderer drives.

**Non-Goals:**

- Long-lived autonomous agents. Sessions are user-initiated.
- Custom tool definitions supplied by the user.
- Multi-agent orchestration.

## Decisions

- **Tool contracts.**
  - `list_mail({ limit })` → returns summary rows from `DB Service mail API.listMessages`.
  - `read_mail({ messageId })` → returns normalized mail via `DB Service mail API.getMessageById`.
  - `search_mail({ query, limit })` → simple LIKE search for phase one.
  - `get_summary({ messageId })` → reads from `mail_ai_artifacts` (Package E).
  - `draft_reply({ messageId, tone? })` → calls `ReplyDraftProcessor`-equivalent path to produce a draft; persists as a local draft; NEVER sends.
  - `wecli_query({ args })` → `args` must classify as `auto`; calls `WecliSkillRuntime` execute.
  - `wecli_action_preview({ args })` → classifies as `requires-confirmation`; returns the plan + audit-intent row but does NOT execute.
- **Never-auto-send.** `draft_reply` returns a draft payload; the renderer's existing compose / review flow is the only path to SMTP.
- **Logout-safe.** Agent sessions are ephemeral and do not modify account state; logout does not kill persisted drafts.
- **Shared types reused.** `shared/wemail/agent.ts` (AgentSession, AgentToolResult), `shared/wemail/mail.ts`, `shared/wemail/intelligence.ts`, `shared/wemail/skills.ts`. Upstream interfaces consumed: `LlmClient` (E), `DB Service mail API` (B), `mail_ai_artifacts` readers (E/F/G), `WecliSkillRuntime` (I).
- **Traces.** Agent reasoning traces log tool names, argument shapes, outcome codes — not mail bodies.

## Risks / Trade-offs

- **[Risk] PI requests an off-menu tool.** → Mitigation: tool dispatcher rejects unknown names; agent prompt enumerates exactly the seven tools.
- **[Risk] `draft_reply` is used as a covert send.** → Mitigation: code path simply cannot reach SMTP; contract-tested.
- **[Risk] `wecli_action_preview` is mistaken for execution.** → Mitigation: it returns a plan object with `executed = false`; audit row is classification-only, not execution.
- **[Risk] Agent streams too much mail content into traces.** → Mitigation: trace payloads are summaries (ids, counts) unless explicitly required; body content is never appended to `AppLogger`.

## Migration Plan

- Additive only.
- Rollback: remove runtime files and revert route handlers.

## Open Questions

- Session persistence vs ephemeral — phase one: ephemeral only (no resume across app restarts).
