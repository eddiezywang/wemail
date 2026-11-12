## 1. Runtime interface

- [x] 1.1 Write failing unit test for `AgentRuntime` shape (start session, submit user turn, receive tool-call stream).
- [x] 1.2 Create `server/wemail/agent/AgentRuntime.ts`.

## 2. MailAgentTools

- [x] 2.1 Write failing unit test for each tool's happy path (`list_mail`, `read_mail`, `search_mail`, `get_summary`, `draft_reply`, `wecli_query`, `wecli_action_preview`).
- [x] 2.2 Write failing unit test: unknown tool name is rejected.
- [x] 2.3 Write failing unit test: `draft_reply` never calls `MailProvider.sendDraft`.
- [x] 2.4 Write failing unit test: `wecli_query` with a non-`ls/list` command is rejected (points to `wecli_action_preview`).
- [x] 2.5 Write failing unit test: `wecli_action_preview` returns `{ executed: false }` and spawns nothing.
- [x] 2.6 Create `server/wemail/agent/MailAgentTools.ts` consuming `DB Service mail API`, `mail_ai_artifacts` readers, and `WecliSkillRuntime`.

## 3. PiAgentRuntime

- [x] 3.1 Write failing unit test: PI runtime wires the tool surface and routes LLM tool calls through the dispatcher.
- [x] 3.2 Create `server/wemail/agent/PiAgentRuntime.ts` reusing `LlmClient`.
- [x] 3.3 Run tests until green.

## 4. Route wiring

- [x] 4.1 Write failing integration test for agent session endpoints.
- [x] 4.2 Modify `server/api/routes/agentRoutes.ts` to resolve `PiAgentRuntime` by default.

## 5. Safety

- [x] 5.1 Write test that agent traces never contain mail body text.
- [x] 5.2 Write test that the code path from `draft_reply` has no reachable `sendDraft` call.

## 6. Verification

- [x] 6.1 Run `npm run test:server` — must pass.
- [x] 6.2 Run `npm run typecheck:server` — must pass.
- [x] 6.3 Run `npm run typecheck:desktop` — must pass.
- [x] 6.4 Run `npm run build:desktop` — must pass.
- [x] 6.5 Confirm new code has unit / integration tests for runtime, tools, and routes.
- [x] 6.6 Confirm no violations of Handoff §6 hard rules (agent never auto-sends, WeCLI confirmation never bypassed, no body in logs).
- [x] 6.7 Commit with the exact Handoff §5.J message: `git commit -m "feat(agent): add pi runtime boundary"`.
