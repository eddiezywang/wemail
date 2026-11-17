## ADDED Requirements

### Requirement: Background synchronization is silent in the workbench

The workbench SHALL NOT render global progress, pause, recoverable-failure, or
completion-summary UI for historical metadata synchronization, body hydration,
intelligence processing, resource throttling, or automatic recovery.

#### Scenario: Historical maintenance is running

- **WHEN** startup status reports historical metadata, body hydration, or
  intelligence work as running
- **THEN** the workbench SHALL render no synchronization progress banner
- **AND** ordinary mail-list updates SHALL continue

#### Scenario: Background work is paused

- **WHEN** the resource governor pauses background work
- **THEN** the workbench SHALL render no global pause message
- **AND** the system SHALL continue exposing the pause through diagnostics

#### Scenario: Historical repair fails

- **WHEN** historical or body work enters a recoverable failure while foreground
  receipt remains usable
- **THEN** the workbench SHALL render no total-mailbox failure message
- **AND** automatic retry SHALL remain silent

#### Scenario: Background synchronization settles

- **WHEN** startup or historical synchronization reaches settled state
- **THEN** the workbench SHALL NOT render a completion summary or toast

### Requirement: User-actionable mail health remains visible

The workbench SHALL continue surfacing mail conditions that require user action
or indicate sustained loss of realtime receipt.

#### Scenario: Mailbox credentials expire

- **WHEN** IMAP authentication enters credential-required state
- **THEN** the existing credential recovery experience SHALL remain available

#### Scenario: Manual refresh is requested

- **WHEN** the user starts a bounded foreground refresh
- **THEN** feedback SHALL remain local to the refresh control
- **AND** completion SHALL NOT create a global synchronization summary

#### Scenario: Realtime receipt is persistently unavailable

- **WHEN** foreground watcher health crosses the sustained-unavailability policy
- **THEN** the workbench MAY show one concise mailbox-health warning
- **AND** the warning SHALL NOT be derived solely from historical or body state

