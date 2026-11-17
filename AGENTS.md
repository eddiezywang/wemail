# Repository Guidelines

## Project Structure & Module Organization
WeMail is an Electron desktop application. Do not add, restore, or assume a Tauri/Rust shell; Electron is the only supported desktop runtime. `app/` contains the React Router renderer, `electron/` contains the Electron main process and preload bridge, `server/` contains the local TypeScript API and WeMail services, and `shared/` stores contracts consumed across those layers. Tests live alongside modules and under `tests/`. Use `scripts/` for repository automation, and treat `workspace/forks`, `workspace/overlay`, `workspace/snapshots`, and `workspace/reports` as migration/support areas unless your task explicitly targets them.

## Code Search Etiquette
This repository contains many large files and generated artifacts (e.g. under `workspace/`, `website/`, `build/`, `dist/`, `dist-electron/`). Do not habitually run repository-wide `grep -rn` or equivalent recursive scans — they are slow and produce noisy output. Prefer targeted search: scope `grep`/`rg` to a specific module directory (`app/`, `server/`, `electron/`, `shared/`), use `find`/`ls` to locate files first, or read likely files directly. When you must search broadly, exclude generated/large directories (`--exclude-dir=node_modules --exclude-dir=build --exclude-dir=dist --exclude-dir=workspace`).

## Parallel Development Execution Rules
This repository is frequently modified by multiple agents at the same time. Treat running development processes and generated artifacts as shared state.

- Source inspection and source edits are allowed by default, but do not proactively run tests, type checks, verification profiles, builds, rebuilds, packaging commands, or desktop/dev-server launch and restart commands.
- Only run a test, verification, type-check, build, rebuild, package, launch, or restart command when the user explicitly requests that operation in the current conversation. An implementation request, status request, or “continue” does not authorize it.
- Do not stop, kill, or restart an existing development or desktop process unless the user explicitly asks for that process operation. Never replace or clean generated outputs merely to make a local check pass.
- When validation would be useful but was not requested, report the exact command that remains available and leave execution to the user.

## Build, Test, and Development Commands
The following commands are available only after the user explicitly authorizes the corresponding operation; do not invoke them automatically. Use `npm run dev:renderer` for the renderer, `npm run dev:api` for the standalone local API, or `npm run dev:desktop` to build and launch the full Electron application. Use `npm run build:renderer` for a production renderer build and `npm run build:desktop` for the renderer plus Electron main/preload output. Use `npm run package:desktop:dir` for an unpacked Windows package or `npm run package:desktop:installer` for the installer. Use `npm run typecheck`, `npm run typecheck:server`, and `npm run typecheck:desktop` for TypeScript validation; use `npm run test:server`, `npm run test:renderer`, or `npm run test:e2e` for the corresponding test suites.

## Development Environment

Use the native runtime for the target platform. Install dependencies with `bun install` using `bun.lock`; the postinstall hook patches pi-agent exports and prepares Electron native bindings. The website has its own lockfile.

`better-sqlite3` is a native module: a binding built for Electron may not load in system Node, and rebuilding it for one runtime may break the other. Check runtime ABI compatibility before rebuilding. A development build and an installed application use separate packaged files.

The desktop data directory is resolved by `electron/main/data-directory.ts`: `WEMAIL_DATA_DIR` takes precedence, followed by the path in `%APPDATA%/wemail/data-location` on Windows, then the default user data directory. SQLite has a single writer; do not launch another instance against an active database. Follow the process restrictions above before starting or stopping applications.

## Rapid Interactive Debugging Workflow
For an active desktop interaction bug, optimize for the shortest evidence loop when the user has explicitly authorized runtime validation. First reproduce or inspect request/runtime traces, change one suspected layer, perform only the narrow build needed for that layer, relaunch, and ask for or observe the same real interaction again. Without explicit authorization, stop after the source change and report the validation command instead of launching it. Do not run test suites during this loop. Do not run all three typecheck commands after every small patch. Do not repeat a full renderer and Electron build when only Electron/server code changed; compile the Electron target and reuse the existing production renderer. For renderer-only changes, rebuild only the renderer and relaunch against the existing Electron output. Run the full relevant typechecks and `npm run build:desktop` only when the user explicitly requests an acceptance checkpoint. A healthy process, HTTP 200, or successful window launch is not interaction acceptance; require request-level evidence and the user-visible outcome.

## Coding Style & Naming Conventions
Follow the existing style: 2-space indentation, double quotes, semicolons, and small focused modules. Use TypeScript and ES modules throughout. Use `PascalCase` for React components and service classes, `camelCase` for functions/variables, and the existing module naming convention in each directory. Treat `.ts`/`.tsx` files in `app/`, `electron/`, `server/`, and `shared/` as source of truth; do not edit generated output in `build/`, `dist/`, or `dist-electron/` directly.

## Testing Guidelines
Add focused tests next to the affected TypeScript modules or in the relevant `tests/` area, following the existing `*.test.ts`, `*.test.tsx`, and `*.test.mjs` conventions.

When the user explicitly requests verification, use these profiles:

- `npm run verify:changed` is the local default. It inspects changed paths and runs only the checks required by the policy below.
- `npm run verify:pr` is the pull-request baseline: all three type checks, server unit tests, and both Vitest projects. CI shards these groups in parallel.
- `npm run verify:full` adds server integration/acceptance/evaluation suites, a production desktop build, browser E2E, and Electron E2E. Use it on `main`, nightly/manual validation, or when the user explicitly requests exhaustive verification.
- `npm run ship` packages the current platform only after the target commit has a successful `verification-gate`; release workflows use the platform-specific `package:release:*` commands.

Map changed paths to checks conservatively:

- Documentation and OpenSpec-only changes do not require application tests.
- `website/` changes run the website suite.
- `app/` and renderer-test changes run renderer type checking plus related Vitest tests.
- `server/` changes run server type checking plus unit tests from the nearest stable server domain.
- `electron/` changes run desktop type checking; startup or bridge changes also require Electron E2E in full validation.
- `shared/` changes run renderer/server type checks, related Vitest tests, and server unit tests because contracts cross process boundaries.
- Packaging, build-config, dependency-lock, or workflow changes run packaging contract tests and a production desktop build.
- Unknown paths fall back to `verify:pr`.

Production packaging compiles with `electron/tsconfig.build.json`, which excludes tests. Test-only edits must not invalidate reusable production build outputs. Prefer `package:desktop:*:from-build` only after a fresh successful `build:desktop`.

Do not proactively run any `npm run test*` command or a verification profile that transitively runs tests. Only run them when the user explicitly requests testing or verification. You may still add or update focused tests and report which commands remain to be run.

## Commit & Pull Request Guidelines
The current history uses Conventional Commit prefixes (`chore: initial commit`); continue with formats like `feat: add mail idle retry` or `fix: validate draft payload`. Keep PRs small and include a short summary, affected paths, verification commands, linked issues, and screenshots for UI changes. After requested changes are verified and committed, push them promptly so `main` does not remain ahead of `origin/main` with local-only work. Call out any `.env` or mailbox setup reviewers need to reproduce the change.

## Security & Configuration Tips
Start from `.env.example`; never commit `.env`, `.env.local`, audit logs, policy overrides, or real mailbox credentials. Use the repository-root `.env.local` only for local settings, and keep provider keys and IMAP/SMTP secrets out of test fixtures and screenshots.
