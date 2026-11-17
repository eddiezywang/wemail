# Agent mail context display implementation plan

> **For the implementation session:** execute this plan task by task, keeping the tests as the behavioral contract and running the listed verification commands at each checkpoint.

## Goal

Implement the approved mail-context presentation for the WeMail AI panel: preserve the selected email ID as hidden runtime context, show a compact attached-mail tag on user turns, and remove email IDs, tool names, paths, commands, and raw execution metadata from user-facing assistant content.

## Constraints and compatibility

- Keep `emailId`, `threadId`, citations, tool calls, audit data, and authorization context available to the server/runtime.
- Do not display internal IDs or implementation metadata in the composer, persisted turns, streaming text, suggestions, or execution summaries.
- Existing conversations without `attachedMail` must continue to render.
- Preserve all unrelated workspace changes; implementation is isolated in branch `codex/agent-mail-context-display`.
- Follow the repository style: 2-space indentation, double quotes, semicolons.

## Task 1: Establish the worktree baseline

Files: none.

1. In the implementation worktree, run `npm install` so renderer, server, and typecheck commands use the repository dependencies.
2. Run `npm run typecheck:server`, `npm run typecheck`, and the focused existing AgentPanel and agent-route tests. Record any baseline failure before changing source.
3. Confirm `git status --short` contains only the new plan before implementation begins.

## Task 2: Add failing shared and presentation tests

Files:

- Add `shared/wemail/agent.test.ts` if shared tests are supported by the current Vitest setup, otherwise cover the contract in the renderer tests.
- Add `app/lib/agent-display.test.ts`.
- Extend the existing AgentPanel test file and agent route test file only where their current fixtures already exercise the target behavior.

Tests to write first and run red:

1. `sanitizeAgentDisplayText` removes citation-like `emailId`, `tool`, and `path` fragments while preserving ordinary prose, Chinese “工具/路径”, and useful line breaks.
2. `friendlyToolLabel` returns a human label for known tools and a generic label rather than the raw name for unknown tools.
3. `formatExecutionMessage` retains a concise success/failure summary but excludes command, binary, resolved path, args, stdout, stderr, and raw error codes.
4. `mapConversationMessagesToUiMessages` restores `attachedMail` and the hidden associated email ID from a persisted user message.
5. The route’s focused-email suggestions contain natural language only and no selected email ID.

Run the smallest applicable tests and confirm they fail for the missing behavior before production code is edited.

## Task 3: Define the shared attached-mail contract and sanitization helpers

Files:

- Modify `shared/wemail/agent.ts`.
- Add `app/lib/agent-display.ts`.
- Add `app/components/agent/AgentAttachedMailTag.tsx`.

Implementation:

1. Add `AgentAttachedMail { subject: string; sender?: string; receivedAt?: string }` and add optional `attachedMail` to `AgentChatInput`.
2. Implement focused display helpers in `app/lib/agent-display.ts`:
   - `sanitizeAgentDisplayText(text, options?)` strips known structured citation fragments and collapses excess blank lines without broad word replacement.
   - `friendlyToolLabel(toolName)` returns a human label, including `summarize_mail` as `整理邮件`, and returns `正在处理` for unknown names.
   - `formatAgentExecutionMessage(execution)` renders only business summary/status and a concise human-readable failure reason.
3. Make the attached-mail tag render an envelope icon, `已关联邮件`, the subject (fallback `当前邮件`), optional sender/time detail, and an optional button-like click target. It must never receive or render raw IDs, tool names, paths, or request metadata.

## Task 4: Make the server preserve hidden context and redact user-facing output

Files:

- Modify `server/api/routes/agentRoutes.ts`.
- Modify `server/wemail/agent/PiAgentRuntime.ts`.

Implementation:

1. Validate and accept optional `attachedMail` display metadata in the agent route body.
2. Persist `attachedMail` with the user turn while retaining existing hidden `emailId`, `threadId`, and runtime context fields.
3. Pass display metadata only as context needed for persistence/UI; do not change tool selection or focused-mail scope behavior.
4. Replace focused-email fallback suggestion prompts with natural language prompts that omit the ID while keeping the click request’s hidden ID behavior unchanged.
5. Update the PI system and structured-output instructions so citations stay structured/internal and normal prose never includes email IDs, tool names, JSON paths, action IDs, or raw implementation details.
6. Before SSE delivery and assistant-message persistence, map assistant-facing text through the sanitizer. Keep structured citation fields for internal consumers and keep tool event state available to the client, but never include internal citation text in visible assistant prose.

## Task 5: Render attached-mail context and safe agent output in the panel

Files:

- Modify `app/components/AgentPanel.tsx`.
- Modify `app/types/index.ts` only if the UI message contract is declared there.
- Modify `app/services/api.ts` only if the request type or serializer needs the new shared field.

Implementation:

1. Extend the local UI message type with `attachedMail` and a separate hidden `attachedEmailId`.
2. When sending a message with a selected email, create display metadata from the selected email’s subject/sender/date, attach it to the user UI message, and send it as `attachedMail` while continuing to send the selected ID through the existing hidden fields.
3. Restore attached metadata from persisted user-message bodies. Keep legacy messages without the field unchanged.
4. Render `AgentAttachedMailTag` beside/above the user bubble. Clicking a historical tag selects the associated hidden email ID; the ID is not rendered.
5. Replace the panel’s local sanitizer and execution formatter with the tested helpers. Sanitize both persisted and streaming assistant text.
6. Add a friendly `summarize_mail` label and ensure tool progress is transient; hide completed tool-only parts from persisted history and never fall back to a raw tool name.
7. Keep the existing composer attachment chip and detach behavior intact.

## Task 6: Run focused tests, fix integration/type issues, and review the diff

Files: implementation files above and their tests.

1. Run the focused renderer and server tests. Fix failures without weakening the redaction assertions.
2. Run `npm run typecheck:server`, `npm run typecheck`, and `npm run build`.
3. Run `git diff --check` and inspect `git diff --stat` plus the full diff for accidental ID rendering, raw tool fallback, or unrelated changes.
4. Run the focused tests again after the final edits.

## Task 7: Commit and launch the updated web app

Files: none beyond the implementation and plan.

1. Commit the implementation on `codex/agent-mail-context-display` with a Conventional Commit message such as `feat: hide internal agent mail metadata`.
2. Start the API and renderer from this worktree on an unused local port (use API `3002` and renderer `5174` if the existing development server is still running).
3. Wait for both health/HTTP endpoints, open `http://127.0.0.1:5174/` in the in-app browser, and verify the page renders.
4. Report the implementation, verification commands, commit, and reopened URL. Do not claim the production app is running unless the fresh server processes and browser page are observed.

## Expected verification commands

```text
npm run test:renderer -- app/components/AgentPanel.test.tsx app/lib/agent-display.test.ts
npm run test:server -- server/api/routes/agentRoutes.test.ts
npm run typecheck:server
npm run typecheck
npm run build
git diff --check
```

## Self-review checklist

- [ ] Tests were red before implementation and green after it.
- [ ] `emailId`, `threadId`, tool names, paths, commands, args, stdout, stderr, and raw error codes are not rendered in normal UI text.
- [ ] Selected email IDs still reach the server/runtime through hidden fields.
- [ ] Attached-mail tags persist across reloads and legacy messages still render.
- [ ] Focused suggestions no longer contain IDs.
- [ ] The original workspace’s unrelated changes were not modified.
- [ ] The browser was reopened against the newly launched renderer.
