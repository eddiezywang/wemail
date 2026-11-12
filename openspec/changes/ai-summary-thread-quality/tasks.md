# AI Summary Thread Quality - Tasks

## Implementation

- [ ] Write failing processor tests for email mode output shape and evidence references.
- [ ] Write failing processor tests for thread mode chronological compression and long-content truncation.
- [ ] Write failing tests for fenced output, invalid JSON shape, missing mail, and no-body mail.
- [ ] Extend summary contracts while preserving existing single-mail API compatibility.
- [ ] Implement profile summary-language handling in prompt/context construction.
- [ ] Implement evidence references to source email ids or section ids.
- [ ] Implement idempotent retry behavior for failed summaries.
- [ ] Add at least 20 summary fixtures and golden eval assertions.
- [ ] Add route tests for trigger, retry, success, failed, and skipped states.
- [ ] Run focused summary processor, route, and eval tests.
- [ ] Run `npm run typecheck:server`.
- [ ] Run `npm run test:server`.

## Execution Agent Report

```text
Change ID: ai-summary-thread-quality
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

Block merge if summaries fabricate deadlines/actions, thread summaries lack source evidence, or retry creates duplicate jobs/results.
