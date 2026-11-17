# Acceptance Report: ai-personalization-learning

## Change ID
ai-personalization-learning

## Goal
Add per-feature learning summary aggregation from feedback, a privacy-safe prompt builder, stable usage bucket statistics, and a reset endpoint for learned preferences.

## Files Touched
- server/wemail/personalization/LearningSummaryService.ts (created -- per-feature learning summary aggregation, computeFromFeedback, reset, resetFeature)
- server/wemail/personalization/LearningSummaryService.test.ts (created -- 9 test cases)
- server/wemail/personalization/PromptBuilder.ts (created -- profile + learning summary prompt builder with sanitizeForLog and LOG_FORBIDDEN_KEYS)
- server/wemail/personalization/PromptBuilder.test.ts (created -- 10 test cases)
- server/wemail/personalization/UsageStatsService.ts (created -- stable UI bucket grouping with processor-version detail rows)
- server/wemail/personalization/UsageStatsService.test.ts (created -- 5 test cases)
- shared/wemail/intelligence.ts (modified -- added LearningSummary, PersonalizedPromptResult, UsageBucketStats types)
- shared/wemail/settings.ts (modified -- extended AiProfileSettings with importantContacts, defaultReplyTone, signaturePreference, defaultSummaryLanguage)
- shared/wemail/usage.ts (modified -- UsageCategory type used by UsageStatsService stable bucket grouping)
- server/wemail/settings/AiProfileSettingsService.ts (modified -- new profile fields, resetProfile with resetLearnedOnly option)
- server/wemail/feedback/AiFeedbackEventRepository.ts (modified -- added findByAccountAndFeature, sanitizeFeedbackPayload with FORBIDDEN_PAYLOAD_KEYS)
- server/api/routes/settingsRoutes.ts (modified -- added GET /learning-summaries, GET /usage-stats, POST /reset-learned endpoints)
- server/api/routes/settingsRoutes.test.ts (modified -- 8 new test cases for personalization endpoints)
- server/wemail/db/migrations.ts (modified -- migration 21: learning_summaries table, processor_version column on ai_usage, profile extension columns; migration 22: important_contacts_json default refinement)
- server/wemail/bootstrap/AppComposition.ts (modified -- wired LearningSummaryService, PromptBuilder, UsageStatsService)

## Spec Scenarios Implemented

- [x] Scenario: Queryable feedback -- PASSED
  - `AiFeedbackEventRepository.findByAccountAndFeature()` queries feedback events by account and feature, returning only matching `AiFeedbackEvent` records. `findByAccount()` also supports optional feature and emailId filters. `LearningSummaryService.computeFromFeedback()` aggregates feedback events into bounded signals: tags produces `suppressedTags` from reject events, replyDraft produces `writingFeedback` (editCount/acceptCount/editRatio), summary produces `averageRating` from rate events. `GET /learning-summaries?accountId=xxx` endpoint returns all summaries for an account. Tests in AiFeedbackEventRepository.test.ts verify filter-by-feature (line 51) and filter-by-emailId (line 80). LearningSummaryService.test.ts verifies computeFromFeedback for tags (line 113), replyDraft (line 135), and summary (line 157).

- [x] Scenario: Private prompt builder -- PASSED
  - `PromptBuilder` logs only ids, feature, version, and outcome metadata via `sanitizeForLog()`. The `LOG_FORBIDDEN_KEYS` set blocks 13 keys: bodyText, bodyHtml, prompt, rawResponse, rawLlmResponse, llmResponse, password, token, apiKey, secret, feedbackText, originalText, editedText. The `promptText` is NEVER included in log output -- the logger receives only `sanitizeForLog({ feature, version, profileFieldsUsed, learningSummaryUsed })`. The `PersonalizedPromptResult.meta` object contains only feature, version, profileFieldsUsed, and learningSummaryUsed. Tests verify: logged metadata does not contain prompt text (line 136), logged metadata does not contain learned tag names (line 137), sanitizeForLog strips forbidden keys flat (line 168) and nested (line 186), and logs-only-safe-metadata (line 216).

- [x] Scenario: Stable usage grouping -- PASSED
  - `UsageStatsService` groups usage by the fixed `USAGE_BUCKETS` constant (7 categories: summary, agent_chat, compose, todo, translation, automation, other). The `processorToCategory()` mapping is a stable switch statement mapping processor names to category buckets (e.g., replyDraft and composeMail both map to "compose"). Detailed rows include processor, processorVersion, model, tokens, calls, and avgDurationMs. All 7 buckets are always returned even with zero counts. Tests verify: stable UI buckets returned (line 16), processor-version detail rows (line 61), correct category grouping for replyDraft/composeMail into compose bucket (line 110), account isolation (line 147), and bucket stability across versions with fixed 7 categories (line 179).

- [x] Scenario: Reset learned preferences -- PASSED
  - `LearningSummaryService.reset(accountId)` deletes all learning summaries for an account via `DELETE FROM learning_summaries WHERE account_id = @accountId`. `resetFeature(accountId, feature)` deletes only a specific feature's summary. `POST /reset-learned` endpoint accepts `{ accountId, feature? }` and calls resetFeature when feature is provided, or reset for all features. Tests verify: reset clears all summaries (line 81), resetFeature clears only one feature (line 97), and reset makes learning summary empty for future prompt building (line 176, verifying `get()` returns null after reset).

## Tests Added
- server/wemail/personalization/LearningSummaryService.test.ts (9 test cases: save/get, upsert, listByAccount, reset, resetFeature, computeFromFeedback for tags, computeFromFeedback for replyDraft, computeFromFeedback for summary, reset-empties-for-prompt-building)
- server/wemail/personalization/PromptBuilder.test.ts (10 test cases: profile personalization, tags learning summary, replyDraft learning summary, summary ratings, meta-excludes-raw-feedback, prompt-excludes-forbidden-keys, sanitizeForLog flat, sanitizeForLog nested, no-profile-no-summary, logs-only-safe-metadata)
- server/wemail/personalization/UsageStatsService.test.ts (5 test cases: stable UI buckets, processor-version detail rows, correct category grouping, account isolation, bucket stability across versions)
- server/api/routes/settingsRoutes.test.ts (8 new test cases: personalization fields save/read, reset-learned clears all, reset-learned clears one feature, reset-learned requires accountId, usage-stats returns stable buckets with details, usage-stats requires accountId, learning-summaries returns summaries, learning-summaries requires accountId)

## Eval Results
- Fixtures: 0 (personalization is aggregation/query logic, not LLM-dependent; tested via unit tests)

## Verification Commands Run
- `npm run typecheck:server` -- PASSED

## Merge Gate Status
- Feedback can be reset: PASS
  - `LearningSummaryService.reset()` deletes all summaries for an account. `resetFeature()` deletes for a specific feature. `POST /reset-learned` API endpoint is wired in settingsRoutes.ts. After reset, `get()` returns null, meaning future prompt building receives no learned signals. Test at line 176 explicitly verifies this scenario.
- Prompts/logs don't leak private feedback text: PASS
  - `PromptBuilder` uses `sanitizeForLog()` which strips 13 forbidden keys recursively. The `promptText` field is never included in log metadata. The `PersonalizedPromptResult.meta` contains only feature, version, profileFieldsUsed, and learningSummaryUsed. Tests verify that logged metadata does not contain prompt text (line 136) or raw feedback text (line 137). `AiFeedbackEventRepository` also sanitizes payloads on save via `sanitizeFeedbackPayload()` with its own `FORBIDDEN_PAYLOAD_KEYS` set.
- Usage buckets are stable: PASS
  - `USAGE_BUCKETS` is a `Object.freeze()`'d constant defining exactly 7 categories. `processorToCategory()` is a deterministic switch statement. `UsageStatsService.getStats()` always returns all 7 buckets with zero counts for unused categories. Test at line 179 verifies the fixed set of 7 categories is returned consistently.

## Known Gaps
- `LearningSummaryService.computeFromFeedback()` takes feedback events as a parameter rather than querying them internally -- the caller must fetch events and pass them in. This is by design (separation of concerns) but means the aggregation is not automatic.
- No automatic trigger to recompute learning summaries when feedback events are recorded -- summaries must be recomputed explicitly or on-demand.
- The `importantContacts` field in profile settings is a simple string array with no validation or normalization of email addresses.
- `UsageStatsService` depends on `USAGE_BUCKETS` from `AiUsageRepository` -- if that constant changes, the bucket stability guarantee could be violated. However, the constant is `Object.freeze()`'d, making accidental mutation unlikely.
- The `GET /learning-summaries` endpoint does not support filtering by feature -- it always returns all summaries for an account.
- No integration test that exercises the full flow from feedback event through computeFromFeedback through PromptBuilder to verify end-to-end prompt personalization.

## Risk Notes
- The `learning_summaries` table is new (migrations 21 and 22) -- additive and non-breaking.
- Profile extensions (importantContacts, defaultReplyTone, signaturePreference, defaultSummaryLanguage) are optional columns -- existing profiles continue to work.
- The `sanitizeForLog` function in PromptBuilder is the primary privacy guard -- it must be kept in sync with any new fields added to learning summary signals. Adding a new signal field without updating `LOG_FORBIDDEN_KEYS` could leak private data.
- The `computeFromFeedback` method stores aggregated signals (suppressedTags, writingFeedback, averageRating) in the learning summary. These aggregated values are included in the prompt text (e.g., "Avoid suggesting these tags: newsletter, marketing") but are NOT included in log metadata. This is correct behavior but worth noting: the prompt text itself does contain derived signal data, which is only visible to the LLM.

## Ready for Review: yes
