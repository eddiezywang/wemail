## ADDED Requirements

### Requirement: Agent workflows use a structured reusable pipeline

The system SHALL represent reusable work as a structured pipeline containing data selection, optional analysis, optional artifact generation, delivery, and versioned review state rather than relying on free-form handoff text between Skills.

#### Scenario: Multiple Skills compose one task

- **WHEN** data selection, analysis, artifact review, and delivery Skills participate in one request
- **THEN** each Skill SHALL consume and produce declared structured artifacts
- **AND** the combined pipeline SHALL preserve stable identifiers and versions

### Requirement: One-shot and automated tasks share the same pipeline

The system SHALL execute the same reviewed pipeline either once immediately or repeatedly under a confirmed trigger, without maintaining separate business representations.

#### Scenario: User requests one image now

- **WHEN** the user asks to analyze today's related mail and send one image without recurring language
- **THEN** the system SHALL build and execute a one-shot pipeline
- **AND** SHALL NOT create an automation rule

#### Scenario: User adds a daily schedule

- **WHEN** the same analysis and artifact request includes a daily schedule
- **THEN** automation authoring SHALL wrap the reviewed pipeline in a scheduled trigger
- **AND** SHALL not reimplement the pipeline steps

### Requirement: Capability discovery is task-oriented

The Agent-facing capability catalog SHALL organize executable behavior by trigger, timing, data, analysis, output, and delivery and SHALL expose schemas, availability, risk, preview support, and recovery information without requiring Agent-authored provider identities.

#### Scenario: Agent plans a chart report

- **WHEN** the Agent needs mail collection, model analysis, HTML rendering, and Bot delivery
- **THEN** it SHALL resolve registered capability identifiers in those task categories
- **AND** SHALL NOT invent or submit a `wemail` provider identifier

#### Scenario: Internal executor implementation changes

- **WHEN** a capability is implemented by a different internal executor without changing its contract
- **THEN** Agent-authored pipeline semantics SHALL remain unchanged

### Requirement: Skills declare composable interfaces

Each composable Skill SHALL declare the structured input kinds it accepts, output kinds it produces, dependencies it requires, review policy it recommends, and tools it may request.

#### Scenario: Resolver composes compatible Skills

- **WHEN** one Skill produces an output kind required by another enabled Skill
- **THEN** the resolver MAY compose them in dependency order
- **AND** the pipeline validator SHALL verify the connection

#### Scenario: Skill interfaces are incompatible

- **WHEN** no registered conversion can connect two Skill interfaces
- **THEN** composition SHALL fail before execution
- **AND** the Agent SHALL explain the unsupported portion without inventing an adapter

### Requirement: Skill selection never grants execution authority

Selecting or installing a Skill SHALL NOT grant tools, mailbox scope, external delivery, or mutation authority beyond the current account policy and explicit user confirmations.

#### Scenario: Personal Skill requests Bot sending

- **WHEN** a personal Skill proposes a Bot delivery step
- **THEN** the registered Bot capability and confirmation policy SHALL determine availability and authorization
- **AND** the Skill instructions alone SHALL NOT dispatch the message

### Requirement: Compiled recipes are stable runtime inputs

Analysis, artifact, and delivery decisions accepted during authoring SHALL compile into versioned recipes that deterministic executors can consume without loading the authoring Skill at each automatic occurrence.

#### Scenario: Confirmed rule runs after Skill update

- **WHEN** the active personal Skill version changes after a rule was confirmed
- **THEN** the rule SHALL continue using its confirmed compiled recipes and Skill snapshots
- **AND** SHALL not silently adopt the new Skill version
