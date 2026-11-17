# AI Quality Foundation

## Problem

AI features currently risk growing independently: each processor can build context, shape metadata, track versions, log failures, and record feedback differently. That makes evaluation, privacy review, retry behavior, and future personalization difficult to enforce consistently.

## Proposal

Introduce the shared quality foundation for all AI features:

- `AiResultMetadata` with processor, version, model, confidence, context references, timing, and token usage.
- `AiFeedbackEvent` for user feedback without storing full mail body.
- `ContextBuilder` for log-safe, bounded, feature-specific mail context.
- Deterministic eval runner over fixed fixtures with machine-readable pass/fail output.
- Summary and tag processors wired as reference adopters.

## Scope

In scope: shared contracts, persistence, context building, eval harness, fixture set, log-safety tests, summary/tag sample integration.

Out of scope: migrating every processor, product UI for eval reports, model provider selection changes.

## Dependencies

Upstream changes: none. This is the only recommended foundation before the rest of the AI-quality changes.

## Success Criteria

- Server typecheck and server tests pass.
- At least 10 AI fixtures exist and are runnable by the eval runner.
- Eval output includes fixture id, feature, status, violations, and token estimate.
- Tests prove AI logs omit `bodyText`, `bodyHtml`, prompt body, and raw LLM response.
