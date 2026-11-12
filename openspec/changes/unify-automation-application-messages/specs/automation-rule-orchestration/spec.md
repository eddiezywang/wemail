## ADDED Requirements

### Requirement: Existing automation rules remain compatible
The system SHALL continue to read and execute existing manual, mail-received, interval-scheduled, structured-condition, natural-language-condition, delayed-execution, and per-message action rules without silently broadening their scope.

#### Scenario: Legacy interval rule is loaded
- **WHEN** a persisted rule contains `intervalMinutes` and no canonical schedule payload
- **THEN** the system SHALL normalize it to an equivalent interval schedule
- **AND** SHALL preserve its enabled state, conditions, actions, and next-run behavior

#### Scenario: Legacy rule has no trigger
- **WHEN** a pre-trigger automation row is read
- **THEN** the system SHALL continue to treat it as manual
- **AND** SHALL NOT begin executing it automatically

### Requirement: Canonical capabilities drive every configuration surface
The system SHALL define trigger schedules, condition fields and operators, collection scopes, processors, and actions in canonical capability definitions used by runtime validation, REST configuration, UI controls, Agent schemas, previews, and confirmation presentation.

#### Scenario: New action capability is registered
- **WHEN** a new automation action is made available for rule creation
- **THEN** its parameter validation and risk metadata SHALL come from the canonical definition
- **AND** UI and Agent capability discovery SHALL expose the same supported parameters

#### Scenario: Unsupported capability is submitted
- **WHEN** UI, REST, or Agent input contains an unregistered trigger, condition, scope, processor, or action type
- **THEN** the shared rule service SHALL reject the draft before persistence

### Requirement: Rules explicitly distinguish per-message and collection execution
The system SHALL represent whether a rule applies actions independently to each matched email or processes the matched email set once per trigger run.

#### Scenario: Existing mail-received rule runs per message
- **WHEN** an existing per-message rule matches a newly inserted live email
- **THEN** the system SHALL execute its actions with that email as the target

#### Scenario: Collection rule matches multiple messages
- **WHEN** a collection rule resolves a window containing multiple matching emails
- **THEN** the system SHALL invoke each collection processor once with one bounded matched-set manifest
- **AND** SHALL invoke collection delivery actions once for that run rather than once per email

### Requirement: Calendar schedules preserve local-time intent
The system SHALL support calendar schedules such as daily at a local time using an IANA timezone and SHALL derive future occurrences from the recurrence anchor rather than execution completion time.

#### Scenario: Daily rule reaches its local time
- **WHEN** a daily rule configured for `10:00` in `Asia/Shanghai` becomes due
- **THEN** the scheduler SHALL claim one run for that calendar occurrence
- **AND** SHALL calculate the next occurrence as the next local calendar day at `10:00`

#### Scenario: Application restarts after a missed occurrence
- **WHEN** the application resumes after one or more scheduled occurrences were missed
- **THEN** it SHALL execute at most the latest eligible catch-up window
- **AND** SHALL NOT enqueue an unbounded backlog

### Requirement: Collection scopes resolve immutable run windows
The system SHALL resolve and persist the account, time window, mailbox scope, and candidate-selection parameters before evaluating a collection rule.

#### Scenario: User requests the past 24 hours
- **WHEN** a rolling 24-hour collection rule is claimed at time `T`
- **THEN** its run window SHALL be persisted as `[T-24h, T]`
- **AND** retries SHALL reuse the same window rather than recalculating it

#### Scenario: Folder and condition filters are combined
- **WHEN** a collection scope targets a folder and the rule contains structured or natural-language conditions
- **THEN** candidates SHALL first be constrained to the account, window, and folder
- **AND** the production matcher SHALL evaluate the rule conditions against those candidates

### Requirement: Collection processors return typed bounded results
The system SHALL execute only registered collection processors and SHALL validate their bounded typed results before an action consumes or persists them.

#### Scenario: Mail digest processor completes
- **WHEN** a mail-digest processor receives a matched-set manifest
- **THEN** it SHALL return validated overview, themes, action items, statistics, and source email references
- **AND** SHALL indicate whether candidate or prompt limits truncated the result

#### Scenario: Processor output is invalid
- **WHEN** a processor or model returns an invalid or oversized result
- **THEN** the run SHALL fail closed for dependent actions
- **AND** the run audit SHALL record a privacy-safe reason without persisting arbitrary output

### Requirement: Production matching and preview matching are identical
The system SHALL use the same normalized rule, structured matcher, natural-language evaluator policy, candidate query, and collection semantics for preview and real execution, except that preview SHALL NOT execute side effects.

#### Scenario: Rule uses composable and natural-language conditions
- **WHEN** a rule draft contains `conditionRules` and `naturalLanguageCondition`
- **THEN** preview SHALL evaluate both in the same order as production execution
- **AND** SHALL NOT fall back to empty legacy conditions

#### Scenario: Preview includes collection work
- **WHEN** a collection rule is previewed
- **THEN** the result SHALL show the resolved example window, matched count, truncation, planned processors, planned deliveries, and warnings
- **AND** SHALL NOT publish a message or mutate mail

### Requirement: Rule runs are idempotent and auditable
The system SHALL persist a unique trigger occurrence, resolved scope, matched references, processor results or result references, action outcomes, status, and rule revision for each automatic run.

#### Scenario: Scheduler observes the same occurrence twice
- **WHEN** two scheduler ticks attempt the same rule occurrence
- **THEN** only one run SHALL claim the trigger key
- **AND** collection processing and message publication SHALL occur at most once

#### Scenario: Confirmed rule is edited before a deferred execution
- **WHEN** a deferred execution refers to an older rule revision
- **THEN** the system SHALL cancel or skip it according to existing version-safety behavior
- **AND** SHALL record the stale revision outcome

### Requirement: Automatic rules remain bounded and fail closed
The system SHALL reject automatic rules without a meaningful condition or explicit bounded collection scope, and SHALL not execute actions when semantic evaluation, processor validation, or account ownership checks fail.

#### Scenario: Account-wide collection has no time or count bound
- **WHEN** a draft proposes an automatic account-wide collection without a bounded time window or candidate limit
- **THEN** validation SHALL reject the rule

#### Scenario: Natural-language evaluation is unavailable
- **WHEN** a rule requires natural-language matching and the configured model is unavailable
- **THEN** the system SHALL execute no dependent processor or action
- **AND** SHALL record an evaluation failure
