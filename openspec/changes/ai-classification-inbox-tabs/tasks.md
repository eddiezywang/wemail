# AI Classification Inbox Tabs - Tasks

## Implementation

- [ ] Write failing contract tests for canonical system category ids.
- [ ] Write failing route tests for `GET /api/intelligence/categories` system plus dynamic categories.
- [ ] Write failing route tests for `GET /api/mail/messages?category=...` with inbox alias, limit, unknown category, and account isolation.
- [ ] Extend classification result with `reason` and `confidence`.
- [ ] Implement stable system taxonomy and category count derivation.
- [ ] Preserve dynamic tags after required system categories.
- [ ] Implement reject feedback suppression for same sender plus normalized subject pattern.
- [ ] Add at least 30 classification fixtures and eval thresholds.
- [ ] Run focused classification, category, mail-route, and eval tests.
- [ ] Run `npm run typecheck:server`.
- [ ] Run `npm run test:server`.
- [ ] If frontend tabs are touched, run the relevant client typecheck command.

## Execution Agent Report

```text
Change ID: ai-classification-inbox-tabs
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

Block merge if frontend or API uses display labels as ids, category data crosses accounts, or dynamic categories replace required system categories.
