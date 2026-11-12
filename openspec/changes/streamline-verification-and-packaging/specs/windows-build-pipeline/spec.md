## MODIFIED Requirements

### Requirement: Ship pipeline chains verification stages

The `npm run ship` script SHALL perform a release-oriented desktop packaging flow without serially rerunning the repository's complete unit and E2E suites. It SHALL build each production target at most once per environment, reuse an existing verified desktop build for subsequent package stages, and fail fast when build, package smoke, or artifact verification fails. Complete test qualification SHALL be provided by `verify:full` or the aggregate CI gate before release packaging.

#### Scenario: Verified local packaging
- **WHEN** a developer invokes `npm run ship` after the target commit has been verified
- **THEN** the command SHALL build the desktop production output once, generate the platform package, run package-specific smoke/integrity checks, and SHALL NOT invoke `test:server`, `test:renderer`, or a rebuilding E2E command

#### Scenario: Any packaging stage fails
- **WHEN** production build, native runtime preparation, package assembly, smoke launch, or artifact verification exits non-zero
- **THEN** subsequent packaging stages SHALL NOT run and the overall command SHALL exit non-zero

## ADDED Requirements

### Requirement: Production build excludes tests
Desktop production compilation SHALL exclude test, live-test, acceptance-test, evaluation-test, and test-only source files from emitted build output while retaining separate type-check coverage for tests.

#### Scenario: Desktop production build
- **WHEN** `npm run build:desktop` compiles Electron, server, and shared production sources
- **THEN** no `*.test.js`, `*.live.test.js`, `*.acceptance.test.js`, or `*.eval.test.js` file SHALL be emitted into `dist-electron`

### Requirement: Package freshness uses production inputs
Incremental desktop packaging SHALL determine build freshness from production inputs only.

#### Scenario: Test-only edit
- **WHEN** production build outputs are fresh and only a test file changes
- **THEN** `package:desktop:dir` SHALL reuse the existing production build instead of rebuilding renderer and Electron output

#### Scenario: Production source edit
- **WHEN** a production source or production build configuration is newer than the build outputs
- **THEN** `package:desktop:dir` SHALL rebuild before assembling the package

### Requirement: Windows cross-build avoids duplicate renderer builds
The Docker Windows packaging flow SHALL invoke the renderer production build no more than once.

#### Scenario: WSL2 Windows package
- **WHEN** `npm run package:windows` runs in its build container
- **THEN** it SHALL invoke `build:desktop` once and SHALL NOT invoke `build:renderer` separately before it

### Requirement: Installer commands produce declared artifacts
CI and release workflow commands SHALL correspond to scripts present in `package.json` and SHALL generate the artifact paths uploaded by their workflows.

#### Scenario: CI Windows installer
- **WHEN** the Windows installer job runs
- **THEN** it SHALL invoke the installer-producing command and find a non-empty installer and blockmap at the declared upload path

#### Scenario: Platform release command
- **WHEN** a Windows x64, macOS x64, or macOS arm64 release job runs
- **THEN** its referenced package script SHALL exist and invoke the release packager with the matching platform and architecture
