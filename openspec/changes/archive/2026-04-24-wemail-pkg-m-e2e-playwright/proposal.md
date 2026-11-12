## Why

Package D shipped `.test.tsx` placeholders without a test runner, and there is zero end-to-end coverage of the Electron renderer. The user's stated goal — "make sure the UI doesn't break before I ship" — requires both unit-level renderer coverage and a real Electron E2E suite that exercises the composed app from Package L.

## What Changes

- Add devDependencies: `@playwright/test`, `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `@vitest/ui`.
- Add `playwright.config.ts` — Electron project, per-test tmp `userData`, trace on failure.
- Add `vitest.config.ts` — jsdom environment, @testing-library setup file.
- Add `tests/e2e/helpers/electronApp.ts` — launch wrapper that mocks IMAP/SMTP via a local hono mock server, mocks the LLM endpoint with canned summary/tag/replyDraft payloads, and cleans `userData` between runs.
- Add `tests/e2e/fixtures/` — account config and canned LLM responses.
- Add ≥5 `tests/e2e/*.spec.ts` specs:
  1. Login flow (blank → configured → API health).
  2. Sync → list → detail → summary card renders.
  3. Tag reject → `mail_tag_feedback_rules` row appears.
  4. Reply draft → edit & send → feedback log entry exists.
  5. Logout → DB preserved.
- Convert Package D placeholder tests into real vitest suites under `tests/frontend/*.test.tsx`.
- Modify `package.json` scripts:
  - `test:renderer`: `vitest`
  - `test:e2e`: `playwright test`
  - `test:e2e:headed`: `playwright test --headed`
  - `test`: `npm run test:server && npm run test:renderer && npm run test:e2e`
- Update `.gitignore`: `test-results/`, `playwright-report/`.

## Capabilities

### New Capabilities
- `e2e-playwright`: end-to-end + renderer testing capability covering Electron launch, mocked upstreams, and React component coverage.

### Modified Capabilities
<!-- none -->

## Impact

- Affects `package.json`, `.gitignore`, root `playwright.config.ts`, root `vitest.config.ts`, new `tests/` tree.
- Depends on Package L being merged so the composed app actually serves data.
- WSL2 default headless; CI uses WSLg or `xvfb-run`. No real IMAP/SMTP/LLM traffic in tests. No flaky waits — must wait on real DOM signals.

## Dependencies

- Package L (composition root) — required so the launched Electron app has working API endpoints to exercise.

## Constraints

- WSL2 headless by default; WSLg or `xvfb-run` for CI.
- No real IMAP/SMTP/LLM traffic in tests — everything mocked locally.
- Renderer tests MUST pass under jsdom env.
- No flakiness — every wait MUST be tied to a real DOM signal, not a timer.

## Acceptance

1. `npm run test:renderer` runs ≥ 10 component tests, all green.
2. `npm run test:e2e` runs ≥ 5 specs, all green.
3. `npm run test:server` continues to pass unchanged.
4. `npm run typecheck:desktop` and `npm run typecheck:server` are clean.
5. Commit message exactly: `test(e2e): add playwright electron and vitest renderer suites`.
