## ADDED Requirements

### Requirement: Large-mailbox startup performance acceptance

The repository SHALL provide deterministic browser and packaged Electron acceptance scenarios for large-mailbox first login and restart behavior.

#### Scenario: Five-thousand-message first login remains interactive

- **WHEN** the packaged test app logs into a deterministic mailbox containing at least 5,000 metadata records across multiple folders
- **THEN** the bounded recent slice SHALL become visible within the approved interaction budget
- **AND** navigation, list scrolling, and opening an available message SHALL remain responsive while historical work continues
- **AND** no historical message SHALL produce a desktop notification or per-message toast

#### Scenario: Slow provider does not block cached workbench

- **WHEN** the deterministic provider delays or intermittently fails historical pages
- **THEN** cached/recent mail interactions SHALL continue to work
- **AND** sync progress SHALL report retry or paused state
- **AND** the run SHALL resume without duplicating committed messages

#### Scenario: Restart resumes a partial historical run

- **WHEN** the app is closed after at least one historical page commits and is then reopened
- **THEN** synchronization SHALL resume from the committed checkpoint
- **AND** previously committed pages SHALL not be fetched and inserted again as a new bootstrap import

### Requirement: Resource-budget acceptance evidence

Controlled packaged Windows runs SHALL collect and evaluate startup phase, CPU, memory, event-loop, queue, event-delivery, and time-to-interactive metrics.

#### Scenario: Controlled low-spec profile satisfies budgets

- **WHEN** the large-mailbox scenario runs on the documented low-spec acceptance profile
- **THEN** time-to-interactive, event-loop delay, working-set growth, background CPU, and active concurrency SHALL satisfy the approved thresholds
- **AND** the acceptance report SHALL include measured values and threshold comparisons

#### Scenario: Resource pressure causes graceful throttling

- **WHEN** the test harness drives the app above a configured background high-water threshold
- **THEN** background metadata, body, and intelligence admission SHALL pause
- **AND** interactive operations and committed checkpoints SHALL remain functional
- **AND** work SHALL resume after the harness restores low-water conditions

### Requirement: Aggregated mail-event regression coverage

The renderer and Electron bridge suites SHALL verify that batch imports and live mail bursts do not cause unbounded notifications or query invalidations.

#### Scenario: Historical batch emits bounded UI work

- **WHEN** a historical batch inserts 100 messages
- **THEN** the test SHALL observe no desktop new-mail notifications
- **AND** renderer query invalidation SHALL occur at most once per affected query family for the batch progress publication

#### Scenario: Live burst is coalesced without losing ids

- **WHEN** several live messages arrive inside the aggregation window
- **THEN** the bridge SHALL deliver a bounded aggregate event
- **AND** durable internal processing SHALL retain every inserted message id
