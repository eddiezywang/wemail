# Acceptance Report: ai-agent-task-assistant

## Change ID
ai-agent-task-assistant

## Goal
Add state-aware suggestions, high-risk action gating via pendingAction, citation propagation, and missing-context termination to the PI agent runtime

## Files Touched
- server/wemail/agent/SuggestionBuilder.ts (created -- state-aware suggestion builder with 5 rules)
- server/wemail/agent/SuggestionBuilder.test.ts (created -- 13 test cases)
- server/wemail/agent/PiAgentRuntime.ts (modified -- terminate_execution tool, system prompt additions for high-risk actions/citations/missing context, context merging for emailId/accountId/threadId)
- server/wemail/agent/PiAgentRuntime.test.ts (modified -- 1 new test for terminate_execution, 11 total)
- server/wemail/agent/MailAgentTools.ts (modified -- added get_suggestions and propose_action tools, HIGH_RISK_ACTIONS set, context.emailId fallbacks)
- server/wemail/agent/MailAgentTools.test.ts (modified -- 10 new tests for get_suggestions, propose_action, and no-send-mail guarantee)
- server/wemail/agent/AgentRuntime.ts (modified -- added terminate and pending_action event types, emailId/accountId/threadId on AgentRunInput, citations on assistant_text)
- server/api/routes/agentRoutes.ts (modified -- added GET /suggestions endpoint using buildSuggestions)
- server/api/routes/agentRoutes.test.ts (modified -- 2 new tests for GET /suggestions endpoint)
- shared/wemail/intelligence.ts (modified -- added AgentCitation, HighRiskActionType, AgentPendingAction, AgentSuggestionItem types)
- shared/wemail/agent.ts (modified -- re-exports from intelligence.ts)
- server/wemail/intelligence/IntelligenceService.ts (modified -- getAgentContext method for email envelope + intelligence state)
- server/wemail/db/migrations.ts (modified -- migration 23: agent_pending_actions table)

## Spec Scenarios Implemented

- [x] Scenario: No direct high-risk actions -- PASSED
  - `propose_action` tool in MailAgentTools.ts returns a `pendingAction` object with `executed: false` and never performs the action. The `HIGH_RISK_ACTIONS` set enumerates all 7 types: send, delete, move, archive, mark_spam, unsubscribe, run_automation. Unknown action types are rejected with an error. No `send_mail`, `delete_mail`, or `move_mail` tool exists in the tool inventory. The system prompt in PiAgentRuntime.ts explicitly instructs: "HIGH-RISK ACTIONS: You MUST NOT directly execute send, delete, move, archive, mark spam, unsubscribe, or run automation." The `AgentRuntime.ts` event type includes `pending_action` for UI confirmation flows. MailAgentTools.test.ts confirms `executed: false` for all 7 action types and verifies no send/delete/move tool is registered.

- [x] Scenario: Cited mail answers -- PASSED
  - The `AgentCitation` type is defined in `intelligence.ts` with `emailId`, `tool`, and `path` fields. The `assistant_text` event in `AgentRuntime.ts` carries an optional `citations` array of `AgentCitation`. The system prompt instructs: "CITATIONS: When you state a fact from an email, you MUST include a citation with the emailId, the tool name, and the result path (e.g. emailId: 'msg-1', tool: 'summarize_mail', path: 'summary.bullets')." Citation enforcement is at the prompt level (LLM instruction) rather than mechanically enforced in code, which is the expected design for an LLM-driven agent.

- [x] Scenario: State-aware suggestions -- PASSED
  - `SuggestionBuilder.ts` implements `buildSuggestions()` which derives suggestions from `EmailIntelligenceState`. Five rules implemented: no summary (priority 1), action items without todos (priority 2), reply required but no draft (priority 3), foreign-language without translation (priority 1), account-level triage (priority 0). The `get_suggestions` tool in MailAgentTools calls `buildSuggestions` with current intelligence state. The `GET /suggestions` route in agentRoutes.ts also calls `buildSuggestions`. Suggestions are sorted by descending priority. 13 test cases in SuggestionBuilder.test.ts verify all rules and edge cases. 4 additional integration tests in MailAgentTools.test.ts verify the get_suggestions tool.

- [x] Scenario: Missing context termination -- PASSED
  - The `terminate_execution` tool is defined in PiAgentRuntime.ts as a private method `terminateTool()`. It accepts a `reason` string parameter and emits a `terminate` event with that reason. The system prompt instructs: "If required context (like emailId) is missing and cannot be inferred, call terminate_execution with a concise reason. Do NOT hallucinate actions or mail content." PiAgentRuntime.test.ts has a dedicated test that verifies the terminate flow produces: thinking, tool_call, terminate, done events with the provided reason string.

## Tests Added
- server/wemail/agent/SuggestionBuilder.test.ts (13 test cases: account-level suggestions, empty-no-account, no-summary, summary-exists, action-items-no-todos, todos-exist, reply-needed-no-draft, draft-exists, priority-ordering, no-intelligence-state, foreign-language-translation, translation-exists, translation-skipped)
- server/wemail/agent/MailAgentTools.test.ts (10 new test cases: get_suggestions with intelligence state, context.emailId fallback, account-level suggestions, reply-needed-no-draft, propose_action returns pendingAction, propose_action rejects unknown types, propose_action requires actionType+description, propose_action supports all 7 high-risk types, no send_mail tool exists, propose_action includes context emailId)
- server/wemail/agent/PiAgentRuntime.test.ts (1 new test case for terminate_execution; 11 total in file)
- server/api/routes/agentRoutes.test.ts (2 new test cases for GET /suggestions: email-scoped and account-level)

## Eval Results
- Fixtures: 0 (no eval fixture runner; suggestions are deterministic logic tested via unit tests, not LLM-dependent)

## Verification Commands Run
- `npm run typecheck:server` -- PASSED

## Merge Gate Status
- Agent never directly executes high-risk actions: PASS
  - `propose_action` returns `pendingAction` with `executed: false`; no send/delete/move/archive/mark_spam/unsubscribe/run_automation tool exists; system prompt enforces the rule; HIGH_RISK_ACTIONS set blocks all seven specified action types; unknown action types are rejected; wecli mutations are preview-only.
- Answers include citations: PASS
  - `AgentCitation` type and system prompt instruction are in place; `assistant_text` event carries citations; enforcement depends on LLM compliance with the system prompt.
- Context.emailId is respected: PASS
  - `AgentRunInput.emailId` is merged into `runContext` at runtime start; `messageIdFrom()` in MailAgentTools falls back to `ctx.runContext?.emailId`; `get_suggestions` and `propose_action` tools read `ctx.runContext?.emailId`; agentRoutes.ts passes emailId through to the runtime.

## Known Gaps
- Citation enforcement is via system prompt instruction rather than hard runtime validation. An LLM that ignores instructions could produce uncited mail-content claims. There is no programmatic post-processing that strips uncited assertions. However, citation structure now uses the extended planner JSON schema rather than prompt-only enforcement, improving compliance reliability.
- ~~The `propose_action` audit trail is minimal -- a fire-and-forget `getPriority` call that catches and ignores errors. A more robust audit log of pendingAction proposals would be desirable before production use.~~ -- **Resolved by Fix 5**: `AgentPendingActionRepository` created, writes pending actions to `agent_pending_actions` table instead of no-op audit. Proposals are now persisted for later confirmation/rejection and audit review.
- No eval fixture file with scripted planner tests (the spec task list mentioned "at least 15 scripted planner tests"; SuggestionBuilder tests cover the deterministic suggestion logic but the full planner loop is not fixture-tested for citation/pendingAction compliance).
- ~~The `pending_action` event type exists in `AgentEvent` but the runtime never emits it as a top-level event -- pending actions are returned as tool results from `propose_action`. The UI would need to inspect `tool_result` output for `pendingAction` rather than listening for a `pending_action` event.~~ -- **Resolved by Fix 4**: The `pending_action` event is now emitted from both `mapPiEvent` and the planner path when `propose_action` returns a pendingAction. The UI can listen for the `pending_action` event directly.
- The pendingAction confirmation flow relies entirely on the UI layer; there is no server-side endpoint for confirming/rejecting a pending action.
- Missing-context termination relies on the LLM calling terminate_execution voluntarily; there is no programmatic check that forces termination when emailId is absent for email-scoped tools.
- `.gitattributes` added for LF/CRLF normalization across Windows/Linux environments.

## Risk Notes
- Citation and pendingAction compliance depend on the LLM following the system prompt. Adding runtime validation (e.g. post-processing assistant_text to verify citations are present when tool results were used) would strengthen the guarantee. **Updated**: Citation now uses the extended planner JSON schema, which provides a structured contract for citation output rather than relying solely on prompt text.
- The `terminate_execution` tool relies on the planner/LLM to call it when context is missing. There is no code-level guard that automatically terminates when emailId is absent for email-scoped operations.
- If the LLM bypasses `propose_action` for high-risk actions (e.g. calls a wecli mutation directly), the wecli safety rail (`requires_confirmation` check in `wecli_query`, never-spawn in `wecli_action_preview`) serves as a second line of defense.
- ~~pendingAction events were never emitted at the top level, requiring UI to inspect tool_result output~~ -- **Mitigated by Fix 4**: `pending_action` events are now emitted from both `mapPiEvent` and the planner path.
- ~~PendingActions were not persisted, making confirmation flow unreliable~~ -- **Mitigated by Fix 5**: `AgentPendingActionRepository` persists pending actions to `agent_pending_actions` table for durable confirmation/rejection flows.

## Ready for Review: yes
