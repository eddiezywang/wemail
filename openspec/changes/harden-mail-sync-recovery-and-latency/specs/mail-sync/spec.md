## ADDED Requirements

### Requirement: Account receipt survives transient failure and worker replacement

The system SHALL reconcile from committed folder checkpoints on every account Worker generation and SHALL retain account-level recovery after a finite metadata job exhausts its retry budget. Authentication failures SHALL wait for updated credentials; provider rate limits SHALL be respected.

#### Scenario: Idle account Worker exits

- **WHEN** a Worker exits with no pending metadata job
- **THEN** its replacement SHALL load the latest committed checkpoints and schedule reconciliation
- **AND** automatic watching SHALL resume without manual refresh or application restart
- **AND** obsolete Worker results SHALL NOT advance current checkpoints

#### Scenario: Startup network failures exhaust one job

- **WHEN** startup reconciliation fails more than six times because the network is unavailable
- **THEN** account recovery SHALL continue with bounded backoff, capped at 60 seconds unless a provider rate limit requires longer
- **AND** a successful later attempt SHALL restore receipt without user intervention

#### Scenario: Credentials change

- **WHEN** valid credentials replace credentials that caused authentication failure
- **THEN** the account SHALL resume reconciliation and watching for the new credential generation
- **AND** the previous generation SHALL no longer mutate synchronization state

### Requirement: Push observation has independent reconciliation compensation

The system SHALL schedule one account-scoped reconciliation intent every 60 seconds while active, including when IDLE is supported. Periodic intents SHALL use the existing event-driven scheduler rather than poll durable queues.

#### Scenario: Push event is missed

- **WHEN** mail arrives without an observed exists event and the account remains connected
- **THEN** a compensation intent SHALL become due within 60 seconds of the preceding check
- **AND** receipt SHALL NOT require another mail arrival

#### Scenario: Mail is delivered outside INBOX

- **WHEN** server rules deliver mail to another eligible folder without changing INBOX
- **THEN** compensation reconciliation SHALL discover it through that folder's checkpoint

#### Scenario: Machine resumes from sleep

- **WHEN** multiple compensation deadlines passed during sleep
- **THEN** the account SHALL request one immediate reconciliation on resume
- **AND** it SHALL NOT replay all expired timer ticks

### Requirement: Incremental checkpoints never skip unresolved messages

The system SHALL process incremental UID results in ascending bounded pages of at most 50 messages and SHALL atomically commit each page with its folder checkpoint through the existing Writer. It SHALL bound UID discovery memory and SHALL NOT discard an older prefix of incremental results to enforce a fetch cap.

#### Scenario: Offline backlog exceeds 5000 messages

- **WHEN** 6000 messages exist after a committed checkpoint
- **THEN** all 6000 SHALL be eligible for paged persistence without omission or duplicate local messages
- **AND** the checkpoint SHALL advance only across successfully resolved pages

#### Scenario: Message dates do not follow UID order

- **WHEN** receivedAt values are out of order relative to UIDs
- **THEN** checkpoint progression SHALL follow UID page completion rather than receivedAt sorting

#### Scenario: Page persistence fails or acknowledgement is lost

- **WHEN** a page fails before commit
- **THEN** its checkpoint SHALL remain unchanged
- **WHEN** acknowledgement is lost after commit
- **THEN** replay SHALL be idempotent and SHALL NOT repeat discovery side effects

#### Scenario: Fetch omits a searched UID

- **WHEN** FETCH does not return every UID found by SEARCH
- **THEN** the system SHALL confirm deletion or retry unresolved results before advancing past them
- **AND** valid numeric UID gaps SHALL NOT alone be treated as missing messages

### Requirement: Folder progress and coverage are independent

The system SHALL maintain each eligible folder's own UIDVALIDITY, incremental checkpoint, and incomplete repair coverage. An INBOX cursor SHALL NOT be used as another folder's date boundary or proof of completed history.

#### Scenario: Another folder is slow

- **WHEN** INBOX metadata is available while another folder is slow
- **THEN** the INBOX page SHALL commit and become visible before that folder finishes
- **AND** other folders SHALL progress fairly through bounded pages

#### Scenario: Folder UIDVALIDITY changes

- **WHEN** one folder changes UIDVALIDITY
- **THEN** only its remote checkpoint SHALL be invalidated
- **AND** its realtime window and resumable configured-range reconstruction SHALL be tracked separately
- **AND** existing local mail SHALL NOT be cleared to restart synchronization

### Requirement: Existing synchronization gaps have explicit repair coverage

The system SHALL perform a versioned, resumable coverage reconciliation within the configured historical range for accounts that may have skipped mail under the previous truncation policy. Repair SHALL preserve realtime checkpoints, local identity, and historical notification/automation suppression.

#### Scenario: Old cursor is already beyond missing mail

- **WHEN** older missing remote messages fall within the configured repair range
- **THEN** coverage reconciliation SHALL recover them despite their UIDs being below the realtime checkpoint
- **AND** restart SHALL resume committed repair progress rather than begin the complete scan again
- **AND** diagnostics SHALL state the covered range without claiming completeness outside it
