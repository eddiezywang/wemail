## MODIFIED Requirements

### Requirement: Existing background provider owns transfer and recovery work

The system SHALL reuse exactly one background provider for historical metadata,
recovery windows, body hydration, user-requested bodies, and attachments. The
background provider SHALL be the sole owner of its IMAP connection lifecycle and
selected-mailbox state.

#### Scenario: Historical page commits

- **WHEN** the background provider synchronizes one historical metadata page
- **THEN** it SHALL acquire and lock the intended mailbox for that page
- **AND** message upserts and the next checkpoint SHALL commit atomically
- **AND** it SHALL release the mailbox transaction before admitting another job
- **AND** the following page SHALL reselect and revalidate its intended mailbox

#### Scenario: User requests uncached content between pages

- **WHEN** a user requests a body or attachment after one historical page has
  committed and before the next page begins
- **THEN** the interactive transfer SHALL run before the next background page
- **AND** the next background page SHALL not rely on selected-mailbox state from
  the previous page
- **AND** foreground IDLE receipt SHALL remain unaffected

#### Scenario: One remote body is missing

- **WHEN** body hydration cannot find or cache one remote message body
- **THEN** the system SHALL record a message-level failure
- **AND** it SHALL NOT disconnect or invalidate an otherwise healthy background
  IMAP session

#### Scenario: Background connection is lost

- **WHEN** a background operation fails because the IMAP connection is no
  longer usable
- **THEN** the background session owner SHALL invalidate the current generation
- **AND** reconnect with bounded backoff
- **AND** the interrupted durable operation SHALL resume from its committed
  checkpoint

### Requirement: Realtime watcher starts before historical completion

The system SHALL model foreground realtime receipt, historical metadata repair,
and body hydration as independently recoverable state machines after cached
readiness and recent-cursor establishment.

#### Scenario: Historical synchronization retries

- **WHEN** historical metadata enters a recoverable background failure
- **THEN** the foreground watcher SHALL remain active
- **AND** historical retry SHALL be scheduled from its own checkpoint and
  backoff state
- **AND** a later foreground synchronization success SHALL NOT restart the full
  startup pipeline or create a duplicate history run

#### Scenario: Realtime is healthy while history is delayed

- **WHEN** foreground IDLE and bounded reconciliation remain healthy while
  historical metadata is retrying
- **THEN** account health SHALL report realtime receipt as healthy
- **AND** historical metadata SHALL report its separate retry state
- **AND** the user-facing status SHALL NOT claim total mailbox synchronization
  failure

## ADDED Requirements

### Requirement: Background IMAP failures are classified by scope

The system SHALL classify background IMAP failures before deciding whether to
retry an item, reset a folder, invalidate a connection, request credentials, or
apply throttling backoff.

#### Scenario: Item-level failure occurs

- **WHEN** a message UID, body, or part is missing while the IMAP session remains
  usable
- **THEN** only that item SHALL enter its retry or terminal-failure policy
- **AND** unrelated metadata and content jobs SHALL remain eligible to run

#### Scenario: UIDVALIDITY changes

- **WHEN** a page transaction observes a UIDVALIDITY value different from its
  committed folder cursor
- **THEN** only that folder checkpoint SHALL be invalidated
- **AND** unrelated folder checkpoints and the foreground realtime session SHALL
  remain usable

#### Scenario: Credential failure occurs

- **WHEN** the server rejects background authentication
- **THEN** the account SHALL enter credential-required state
- **AND** automatic connection retries SHALL stop until credentials are updated

