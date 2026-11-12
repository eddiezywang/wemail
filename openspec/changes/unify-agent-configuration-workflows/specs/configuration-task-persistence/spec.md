## ADDED Requirements

### Requirement: Actionable configuration state is durable
WeMail SHALL persist actionable configuration tasks, phase steps, issues, recovery actions, and effects before presenting a state that waits for later input, confirmation, or recovery.

#### Scenario: Application restarts while task is blocked
- **WHEN** WeMail restarts after a task becomes blocked
- **THEN** the latest committed snapshot and valid recovery actions SHALL remain available
- **AND** the task SHALL NOT restart side-effecting work automatically

### Requirement: Task mutations are revision-safe and deduplicated
Every task mutation SHALL use optimistic revision checks, and WeMail SHALL allow at most one active task for the same account, configuration kind, target, and operation key.

#### Scenario: Equivalent intent is submitted twice
- **WHEN** a second entry point submits intent equivalent to an active task
- **THEN** WeMail SHALL return or resume the active task
- **AND** SHALL NOT create a duplicate pending mutation

#### Scenario: Two windows update the same task revision
- **WHEN** one window has already advanced the task revision
- **THEN** a mutation from the stale window SHALL be rejected with a configuration conflict

### Requirement: Persisted tasks use scoped references and bounded metadata
Configuration task records SHALL store scoped identifiers, hashes, fingerprints, counts, timestamps, statuses, and bounded summaries instead of embedding configuration secrets or business content.

#### Scenario: Provider returns sensitive diagnostic data
- **WHEN** provider output contains credentials, mail content, attachment content, raw tokens, prompts, temporary paths, or unrestricted environment data
- **THEN** task persistence SHALL omit that data
- **AND** SHALL store only allowlisted privacy-safe metadata

### Requirement: Retention follows task risk and actionability
Active actionable tasks SHALL remain until resolved or cancelled. Completed tasks SHALL default to 30-day retention, ordinary failed or cancelled tasks to 14 days, and outcome-unknown or externally effectful tasks to 90 days.

#### Scenario: Completed task expires
- **WHEN** a completed task reaches its retention deadline
- **THEN** cleanup MAY remove the workflow records
- **AND** SHALL NOT delete committed configuration, immutable rule versions, or independent audit records

### Requirement: Recovery reconciles persisted effects
Before resuming a persisted task, WeMail SHALL load and reconcile its recorded effects and authoritative target state.

#### Scenario: Process exited after commit
- **WHEN** the application exited after a commit effect was recorded but before verification completed
- **THEN** restart recovery SHALL verify the target state
- **AND** SHALL NOT repeat the commit unless authoritative reconciliation proves no effect occurred and retry is safe
