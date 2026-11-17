## ADDED Requirements

### Requirement: Skill Center is local and has two scopes

The system SHALL support immutable built-in Skills and versioned personal Skills only, and SHALL NOT require organization, enterprise, workspace, or cloud Skill management.

#### Scenario: Application lists local Skills

- **WHEN** the user opens Skill Center
- **THEN** the system SHALL list built-in and personal Skills from local application state
- **AND** SHALL NOT require a remote Skill service

#### Scenario: Personal Skill uses the same display name as a built-in Skill

- **WHEN** a personal Skill has the same display name as a built-in Skill
- **THEN** both Skills SHALL retain distinct stable identifiers
- **AND** the personal Skill SHALL NOT overwrite or impersonate the built-in Skill

### Requirement: Skill packages use a portable managed layout

Each Skill SHALL be a managed package containing a required `SKILL.md` and MAY contain WeMail metadata, Agent UI metadata, one-level references, assets, and scripts. WeMail-specific metadata SHALL live outside the portable `SKILL.md` frontmatter.

#### Scenario: Valid package is installed

- **WHEN** a package contains valid `SKILL.md` metadata and a compatible WeMail manifest
- **THEN** the package SHALL be copied into a versioned managed directory
- **AND** its immutable content hash SHALL be recorded

#### Scenario: Portable package lacks a WeMail manifest

- **WHEN** the user imports a standard `SKILL.md` package without a WeMail manifest
- **THEN** the system SHALL infer only safe instruction metadata
- **AND** SHALL require compatibility and permission review before installation

### Requirement: Built-in and personal packages use separate storage

Built-in Skill packages SHALL be loaded from packaged application resources, while personal Skill packages SHALL be stored below Electron `userData`; registry metadata and activation state SHALL be persisted in the local database.

#### Scenario: Application is upgraded

- **WHEN** a new application version replaces built-in Skill resources
- **THEN** personal Skill packages and their version history SHALL remain unchanged

#### Scenario: Personal package source changes after import

- **WHEN** the original imported folder or archive is modified after installation
- **THEN** the managed installed Skill version SHALL remain unchanged

### Requirement: Skill loading uses progressive disclosure

The Agent runtime SHALL load enabled Skill identity and triggering metadata first, load selected `SKILL.md` bodies only when relevant, and load references or assets only when required by the selected workflow.

#### Scenario: User asks an ordinary mail question

- **WHEN** no report, automation, delivery, or Skill-authoring workflow is relevant
- **THEN** the runtime SHALL NOT inject the full bodies of those unrelated Skills

#### Scenario: User explicitly names a Skill

- **WHEN** the user explicitly requests an enabled Skill
- **THEN** the resolver SHALL prefer that Skill
- **AND** SHALL load only its declared dependency closure

### Requirement: Skill import is validated and fail-closed

The import service SHALL validate package naming, frontmatter, manifest schemas, paths, file types, size limits, content hashes, tool declarations, permissions, dependencies, and compatibility before installation.

#### Scenario: Archive attempts path traversal

- **WHEN** an imported archive contains an absolute path, parent traversal, unsafe link, or file outside the package root
- **THEN** import SHALL fail before any managed Skill file is installed

#### Scenario: Imported Skill references unsupported tools

- **WHEN** a Skill requires a tool that WeMail cannot map to a registered internal capability
- **THEN** the compatibility preview SHALL identify that requirement as unavailable
- **AND** the Skill SHALL NOT be reported as fully usable

### Requirement: Personal Skills cannot execute arbitrary code

Personal Skills SHALL be instruction, reference, and asset packages that can call only registered WeMail tools allowed by policy. Imported scripts, shell commands, arbitrary Node.js, Python, HTTP, Electron IPC, and unrestricted filesystem operations SHALL NOT execute.

#### Scenario: Personal Skill contains scripts

- **WHEN** an imported personal Skill includes a `scripts` directory
- **THEN** the system SHALL mark those files as inert or reject the package according to policy
- **AND** SHALL NOT execute them

#### Scenario: Skill declares a high-risk tool

- **WHEN** a Skill declares a send, delete, external mutation, or other high-risk tool
- **THEN** the existing WeMail confirmation policy SHALL still apply
- **AND** installing the Skill SHALL NOT grant that permission

### Requirement: Users can manage personal Skills in Settings

Skill Center SHALL allow users to create, import, inspect, enable, disable, edit, export, version, roll back, and delete personal Skills, and SHALL show permissions, compatibility, source, current version, and automation-rule references.

#### Scenario: User deletes a referenced Skill

- **WHEN** an automation rule references a personal Skill version
- **THEN** Skill Center SHALL prevent destructive removal of the referenced immutable version
- **AND** SHALL explain the referencing rules and available migration choices

#### Scenario: User rolls back a Skill

- **WHEN** the user activates an older personal Skill version
- **THEN** new one-shot tasks SHALL use that active version
- **AND** existing automation rule snapshots SHALL remain unchanged

### Requirement: Agent can author a personal Skill through conversation

The protected Skill-authoring workflow SHALL extract reusable procedure from user intent or a successful task, remove task-specific data and secrets, create a versioned draft, support natural-language revision, validate it, and require exact installation confirmation.

#### Scenario: User saves a successful report workflow

- **WHEN** the user asks to save the current accepted report process as a Skill
- **THEN** the Agent SHALL produce a reviewable Skill draft that separates reusable instructions from current mail content and current-day data
- **AND** SHALL NOT install it yet

#### Scenario: User confirms Skill installation

- **WHEN** the user explicitly confirms the current validated Skill draft
- **THEN** the system SHALL install exactly the confirmed draft hash
- **AND** SHALL verify the installed version before reporting success

#### Scenario: User has not confirmed

- **WHEN** a Skill draft is valid but the user has not explicitly authorized installation
- **THEN** no personal Skill package SHALL be installed or enabled
