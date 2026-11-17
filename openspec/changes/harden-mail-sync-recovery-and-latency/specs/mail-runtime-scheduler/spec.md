## ADDED Requirements

### Requirement: Reconciliation triggers coalesce without losing newer demand

The system SHALL allow at most one active metadata reconciliation per account and SHALL merge startup, manual, push, compensation, and recovery demand into the same coordinator. Demand observed during active work SHALL retain a pending check across the next safe page boundary.

#### Scenario: Multiple triggers arrive during a run

- **WHEN** manual refresh, push, and compensation triggers arrive during reconciliation
- **THEN** they SHALL share the active coordinator and retain one pending follow-up check
- **AND** they SHALL NOT create concurrent searches, extra sessions, or an unbounded queue of equivalent jobs

#### Scenario: Account stops or is replaced

- **WHEN** an account runtime stops or changes generation
- **THEN** its timers, admission waits, and pending callbacks SHALL be cancelled or invalidated
- **AND** they SHALL NOT dispatch work for the obsolete account

### Requirement: Core metadata has bounded scheduling delay

The system SHALL admit due realtime and manual metadata before claiming further background body or historical work, after the currently active bounded operation completes. Existing foreground body capacity and provider connection limits SHALL remain respected.

#### Scenario: Bodies are queued

- **WHEN** many background body jobs are ready and a metadata check becomes due
- **THEN** metadata SHALL be dispatched at the next available safe boundary
- **AND** it SHALL NOT wait for the body queue to drain

#### Scenario: Background governance remains paused

- **WHEN** background work is paused by resource governance
- **THEN** core metadata SHALL use bounded sync admission and backpressure
- **AND** it SHALL NOT wait indefinitely for the background low-water threshold
- **AND** history and body prefetch SHALL remain constrained

### Requirement: Recovery deadlines reclaim actual execution ownership

The system SHALL enforce a 30-second deadline for a blocking IMAP operation and SHALL recover an active reconciliation with no command-completion or durable-commit progress for 60 seconds. Cancellation or generation invalidation SHALL prevent timed-out operations from continuing as concurrent owners of the same session.

#### Scenario: Socket operation hangs while heartbeats continue

- **WHEN** an IMAP operation fails to settle within its deadline
- **THEN** the operation/session SHALL be cancelled or invalidated before replacement work runs
- **AND** recovery SHALL resume from the committed checkpoint despite continued thread heartbeats

#### Scenario: Provider throttles recovery

- **WHEN** a provider returns a retry deadline
- **THEN** the account SHALL honor it across automatic and manual triggers
- **AND** individual jobs SHALL NOT independently reconnect in parallel

#### Scenario: Writer request times out

- **WHEN** a page commit acknowledgement times out with an uncertain commit outcome
- **THEN** the system SHALL reconcile durable state and safely replay as needed
- **AND** it SHALL NOT advance a speculative checkpoint or blindly repeat unrelated sends
