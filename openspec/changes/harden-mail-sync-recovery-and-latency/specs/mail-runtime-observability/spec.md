## ADDED Requirements

### Requirement: Receipt health is based on synchronization progress

The system SHALL expose last successful remote check, last durable commit, active stage and age, last progress, next check/retry, failure classification, consecutive failures, and Worker generation/recovery count through the existing runtime health model. A heartbeat alone SHALL NOT establish receipt health.

#### Scenario: Idle mailbox remains healthy

- **WHEN** remote checks succeed with no new messages
- **THEN** last successful check SHALL advance
- **AND** the mailbox SHALL NOT be reported stalled solely because no messages were committed

#### Scenario: Live receipt stops while historical work continues

- **WHEN** core checks stop making expected progress while other jobs and heartbeats continue
- **THEN** receipt health SHALL identify the stalled core stage and recovery schedule
- **AND** historical progress SHALL NOT mask the fault

### Requirement: Refresh feedback distinguishes acceptance from completion

The system SHALL retain the single local refresh interaction and SHALL distinguish accepted/shared work, successful remote reconciliation, and failure. Automatic historical and recovery work SHALL remain silent under the existing mail-refresh UX policy.

#### Scenario: Refresh is queued

- **WHEN** a manual request is accepted but no remote check has completed
- **THEN** the UI SHALL NOT claim successful refresh completion

#### Scenario: Refresh discovers metadata

- **WHEN** a metadata page commits during manual refresh
- **THEN** the local list and counts SHALL update without waiting for body hydration or history completion
- **AND** existing duplicate-notification suppression SHALL remain in effect

### Requirement: Mail delivery latency is attributable across stages

The system SHALL correlate trigger, dispatch, remote completion, durable commit, event delivery, and list visibility using bounded diagnostic records. Records SHALL NOT contain credentials, message bodies, or attachment contents.

#### Scenario: A new message appears late

- **WHEN** acceptance measures a delayed message
- **THEN** evidence SHALL separate scheduling, provider, Writer, and renderer delay
- **AND** a queued response, HTTP success, or live process SHALL NOT substitute for visible-message acceptance
