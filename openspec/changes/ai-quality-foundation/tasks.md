# AI Quality Foundation - Tasks

## Implementation

- [ ] Write failing tests for `AiResultMetadata` serialization, optional fields, and result persistence.
- [ ] Add shared `AiResultMetadata` and `AiFeedbackEvent` contracts in the shared/server AI contract area.
- [ ] Write failing tests proving feedback persistence stores ids and event payloads but not full mail bodies.
- [ ] Implement feedback repository/service with account and feature query filters.
- [ ] Write failing tests for `ContextBuilder` redaction, truncation, section refs, and token estimates.
- [ ] Implement `ContextBuilder` and update summary/tag processors as sample integrations.
- [ ] Write failing eval-runner tests for deterministic pass/fail JSON output.
- [ ] Add at least 10 fixtures across summary and classification/tag cases.
- [ ] Implement eval runner with fake LLM support and fixture assertion reporting.
- [ ] Write log-safety tests that include sentinel `bodyText`, `bodyHtml`, prompt, and raw response strings.
- [ ] Run focused tests for metadata, feedback, context builder, eval runner, and log safety.
- [ ] Run `npm run typecheck:server`.
- [ ] Run `npm run test:server`.

## Execution Agent Report

Return:

```text
Change ID: ai-quality-foundation
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

Block merge if logs leak mail body, prompt, raw response, or secrets; if metadata/feedback schemas lack tests; or if eval results require manual inspection instead of machine-readable pass/fail status.
