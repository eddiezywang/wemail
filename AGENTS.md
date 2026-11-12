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

## Windows Development Environment (IMPORTANT)
**Development happens on native Windows.** This repo lives in the repository directory on the development machine. The agent shell is **Git Bash / MSYS2 (MINGW64) running on Windows** — it is a Windows process with direct access to `cmd.exe`/`powershell.exe`, the Windows filesystem, and the Windows Electron runtime. It is **NOT WSL** and **NOT Linux**. When you need to launch, inspect, or interact with the desktop app, you are already on the Windows side — do not invent a WSL boundary that does not exist, and do not tell the user "I can't do this from WSL."

System facts on this machine (verify with `uname -o` → `Msys`, `node -v`, `cat "$APPDATA/wemail/data-location"`):

- System `node`: v24.x (Node `modules` ABI **137**), at `C:\Program Files\nodejs`.
- Electron runtime: **41.x**, exe at `node_modules/electron/dist/WeMailDesktop.exe` (also `electron.exe`).
- Installed product: `D:\Programs\WeMailClient\WeMail.exe` (a fully packaged `app.asar` build — see below).
- Data directory pointer (`%APPDATA%\wemail\data-location`) resolves to `D:\Programs\WeMailData`.

### Native-binding ABI mismatch (the #1 source of false "tests fail" conclusions)
`node_modules/better-sqlite3` is rebuilt for **Electron's Node ABI** (`NODE_MODULE_VERSION` **145**, Electron 41), not for the system `node` ABI (137). Consequences:

- **System `node` cannot load the binding.** Running server tests or any `node`/`tsx` script that touches SQLite under system `node` (v24) fails with `ERR_DLOPEN_FAILED: ... compiled against NODE_MODULE_VERSION 145. This version of Node.js requires 137`. This is expected and is **not** a code defect — those tests must run under Electron's runtime (or via `dev:desktop`), not plain system `node`. Non-DB unit tests still run fine under system `node`.
- **Do not flip the binding to system-node.** Running `npm rebuild better-sqlite3` (or `node-gyp`/`@electron/rebuild`) without targeting Electron rebuilds the `.node` for ABI 137, which then **breaks `dev:desktop` and the packaged app** (they need ABI 145). The Electron-ABI build is the source of truth; only rebuild native bindings when you intend to and know which ABI you are targeting.
- TypeScript compilation (`tsc`/`tsx` without SQLite) works under system `node` and is the fast path for type checks and the Electron-target rebuild below.

### Dev build vs installed product (don't confuse them)
- `npm run dev:desktop` builds into repo `dist-electron/` (+ Vite renderer) and launches `node_modules/electron/dist/WeMailDesktop.exe` against it. **Only a dev launch reads your freshly compiled `dist-electron`.**
- The installed `D:\Programs\WeMailClient\WeMail.exe` reads its own bundled `resources/app.asar` and is **NOT affected by repo rebuilds**. To put a source change into the installed product you must repackage and reinstall (`npm run package:desktop:installer`, then run the installer). `build:desktop:main:quick` / `build:desktop` only help a dev launch.
- For a fast Electron/server/shared rebuild without touching the renderer or native bindings, use `npm run build:desktop:main:quick` (incremental `tsc -p electron/tsconfig.build.json`, which includes `electron/**`, `server/**`, `shared/**`).

### SQLite data dir is single-writer
`D:\Programs\WeMailData\wemail.sqlite` is opened by exactly one app instance at a time. Launching `dev:desktop` while the installed `WeMail.exe` (or another instance) holds that database causes `SQLITE_BUSY`/lock errors. Before starting a second instance against the same data dir, stop the running one (and get explicit user permission first — see Parallel Development Execution Rules).

### Launching / inspecting the app
Because the shell is already native Windows, launch directly (no `cmd.exe /c` wrapper is required, though it also works):

- Dev: `npm run dev:desktop` (waits on the Vite renderer, rebuilds Electron, launches `dist-electron/electron/main/app.js`).
- Installed product: just run `D:\Programs\WeMailClient\WeMail.exe`.
- Process/port checks: `powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort <port> -State Listen | ..."` and `Get-CimInstance Win32_Process`.

### Data directory resolution
Desktop runtime logs/data are **not** always under `%APPDATA%\wemail`. The data directory is resolved by `electron/main/data-directory.ts` `resolveDataDirectory()`: it first honors `WEMAIL_DATA_DIR`, then reads the pointer file `%APPDATA%\wemail\data-location`, then falls back to `%APPDATA%\wemail\data`. On this machine the pointer resolves to `D:\Programs\WeMailData`, so the boot log (`startup.log`, truncated per launch), `notification-delivery-ledger.json`, and the DB all live there. Read `startup.log` from that resolved dir for runtime traces (e.g. notification `source` / `custom-notification-failed`), never from the C-drive userData dir.

### Other environment notes
- Dependency installs go through `bun install` (`bun.lock` is the canonical lockfile; root `package-lock.json` is gitignored). Running `npm install` at the repo root regenerates a stray local `package-lock.json` that can drift from `bun.lock`, which the packaging pipeline installs with `--frozen-lockfile` — avoid it (the `website/` workspace still uses npm with its own tracked lockfile).
- `scripts/patch-pi-skill-exports.mjs` must run after every install (it is the `postinstall` hook) or `tsc` fails on `PiSkillResources.ts`; re-run it manually if it was skipped (e.g. `bun install` without `--trust`).
- If a full `npm run dev:desktop` fails because of an unrelated in-progress parallel change (e.g. the UI information-boundary check or a type error), report the blocking change instead of editing that work-in-progress code unless the user asks you to fix it.
- If a shell ever genuinely is WSL2 (a different machine/setup, not this one), the original WSL caveats apply: do not launch a Linux Electron there (no keyring/safeStorage, wrong bindings, no visible window), and do not rebuild native bindings from WSL (it overwrites the Windows binding with a Linux one). On this machine that situation does not arise.

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
