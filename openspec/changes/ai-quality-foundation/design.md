# AI Quality Foundation - Design

## Architecture

Add a shared AI quality layer below feature processors:

- `AiResultMetadata` is attached to every new AI result row and can be embedded in existing `result_json` until a migration creates first-class columns.
- `AiFeedbackEvent` is a normalized event record keyed by account, feature, optional email/thread ids, event type, and sanitized payload.
- `ContextBuilder` owns truncation, redaction, section ids, token estimates, and `contextRefs`.
- Eval runner loads fixture JSON, invokes processors or fake LLM adapters, validates JSON schema and feature-specific assertions, then writes deterministic JSON.

## Privacy Boundary

No prompt body, raw LLM response, full mail body, credentials, or sensitive URL query values may be logged. Logs may include ids, processor name, version, model, status, duration, token counts, and violation codes.

## Implementation Notes

Execution agents should prefer additive contracts that keep existing routes compatible. Summary and tag processors are enough reference integrations; other changes will adopt the foundation incrementally.

## Handoff

Change ID: `ai-quality-foundation`
Goal: shared AI metadata, feedback, context, and eval infrastructure.
Primary verification: `npm run typecheck:server`, `npm run test:server`, focused eval command.
