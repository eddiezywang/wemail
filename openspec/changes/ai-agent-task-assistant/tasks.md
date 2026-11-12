# AI Agent Task Assistant - Tasks

## Implementation

- [ ] Write failing route tests for email-scoped suggestions based on summary/todo/draft/translation state.
- [ ] Write failing route tests for account-scoped suggestions and missing context.
- [ ] Write failing tests that mail-content answers include citations to tool results.
- [ ] Write failing tests that tool errors return recovery suggestions.
- [ ] Write failing tests that high-risk actions return `pendingAction` and are not executed.
- [ ] Add context support for `emailId`, `accountId`, and `threadId` in agent conversations.
- [ ] Implement state-aware suggestion builder.
- [ ] Implement citation propagation from tool results to final agent response.
- [ ] Ensure mutating tool calls include audit caller source `agent`.
- [ ] Add at least 15 scripted planner tests.
- [ ] Run focused agent route, tool, and planner tests.
- [ ] Run `npm run typecheck:server`.
- [ ] Run `npm run test:server`.

## Execution Agent Report

```text
Change ID: ai-agent-task-assistant
Goal:
Files touched:
Spec scenarios implemented:
Tests added:
Verification commands:
Known gaps:
Risk notes:
Ready for review: yes/no
```

## Merge Gate

Block merge if the agent directly executes high-risk actions, answers mail facts without citations, or ignores `context.emailId`.
