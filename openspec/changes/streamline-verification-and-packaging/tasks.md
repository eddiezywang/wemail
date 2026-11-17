## 1. Production Build and Packaging

- [x] 1.1 Add a production Electron TypeScript configuration that excludes test sources and switch desktop builds to it
- [x] 1.2 Make package freshness ignore test-only inputs and add an explicit reuse-existing-build packaging path
- [x] 1.3 Remove the duplicate renderer build from the Docker Windows flow
- [x] 1.4 Add/fix installer and platform release package scripts so workflow commands and artifacts agree
- [x] 1.5 Add packaging contract tests for production exclusions, build reuse, and declared release commands

## 2. Test Selection and Local Profiles

- [x] 2.1 Implement deterministic server test classification, path filtering, and sharding utilities with contract tests
- [x] 2.2 Extend the server test runner and add unit, integration, acceptance, evaluation, and live commands
- [x] 2.3 Add independently runnable and shardable Vitest Node/renderer commands plus related-file execution
- [x] 2.4 Implement changed-path classification for documentation, website, renderer, server, Electron, shared, and packaging changes
- [x] 2.5 Implement `verify:changed`, `verify:pr`, and `verify:full` orchestration with selector contract tests

## 3. CI and Release

- [x] 3.1 Split PR CI into parallel type-check, server-unit-shard, and Vitest-shard jobs with an aggregate verification gate
- [x] 3.2 Add main/nightly/manual full validation for integration, acceptance, evaluation, browser E2E, and Electron E2E
- [x] 3.3 Gate release packaging on a successful aggregate verification check for the target commit
- [x] 3.4 Consolidate Windows installer CI to avoid duplicate or non-installer packaging jobs

## 4. Policy and Verification

- [x] 4.1 Update root `AGENTS.md` with the four verification profiles and path-to-check policy
- [x] 4.2 Verify selector unit tests, representative server/Vitest shards, production type checks, desktop build, and packaging contract tests
- [x] 4.3 Audit all specification scenarios against scripts, workflows, and command output; document known unrelated stale tests
