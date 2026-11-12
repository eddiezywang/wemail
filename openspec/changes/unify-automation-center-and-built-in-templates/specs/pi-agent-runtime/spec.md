## ADDED Requirements

### Requirement: Agent automation editing uses the canonical foreground draft

The PI Agent SHALL create and revise automations through the same versioned `ExecutionPipelineDraft`, validation, preview, review, exact confirmation, commit, and verification services used by structured Automation Center editing.

#### Scenario: Agent revises a form-created draft

- **WHEN** the user asks the Agent to change a draft started in the Automation Center
- **THEN** PI SHALL receive the current typed draft identity and revision
- **AND** it SHALL update typed configuration rather than create a parallel rule

#### Scenario: Form resumes an Agent-created draft

- **WHEN** the user opens structured configuration for an unfinished Agent draft
- **THEN** the form SHALL display the current server-authoritative values and reviews
- **AND** saving SHALL use optimistic revision validation

### Requirement: Verified Agent rules are projected into Automation Center

The Agent SHALL not report durable automation success until the committed rule reloads, verifies, and is available through the unified foreground projection.

#### Scenario: Commit succeeds but unified projection does not verify

- **WHEN** a rule write returns but the unified detail cannot reproduce the confirmed rule identity and pipeline hash
- **THEN** the configuration outcome SHALL remain partial or uncertain
- **AND** PI SHALL not claim completed success

#### Scenario: Verified rule is created

- **WHEN** the exact confirmed rule reloads and its unified detail matches
- **THEN** the Agent MAY report success
- **AND** it SHALL provide an action to open that rule in Automation Center

### Requirement: Agent template selection remains user-oriented

PI SHALL reason about user-visible templates and capability categories without exposing provider or executor identities as configuration requirements.

#### Scenario: User asks for 邮箱速览

- **WHEN** the built-in template is compatible with the request
- **THEN** PI SHALL propose or instantiate that template’s pipeline draft
- **AND** it SHALL ask only for material missing user decisions

#### Scenario: Required capability is unavailable

- **WHEN** one template step depends on a known unavailable capability
- **THEN** PI SHALL localize the blocker to that stage and explain its impact and recovery
- **AND** it SHALL not emit a generic provider discovery card
