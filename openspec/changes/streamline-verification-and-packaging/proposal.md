## Why

WeMail currently treats local verification, pull-request validation, end-to-end testing, and release packaging as one mostly serial workflow. The result is more than five minutes of feedback for routine changes, repeated renderer and desktop builds, production compilation of test sources, and release jobs whose package commands no longer match the repository scripts.

## What Changes

- Introduce explicit fast, pull-request, full, and release verification profiles instead of running every test for every change.
- Split server tests into unit, integration, acceptance, evaluation, and live scopes, while supporting explicit files, changed-file selection, and CI sharding.
- Split Vitest node and renderer projects into directly runnable and shardable commands, with changed-file execution for local work.
- Add a path-aware verification command that skips application tests for documentation-only changes and selects the affected layers for renderer, server, Electron, shared-contract, and packaging changes.
- Add production-only TypeScript build configurations that exclude tests and test harnesses.
- Remove duplicate renderer/desktop builds, allow E2E and packaging to reuse a completed build, and make package freshness ignore non-production files.
- Rework CI so independent checks run in parallel, expensive suites are path-gated, full integration coverage runs on main/nightly, and releases package only commits that have passed verification.
- Repair and consolidate desktop release commands and installer artifact expectations.
- Record the permanent verification and packaging policy in the repository root `AGENTS.md`.
- **BREAKING**: `npm run ship` no longer serially runs every test suite before building; it becomes the release-oriented build/package path and relies on the required verification profile/CI gate.

## Capabilities

### New Capabilities

- `verification-profiles`: Defines local changed-file checks, pull-request checks, full/nightly validation, test scopes, sharding, and path-based test selection.

### Modified Capabilities

- `windows-build-pipeline`: Removes repeated builds from shipping and requires reusable production build outputs plus verified installer generation.

## Impact

- Scripts and commands in `package.json` and `scripts/`.
- TypeScript production and verification configurations under the repository root, `server/`, and `electron/`.
- Vitest, Node test, Playwright, and desktop packaging execution.
- GitHub Actions CI and release workflows.
- Contributor/agent guidance in `AGENTS.md`.
- No runtime application API or persisted user data changes.
