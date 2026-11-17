## Context

The user develops on WSL2 and wants a single command to produce a Windows `.exe`. `electron-builder --win` today relies on Windows-only toolchains (or partial wine support). We need a containerised cross-build that runs from WSL2 and emits `dist/*.exe` without leaving the shell.

## Goals / Non-Goals

**Goals:**
- `npm run package:windows` from WSL2 produces an unsigned `.exe`.
- `npm run ship` chains typecheck → server tests → renderer tests → E2E → package.
- Reproducible build via a pinned Docker image based on `electronuserland/builder:wine-mono`.
- Clean `electron-builder.yml` that whitelists payload and unpacks native `.node` files.
- Docs covering prerequisites, signing paths, and common failures.

**Non-Goals:**
- Code signing — unsigned is acceptable for phase one.
- Mac / Linux installers — Windows only for now.
- Cross-arch: x64 only.
- Publishing / auto-update hookup.

## Decisions

**Decision 1: Docker + `electronuserland/builder:wine-mono`.**
Rationale: this image already has wine + mono + build tools preinstalled for electron-builder cross-builds. Alternative — install wine directly in WSL — rejected: messy, fragile, and dirties the developer host.

**Decision 2: `scripts/build-windows.sh` is POSIX sh, not bash-specific.**
Rationale: the script has to run inside the container (Alpine-derived) and from WSL shells that may not be bash. Keeps the contract narrow.

**Decision 3: Graceful fallback when Docker is missing.**
Rationale: not every contributor will have Docker Desktop. An early `exit 2` with guidance is kinder than a cryptic `docker: not found`. Alternative — native wine fallback — rejected, too much scope.

**Decision 4: Extract `electron-builder.yml` from `package.json`.**
Rationale: the YAML is about to grow (files whitelist, asarUnpack, nsis options). Keeping it inline bloats `package.json` and makes diffs noisy.

**Decision 5: Optional GitHub Actions workflow as a parallel native fallback.**
Rationale: if a contributor can't run Docker, CI can still produce an exe on `windows-latest`. Not a prerequisite for local developer flow.

## Risks / Trade-offs

- [Risk] `better-sqlite3` ABI mismatch against Electron's Node version inside the container → Mitigation: explicit `electron-rebuild --arch=x64 --platform=win32` step; documented in troubleshooting.
- [Risk] Wine permissions / sandbox issues on some WSL configs → Mitigation: document known fixes; the container isolates most surface area.
- [Risk] Unsigned exe triggers SmartScreen on end-user machines → Accepted for phase one; docs include signing paths for future.
- [Trade-off] CI duration grows substantially — acceptable since `ship` is opt-in, not every PR.

## Migration Plan

1. Land Dockerfile, script, `electron-builder.yml`, and docs with no change to existing scripts.
2. Add `package:windows` script and verify locally.
3. Add `ship` script composing the full chain once Package M is green.

Rollback: delete `docker/windows-build/`, `scripts/build-windows.sh`, `electron-builder.yml`; revert `package.json` script additions.

## Open Questions

- Do we want to pin a specific `electronuserland/builder` tag or track `wine-mono`? Initial plan: pin a digest in the Dockerfile comment, update manually.
