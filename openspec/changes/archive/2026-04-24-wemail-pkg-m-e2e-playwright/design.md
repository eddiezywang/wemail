## Context

The repository has strong server-side coverage but zero renderer or end-to-end coverage. Package D shipped React components with `.test.tsx` placeholder files that have no runner configured. With Package L wiring a real API, we finally have something worth driving from a browser. Before shipping, we need confidence that the UI flows still work after every PR.

## Goals / Non-Goals

**Goals:**
- Fast, reliable vitest renderer suite usable in watch mode.
- Playwright Electron suite that launches the composed app with mocked upstreams.
- Scripted entry points (`test:renderer`, `test:e2e`, `test:e2e:headed`) chained under `test`.
- WSL2-first ergonomics: headless by default, optional WSLg / xvfb.

**Non-Goals:**
- Visual regression / screenshot diffing.
- Cross-browser coverage — Electron's Chromium is the only target.
- Real account flows — everything is mocked.

## Decisions

**Decision 1: Playwright over Spectron.**
Rationale: Spectron is archived. Playwright has first-class Electron support, trace viewer, and an active community. No alternative seriously considered.

**Decision 2: Local hono mock server for IMAP/SMTP/LLM.**
Rationale: we already use hono on the server side, so contributors know it. A single in-process mock process is simpler than separate sinks for IMAP and HTTP. Alternative — `nock` / service workers — rejected because Electron main-process traffic isn't easy to intercept from the renderer side.

**Decision 3: Per-test tmp `userData`.**
Rationale: parallelism and test isolation. Each spec gets a fresh SQLite file, and the logout test can assert DB preservation without polluting peers.

**Decision 4: vitest over jest for renderer.**
Rationale: faster, ESM-native, matches the ecosystem we already use for server. jsdom env is built in.

**Decision 5: Convert Package D placeholders, do not delete.**
Rationale: preserves the file structure Package D set up and gives a natural home for the real tests.

## Risks / Trade-offs

- [Risk] Playwright on WSL2 without display → Mitigation: headless by default; document `xvfb-run` / WSLg for `--headed` runs.
- [Risk] Flaky waits on DOM signals → Mitigation: all waits go through Playwright's built-in auto-retry locators; no `waitForTimeout`.
- [Risk] Electron version mismatch between `@playwright/test` expectations and our bundled Electron → Mitigation: pin Playwright in devDeps and verify the launcher helper passes `executablePath` explicitly.
- [Trade-off] Test run time grows — expected. Compensated by `test:server` staying fast and `test:e2e` running last in the `ship` chain.

## Migration Plan

1. Add runners and configs without touching existing scripts.
2. Convert placeholders into real renderer tests.
3. Write E2E helpers and specs.
4. Rewire the root `test` script to chain all three suites only after green runs are confirmed.

Rollback: delete the new test trees; script changes are additive.

## Open Questions

- CI runtime: do we accept +3–5 min on `ship`, or do we parallelise `test:e2e` shards? Defer until we have a baseline.
