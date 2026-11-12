## ADDED Requirements

### Requirement: Versioned WeMail agent events

The server SHALL expose a Pi-independent event protocol containing `schemaVersion`, `conversationId`, `runId`, monotonic `sequence`, `timestamp`, and event-specific data.

#### Scenario: Pi emits a runtime event

- **WHEN** the configured Pi runtime emits an event
- **THEN** the server adapter SHALL convert it to a WeMail event before SSE transport or persistence
- **AND** raw Pi event types SHALL NOT be required by the renderer

### Requirement: Explicit run lifecycle

The system SHALL distinguish active generation, tool execution, retry, stopped, failed, interrupted, and settled run states.

#### Scenario: Assistant text ends before a final tool completes

- **WHEN** assistant text has ended but a tool remains active
- **THEN** the run SHALL NOT be reported as settled until the tool and all retry activity complete

### Requirement: Durable throttled snapshots

The server SHALL persist structured assistant snapshots no more than once per second during token streaming and immediately at reasoning, text, tool, stop, and error boundaries.

#### Scenario: Process exits during streaming

- **WHEN** the process exits after at least one snapshot
- **THEN** the next startup SHALL show the latest saved partial response as interrupted
- **AND** it SHALL NOT automatically restart execution

### Requirement: Conversation and global concurrency limits

The scheduler SHALL permit one active run per conversation and at most two active runs across conversations.

#### Scenario: Third conversation requests a run

- **WHEN** two conversations already have active runs and a third run is submitted
- **THEN** the third run SHALL enter a visible waiting state until capacity is available

### Requirement: Durable follow-up queue

Sent follow-up messages SHALL be persisted with text, attachment references, creation time, and ordering. They SHALL execute automatically after normal completion but SHALL pause after user stop or application restart.

#### Scenario: Application restarts with queued follow-ups

- **WHEN** WeMail starts with previously queued follow-up messages
- **THEN** those messages SHALL remain visible in paused state
- **AND** they SHALL require user confirmation before execution resumes

### Requirement: Safe stop semantics

Stopping SHALL cancel model generation and cancellable read tools, preserve partial content and completed effects, pause queued follow-ups, and wait for non-cancellable tools to report their final status.

#### Scenario: User stops during a non-cancellable mutation

- **WHEN** the user stops while a mutation is already executing
- **THEN** the UI SHALL NOT assume rollback or failure
- **AND** the system SHALL record the mutation's eventual result before settling the run

### Requirement: Capability-aware retry

The system SHALL retry transient model failures and explicitly idempotent read tools at most twice with cancellable exponential backoff, and SHALL NOT automatically retry unsafe mutations.

#### Scenario: Send execution outcome is unknown

- **WHEN** a send operation loses its response and success cannot be disproved
- **THEN** the system SHALL NOT retry automatically
- **AND** it SHALL surface an indeterminate result for user resolution

### Requirement: Semantic write confirmation matrix

The runtime SHALL directly execute reads, analysis, unsent draft generation, and explicitly requested low-risk single-item operations, while send, delete, move, archive, spam, unsubscribe, inferred mutations, batch mutations, automation, WeCLI, and allowance-invoice mutations SHALL require exact-parameter confirmation.

#### Scenario: Agent infers an archive operation

- **WHEN** the user did not explicitly authorize the exact archive operation in the current turn
- **THEN** the runtime SHALL create a pending operation
- **AND** no archive mutation SHALL execute before confirmation

### Requirement: Idempotent write execution

Every confirmed write operation SHALL carry an idempotency key and SHALL authorize only the parameters shown in the confirmation.

#### Scenario: Duplicate confirmation request arrives

- **WHEN** the same idempotency key is submitted more than once
- **THEN** the write SHALL execute at most once
- **AND** the existing result SHALL be returned for duplicates
