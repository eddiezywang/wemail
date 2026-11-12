## ADDED Requirements

### Requirement: MCP synchronization shares the account coordinator

The system SHALL route `sync_mail_account` through the existing account-scoped startup/sync coordinator, checkpoints, resource governor, and single-flight behavior.

#### Scenario: Equivalent sync is already running

- **WHEN** MCP requests an account or folder sync equivalent to active work
- **THEN** the request SHALL share or observe the existing run
- **AND** it SHALL NOT create another provider, `Mail Core sync worker`, watcher, or historical pipeline

#### Scenario: MCP requests one folder

- **WHEN** a valid provider folder id is supplied
- **THEN** the coordinator SHALL bound work to that account/folder where supported
- **AND** checkpoint, UID validity, batching, and resource-admission rules SHALL remain in effect

#### Scenario: Sync continues beyond tool latency

- **WHEN** admitted synchronization cannot settle within the synchronous tool response budget
- **THEN** the tool SHALL return accepted/shared state, phase, counters, and a pollable operation id
- **AND** the MCP session SHALL not need to remain blocked until the mailbox history completes

#### Scenario: Historical messages are imported

- **WHEN** an MCP-requested sync imports historical or bootstrap messages
- **THEN** existing historical notification and automation-suppression semantics SHALL remain in effect
- **AND** the request SHALL not relabel historical messages as live arrivals
