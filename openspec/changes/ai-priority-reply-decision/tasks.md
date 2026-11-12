# AI Priority Reply Decision - Tasks

## Implementation

- [ ] Write failing tests for `PriorityResult` shape, reason, signals, and optional deadline.
- [ ] Write failing tests for deterministic output with identical stored inputs and processor version.
- [ ] Write failing tests that bulk/newsletter/marketing mail defaults low unless strong contrary evidence exists.
- [ ] Write failing tests that direct requests with deadline become high priority.
- [ ] Align existing `replyDecision` route/tool result with priority state.
- [ ] Implement signal extraction for sender, questions, deadlines, direct/cc, reply history, and system category.
- [ ] Ensure priority processor never enqueues or generates reply drafts.
- [ ] Add at least 25 priority fixtures and eval thresholds.
- [ ] Add route and agent-tool tests for state-aware reply decision output.
- [ ] Run focused priority/reply-decision tests and eval.
- [ ] Run `npm run typecheck:server`.
- [ ] Run `npm run test:server`.

## Execution Agent Report

```text
Change ID: ai-priority-reply-decision
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

Block merge if priority lacks a reason, bulk mail is commonly high priority, or this processor directly generates drafts.
