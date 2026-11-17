# Enterprise Smart Classification Implementation Plan

> **For implementers:** Execute this plan task-by-task. Keep each commit focused, run the listed tests before committing, and preserve unrelated working-tree changes.

**Goal:** Replace WeMail's overlapping eight-way inbox taxonomy with three independent system classifications—重要、待处理、发票—then add per-account temporary content topics that can become long-term user smart tags only after confirmation through the existing application-message center.

**Architecture:** Evolve the existing tag result into a backward-compatible schema that stores three independent system signals plus bounded content topics. Keep user smart tags in the existing `user_tags` and backfill/learning pipeline. Add a durable per-account topic-candidate repository and a suggestion service that creates idempotent application messages. The renderer presents the approved A layout: separate “智能分类” and “我的标签” sidebar groups, while temporary topics remain inline-only.

**Tech Stack:** TypeScript, React 19, React Router, TanStack Query, Hono, SQLite, existing intelligence orchestrator, Vitest, React Testing Library, Node test.

## Global Constraints

- Electron remains the only desktop shell.
- Do not create, rename, or delete IMAP folders as part of classification.
- Do not edit generated `build/`, `dist/`, or `dist-electron/` output.
- Preserve existing user smart-tag IDs, mail relations, backfill runs, feedback, and prompt-learning history.
- System classifications are independent; one email may match all three.
- Temporary topics never appear in the sidebar and never create user tags without confirmation.
- Application-message actions must be account-isolated and idempotent.
- Historical `receipt` results require reclassification; do not blindly relabel them as invoices.
- Use the approved visual semantics: coral + solid icons for system classification, blue-gray + outline icons for user tags, neutral dashed chips for temporary topics.
- Do not rely on color alone; retain headings, icon treatment, focus states, and different management capabilities.

---

## Task 1: Introduce the backward-compatible classification contract

**Files:**

- Modify: `shared/wemail/intelligence.ts`
- Modify: `app/types/wemail.ts`
- Modify: `server/wemail/intelligence/IntelligenceResultRepository.ts`
- Add: `server/wemail/intelligence/IntelligenceResultRepository.test.ts`
- Add: `shared/wemail/intelligence.test.ts`

- [ ] Add failing tests for a tag result that simultaneously matches important, action-required, and invoice.
- [ ] Add `ClassificationSignal` and `ContentTopicTag` types.
- [ ] Add a new schema version for `TagResult` with:

  ```ts
  system: {
    important: ClassificationSignal;
    actionRequired: ClassificationSignal & { actions?: string[] };
    invoice: ClassificationSignal & { evidence?: string[] };
  };
  contentTags: ContentTopicTag[];
  ```

- [ ] Keep a read adapter for legacy `classification.categoryId` and legacy `tags` rows.
- [ ] Make legacy categories map conservatively:

  - `important` => important signal only.
  - `action_required` => action-required signal only.
  - `receipt` => no automatic invoice match; mark as requiring reclassification.
  - all others => no new system match.

- [ ] Cap `contentTags` at three and reject malformed confidence values.
- [ ] Persist the new JSON shape without removing legacy category columns yet.
- [ ] Run:

  `node --import tsx --test server/wemail/intelligence/IntelligenceResultRepository.test.ts`

- [ ] Run:

  `npm run typecheck`

- [ ] Commit:

  `git commit -m "feat: add independent smart classification contract"`

## Task 2: Replace the fixed vocabularies in the tag prompt and processor

**Files:**

- Modify: `server/wemail/ai/prompts/tagPrompt.ts`
- Modify: `server/wemail/ai/prompts/smartTagDefinitions.ts`
- Modify: `server/wemail/intelligence/processors/TagProcessor.ts`
- Test: `server/wemail/ai/prompts/tagPrompt.test.ts`
- Test: `server/wemail/intelligence/processors/TagProcessor.test.ts`
- Test fixtures: `server/wemail/intelligence/eval/fixtures/tags-basic.json`
- Modify: `server/wemail/intelligence/eval/features/tags.spec.ts`
- Modify: `server/wemail/intelligence/eval/scoring/RuleScorer.ts`

- [ ] Add failing prompt-schema tests proving the model returns three independent signals and zero to three temporary content topics.
- [ ] Remove the eight legacy system-category enum from the new output schema.
- [ ] Remove the eight all-user built-in semantic tags from the fixed emitted vocabulary.
- [ ] Retain their names only as optional normalization seeds for temporary topics.
- [ ] Encode the approved definitions and exclusions for important, action-required, and invoice.
- [ ] Require topic names to be short, stable business phrases and prohibit:

  - important / 待处理 / 发票;
  - 通知 / 其他 / 个人;
  - names, dates, and one-off version strings as standalone topics.

- [ ] Update `TagProcessor` parsing, confidence tiers, feedback-rule integration, logging, and metadata fingerprinting for the new result.
- [ ] Ensure user-defined smart tags continue to be evaluated through `buildSmartTagDefinitions` and remain separate from temporary topics.
- [ ] Add tests for:

  - important + action-required + invoice together;
  - ordinary status notification matching none;
  - payment receipt excluded from invoice;
  - invoice attachment included;
  - no more than three temporary topics;
  - malformed or prohibited topics dropped.

- [ ] Update evaluation fixtures and scorer expectations.
- [ ] Run:

  `node --import tsx --test server/wemail/ai/prompts/tagPrompt.test.ts server/wemail/intelligence/processors/TagProcessor.test.ts`

- [ ] Commit:

  `git commit -m "feat: simplify system classification prompts"`

## Task 3: Expose independent system filters and compatibility counts

**Files:**

- Modify: `server/wemail/intelligence/IntelligenceResultRepository.ts`
- Modify: `server/wemail/intelligence/IntelligenceService.ts`
- Modify: `server/api/routes/intelligenceRoutes.ts`
- Modify: `server/api/routes/mailRoutes.ts`
- Modify: `app/services/api.ts`
- Modify: `app/queries/listCategories.ts`
- Test: `server/wemail/intelligence/categories/ClassificationInboxTabs.test.ts`
- Test: `server/api/routes/mailRoutes.test.ts`
- Test: `app/services/api.test.ts`

- [ ] Add failing repository tests for overlapping counts: one message may increment multiple system filters.
- [ ] Replace the public system-category list with exactly:

  - `important` / 重要;
  - `action_required` / 待处理;
  - `invoice` / 发票.

- [ ] Keep legacy category reads internal during migration, but never return newsletter, marketing, notification, personal, or other as sidebar categories.
- [ ] Update mail-list filtering to query each independent signal instead of the legacy single `category_id`.
- [ ] Ensure filters run before pagination and preserve account and folder isolation.
- [ ] Keep user smart-tag filtering by stable `smartTagId` unchanged.
- [ ] Add API tests for a message appearing in multiple system-filter results.
- [ ] Add a compatibility test for an old database containing legacy rows.
- [ ] Run:

  `node --import tsx --test server/wemail/intelligence/categories/ClassificationInboxTabs.test.ts server/api/routes/mailRoutes.test.ts`

- [ ] Commit:

  `git commit -m "feat: expose simplified smart classification filters"`

## Task 4: Build the approved dual-group sidebar and inline visual language

**Files:**

- Modify: `app/components/sidebar/MailboxNavigationGroup.tsx`
- Modify: `app/components/Sidebar.tsx`
- Modify: `app/lib/mail-categories.ts`
- Modify: `app/components/wemail/EmailSmartTags.tsx`
- Modify: `app/components/wemail/EmailIntelligenceCard.tsx`
- Test: `app/components/Sidebar.test.tsx`
- Test: `app/components/wemail/EmailSmartTags.test.tsx`
- Test: `app/routes/_workbench.test.tsx`

- [ ] Add failing renderer tests for two headings: “智能分类” and “我的标签”.
- [ ] Render only 重要、待处理、发票 under “智能分类”.
- [ ] Render existing user tags under “我的标签”.
- [ ] Keep system items non-manageable: no edit/delete overflow button.
- [ ] Keep user-tag management available by mouse and keyboard.
- [ ] Apply coral solid semantic icons to system items and blue-gray outline tag icons to user items.
- [ ] Preserve selected backgrounds, left accent, unread counts, truncation, titles, and compact density.
- [ ] Render temporary content topics as neutral dashed chips in list/detail only.
- [ ] Render system signals and user smart tags with distinct chip treatments.
- [ ] Add accessible names that communicate “系统分类” or “我的标签” without relying on color.
- [ ] Verify IMAP custom folders remain in the folder section and are not moved into either smart group.
- [ ] Run:

  `npm run test:renderer -- app/components/Sidebar.test.tsx app/components/wemail/EmailSmartTags.test.tsx app/routes/_workbench.test.tsx`

- [ ] Commit:

  `git commit -m "feat: separate system and user smart classifications"`

## Task 5: Add durable topic-candidate persistence

**Files:**

- Modify: `server/wemail/db/migrations.ts`
- Modify: `server/wemail/db/Database.test.ts`
- Add: `server/wemail/intelligence/TopicCandidateRepository.ts`
- Add: `server/wemail/intelligence/TopicCandidateRepository.test.ts`
- Modify: `server/wemail/bootstrap/AppCompositionTypes.ts`
- Modify: `server/wemail/bootstrap/composition/intelligence.ts`

- [ ] Add migration `60` for per-account topic candidates, aliases, mail evidence, feedback, suggestion state, and long-term tag linkage.
- [ ] Add indexes for:

  - account + normalized key;
  - account + suggestion state + last-seen time;
  - topic + email uniqueness;
  - account + suppression key.

- [ ] Define suggestion states: `collecting`, `pending`, `created`, `deferred`, `suppressed`, `failed`.
- [ ] Store bounded evidence metadata only: email ID, thread ID, sender-domain hash or normalized sender key, confidence, first/last seen timestamps.
- [ ] Do not duplicate email bodies in topic tables.
- [ ] Implement account-isolated repository methods for upsert, alias merge, evidence aggregation, feedback, suppression, and long-term tag linkage.
- [ ] Make evidence and alias writes idempotent.
- [ ] Add restart and migration tests.
- [ ] Run:

  `node --import tsx --test server/wemail/db/Database.test.ts server/wemail/intelligence/TopicCandidateRepository.test.ts`

- [ ] Commit:

  `git add server/wemail/db server/wemail/intelligence/TopicCandidateRepository* server/wemail/bootstrap && git commit -m "feat: persist smart topic candidates"`

## Task 6: Normalize and aggregate temporary content topics

**Files:**

- Add: `server/wemail/intelligence/ContentTopicNormalizer.ts`
- Add: `server/wemail/intelligence/ContentTopicNormalizer.test.ts`
- Add: `server/wemail/intelligence/ContentTopicService.ts`
- Add: `server/wemail/intelligence/ContentTopicService.test.ts`
- Modify: `server/wemail/intelligence/processors/TagProcessor.ts`
- Modify: `server/wemail/bootstrap/composition/intelligence.ts`

- [ ] Write tests for stripping dates, names, ticket numbers, and one-off versions without destroying stable product names.
- [ ] Add deterministic normalization before any semantic merge.
- [ ] Merge exact normalized keys and persisted aliases first.
- [ ] Require evidence similarity before merging merely similar names.
- [ ] Keep unrelated concepts separate even if their labels share words.
- [ ] Record each accepted temporary topic against its email after tag processing succeeds.
- [ ] Record user rejection as negative evidence without deleting the entire candidate.
- [ ] Enforce the per-message maximum of three topics at the service boundary.
- [ ] Add tests for repeated processing, account isolation, alias merge, and negative-feedback scoring.
- [ ] Run:

  `node --import tsx --test server/wemail/intelligence/ContentTopicNormalizer.test.ts server/wemail/intelligence/ContentTopicService.test.ts server/wemail/intelligence/processors/TagProcessor.test.ts`

- [ ] Commit:

  `git commit -m "feat: normalize and aggregate mail topics"`

## Task 7: Generate idempotent smart-tag suggestions in application messages

**Files:**

- Add: `server/wemail/intelligence/SmartTagSuggestionService.ts`
- Add: `server/wemail/intelligence/SmartTagSuggestionService.test.ts`
- Modify: `shared/wemail/applicationMessages.ts`
- Modify: `server/wemail/applicationMessages/ApplicationMessageRepository.ts`
- Modify: `server/wemail/applicationMessages/ApplicationMessageRepository.test.ts`
- Modify: `server/wemail/bootstrap/AppCompositionTypes.ts`
- Modify: `server/wemail/bootstrap/composition/intelligence.ts`

- [ ] Add failing tests for the default gate: five mails in thirty days across at least two threads or two senders.
- [ ] Add checks for one-off events, overlap with existing user tags, pending suggestions, and suppression.
- [ ] Add application-message type `smart-tag-suggestion`.
- [ ] Add typed interactions for:

  - preview topic emails;
  - create suggested tag;
  - edit and create;
  - defer suggestion;
  - suppress suggestion.

- [ ] Use `accountId + topicId` as the pending-message idempotency key.
- [ ] Persist message status transitions so handled suggestions remain auditable.
- [ ] Make service thresholds and time windows injectable for deterministic tests.
- [ ] Trigger evaluation after new topic evidence is recorded and from a bounded periodic sweep for recovery.
- [ ] Ensure a service failure leaves the candidate retryable and does not affect mail processing.
- [ ] Run:

  `node --import tsx --test server/wemail/intelligence/SmartTagSuggestionService.test.ts server/wemail/applicationMessages/ApplicationMessageRepository.test.ts`

- [ ] Commit:

  `git commit -m "feat: suggest stable smart tags in application messages"`

## Task 8: Add suggestion actions to the application-message API and UI

**Files:**

- Modify: `server/api/routes/applicationMessageRoutes.ts`
- Add: `server/api/routes/applicationMessageRoutes.test.ts`
- Modify: `app/services/api.ts`
- Modify: `app/queries/applicationMessages.ts`
- Modify: `app/components/applicationMessages/ApplicationMessageCenter.tsx`
- Add: `app/components/applicationMessages/ApplicationMessageCenter.test.tsx`
- Reuse: `app/components/wemail/CreateSmartTagDialog.tsx`

- [ ] Add account-isolated action endpoints that validate message type, topic state, and action payload.
- [ ] Make create/defer/suppress actions idempotent.
- [ ] Render the suggestion's topic name, sample count, thread/sender spread, and representative mail references.
- [ ] Implement “查看邮件” using the existing mail-reference navigation.
- [ ] Implement “编辑后创建” by opening the smart-tag dialog with suggested name and description.
- [ ] Keep handled messages visible with status labels: 已创建、暂不创建、不再建议、创建失败.
- [ ] Disable action buttons while a mutation is pending and show retryable errors without closing the message.
- [ ] Add keyboard and screen-reader coverage for every action.
- [ ] Invalidate application-message, user-tag, and backfill queries after successful creation.
- [ ] Run:

  `npm run test:renderer -- app/components/applicationMessages/ApplicationMessageCenter.test.tsx`

- [ ] Run:

  `node --import tsx --test server/api/routes/applicationMessageRoutes.test.ts`

- [ ] Commit:

  `git commit -m "feat: confirm smart tag suggestions in notification center"`

## Task 9: Reuse user-tag creation, backfill, and learning atomically

**Files:**

- Modify: `server/wemail/intelligence/UserTagRepository.ts`
- Modify: `server/wemail/db/migrations.ts`
- Modify: `server/wemail/intelligence/SmartTagBackfillRepository.ts`
- Modify: `server/api/routes/intelligenceRoutes.ts`
- Modify: `app/queries/userTags.ts`
- Test: `server/api/routes/intelligenceRoutes.test.ts`
- Add: `server/wemail/intelligence/UserTagRepository.test.ts`
- Add: `app/queries/userTags.test.tsx`

- [ ] Add an optional creation-source field: `manual` or `ai-suggestion`.
- [ ] Add optional `sourceTopicId` without changing the stable user-tag identity model.
- [ ] Add migration `61` for the user-tag creation source and source topic ID.
- [ ] Create the user tag, link the topic, transition the message, and enqueue backfill in one transaction or compensating workflow.
- [ ] On failure, leave no visible orphan tag and keep the application message retryable.
- [ ] Prevent a second confirmation from creating a duplicate tag.
- [ ] Preserve existing prompt generation, smart-tag relation, feedback, and batch-learning behavior.
- [ ] Add tests for direct create, edited create, duplicate confirmation, failure rollback, and historical backfill start.
- [ ] Run:

  `node --import tsx --test server/api/routes/intelligenceRoutes.test.ts server/wemail/intelligence/UserTagRepository.test.ts`

- [ ] Commit:

  `git commit -m "feat: create learned smart tags from confirmed topics"`

## Task 10: Add manual overrides and legacy reclassification

**Files:**

- Modify: `server/wemail/db/migrations.ts`
- Add: `server/wemail/intelligence/SystemClassificationOverrideRepository.ts`
- Add: `server/wemail/intelligence/SystemClassificationOverrideRepository.test.ts`
- Modify: `server/api/routes/intelligenceRoutes.ts`
- Modify: `app/services/api.ts`
- Modify: `app/components/wemail/EmailIntelligenceCard.tsx`
- Modify: `app/components/wemail/EmailSmartTags.tsx`
- Add or modify: background reclassification service under `server/wemail/intelligence/`

- [ ] Persist per-email, per-system-classification user overrides with account isolation.
- [ ] Add migration `62` for the override table and its account/email/classification uniqueness constraint.
- [ ] Add endpoints to set and clear important, action-required, and invoice overrides.
- [ ] Ensure user overrides win over subsequent AI recomputation.
- [ ] Canceling invoice classification must not delete attachments or invoice-platform state.
- [ ] Add a bounded reclassification job for legacy rows.
- [ ] Prioritize legacy `receipt` rows for reclassification; never mass-convert them to invoice.
- [ ] Keep old category columns readable until the migration job and compatibility window are complete.
- [ ] Expose progress and failure counts through existing intelligence status patterns, not new folders.
- [ ] Add tests for override precedence, clearing overrides, restart durability, and legacy receipt exclusion.
- [ ] Run focused server and renderer tests.
- [ ] Commit:

  `git commit -m "feat: support classification overrides and migration"`

## Task 11: Complete cross-layer verification and desktop acceptance

**Files:**

- Add: `tests/e2e/enterprise-smart-classification.spec.ts`
- Update: relevant testing documentation under `docs/testing/`
- Update: snapshots only when they represent intentional approved UI changes

- [ ] Add E2E coverage for a mail matching important + action-required + invoice.
- [ ] Add E2E coverage proving a payment receipt is not classified as invoice.
- [ ] Verify the sidebar displays only the three system classifications and preserves existing user tags.
- [ ] Verify temporary topics remain inline-only.
- [ ] Seed five related messages across multiple threads or senders and verify exactly one application-message suggestion.
- [ ] Confirm a suggestion and verify:

  - it enters “我的标签”;
  - historical backfill starts;
  - the notification remains auditable as 已创建.

- [ ] Suppress a suggestion and verify synonymous candidates do not create another notification.
- [ ] Verify an IMAP folder named “服务器故障” remains in the folder area and is not treated as a generated classification.
- [ ] Run:

  `npm run typecheck`

- [ ] Run:

  `npm run typecheck:server`

- [ ] Run:

  `npm run typecheck:desktop`

- [ ] Run:

  `npm run test:server`

- [ ] Run:

  `npm run test:renderer`

- [ ] Run:

  `npm run build:desktop`

- [ ] Run the focused Electron E2E spec:

  `npm run test:e2e -- tests/e2e/enterprise-smart-classification.spec.ts`

- [ ] Commit:

  `git add tests docs/testing && git commit -m "test: cover enterprise smart classification"`

## Rollout Order

1. Ship Tasks 1–4 behind a compatibility switch so the new contract and dual-group UI can be validated without enabling topic suggestions.
2. Enable Tasks 5–9 for internal accounts after topic aggregation and notification-center actions pass live sampling.
3. Run Task 10 historical reclassification in bounded batches and monitor invoice false positives.
4. Remove legacy visible taxonomy only after the new filters and compatibility reads are stable.

## Final Acceptance Checklist

- [ ] User-visible system classifications are exactly 重要、待处理、发票.
- [ ] The same email can match any combination of the three.
- [ ] The sidebar uses separate “智能分类” and “我的标签” sections.
- [ ] Existing user smart tags and relations are preserved.
- [ ] Temporary topics are bounded, normalized, and inline-only.
- [ ] Stable topics produce one idempotent, auditable application message.
- [ ] A user confirmation is required before long-term tag creation and backfill.
- [ ] Defer and suppress states behave as specified.
- [ ] Manual overrides survive recomputation.
- [ ] Legacy receipt rows are reclassified instead of renamed blindly.
- [ ] IMAP folders and system failures never become AI-generated navigation categories.
