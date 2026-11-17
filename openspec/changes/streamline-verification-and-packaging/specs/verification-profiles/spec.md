## ADDED Requirements

### Requirement: Changed-file verification profile
The repository SHALL provide a path-aware verification command that selects checks from committed, staged, unstaged, and untracked changes and SHALL skip application tests when every changed path is documentation or OpenSpec content.

#### Scenario: Renderer-only change
- **WHEN** changed paths are limited to renderer source and colocated renderer tests
- **THEN** the command SHALL run renderer type validation and related Vitest tests without running the full server suite or E2E suites

#### Scenario: Documentation-only change
- **WHEN** every changed path is documentation, Markdown, or OpenSpec planning content
- **THEN** the command SHALL exit successfully without running application tests or desktop packaging

#### Scenario: Shared-contract change
- **WHEN** a changed path is under `shared/`
- **THEN** the command SHALL run renderer and server type validation plus conservative cross-layer unit validation

#### Scenario: Packaging change
- **WHEN** package manifests, desktop build configuration, or packaging scripts change
- **THEN** the command SHALL run packaging contract tests and a production desktop build

### Requirement: Server test scopes
The server test runner SHALL support all, unit, integration, acceptance, evaluation, and live scopes, explicit path filtering, deterministic file ordering, and deterministic shards.

#### Scenario: Default unit scope excludes expensive categories
- **WHEN** `test:server:unit` runs
- **THEN** live, acceptance, evaluation, and integration-classified files SHALL NOT be selected

#### Scenario: Full compatibility command
- **WHEN** `test:server` runs without scope arguments
- **THEN** every discovered server `*.test.ts` file SHALL remain eligible to run

#### Scenario: CI shard selection
- **WHEN** two invocations select shard 1/N and shard 2/N from the same repository state
- **THEN** each SHALL receive a deterministic disjoint subset and all N shards together SHALL cover the selected scope

### Requirement: Renderer test profiles
The repository SHALL expose independently runnable Vitest Node and renderer/jsdom projects, related-file execution for local changes, and deterministic CI sharding.

#### Scenario: Node-only test command
- **WHEN** the Node renderer-test profile runs
- **THEN** it SHALL exclude jsdom component tests

#### Scenario: Related renderer tests
- **WHEN** related-file validation receives changed renderer source paths
- **THEN** Vitest SHALL run only tests related to those paths and SHALL succeed when no related test exists

### Requirement: Pull-request and full verification profiles
The repository SHALL distinguish a parallelizable pull-request profile from a full integration profile.

#### Scenario: Pull-request verification
- **WHEN** PR CI runs
- **THEN** type checks, all server unit shards, and all Vitest project shards SHALL run as independent jobs with one aggregate required gate

#### Scenario: Full validation
- **WHEN** main, nightly, or manual full validation runs
- **THEN** integration, acceptance, evaluation, browser E2E, and Electron E2E checks SHALL remain available in addition to unit validation

### Requirement: Release verification separation
Release packaging SHALL NOT rerun the complete unit-test matrix and SHALL require evidence that the target commit passed the aggregate verification gate.

#### Scenario: Green release commit
- **WHEN** a tagged or manually selected commit has a successful aggregate verification gate
- **THEN** platform packaging SHALL proceed directly to build, sign/notarize, package, smoke-check, and artifact verification

#### Scenario: Unverified release commit
- **WHEN** the target commit has no successful aggregate verification gate
- **THEN** release packaging SHALL fail before signing or artifact generation

### Requirement: Verification policy documentation
The root `AGENTS.md` SHALL define the four verification contexts, path-to-check mapping, and the rule that narrow changes use focused checks while full suites are reserved for explicit full validation contexts.

#### Scenario: Agent chooses validation
- **WHEN** an agent completes a narrow renderer, server, documentation, shared-contract, or packaging change
- **THEN** `AGENTS.md` SHALL provide an unambiguous minimum verification profile for that change
