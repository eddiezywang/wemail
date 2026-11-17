## ADDED Requirements

### Requirement: Single-flight account startup coordination

The system SHALL use one account-scoped startup coordinator as the sole owner of bootstrap mail synchronization and SHALL expose its current phase and progress.

#### Scenario: First login starts one bootstrap run

- **WHEN** an account login succeeds and onboarding later navigates to the workbench
- **THEN** exactly one bootstrap synchronization run SHALL own initial metadata progress for that account
- **AND** watcher startup, onboarding completion, and settings invalidation SHALL NOT enqueue duplicate bootstrap runs

#### Scenario: LLM settings do not restart mail services

- **WHEN** LLM settings are saved for an active account
- **THEN** LLM-dependent processors SHALL be reconfigured without recreating the active mail provider, watcher, body worker, or startup coordinator
- **AND** no new bootstrap mail run SHALL be created solely because the LLM settings changed

#### Scenario: Compatible manual request joins active work

- **WHEN** the user requests a refresh that is already covered by an active compatible synchronization run
- **THEN** the request SHALL join or observe that run rather than enqueueing duplicate provider work
- **AND** the response SHALL report the active run identity and progress

### Requirement: Progressive interactive readiness

The system SHALL make cached mail and the workbench interactive before historical metadata, background bodies, or historical intelligence recovery must complete.

#### Scenario: Cached data is usable without network completion

- **WHEN** the app opens with locally persisted mail and the provider is slow or unavailable
- **THEN** the workbench SHALL render the cached list and accept navigation and local reads
- **AND** background connection status SHALL be visible without blocking the workbench

#### Scenario: First remote slice unlocks a new account

- **WHEN** a new account has no cached mail and the provider returns the bounded recent Inbox slice
- **THEN** those messages SHALL become visible before historical folders and bodies complete
- **AND** the startup phase SHALL transition to `interactive`

### Requirement: Resource-aware background admission

The system SHALL classify work as interactive, live, or background and SHALL suspend admission of new background work when configured CPU, memory, or event-loop thresholds are exceeded.

#### Scenario: Memory high-water suspends low-priority work

- **WHEN** app-wide working set reaches the configured high-water threshold
- **THEN** no new historical metadata, background body, or historical intelligence batch SHALL start
- **AND** an in-flight bounded transaction SHALL be allowed to finish and checkpoint safely
- **AND** background admission SHALL resume only after the low-water and cooldown conditions are met

#### Scenario: Interactive work outranks historical work

- **WHEN** a user requests a message body while historical work is queued or throttled
- **THEN** the requested body SHALL receive interactive priority
- **AND** duplicate fetches for the same message SHALL remain single-flight

#### Scenario: Threshold crossing is observable

- **WHEN** background work is paused or resumed by the resource governor
- **THEN** diagnostics SHALL record the metric, threshold, workload class, phase, and transition time
- **AND** diagnostics SHALL NOT contain mail content, credentials, or raw provider payloads

### Requirement: Startup responsiveness budgets

The packaged Windows application SHALL have measurable startup responsiveness budgets that are enforced in controlled acceptance runs.

#### Scenario: Workbench interaction budget

- **WHEN** onboarding completes on the controlled low-spec acceptance profile with a healthy local API
- **THEN** the workbench SHALL become interactive within the approved P95 budget
- **AND** historical synchronization SHALL be permitted to continue afterward

#### Scenario: Event-loop responsiveness during sync

- **WHEN** a large-mailbox bootstrap run is active
- **THEN** main-process event-loop delay SHALL remain below the approved sustained threshold
- **AND** threshold violations SHALL produce a diagnostic failure rather than being silently ignored

### Requirement: Metadata-only startup diagnostics

The system SHALL emit structured startup and synchronization metrics sufficient to identify a stall without recording private mail content.

#### Scenario: Phase metrics are recorded

- **WHEN** a startup phase or bounded work batch starts and completes
- **THEN** diagnostics SHALL include phase, origin, duration, counts, resource readings, queue depth, and result status
- **AND** diagnostics SHALL omit subjects, addresses, message bodies, attachment content, credentials, and raw request or response payloads

#### Scenario: Responsiveness watchdog records a stall

- **WHEN** the main process or renderer misses the configured responsiveness deadline
- **THEN** the system SHALL record a local watchdog event with recent phase and resource metadata
- **AND** the application SHALL preserve the last committed synchronization checkpoint
