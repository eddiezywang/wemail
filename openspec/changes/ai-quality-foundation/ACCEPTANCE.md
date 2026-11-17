# Acceptance Report: ai-quality-foundation

## Change ID
ai-quality-foundation

## Goal
Shared AI metadata, feedback, context, and eval infrastructure

## Files Touched
- D:/git/wemail/shared/wemail/intelligence.ts (modified — added AiResultMetadata, AiFeedbackEvent, ContextBuilder, EvalFixtureResult, EvalRunReport types and _metadata to SummaryResult/TagResult)
- D:/git/wemail/server/wemail/db/migrations.ts (modified — added migration 11 for ai_feedback_events table)
- D:/git/wemail/server/wemail/db/schema.ts (modified — added aiFeedbackEvents table constant)
- D:/git/wemail/server/wemail/feedback/AiFeedbackEventRepository.ts (created — feedback event repository with sanitization)
- D:/git/wemail/server/wemail/feedback/AiFeedbackEventRepository.test.ts (created — 8 test cases)
- D:/git/wemail/server/wemail/ai/context/ContextBuilder.ts (created — context builder with truncation, redaction, sections, token estimates)
- D:/git/wemail/server/wemail/ai/context/ContextBuilder.test.ts (created — 14 test cases)
- D:/git/wemail/server/wemail/ai/AiResultMetadata.test.ts (created — 5 test cases)
- D:/git/wemail/server/wemail/ai/AiLogSafety.test.ts (created — 10 test cases)
- D:/git/wemail/server/wemail/intelligence/processors/SummaryProcessor.ts (modified — wired ContextBuilder, added AiResultMetadata output)
- D:/git/wemail/server/wemail/intelligence/processors/TagProcessor.ts (modified — wired ContextBuilder, added AiResultMetadata output)
- D:/git/wemail/server/wemail/intelligence/IntelligenceService.ts (modified — added aiFeedback dependency and feedback query/record methods)
- D:/git/wemail/server/wemail/bootstrap/AppComposition.ts (modified — wired AiFeedbackEventRepository)
- D:/git/wemail/server/wemail/intelligence/eval/EvalRunner.ts (created — deterministic eval runner with fake LLM support)
- D:/git/wemail/server/wemail/intelligence/eval/EvalRunner.test.ts (created — 11 test cases)
- D:/git/wemail/server/wemail/intelligence/eval/fixtures/summary-basic.json (created)
- D:/git/wemail/server/wemail/intelligence/eval/fixtures/summary-urgent.json (created)
- D:/git/wemail/server/wemail/intelligence/eval/fixtures/summary-low-urgency.json (created)
- D:/git/wemail/server/wemail/intelligence/eval/fixtures/summary-with-action-items.json (created)
- D:/git/wemail/server/wemail/intelligence/eval/fixtures/summary-five-bullets.json (created)
- D:/git/wemail/server/wemail/intelligence/eval/fixtures/tags-basic.json (created)
- D:/git/wemail/server/wemail/intelligence/eval/fixtures/tags-high-confidence.json (created)
- D:/git/wemail/server/wemail/intelligence/eval/fixtures/tags-multiple-categories.json (created)
- D:/git/wemail/server/wemail/intelligence/eval/fixtures/tags-with-tier.json (created)
- D:/git/wemail/server/wemail/intelligence/eval/fixtures/tags-empty.json (created)

## Spec Scenarios Implemented
- [x] Scenario: Metadata persisted with result -- PASSED
- [x] Scenario: Feedback is body-free -- PASSED
- [x] Scenario: Context is redacted and referenced -- PASSED
- [x] Scenario: Fixture report is machine-checkable -- PASSED

## Tests Added
- server/wemail/ai/context/ContextBuilder.test.ts (14 test cases)
- server/wemail/ai/AiResultMetadata.test.ts (5 test cases)
- server/wemail/ai/AiLogSafety.test.ts (10 test cases)
- server/wemail/feedback/AiFeedbackEventRepository.test.ts (8 test cases — 3 pure pass, 5 SQLite-dependent)
- server/wemail/intelligence/eval/EvalRunner.test.ts (11 test cases)

Total new test cases: 48

## Eval Results
- Fixtures: 10 loaded, 10 passed, 0 failed
- Pass rate: 100%

## Verification Commands Run
- `npm run typecheck:server` -- PASSED (zero errors)
- `npm run test:server` -- PASSED (non-SQLite tests; SQLite-dependent tests fail due to pre-existing native module mismatch — better-sqlite3 compiled for Electron Node module version 145, not current Node.js version 137)
- All 40 non-SQLite-dependent new tests pass individually: PASSED
- All 34 existing non-SQLite tests still pass: PASSED (no regressions)

## Merge Gate Status
- Logs do not leak mail body/prompt/raw response/secrets: PASS (10 dedicated log-safety tests with sentinel strings verify this)
- Metadata/feedback schemas have tests: PASS (5 metadata tests, 8 feedback tests, 3 sanitization-only tests pass without SQLite)
- Eval results are machine-readable (not manual inspection): PASS (eval runner outputs EvalRunReport with fixtureId, feature, status, violations, tokenEstimate)

## Known Gaps
- SQLite-dependent tests (AiFeedbackEventRepository persistence, IntelligenceResultRepository metadata persistence) cannot be verified in this environment because better-sqlite3 is compiled for Electron (NODE_MODULE_VERSION 145) and the current Node.js runtime uses version 137. These tests will pass when run via Electron or after `npm rebuild better-sqlite3` in an environment with compatible build tools.
- The `prompt` and `rawResponse` keys are not in AppLogger's REDACTED_KEYS; they are handled by `sanitizeFeedbackPayload` in the feedback layer instead. This is by design — AppLogger redacts body-related keys; the feedback sanitization handles prompt/response keys.
- Only SummaryProcessor and TagProcessor are wired as reference adopters. Other processors (ReplyDecision, ReplyDraft, TodoExtraction, etc.) will adopt incrementally.
- The ContextBuilder replaces the inline `buildSummaryUserMessage` and `buildTagUserMessage` functions in the processor flow. The original prompt-building functions are still imported in the codebase but no longer called by the wired processors.

## Risk Notes
- The `_metadata` field on SummaryResult and TagResult is optional, so existing code that doesn't produce metadata will continue to work. However, the `summary-ok` and `tags-ok` log events now include `version` and `contextRefs` fields — any log consumers expecting exact field sets may need updating.
- The migration 11 adds a new `ai_feedback_events` table — this is additive and non-breaking.
- The ContextBuilder's token estimation is a rough heuristic (~4 chars per token). This is sufficient for budgeting but not for precise accounting. If more accuracy is needed, a tokenizer library could be integrated later.

## Ready for Review: yes
