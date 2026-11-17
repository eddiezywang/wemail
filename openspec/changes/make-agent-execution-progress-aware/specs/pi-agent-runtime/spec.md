## ADDED Requirements

### Requirement: Productive Agent execution is not stopped by a low fixed iteration count

The system SHALL allow a built-in Agent run to continue while it is producing observable progress, even when the run exceeds the former shared model-turn or tool-call limit.

Observable progress SHALL include discovering a new mail identifier or page cursor, reading a previously unread selected message, producing new analysis state, advancing a workflow phase, creating a new draft or artifact revision, or creating a new pending operation.

#### Scenario: Multi-mail report exceeds the former iteration limit

- **WHEN** the Agent searches a bounded mail scope, reads distinct selected messages, computes analysis, and creates an artifact through more than six productive steps
- **THEN** the runtime SHALL allow those steps to continue
- **AND** it SHALL allow the model to inspect the final tool result and return a user-facing outcome

#### Scenario: Distinct paginated results are progress

- **WHEN** successive read-only calls return new mail identifiers or a new page cursor
- **THEN** the runtime SHALL classify each successful call as progress
- **AND** it SHALL reset the consecutive no-progress counter

### Requirement: Agent execution uses independent loop and resource guards

The system SHALL guard Agent execution with independent exact-repeat, consecutive no-progress, emergency total-call, per-operation deadline, whole-run deadline, and cancellation controls. It SHALL NOT use one shared low iteration value as all of those controls.

#### Scenario: Exact tool call repeats

- **WHEN** the Agent invokes the same tool with the same normalized arguments more than the configured exact-repeat allowance
- **THEN** the runtime SHALL stop the run as a repeated-call loop
- **AND** it SHALL NOT execute the disallowed repeated call

#### Scenario: Calls vary without producing progress

- **WHEN** successive tool attempts vary in name or arguments but repeatedly fail, return equivalent results, or fail to advance observable state
- **THEN** the runtime SHALL increment a consecutive no-progress counter
- **AND** it SHALL stop the run when the configured consecutive no-progress allowance is exceeded

#### Scenario: Emergency total-call ceiling is reached

- **WHEN** a run reaches the configured emergency tool-call ceiling despite continuing to vary its calls
- **THEN** the runtime SHALL stop the run before executing another tool
- **AND** the termination reason SHALL identify the emergency resource ceiling rather than describing a normal task as too broad

#### Scenario: Productive work reaches a deadline

- **WHEN** a productive run exceeds the configured whole-run deadline
- **THEN** the runtime SHALL abort outstanding Agent work
- **AND** it SHALL return a deadline-specific failed outcome without misclassifying the run as a loop

#### Scenario: User cancels a productive run

- **WHEN** the user cancels an active run
- **THEN** the runtime SHALL abort outstanding model and tool work
- **AND** cancellation SHALL take precedence over progress and resource counters

### Requirement: Progress-aware guards are consistent across runtime modes

The system SHALL apply the same execution-limit semantics to the native PI path, planner-stream PI path, and legacy planner path.

#### Scenario: Productive sequence runs through each runtime mode

- **WHEN** equivalent productive tool sequences are executed through each supported runtime mode
- **THEN** every mode SHALL permit the sequence beyond the former low fixed limit
- **AND** every mode SHALL emit a final user-facing outcome after the last tool result

#### Scenario: Repeated sequence runs through each runtime mode

- **WHEN** equivalent repeated or no-progress sequences are executed through each supported runtime mode
- **THEN** every mode SHALL stop according to the same configured guard and reason category

### Requirement: Agent can read several selected mail sources in one bounded call

The system SHALL expose an internal Agent tool that accepts several distinct message identifiers and returns bounded stored body text and envelope metadata for messages owned by the active account. The tool SHALL preserve input order, report unavailable messages individually, and SHALL NOT expose messages from another account.

#### Scenario: Batch reads distinct selected messages

- **WHEN** the Agent submits valid identifiers for several messages owned by the active account
- **THEN** the tool SHALL return one ordered result entry per distinct identifier
- **AND** each successful entry SHALL include bounded body text, envelope metadata, and truncation metadata

#### Scenario: Duplicate identifiers are submitted

- **WHEN** the batch input contains the same message identifier more than once
- **THEN** the tool SHALL read and return that message only once
- **AND** the returned entries SHALL preserve first-occurrence order

#### Scenario: Batch limits are exceeded

- **WHEN** requested identifiers, per-message characters, or total returned characters exceed configured limits
- **THEN** the tool SHALL reject invalid input or truncate content to the declared bounds
- **AND** it SHALL return explicit count and truncation metadata

#### Scenario: A requested message is missing or belongs to another account

- **WHEN** a requested identifier cannot be read within the active account
- **THEN** the corresponding entry SHALL report an unavailable status without body content
- **AND** other valid entries in the bounded batch MAY still succeed

#### Scenario: Batch mail bodies are observed and logged

- **WHEN** the batch tool emits runtime observations or application logs
- **THEN** observations and logs SHALL contain only counts, identifiers in approved citation structures, truncation state, duration, and outcome metadata
- **AND** they SHALL NOT contain mail body text, HTML, credentials, or absolute local paths

### Requirement: Guard termination produces an actionable structured outcome

The system SHALL emit a structured failed or cancelled conclusion before termination when a progress guard, resource ceiling, deadline, or cancellation ends a run.

#### Scenario: Consecutive no-progress guard stops a run

- **WHEN** the no-progress allowance is exceeded
- **THEN** the conclusion SHALL identify that recent steps stopped advancing
- **AND** it SHALL distinguish completed work from steps that were not executed

#### Scenario: Deadline stops a run

- **WHEN** a tool or whole-run deadline expires
- **THEN** the conclusion SHALL identify the expired deadline
- **AND** it SHALL provide a concrete retry action without claiming that an iteration limit was reached
