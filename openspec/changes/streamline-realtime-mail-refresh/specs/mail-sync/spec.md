## ADDED Requirements

### Requirement: Foreground realtime connection isolation

The system SHALL reserve one account-scoped foreground provider for IMAP IDLE, reconnect catch-up, bounded recent reconciliation, manual refresh, and lightweight health checks.

#### Scenario: Historical metadata is running

- **WHEN** background historical metadata synchronization is active
- **THEN** the foreground provider SHALL remain able to receive an IDLE mailbox event and reconcile new mail
- **AND** historical provider work SHALL NOT occupy the foreground synchronization queue

#### Scenario: Foreground connection is restored

- **WHEN** the foreground provider reconnects after a transient failure
- **THEN** it SHALL run a compatible bounded reconciliation before returning to IDLE
- **AND** mail delivered while disconnected SHALL become eligible for normal live discovery handling

### Requirement: Existing background provider owns transfer and recovery work

The system SHALL reuse the existing second account-scoped provider for historical metadata pages, recovery windows, background body hydration, user-requested bodies, and attachments rather than adding a third persistent IMAP connection.

#### Scenario: Historical page commits

- **WHEN** the background provider completes a historical metadata page
- **THEN** message upserts and its checkpoint SHALL commit through the shared repository boundary
- **AND** the next page SHALL remain resumable after interruption

#### Scenario: User requests uncached content

- **WHEN** a user requests a body or attachment while background history remains
- **THEN** the requested transfer SHALL be admitted ahead of subsequent background pages
- **AND** foreground IDLE receipt SHALL remain unaffected

### Requirement: Realtime watcher starts before historical completion

The system SHALL start the foreground watcher after cached readiness and a usable bounded recent cursor are established, without waiting for historical metadata, background bodies, or intelligence recovery to complete.

#### Scenario: New account recent slice completes

- **WHEN** the bounded recent slice has been persisted and its cursor committed
- **THEN** the foreground watcher SHALL start and enter its connection lifecycle
- **AND** historical metadata SHALL continue independently on the background provider

#### Scenario: Historical synchronization fails

- **WHEN** background historical synchronization enters a recoverable failure after foreground readiness
- **THEN** the foreground watcher SHALL remain active
- **AND** the account SHALL continue to receive live mail

### Requirement: Manual refresh coalesces with compatible foreground work

The system SHALL treat manual refresh as an immediate account-reconciliation intent and SHALL join equivalent IDLE, reconnect, startup-recent, or manual work that is already active.

#### Scenario: Reconciliation is already running

- **WHEN** the user requests refresh while a compatible foreground reconciliation is active
- **THEN** the request SHALL observe or join that run
- **AND** it SHALL NOT create a duplicate IMAP search or provider instance

#### Scenario: No reconciliation is active

- **WHEN** the user requests refresh while the foreground provider is healthy and idle
- **THEN** the system SHALL start one bounded foreground reconciliation
- **AND** its completion SHALL NOT wait for unrelated historical repair

### Requirement: Mail discovery and presentation policy are independent

The system SHALL record first-time mail discovery independently from renderer refresh, automation eligibility, intelligence scheduling, and desktop-notification policy.

#### Scenario: Live mail is discovered

- **WHEN** IDLE or reconnect reconciliation inserts new Inbox mail
- **THEN** the renderer and unread counts SHALL update
- **AND** eligible automation SHALL run at most once
- **AND** desktop notification policy MAY notify

#### Scenario: Manual refresh discovers mail

- **WHEN** manual refresh inserts new mail
- **THEN** the renderer and unread counts SHALL update
- **AND** eligible automation SHALL run at most once
- **AND** desktop notification policy SHALL suppress a redundant foreground notification

#### Scenario: Historical recovery inserts mail

- **WHEN** a historical or repair page inserts previously unseen mail
- **THEN** renderer delivery SHALL remain bounded
- **AND** desktop notification SHALL be suppressed
- **AND** receive-mail automation SHALL require explicit historical-backfill opt-in

### Requirement: Enterprise cursor health uses provider status and bounded confirmation

The system SHALL use ImapFlow-provided mailbox status as a cursor health signal and SHALL confirm suspicious enterprise UID regressions through bounded background overlap before replacing a cursor.

#### Scenario: UIDVALIDITY changes

- **WHEN** the provider reports UIDVALIDITY different from the committed folder cursor
- **THEN** the affected cursor SHALL be treated as invalid
- **AND** unrelated folder cursors SHALL remain usable

#### Scenario: UIDNEXT appears behind the local cursor

- **WHEN** provider status reports a suspicious UIDNEXT regression while UIDVALIDITY is unchanged
- **THEN** the system SHALL schedule a bounded overlap confirmation on the background provider
- **AND** it SHALL NOT repeatedly run a 30-day scan on the foreground connection

#### Scenario: A gap is confirmed

- **WHEN** bounded confirmation finds mail missing from the local repository
- **THEN** the system SHALL restore a recent usable cursor first
- **AND** re-arm foreground receipt
- **AND** continue the wider recovery window as resumable background work

### Requirement: ImapFlow remains the IMAP protocol engine

The system SHALL delegate automatic IDLE, IDLE renewal, mailbox status parsing, mailbox locking, streaming fetch, and advertised extension behavior to ImapFlow.

#### Scenario: Server advertises supported synchronization extensions

- **WHEN** the connected enterprise mail server advertises CONDSTORE or QRESYNC and acceptance confirms correct behavior
- **THEN** the provider MAY enable the corresponding ImapFlow capability
- **AND** WeMail SHALL NOT implement a parallel custom protocol parser for that extension

#### Scenario: IMAP connection closes

- **WHEN** ImapFlow emits a close or error event
- **THEN** the WeMail foreground supervisor SHALL own reconnect scheduling
- **AND** protocol-level IDLE state SHALL remain owned by ImapFlow
