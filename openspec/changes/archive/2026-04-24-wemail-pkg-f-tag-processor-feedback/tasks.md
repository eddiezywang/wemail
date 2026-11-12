## 1. Prompt module

- [x] 1.1 Write failing test asserting `tagPrompt.ts` exports stable constants including `BUILTIN_TAGS` with the eight phase-one tags.
- [x] 1.2 Create `server/wemail/ai/prompts/tagPrompt.ts`.

## 2. Schema updates

- [x] 2.1 Write failing migration test for `mail_tag_feedback_rules` columns (`sender_pattern`, `subject_pattern`, `tag`, `action`, `created_at`) and UNIQUE index.
- [x] 2.2 Modify `server/wemail/db/schema.ts` and `server/wemail/db/migrations.ts` as needed.

## 3. TagProcessor

- [x] 3.1 Write failing unit test: happy-path tag generation over the built-in vocabulary; off-vocabulary tags filtered.
- [x] 3.2 Write failing unit test: with a pre-seeded `reject` rule, the matching tag is dropped for a similar message.
- [x] 3.3 Write failing unit test: retry budget honored for transient LLM errors.
- [x] 3.4 Create `server/wemail/intelligence/processors/TagProcessor.ts`; reuse `LlmClient` from Package E, `DB Service mail API` from Package B.
- [x] 3.5 Register the processor in the bus composition root.

## 4. Feedback API

- [x] 4.1 Write failing integration test for `POST /api/intelligence/messages/:id/tags/:tag/reject` (rule persisted) and `.../accept` (rule removed).
- [x] 4.2 Modify `server/api/routes/intelligenceRoutes.ts`.
- [x] 4.3 Run tests until green.

## 5. Safety

- [x] 5.1 Write test that `TagProcessor` logs never contain body or prompt bodies.

## 6. Verification

- [x] 6.1 Run `npm run test:server` — must pass.
- [x] 6.2 Run `npm run typecheck:server` — must pass.
- [x] 6.3 Run `npm run typecheck:desktop` — must pass.
- [x] 6.4 Run `npm run build:desktop` — must pass.
- [x] 6.5 Confirm new code has unit / integration tests for processor, feedback rules, and API.
- [x] 6.6 Confirm no violations of Handoff §6 hard rules (queue not bypassed, no body in logs, fixed prompt module).
- [x] 6.7 Commit with the exact Handoff §5.F message: `git commit -m "feat(ai): add smart tag processor and feedback rules"`.
