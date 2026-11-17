## ADDED Requirements

### Requirement: Priority and resource-aware intelligence dispatch

The intelligence queue SHALL distinguish interactive, live-mail, and historical-recovery work and SHALL enforce bounded startup concurrency.

#### Scenario: Startup uses reduced concurrency

- **WHEN** an account startup has not reached the settled phase
- **THEN** historical intelligence dispatch SHALL use the configured startup concurrency of one by default
- **AND** user-requested intelligence SHALL be eligible ahead of historical recovery jobs

#### Scenario: Historical recovery waits for interactive readiness

- **WHEN** startup has not yet marked the workbench interactive
- **THEN** existing-mail tag and summary recovery SHALL NOT begin scanning or dispatching historical jobs

#### Scenario: Resource pressure pauses historical dispatch

- **WHEN** the resource governor denies background admission
- **THEN** pending historical intelligence jobs SHALL remain durable without being claimed
- **AND** live or interactive jobs MAY run only within their own configured concurrency and resource rules

### Requirement: Bounded resumable intelligence backfill

Existing-mail tag and summary recovery SHALL scan bounded pages, persist progress, and yield between pages rather than scanning thousands of messages synchronously during account construction.

#### Scenario: Account construction does not perform a large synchronous scan

- **WHEN** account-scoped services are constructed for an account with many existing messages
- **THEN** construction SHALL complete without synchronously scanning the full tag or summary recovery limit
- **AND** recovery SHALL be scheduled as resumable background pages after interactive readiness

#### Scenario: Backfill resumes after restart

- **WHEN** the app restarts after some recovery pages have completed
- **THEN** recovery SHALL resume from durable progress or idempotent job state
- **AND** already completed results SHALL not be duplicated

### Requirement: Bounded inserted-mail fan-out

Mail insertion SHALL enqueue intelligence and automation work through bounded durable scheduling rather than creating an unbounded number of untracked promises.

#### Scenario: Large import does not create unbounded in-process work

- **WHEN** a metadata batch inserts many messages
- **THEN** downstream work SHALL be represented by durable or bounded queue entries
- **AND** in-process active handlers SHALL never exceed the configured concurrency for their workload class
