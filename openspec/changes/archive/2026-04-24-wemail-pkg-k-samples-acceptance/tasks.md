## 1. Samples module

- [x] 1.1 Write failing unit test: `ALL_SAMPLES` contains at least one entry per phase-one category; every entry validates against the `MailMessage` shape.
- [x] 1.2 Write failing unit test asserting the prompt-injection sample contains override-style directives in both subject and body.
- [x] 1.3 Create `server/wemail/testing/mailSamples.ts` with named exports per category and an `ALL_SAMPLES` array.

## 2. Samples documentation

- [x] 2.1 Write `docs/testing/wemail-mail-samples.md` describing each category, its purpose, and how to extend.
- [x] 2.2 Include a note that samples are synthetic and for automated testing only.

## 3. Acceptance checklist

- [x] 3.1 Write `docs/testing/wemail-acceptance-checklist.md` with a checkbox for each Handoff §2 hard rule, referencing code locations / routes.
- [x] 3.2 Review the checklist against Handoff §2 to ensure completeness.

## 4. Verification

- [x] 4.1 Run `npm run test:server` — must pass.
- [x] 4.2 Run `npm run typecheck:server` — must pass.
- [x] 4.3 Run `npm run typecheck:desktop` — must pass.
- [x] 4.4 Run `npm run build:desktop` — must pass.
- [x] 4.5 Confirm new code has unit tests for the samples module.
- [x] 4.6 Confirm no violations of Handoff §6 hard rules in the sample content (samples themselves are harmless but consumers must not log bodies).
- [x] 4.7 Commit with the exact Handoff §5.K message: `git commit -m "test(wemail): add samples and acceptance checklist"`.
