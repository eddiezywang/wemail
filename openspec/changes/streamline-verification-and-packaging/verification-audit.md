# Verification Audit

## Scenario coverage

- Production Electron compilation cleans generated Electron output, then uses `electron/tsconfig.build.json`; test sources are excluded while the broader desktop type-check configuration remains unchanged. Cleaning prevents stale test JavaScript from an older broad compilation from leaking into a package. Files named `*.spec.ts` under the intelligence evaluation registry are production feature specifications and remain intentionally compiled.
- Desktop packaging freshness walks only production inputs. `package:desktop:dir:from-build` and `package:desktop:installer:from-build` reject missing or stale build output.
- Windows Docker packaging invokes `build:desktop` once and no longer invokes `build:renderer` separately.
- Server tests are deterministically classified as unit, integration, acceptance, evaluation, or live; selection supports repeated path filters and stable `index/total` sharding.
- Vitest Node and DOM projects can run and shard independently, while `test:renderer:related` supports local changed-file checks.
- Changed-path routing covers documentation/OpenSpec, website, renderer, server domains, Electron, shared contracts, packaging inputs, and an unknown-path fallback.
- Pull-request CI runs type checks, four server-unit shards, and four Vitest project/shards in parallel. Applicable browser/Electron E2E jobs and all full-context suites feed the final `verification-gate`.
- Main, nightly, and manual CI add server integration/acceptance/evaluation, browser E2E, and Electron E2E.
- Desktop release jobs query the target commit for a successful final `verification-gate` and use declared platform release commands. The duplicate Windows installer job was removed from general CI.

## Local verification evidence

- `npx openspec validate streamline-verification-and-packaging --strict`: passed.
- `npm run test:packaging`: 57 passed, 1 platform skip (58 total).
- `npm run typecheck`, `npm run typecheck:server`, and `npm run typecheck:desktop`: passed.
- `npm run build:desktop`: passed; production renderer and Electron output completed in about 44 seconds.
- `npm run test:server:unit -- --shard 1/4`: 59 files, 528 tests passed in about 41 seconds.
- `npm run test:renderer:node -- --shard=1/2`: 29 files, 201 tests passed in about 7 seconds.
- `npm run test:renderer:node -- --shard=2/2`: 29 files, 142 tests passed in about 17 seconds.
- `npm run test:renderer:dom -- --shard=1/2`: 49 files, 285 tests passed in about 72 seconds.
- `npm run test:renderer:dom -- --shard=2/2`: 48 files, 356 tests passed in about 65 seconds.
- Focused stale-contract cleanup: database migration tests (19), NavLink tests (8), Sidebar tests (11), and SingleMessageView test (1) passed.

## Known environmental warnings

- Root renderer type generation and production build emit a non-fatal warning when `website/node_modules` is not installed because the website tsconfig extends Astro's strict config. Both commands exit successfully; the website has its own dependency install and test profile.
- Vite reports two existing renderer chunks over 500 kB. This change reduces redundant builds and test execution but does not alter renderer chunking.
