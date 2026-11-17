## ADDED Requirements

### Requirement: User-facing configuration outcomes are deterministic projections
WeMail SHALL derive the primary configuration status, current need, completed work, unattempted work, impact, unaffected scope, and available actions from the canonical task snapshot.

#### Scenario: Summary model is unavailable
- **WHEN** optional LLM wording generation fails
- **THEN** the user SHALL still receive a complete and correct deterministic configuration outcome

### Requirement: Configuration presentation prioritizes the user goal
The primary presentation SHALL lead with the configuration goal and task state, followed by the current blocker or required input, progress, impact, and recovery actions. Tool names, commands, call IDs, and internal codes SHALL appear only as optional diagnostic detail.

#### Scenario: Capability probe is blocked by a missing dependency
- **WHEN** a capability probe cannot run because its dependency is missing
- **THEN** the main card SHALL state that configuration is paused and which configuration work was not performed
- **AND** SHALL NOT lead with a generic tool execution failure

### Requirement: One configuration task updates one stable card
Agent and Settings surfaces SHALL update configuration presentation by task ID and revision rather than appending unrelated cards for each internal tool call.

#### Scenario: Task advances from blocked to preview ready
- **WHEN** recovery succeeds and the task advances to preview
- **THEN** the existing configuration card SHALL update in place
- **AND** completed earlier phases SHALL remain visible

### Requirement: Cross-surface facts and actions remain consistent
Agent, Settings, REST snapshots, and action-required messages SHALL expose the same canonical status, issue, effects, and recovery actions, while allowing surface-specific display density.

#### Scenario: User follows an action-required deep link
- **WHEN** the user opens Settings from a configuration action-required message
- **THEN** Settings SHALL load the referenced task's current revision
- **AND** stale copied message content SHALL NOT override current task state

### Requirement: LLM output cannot alter workflow facts
LLM-generated content MAY provide bounded business-language descriptions but SHALL NOT change task status, step state, issue category, effects, retry safety, confirmation requirements, or recovery actions.

#### Scenario: LLM claims a blocked task completed
- **WHEN** generated wording contradicts the canonical task snapshot
- **THEN** the projector SHALL ignore or replace the contradictory wording
- **AND** SHALL render the canonical blocked state

### Requirement: Only durable intervention states generate action-required delivery
A configuration task SHALL be eligible for an application message or desktop action-required notification only when it durably waits for user intervention and the recovery action remains valid.

#### Scenario: Transient read check retries automatically
- **WHEN** a short transient failure is being retried safely
- **THEN** WeMail SHALL NOT create an action-required desktop notification

#### Scenario: User cancels a blocked task
- **WHEN** the user cancels the task
- **THEN** its referenced action-required message SHALL update or close
- **AND** SHALL NOT continue presenting an active recovery action
