## ADDED Requirements

### Requirement: Configuration entry points share one canonical task
WeMail SHALL represent persistent configuration initiated through the Agent, Settings, REST, or a recovery surface as one account-scoped configuration task with a stable identifier and revision.

#### Scenario: User opens Settings after Agent configuration blocks
- **WHEN** an Agent-created configuration task is blocked and the user opens the corresponding Settings surface
- **THEN** Settings SHALL display the same task status, issue, progress, and recovery actions
- **AND** SHALL NOT create an independent configuration attempt

### Requirement: Durable task creation is delayed until configuration is actionable
WeMail SHALL keep speculative discussion ephemeral and SHALL create a durable task only after the configuration kind, target, and operation are known and the workflow enters prerequisite checking or another actionable phase.

#### Scenario: User discusses an uncertain configuration idea
- **WHEN** the user has not selected a target or operation
- **THEN** the Agent SHALL NOT persist a configuration task

#### Scenario: Workflow starts prerequisite checking
- **WHEN** the target and operation are known and prerequisite checking begins
- **THEN** WeMail SHALL persist the configuration task before running the check

### Requirement: Configuration workflows use canonical phases and step states
WeMail SHALL use the canonical phases `understand_goal`, `collect_requirements`, `check_prerequisites`, `discover_capabilities`, `compile_configuration`, `validate_configuration`, `generate_preview`, `await_confirmation`, `commit_configuration`, and `verify_configuration`. A domain MAY skip an inapplicable phase but SHALL NOT introduce a synonymous top-level phase.

#### Scenario: A prerequisite blocks later work
- **WHEN** prerequisite checking is blocked before discovery, preview, and commit
- **THEN** the prerequisite step SHALL be `blocked`
- **AND** unattempted downstream steps SHALL be `skipped` rather than `failed`

### Requirement: Task, issue, and effect states remain independent
WeMail SHALL model the user's task status independently from its issues and from each operation's effect state. Effect state SHALL distinguish `none`, `planned`, `started`, `committed`, `rolled_back`, `partial`, and `unknown`.

#### Scenario: Commit succeeds but verification is unavailable
- **WHEN** the system has authoritative evidence that a configuration commit succeeded but cannot complete its verification read
- **THEN** the task SHALL preserve the committed effect
- **AND** the outcome SHALL NOT claim that the configuration was not created

#### Scenario: Mutation response is lost
- **WHEN** an external mutation started and its outcome cannot be established
- **THEN** the effect SHALL be `unknown`
- **AND** the task SHALL enter an outcome-unknown state that prohibits automatic retry

### Requirement: Confirmation binds the exact configuration authorization
Every persistent configuration mutation SHALL require an authorization bound to task ID and revision, account, operation, normalized draft hash, preview ID and hash where applicable, source revision, capability fingerprints, risk limits, and expiry.

#### Scenario: Material configuration changes after preview
- **WHEN** any bound material value changes after the user reviewed a preview
- **THEN** the previous confirmation SHALL be invalid
- **AND** the workflow SHALL generate a new preview before offering confirmation

### Requirement: Completion requires commit verification
The workflow SHALL mark a configuration completed only after an authoritative read verifies the expected resource identity, account ownership, revision, and state.

#### Scenario: Verified rule creation
- **WHEN** the exact previewed rule is committed and an authoritative read returns its expected identity, account, revision, and enabled state
- **THEN** the task SHALL become completed

#### Scenario: Commit is rejected by an optimistic revision check
- **WHEN** the source configuration revision changes before commit
- **THEN** the workflow SHALL record a configuration conflict
- **AND** SHALL NOT overwrite the newer revision

### Requirement: Configuration workflows exclude one-time operations
The configuration state machine SHALL cover persistent control-plane changes and SHALL NOT be required for one-time mail queries, sends, moves, or other ordinary operational work.

#### Scenario: User sends one email
- **WHEN** the user confirms a one-time email send
- **THEN** the send SHALL use its existing operation and audit lifecycle
- **AND** SHALL NOT create a configuration task solely because it requires confirmation
