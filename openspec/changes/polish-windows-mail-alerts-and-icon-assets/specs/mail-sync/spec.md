## MODIFIED Requirements

### Requirement: Foreground receipt adapts when IMAP IDLE is unavailable

The foreground watcher SHALL prefer ImapFlow IDLE when healthy and SHALL use
bounded adaptive polling when the server does not support IDLE or the IDLE path
is repeatedly unavailable.

#### Scenario: IDLE is healthy

- **WHEN** the connected server advertises and sustains IMAP IDLE
- **THEN** the watcher SHALL use IDLE as the primary discovery mechanism
- **AND** an additional fast polling loop SHALL NOT compete with the IDLE connection

#### Scenario: IDLE is unavailable

- **WHEN** the server does not advertise a usable IDLE capability
- **THEN** the watcher SHALL begin foreground polling at a 15-second service interval
- **AND** normal polling SHALL remain invisible in the workbench UI

#### Scenario: Repeated healthy polls find no mailbox change

- **WHEN** bounded consecutive foreground polls complete without discovering changes
- **THEN** the watcher SHALL retain the 15-second online interval
- **AND** it SHALL NOT treat a quiet mailbox as a network failure

#### Scenario: Polling and another reconciliation overlap

- **WHEN** a timer fires while compatible manual, reconnect, or foreground reconciliation is active
- **THEN** the timer request SHALL join or skip the active work
- **AND** the account SHALL not run duplicate foreground mailbox searches

#### Scenario: A transient polling failure occurs

- **WHEN** a foreground poll fails with a retryable error
- **THEN** the watcher SHALL use bounded exponential backoff with jitter
- **AND** it SHALL not busy-loop or expose routine synchronization progress

### Requirement: Receipt latency diagnostics separate provider delay from application delay

The system SHALL record privacy-safe bounded timestamps that distinguish mailbox
discovery, durable insertion, and Windows toast submission without treating the
message Date header as the application receipt time.

#### Scenario: Support investigates a delayed notification

- **WHEN** diagnostics are enabled for a live discovery
- **THEN** support SHALL be able to determine discovery-to-insert and discovery-to-toast latency
- **AND** diagnostics SHALL not include subject, sender, body, attachment names, or credentials
