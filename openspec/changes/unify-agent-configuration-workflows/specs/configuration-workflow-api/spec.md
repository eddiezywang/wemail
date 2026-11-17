## ADDED Requirements

### Requirement: Mutating configuration APIs return task snapshots
Every migrated configuration mutation API SHALL return a task identifier, current revision, canonical snapshot, and available recovery or confirmation actions instead of exposing only a direct handler result.

#### Scenario: Automation configuration is blocked
- **WHEN** an API request starts an automation configuration whose required provider is unavailable
- **THEN** the response SHALL identify a blocked configuration task and its recovery actions
- **AND** SHALL NOT return an ambiguous generic server failure

### Requirement: Configuration events are revisioned and resumable
WeMail SHALL publish revisioned lifecycle events for task creation, phase changes, issues, recovery availability, preview readiness, and completion, and clients SHALL be able to fetch the authoritative latest snapshot.

#### Scenario: Client misses an event
- **WHEN** a client reconnects after missing configuration events
- **THEN** it SHALL fetch the latest task revision
- **AND** SHALL NOT reconstruct state solely from received deltas

### Requirement: All mutating entry points use the workflow service
Agent tools, Settings handlers, REST routes, and recovery actions for a migrated configuration kind SHALL invoke the canonical workflow service and SHALL NOT write the target configuration directly.

#### Scenario: Settings saves an automation rule
- **WHEN** the automation configuration flow has migrated
- **THEN** Settings SHALL use the same preview, confirmation, commit, and verification workflow as the Agent

### Requirement: Recovery commands enforce task revision and account scope
Recovery, confirmation, cancellation, and retry requests SHALL include the expected task revision and SHALL verify the active account and permitted transition.

#### Scenario: Recovery action is stale
- **WHEN** a client invokes a recovery action from an older task revision
- **THEN** the service SHALL reject the transition
- **AND** SHALL return the current snapshot without executing the stale action

### Requirement: Simple read checks may remain synchronous
WeMail SHALL permit read-only configuration inspection that creates no actionable process to return synchronously without creating a durable task.

#### Scenario: User reads current notification preference
- **WHEN** a caller only requests the current preference and no recovery is needed
- **THEN** the API MAY return the preference directly
- **AND** SHALL NOT create a configuration task
