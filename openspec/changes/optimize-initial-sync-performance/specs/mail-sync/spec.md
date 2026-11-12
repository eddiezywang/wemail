## ADDED Requirements

### Requirement: Bounded resumable metadata synchronization

The system SHALL fetch, normalize, persist, and release mail metadata in bounded pages with a durable per-account/per-folder checkpoint.

#### Scenario: Recent metadata uses a bounded first page

- **WHEN** a bootstrap run starts for an account without cached messages
- **THEN** the provider SHALL fetch no more than the configured recent interactive page before publishing progress
- **AND** the service SHALL NOT wait for the entire historical window before persisting that page

#### Scenario: Historical sync releases completed pages

- **WHEN** a historical synchronization spans multiple pages or folders
- **THEN** each page SHALL be normalized, persisted, checkpointed, and released before the next page is fetched
- **AND** memory retained by the synchronization pipeline SHALL be bounded by the configured page and transaction sizes rather than total mailbox matches

#### Scenario: Interrupted sync resumes from checkpoint

- **WHEN** the application stops after committing a metadata page but before historical synchronization settles
- **THEN** the next run SHALL resume from the committed folder checkpoint
- **AND** it SHALL NOT require restarting the full historical window

#### Scenario: UID validity change invalidates only the affected checkpoint

- **WHEN** a provider reports a changed UID validity for one folder
- **THEN** the system SHALL replace or rebuild the affected folder checkpoint safely
- **AND** checkpoints for unrelated folders SHALL remain usable

### Requirement: Short transactional batch persistence

The system SHALL persist metadata with reusable prepared statements in bounded SQLite transactions and SHALL yield between transactions.

#### Scenario: Batch cursor commit is atomic

- **WHEN** a metadata batch is persisted successfully
- **THEN** all message upserts and the corresponding folder checkpoint SHALL commit atomically
- **AND** an observer SHALL not see a checkpoint beyond messages that were committed

#### Scenario: Failed batch preserves prior checkpoint

- **WHEN** a batch transaction fails
- **THEN** none of that batch's partial writes or checkpoint advancement SHALL remain committed
- **AND** the run SHALL remain resumable from the prior checkpoint

#### Scenario: Synchronization yields between batches

- **WHEN** more metadata remains after a committed batch
- **THEN** the synchronizer SHALL yield control and consult resource admission before beginning the next batch

### Requirement: Bootstrap and live delivery semantics are distinct

The system SHALL attach an explicit origin to every synchronization operation and SHALL not present historical/bootstrap inserts as live mail arrivals.

#### Scenario: Bootstrap import suppresses live notifications

- **WHEN** a `bootstrap` or `historical` run inserts previously unseen local rows
- **THEN** the system SHALL NOT create per-message desktop notifications or received-mail toasts
- **AND** it SHALL NOT emit one renderer invalidation event per inserted message

#### Scenario: Live arrivals are coalesced

- **WHEN** multiple messages arrive through live IDLE or polling within the aggregation window
- **THEN** the system SHALL emit a bounded aggregate mail-change event
- **AND** the renderer SHALL invalidate each affected query family at most once for that aggregate

#### Scenario: Historical automation requires explicit opt-in

- **WHEN** historical synchronization inserts messages
- **THEN** receive-mail automation SHALL NOT fan out automatically unless the rule explicitly declares historical-backfill behavior

### Requirement: Priority-aware body hydration

The system SHALL prioritize user-requested and visible recent bodies over background historical hydration and SHALL subject background hydration to resource admission.

#### Scenario: Selected message preempts background ordering

- **WHEN** the user opens a message whose body is not cached
- **THEN** that message SHALL be moved ahead of queued background body work
- **AND** the existing single-flight guarantee for the message id SHALL be preserved

#### Scenario: Background body work pauses under pressure

- **WHEN** the resource governor denies background admission
- **THEN** no new background body fetch SHALL begin
- **AND** pending body state SHALL remain durable and resumable
