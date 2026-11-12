# AI Personalization Learning - Tasks

## Implementation

- [ ] Write failing profile save/read/reset tests for new profile fields.
- [ ] Write failing feedback query tests by account and feature.
- [ ] Write failing tests that reset clears learning summary.
- [ ] Write failing tests that prompt/log output does not expose raw private feedback text.
- [ ] Write failing usage route tests for fixed UI buckets and detailed rows.
- [ ] Extend profile contracts and repository/service.
- [ ] Implement per-feature learning summary aggregation.
- [ ] Integrate prompt builder with profile plus learning summary.
- [ ] Implement usage records grouped by bucket and processor version.
- [ ] Prove draft edited feedback influences writing style summary.
- [ ] Prove tag reject feedback influences classification suppression.
- [ ] Run focused profile, feedback, prompt, usage, and reset tests.
- [ ] Run `npm run typecheck:server`.
- [ ] Run `npm run test:server`.
- [ ] If settings page API consumers are touched, run relevant client typecheck.

## Execution Agent Report

```text
Change ID: ai-personalization-learning
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

Block merge if feedback cannot be reset, prompts/logs leak private feedback text, or usage buckets are unstable for frontend display.
