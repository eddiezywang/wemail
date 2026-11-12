# AI Todo Extraction Quality - Tasks

## Implementation

- [ ] Write failing extraction tests for title, description, dueDate, startTime, confidence, and sourceSpan.
- [ ] Write failing tests that extracted todos are `suggested`, not `confirmed`.
- [ ] Write failing dedupe tests for rerunning extraction on same email/thread.
- [ ] Write failing tests that user deletion suppresses the same suggested todo for that email.
- [ ] Implement unified todo repository support for manual and AI todos.
- [ ] Implement confirm, complete, restore, delete, and list routes with account isolation.
- [ ] Implement dueDate parsing guardrails for explicit or strongly implied dates only.
- [ ] Add automation suppression hook for todo creation.
- [ ] Add at least 25 todo fixtures and eval thresholds.
- [ ] Run focused todo processor, repository, route, and eval tests.
- [ ] Run `npm run typecheck:server`.
- [ ] Run `npm run test:server`.

## Execution Agent Report

```text
Change ID: ai-todo-extraction-quality
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

Block merge if AI creates confirmed todos automatically, deleted suggestions reappear, or ambiguous dates are forced into incorrect due dates.
