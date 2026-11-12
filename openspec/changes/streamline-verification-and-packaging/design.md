## Context

The repository has four distinct validation contexts but currently exposes mostly all-or-nothing commands. `test:server` discovers 256 files without scope filtering, `test:renderer` starts 157 Vitest files across Node and jsdom, `ship` serializes type checks and all suites, Electron E2E builds the desktop output, and Windows packaging builds it again. The Windows Docker script also invokes the renderer build both directly and through `build:desktop`. Production Electron TypeScript compilation includes `server` and `shared` test files, and the incremental package freshness scan treats test-only edits as production changes.

The repository already has useful building blocks: separate Vitest projects, E2E `--skip-build`, a cached Windows directory packager, native-binding caches, and focused tests colocated with implementation. The design extends those mechanisms rather than adding a test framework or build system.

## Goals / Non-Goals

**Goals:**

- Give developers a fast default that selects verification from changed paths.
- Preserve a discoverable full validation command and complete CI coverage.
- Separate unit, integration, acceptance, evaluation, and live server suites.
- Make test selection and sharding deterministic and testable.
- Compile only production TypeScript into desktop artifacts.
- Build renderer/main once per packaging flow and reuse those outputs for E2E/package stages.
- Make PR checks parallel and make release packaging depend on a green commit rather than rerunning the full suite.
- Keep long-running validation available on main, manual dispatch, and nightly schedules.

**Non-Goals:**

- Deleting tests solely to improve timing.
- Replacing Node test, Vitest, or Playwright.
- Inferring a perfect module dependency graph for server tests.
- Changing application runtime behavior or mailbox data.
- Making code signing or Apple notarization faster.

## Decisions

### 1. Four named verification profiles

The repository will expose `verify:changed`, `verify:pr`, `verify:full`, and release packaging commands. `verify:changed` is path-aware and local; `verify:pr` covers type checks and the default unit suites; `verify:full` adds integration, acceptance, evaluation, browser, and Electron suites; release packaging builds and verifies artifacts but does not rerun unit suites.

This is preferred over one command with many environment flags because command names make intent visible in CI logs and `AGENTS.md`.

### 2. Deterministic filename-based server scopes

Server scope classification will use stable names and locations:

- live: `*.live.test.ts`
- acceptance: `*.acceptance.test.ts` or an `acceptance/` directory
- evaluation: `*.eval.test.ts`, `*.evaluation.test.ts`, or an `eval/` directory
- integration: `*.integration.test.ts` and `*.workspace.test.ts`
- unit: all remaining server tests

The existing `test:server` remains the all-scope compatibility command. New scope commands and explicit `--path`/`--shard` options use one shared selector. Manual sharding partitions the sorted file list, so it does not depend on Node-version-specific sharding flags.

### 3. Conservative changed-path routing

`verify:changed` will gather committed, staged, unstaged, and untracked paths. Documentation/OpenSpec-only edits skip application tests. Website-only edits run the website suite. Renderer and Electron edits use Vitest related-file execution plus the relevant type check. Server edits run tests in the nearest server domain plus the server type check. Shared-contract edits run both type-check layers and the default server unit suite because their impact crosses layers. Packaging/configuration edits run packaging tests and a production desktop build.

When classification is uncertain, the selector broadens validation; it never silently treats an unknown production path as documentation-only.

### 4. Production TypeScript configuration is separate from test checking

`electron/tsconfig.build.json` will extend the desktop config and exclude test sources. `build:desktop` will use it, while `typecheck:desktop` continues checking tests. This removes test emit and production-build coupling without reducing test type safety.

### 5. Reusable build outputs are explicit

The directory packager will accept `--skip-build`, and its freshness scan will ignore tests. E2E already accepts `--skip-build`. Windows Docker packaging will invoke `build:desktop` once. Installer commands will distinguish “build if needed” from “package an existing verified build.”

The alternative of relying only on mtimes was rejected because test-only edits currently invalidate production outputs. A source filter is sufficient for this change; a full content-addressed build graph can be added later.

### 6. CI uses shards and an aggregate gate

PR CI will run type checks, server unit shards, and Vitest project shards in parallel. A final `verification-gate` job provides one stable required check. Full integration/E2E validation will run on main, schedule, or manual dispatch, and expensive browser/Electron jobs will be path-gated on PRs.

Release workflows will query the target commit for a successful `verification-gate` before platform packaging jobs begin. This avoids rerunning the unit matrix during release while preserving a machine-enforced prerequisite.

### 7. Repository policy is authoritative in AGENTS.md

The root `AGENTS.md` will document which profile applies to each change type, prohibit unconditional full-suite runs for narrow changes, require focused tests when implementation changes behavior, and reserve full validation for explicit requests, CI/main/nightly, and release qualification.

## Risks / Trade-offs

- [Changed-file selection misses indirect server impact] → Shared files broaden to the server unit suite; PR CI still runs every unit shard.
- [Filename scopes initially misclassify a test] → Add selector contract tests and keep `test:server` as an all-scope fallback.
- [Release commit lacks a visible CI gate, especially on manual dispatch] → Fail closed with a message explaining how to run CI; allow no implicit bypass.
- [CI matrix increases job count] → Use one aggregate required check and cache npm downloads on every job.
- [Production tsconfig excludes a helper imported only by packaging smoke] → Keep imported runtime helpers included through normal TypeScript dependency resolution and verify required packaged files.
- [E2E remains inherently slow] → Move it off the local default rather than weakening it.
- [Existing stale tests fail full validation] → Record failures separately; do not make unrelated full-suite failures block focused implementation verification unless the changed area owns them.

## Migration Plan

1. Add selector modules/tests and new scripts without removing compatibility commands.
2. Switch production build and packaging flows to reusable outputs.
3. Introduce CI shards and the aggregate gate; validate workflow syntax and local shard commands.
4. Add main/nightly full validation and release prerequisite checks.
5. Update `AGENTS.md`; retain old commands as documented full fallbacks during migration.

Rollback is command-level: restore the prior package scripts and CI workflow while leaving selector utilities unused. No user data migration is required.

## Open Questions

- Historical timing data is not yet persisted per test file; initial shard balance is deterministic by file index rather than duration-aware.
- Electron E2E availability on Linux CI may still depend on runner display/native-library support; the full workflow should fail clearly rather than report a false skip.
