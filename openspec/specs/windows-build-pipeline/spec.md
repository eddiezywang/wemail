# windows-build-pipeline Specification

## Purpose
TBD - created by archiving change wemail-pkg-n-windows-build-pipeline. Update Purpose after archive.
## Requirements
### Requirement: One-command Windows build from WSL2

The repository SHALL provide `npm run package:windows` which, from a WSL2 shell with Docker Desktop + WSL integration, produces an unsigned Windows `.exe` installer under `dist/` without requiring any Windows host.

#### Scenario: Build from WSL2
- **WHEN** a developer on WSL2 with Docker running invokes `npm run package:windows`
- **THEN** `scripts/build-windows.sh` SHALL build the `wemail-winbuild` image, run electron-builder inside the container targeting `win --x64`, and emit a `.exe` under `dist/`

#### Scenario: Docker missing
- **WHEN** the script runs on a host without `docker` installed
- **THEN** it SHALL print guidance and exit with code 2, without attempting any build step

### Requirement: Ship pipeline chains verification stages

The `npm run ship` script SHALL run, fail-fast and in order: `typecheck:server`, `typecheck:desktop`, `test:server`, `test:renderer`, `test:e2e`, then `package:windows`.

#### Scenario: Any stage fails
- **WHEN** any stage in `ship` exits non-zero
- **THEN** subsequent stages SHALL NOT run and the overall command SHALL exit non-zero

### Requirement: electron-builder config excludes test and spec artefacts

The `electron-builder.yml` SHALL use `win.target: [nsis]` with `nsis.oneClick: false`, `asarUnpack: ["**/*.node"]` for `better-sqlite3`, and a `files` whitelist that excludes tests, `openspec/`, docs, and source maps from the shipped installer.

#### Scenario: Installer payload
- **WHEN** the `.exe` is built
- **THEN** the installer payload SHALL NOT contain `*.test.*`, `openspec/`, `docs/`, or `*.map` files

### Requirement: Windows build documentation

The repository SHALL include `docs/build/windows-build.md` covering WSL2 + Docker Desktop prerequisites, usage of `npm run package:windows`, the unsigned-exe warning, signing paths (signtool on Windows, jsign on Linux), and troubleshooting for better-sqlite3 ABI and wine permissions.

#### Scenario: New contributor reads docs
- **WHEN** a new contributor follows `docs/build/windows-build.md` on a fresh WSL2 host
- **THEN** they SHALL be able to produce a `.exe` using only the documented steps

