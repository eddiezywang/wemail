## Why

`electron-builder --win` today only runs on Windows, but the user develops in WSL2 and wants a one-command path to a `.exe`. Without a containerised cross-build, every release has to context-switch out of WSL, breaking the "ship from one shell" goal.

## What Changes

- Add `docker/windows-build/Dockerfile` based on `electronuserland/builder:wine-mono`, layered with Node 20, electron-builder, and prebuild support.
- Add `scripts/build-windows.sh`:
  1. Check for `docker`; if missing, print guidance and exit 2.
  2. `docker build -t wemail-winbuild docker/windows-build`.
  3. `docker run --rm -v $PWD:/app -w /app wemail-winbuild` running:
     - `npm ci --target_platform=win32 --target_arch=x64`
     - `npx electron-rebuild --arch=x64 --platform=win32`
     - `npm run build:desktop`
     - `npx electron-builder --win --x64`
  4. Surface `dist/*.exe` path on stdout.
- Modify `package.json`:
  - `package:windows`: `bash scripts/build-windows.sh`
  - `ship`: `npm run typecheck:server && npm run typecheck:desktop && npm run test:server && npm run test:renderer && npm run test:e2e && npm run package:windows`
- Add `electron-builder.yml` (extracted from `package.json` if currently inline):
  - `win.target: [nsis]`, icon, `nsis.oneClick: false`.
  - `files` whitelist excluding tests, `openspec/`, docs, source maps.
  - `asarUnpack: ["**/*.node"]` for `better-sqlite3`.
- Add optional `.github/workflows/ci.yml` running `test:server` + `test:e2e` on `ubuntu-latest`, with `package:windows` on `windows-latest` as a parallel native fallback.
- Add `docs/build/windows-build.md` covering WSL2 + Docker Desktop prerequisites, `npm run package:windows` usage, the unsigned-exe warning, signing paths (signtool on Win, jsign on Linux), and troubleshooting (better-sqlite3 ABI, wine permissions).

## Capabilities

### New Capabilities
- `windows-build-pipeline`: containerised, one-command Windows installer build invokable from WSL2.

### Modified Capabilities
<!-- none -->

## Impact

- Affects `package.json`, new `docker/`, new `scripts/`, new `electron-builder.yml`, optional `.github/workflows/ci.yml`, new `docs/build/`.
- Depends on Package L (something to package) and Package M (`ship` chains `test:e2e`).
- No code signing in phase one — unsigned exe is acceptable. Docker is optional with a graceful fallback message. Script must stay POSIX-sh compatible.

## Dependencies

- Package L (composition root) — provides a real composed app to package.
- Package M (E2E + renderer suites) — `ship` invokes `test:e2e` before packaging.

## Constraints

- No code signing in phase one — unsigned `.exe` is acceptable.
- Docker is optional — script gracefully exits with a clear message when unavailable.
- No proprietary registry access required.
- `scripts/build-windows.sh` MUST stay POSIX-sh compatible.

## Acceptance

1. `npm run package:windows` on WSL2 (with Docker Desktop + WSL integration) produces `dist/*.exe`.
2. `npm run ship` chains all stages and fails fast on the first error.
3. `docs/build/windows-build.md` covers prerequisites, troubleshooting, and signing paths.
4. Commit message exactly: `feat(build): one-command windows build pipeline from wsl2`.
