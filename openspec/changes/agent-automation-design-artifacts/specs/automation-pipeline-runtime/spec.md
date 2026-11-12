## ADDED Requirements

### Requirement: Newly authored rules use a versioned sequential pipeline
The system SHALL persist newly authored automation rules as immutable V2 revisions containing one ordered pipeline and SHALL support existing V1 rules through compatibility compilation.

#### Scenario: New rule contains processing and delivery
- **WHEN** the Agent creates a scheduled digest-and-report rule
- **THEN** extraction, normalization, design, artifact storage, and message publication SHALL be represented as ordered pipeline steps
- **AND** no step SHALL depend on a later step

#### Scenario: Existing V1 rule is edited
- **WHEN** a user materially edits a V1 rule
- **THEN** preview SHALL compile it into a V2 revision
- **AND** the existing V1 revision SHALL remain unchanged until the user confirms the upgrade

### Requirement: Pipeline values and bindings are typed and structured
Pipeline steps SHALL exchange only registered automation value kinds, and input bindings SHALL use structured literal, trigger, collection, previous-step, run, or coalesce expressions validated against provider schemas.

#### Scenario: Attachment output feeds WeCLI
- **WHEN** a mail step emits an AttachmentCollection value and a WeCLI slot expects files
- **THEN** the binding SHALL reference that prior step and output path explicitly
- **AND** the rule SHALL store no runtime file path or free-form `${attachments}` string

#### Scenario: Binding path is invalid
- **WHEN** a binding references an unknown step, future step, missing path, or incompatible value type
- **THEN** static compilation SHALL return a path-specific structured error
- **AND** sample or production execution SHALL not begin

### Requirement: Collection expansion is explicit and bounded
Each step SHALL declare `single`, `all`, or `each` expansion, and the runtime SHALL reject implicit Cartesian products or unbounded per-item invocation.

#### Scenario: All attachments are uploaded together
- **WHEN** a command slot accepts a file collection and expansion is `all`
- **THEN** the provider SHALL receive the bounded collection in one invocation

#### Scenario: Two independent collections request `each`
- **WHEN** a step would independently expand two collections
- **THEN** validation SHALL reject the step
- **AND** SHALL require an earlier processor to create explicit paired records

### Requirement: Pipeline failure and retry behavior is capability-aware
The runtime SHALL execute steps in order, honor confirmed `stop` or `continue` policy, skip unavailable dependencies, and retry only operations that are both retryable and proven retry-safe.

#### Scenario: External upload times out after an uncertain side effect
- **WHEN** an external upload times out and the provider cannot prove whether the upload occurred
- **THEN** the runtime SHALL NOT blindly retry
- **AND** the step SHALL record an uncertain execution failure for user review

#### Scenario: Read-only transient operation is safe to retry
- **WHEN** a read-only provider reports a transient retryable and retry-safe failure within the confirmed retry limit
- **THEN** the runtime MAY retry the same immutable input
- **AND** SHALL record every attempt

### Requirement: Schedule progress is durable and separate from rule revisions
The system SHALL persist mutable runtime state separately from immutable confirmed rule configuration, including planned occurrence boundaries, next run, completion state, failure counters, and pause reason.

#### Scenario: Application restarts after daily run time
- **WHEN** WeMail starts after one or more eligible occurrences were missed
- **THEN** the scheduler SHALL claim at most the latest eligible occurrence
- **AND** SHALL mark the run delayed while retaining the original planned time
- **AND** SHALL not enqueue an unbounded backlog

#### Scenario: Missed occurrence is too old
- **WHEN** the latest missed occurrence exceeds the confirmed maximum catch-up age
- **THEN** the scheduler SHALL skip stale processing, advance the schedule cursor, and record or publish a warning

### Requirement: Scheduled windows use planned recurrence boundaries
Collection rules using the previous schedule window SHALL resolve data boundaries from planned occurrences rather than actual delayed start or completion time.

#### Scenario: Daily report runs two hours late
- **WHEN** a 09:00 daily rule is caught up at 11:00
- **THEN** its window SHALL end at the planned 09:00 occurrence
- **AND** its next window SHALL begin at that planned boundary

### Requirement: Rule and step runs are idempotent and auditable
Each automatic occurrence SHALL have a stable rule-revision key, and every step SHALL persist bounded input summary, output reference, side effects, capability fingerprint, duration, status, warnings, and privacy-safe error metadata.

#### Scenario: Scheduler and restart recovery claim the same occurrence
- **WHEN** concurrent workers attempt the same rule revision and planned occurrence
- **THEN** only one run SHALL own the occurrence key
- **AND** every external side effect and message artifact SHALL occur at most once
