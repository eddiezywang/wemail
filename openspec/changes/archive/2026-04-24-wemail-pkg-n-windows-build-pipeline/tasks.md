## 1. Container image

- [x] 1.1 Add `docker/windows-build/Dockerfile` based on `electronuserland/builder:wine-mono`
- [x] 1.2 Layer Node 20, electron-builder, and prebuild support into the image
- [x] 1.3 Verify `docker build -t wemail-winbuild docker/windows-build` succeeds locally

## 2. Build script

- [x] 2.1 Add `scripts/build-windows.sh` (POSIX sh)
- [x] 2.2 Check for `docker`; if missing, print guidance and exit 2
- [x] 2.3 Build the `wemail-winbuild` image
- [x] 2.4 `docker run --rm -v $PWD:/app -w /app wemail-winbuild` chaining:
  - `npm ci --target_platform=win32 --target_arch=x64`
  - `npx electron-rebuild --arch=x64 --platform=win32`
  - `npm run build:desktop`
  - `npx electron-builder --win --x64`
- [x] 2.5 Surface `dist/*.exe` path on stdout

## 3. electron-builder config

- [x] 3.1 Add `electron-builder.yml` extracted from `package.json` if inline
- [x] 3.2 Set `win.target: [nsis]`, icon path, `nsis.oneClick: false`
- [x] 3.3 Set `asarUnpack: ["**/*.node"]` for `better-sqlite3`
- [x] 3.4 Add a `files` whitelist excluding tests, `openspec/`, docs, source maps

## 4. package.json scripts

- [x] 4.1 Add `package:windows`: `bash scripts/build-windows.sh`
- [x] 4.2 Add `ship`: `typecheck:server && typecheck:desktop && test:server && test:renderer && test:e2e && package:windows`

## 5. CI (optional)

- [x] 5.1 Add `.github/workflows/ci.yml` with `ubuntu-latest` running `test:server` + `test:e2e`
- [x] 5.2 Add a parallel `windows-latest` job running `package:windows` as native fallback

## 6. Docs

- [x] 6.1 Add `docs/build/windows-build.md`
- [x] 6.2 Document WSL2 + Docker Desktop prerequisites
- [x] 6.3 Document `npm run package:windows` usage
- [x] 6.4 Include unsigned-exe warning and signing paths (signtool on Win, jsign on Linux)
- [x] 6.5 Troubleshooting: better-sqlite3 ABI mismatch, wine permission errors

## 7. Verification

- [x] 7.1 `npm run test:server` passes
- [x] 7.2 `npm run typecheck:server` and `npm run typecheck:desktop` are clean
- [x] 7.3 `npm run build:desktop` is clean
- [x] 7.4 `npm run package:windows` on WSL2 with Docker produces `dist/*.exe`
- [x] 7.5 `npm run ship` chains stages with fail-fast
- [x] 7.6 `docs/build/windows-build.md` covers prereqs, troubleshooting, signing
- [x] 7.7 No §6 hard-rule violation (no signing required; POSIX-sh script; graceful Docker fallback)
- [x] 7.8 Commit message exactly: `feat(build): one-command windows build pipeline from wsl2`
