## ADDED Requirements

### Requirement: Automation templates are declarative pipeline blueprints

The system SHALL represent each automation template as immutable metadata, configuration schema, UI schema, pipeline blueprint, result schema identity, renderer identity, defaults, version, and content hash.

#### Scenario: Built-in template is instantiated

- **WHEN** a user selects a built-in template and supplies valid configuration
- **THEN** the system SHALL compile the template into the canonical `ExecutionPipelineDraft`
- **AND** subsequent preview, review, confirmation, scheduling, and execution SHALL use existing pipeline services

#### Scenario: Template declares an independent executor

- **WHEN** a package attempts to bypass the pipeline runtime with its own scheduler or unrestricted executor
- **THEN** template validation SHALL reject the package

### Requirement: Template terminology remains separate from Skills and capabilities

The registry SHALL treat templates as user-facing reusable configurations, Skills as Agent reasoning packages, capabilities as executable operations, and rules as confirmed instances.

#### Scenario: Template references Agent guidance

- **WHEN** a template declares one or more Skills for authoring or review
- **THEN** those Skills MAY help construct the draft
- **AND** they SHALL NOT execute during an automatic occurrence

#### Scenario: Template references a capability

- **WHEN** the pipeline blueprint names a registered capability
- **THEN** normal capability readiness, schema, risk, and fingerprint validation SHALL apply
- **AND** internal provider identity SHALL not appear in template configuration

### Requirement: Built-in and personal templates are discovered locally and validated

The registry SHALL discover built-in templates from packaged Electron resources with a development fallback and SHALL store versioned personal templates in managed local storage.

#### Scenario: Application update adds a built-in template

- **WHEN** a newer application contains a new valid built-in template version
- **THEN** the registry SHALL expose it without altering rules bound to earlier versions

#### Scenario: Personal template shadows a protected built-in ID

- **WHEN** a personal template declares a protected built-in ID
- **THEN** installation SHALL fail or require a distinct personal-copy ID

#### Scenario: Template package is tampered

- **WHEN** the resolved content no longer matches its registered hash
- **THEN** the version SHALL be disabled
- **AND** no new rule or upgrade SHALL compile from it

### Requirement: Template configuration is schema-validated and UI-safe

The server SHALL validate defaults and user configuration against a bounded registered schema before creating or revising a pipeline draft.

#### Scenario: Configuration contains an unknown property

- **WHEN** strict template configuration includes an undeclared field
- **THEN** validation SHALL return a path-specific error
- **AND** draft compilation SHALL not begin

#### Scenario: UI schema requests arbitrary code

- **WHEN** a template UI schema requests executable script, raw HTML, network access, process access, or unrestricted filesystem behavior
- **THEN** template validation SHALL reject it

### Requirement: Recommended templates do not create side effects

The foreground catalog SHALL distinguish recommended templates from configured automations, and viewing or previewing a recommendation SHALL not persist or enable a rule.

#### Scenario: User previews a recommendation

- **WHEN** the user opens “邮箱速览” from the recommended section
- **THEN** the center SHALL show its purpose, defaults, required capabilities, and sample/real-data preview choice
- **AND** no schedule or delivery SHALL be enabled

#### Scenario: User accepts a template

- **WHEN** all required configuration and reviews are current and the user confirms the exact rule
- **THEN** the system SHALL create one verified automation rule bound to that template version

### Requirement: Rules bind exact template and renderer versions

Every template-created rule SHALL persist template ID, template version, template hash, result schema identity, renderer ID, and renderer version in its immutable rule version.

#### Scenario: New template version becomes available

- **WHEN** a rule is bound to an older compatible template version
- **THEN** the center SHALL mark an optional upgrade
- **AND** automatic runs SHALL continue using the bound version

#### Scenario: User upgrades a template-bound rule

- **WHEN** the user starts an upgrade
- **THEN** the system SHALL create a draft, show semantic changes, regenerate affected previews, and require exact confirmation
- **AND** the previous rule version SHALL remain available for rollback

### Requirement: Successful workflows can become non-executable personal templates

The system SHALL allow a confirmed reusable workflow to be saved as a versioned personal template after removing source-specific values, mail content, credentials, and transient identifiers.

#### Scenario: Save successful monitoring workflow as template

- **WHEN** the user asks to reuse a successful monitoring workflow
- **THEN** the system SHALL derive configuration inputs and a pipeline blueprint
- **AND** it SHALL exclude sample rows, mail bodies, account secrets, local temporary paths, and run IDs
