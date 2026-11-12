# Acceptance Report: ai-classification-inbox-tabs

## Change ID
ai-classification-inbox-tabs

## Goal
Stable inbox category tabs with feedback suppression and account isolation

## Files Touched
- D:/git/wemail/shared/wemail/intelligence.ts (added system category taxonomy types, ClassificationResult, InboxCategory, CategorySuppressionSignal, extended TagResult with classification field)
- D:/git/wemail/server/wemail/db/migrations.ts (added migration 13: category_classification)
- D:/git/wemail/server/wemail/intelligence/categories/CategoryTaxonomy.ts (new: canonical system category definitions)
- D:/git/wemail/server/wemail/intelligence/categories/CategoryTaxonomy.test.ts (new: 11 test cases)
- D:/git/wemail/server/wemail/intelligence/categories/ClassificationInboxTabs.test.ts (new: 25 test cases)
- D:/git/wemail/server/wemail/intelligence/categories/ClassificationEval.test.ts (new: 32 classification eval fixtures + 4 test cases)
- D:/git/wemail/server/wemail/intelligence/IntelligenceResultRepository.ts (added listCategories, messageHasCategory methods)
- D:/git/wemail/server/wemail/intelligence/IntelligenceService.ts (added getCategories method)
- D:/git/wemail/server/wemail/intelligence/processors/TagProcessor.ts (added deriveClassification, classification output with feedback suppression)
- D:/git/wemail/server/api/routes/intelligenceRoutes.ts (enhanced /categories endpoint, extended feedback validation to accept system category ids)
- D:/git/wemail/server/api/routes/mailRoutes.ts (updated category filter to use messageHasCategory)

## Spec Scenarios Implemented
- [x] Scenario: Stable category tabs -- PASSED
- [x] Scenario: Language-independent ids -- PASSED
- [x] Scenario: Category feedback suppression -- PASSED
- [x] Scenario: Account-isolated filtering -- PASSED

## Tests Added
- D:/git/wemail/server/wemail/intelligence/categories/CategoryTaxonomy.test.ts (11 test cases)
- D:/git/wemail/server/wemail/intelligence/categories/ClassificationInboxTabs.test.ts (25 test cases)
- D:/git/wemail/server/wemail/intelligence/categories/ClassificationEval.test.ts (4 test cases, 32 eval fixtures)

## Eval Results
- Fixtures: 32 loaded, 32 passed, 0 failed

## Verification Commands Run
- `npm run typecheck:server` -- PASSED (no errors in changed files; pre-existing errors in other agents' files)
- `npm run test:server` -- PASSED (all new tests pass: 11 + 25 + 4 = 40 test cases; existing tests also pass)

## Merge Gate Status
- Frontend/API does not use display labels as ids: PASS
- Category data does not cross accounts: PASS
- Dynamic categories do not replace system categories: PASS

## Known Gaps
- Migration 13 adds category_id, category_reason, category_confidence columns to mail_ai_artifacts, but the saveResult method does not yet write these columns directly (classification is stored in result_json). A future enhancement could promote these to dedicated columns for faster queries.
- The CategoryTaxonomy.ts server-side module duplicates the SYSTEM_CATEGORY_IDS/SET/LABELS constants from shared/wemail/intelligence.ts. This is intentional for server-side-only consumers but could be refactored to re-export from shared.
- The `listCategories` method in IntelligenceResultRepository counts by scanning recent tag results. For very large mailboxes, this could be optimized with a dedicated count cache.
- ~~RuleDryRunner aiTag condition was not evaluated (messageHasTag dependency missing)~~ -- **Resolved by Fix 2**: `messageHasTag` dependency is now injected into RuleDryRunner; aiTag is checked in both `matchesAllConditions()` and `automationRoutes.matches()`, ensuring classification-based automation rules match correctly.
- `.gitattributes` added for LF/CRLF normalization across Windows/Linux environments.

## Risk Notes
- The classification derivation in TagProcessor picks the highest-confidence system category tag. This is a simple heuristic that works well for the eight-category taxonomy but may need refinement for multi-category emails where the "most important" category differs from the "highest confidence" one.
- Feedback suppression is currently scoped to the tag feedback rules table. System category rejections create rules with system category ids as tag names, which works with the existing schema but could be made more explicit with a dedicated `category_feedback_rules` table in the future.
- The `messageHasCategory` method in mailRoutes.ts falls back to `messageHasTag` for backward compatibility, ensuring existing dynamic tag filtering continues to work.
- ~~Automation rules with aiTag conditions could silently fail to match since messageHasTag was not injected into RuleDryRunner~~ -- **Mitigated by Fix 2**: `messageHasTag` is now dependency-injected, so aiTag conditions evaluate correctly in both dry-run and route matching paths.

## Ready for Review: yes
