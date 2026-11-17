# AI Link Risk Unsubscribe - Tasks

## Implementation

- [ ] Write failing extraction tests for URLs in text, HTML anchors, and unsubscribe headers.
- [ ] Write failing tests proving extraction never fetches remote URLs.
- [ ] Write failing risk tests for display-domain mismatch, shortener, unsafe scheme, and suspicious TLD.
- [ ] Write failing log-safety tests for URLs with credential-bearing query values.
- [ ] Implement link parser and normalized link metadata contract.
- [ ] Implement unsubscribe detection from headers and body.
- [ ] Implement calibrated risk scoring and risk reasons.
- [ ] Add at least 20 link fixtures and eval thresholds.
- [ ] Run focused parser, risk, route, log-safety, and eval tests.
- [ ] Run `npm run typecheck:server`.
- [ ] Run `npm run test:server`.

## Execution Agent Report

```text
Change ID: ai-link-risk-unsubscribe
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

Block merge if any code opens or requests links, logs complete sensitive URLs, or marks all links high risk without useful discrimination.
