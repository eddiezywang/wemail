# AI Automation Rule Suggestions - Tasks

## Implementation

- [ ] Write failing route tests for `POST /api/automation/rules/suggest`.
- [ ] Write failing tests that suggestions return disabled drafts and do not save enabled rules.
- [ ] Write failing dry-run tests for matched mail, match reasons, and planned actions.
- [ ] Write failing tests that disabled rules do not execute.
- [ ] Write failing tests that trash/spam/archive actions return 400 without explicit confirmation.
- [ ] Implement suggestion input handling for emailId, sender, category, and naturalLanguageIntent.
- [ ] Implement dry-run count/reason consistency with run.
- [ ] Implement audited rule run with matched/applied counts.
- [ ] Add at least 15 automation fixtures.
- [ ] Run focused automation suggestion, dry-run, run, and route tests.
- [ ] Run `npm run typecheck:server`.
- [ ] Run `npm run test:server`.

## Execution Agent Report

```text
Change ID: ai-automation-rule-suggestions
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

Block merge if AI suggestion auto-enables a rule, dry-run omits match reasons, or dangerous actions run without confirmation.
