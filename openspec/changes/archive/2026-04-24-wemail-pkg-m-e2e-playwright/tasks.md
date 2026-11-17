## 1. Tooling

- [ ] 1.1 Add devDeps: `@playwright/test`, `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `@vitest/ui`
- [ ] 1.2 Add `playwright.config.ts` with an Electron project, tmp `userData` per test, trace on failure
- [ ] 1.3 Add `vitest.config.ts` with jsdom env and a testing-library setup file
- [ ] 1.4 Update `.gitignore` to ignore `test-results/` and `playwright-report/`

## 2. E2E harness

- [ ] 2.1 Add `tests/e2e/helpers/electronApp.ts` launcher wrapper
- [ ] 2.2 Implement local hono mock server for IMAP/SMTP upstreams
- [ ] 2.3 Implement LLM mock endpoint returning canned summary/tags/replyDraft
- [ ] 2.4 Wire clean `userData` per run into the helper
- [ ] 2.5 Add `tests/e2e/fixtures/` with account config and canned LLM responses

## 3. E2E specs

- [ ] 3.1 `tests/e2e/login.spec.ts` — blank → configured → API health
- [ ] 3.2 `tests/e2e/sync-summary.spec.ts` — sync → list → detail → summary card renders
- [ ] 3.3 `tests/e2e/tag-reject.spec.ts` — reject tag → `mail_tag_feedback_rules` row appears
- [ ] 3.4 `tests/e2e/reply-draft.spec.ts` — edit draft → send → feedback log entry
- [ ] 3.5 `tests/e2e/logout.spec.ts` — logout → DB preserved

## 4. Renderer suite

- [ ] 4.1 Convert Package D `.test.tsx` placeholders into real vitest suites under `tests/frontend/`
- [ ] 4.2 Ensure ≥10 component tests covering mail list, detail, summary card, tag chip, reply draft editor, login form, settings panel

## 5. Scripts

- [ ] 5.1 Add `test:renderer`: `vitest`
- [ ] 5.2 Add `test:e2e`: `playwright test`
- [ ] 5.3 Add `test:e2e:headed`: `playwright test --headed`
- [ ] 5.4 Rewire root `test` to chain `test:server && test:renderer && test:e2e`

## 6. Verification

- [ ] 6.1 `npm run test:server` passes unchanged
- [ ] 6.2 `npm run typecheck:server` and `npm run typecheck:desktop` are clean
- [ ] 6.3 `npm run build:desktop` is clean
- [ ] 6.4 `npm run test:renderer` — ≥ 10 component tests green
- [ ] 6.5 `npm run test:e2e` — ≥ 5 specs green (headless on WSL2)
- [ ] 6.6 No §6 hard-rule violation (no live IMAP/SMTP/LLM calls; no flaky timer waits; jsdom env for renderer)
- [ ] 6.7 Commit message exactly: `test(e2e): add playwright electron and vitest renderer suites`
