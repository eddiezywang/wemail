## MODIFIED Requirements

### Requirement: IMAP sync into local SQLite
The system SHALL run phased and incremental IMAP synchronization through account-scoped realtime, interactive-transfer, and background-transfer roles and SHALL persist normalized bounded batches only through the canonical DB Service Writer. Synchronization SHALL represent canonical messages separately from remote folder/UID instances and SHALL not own a writable repository or database connection.

#### Scenario: Initial sync becomes interactive quickly
- **WHEN** a newly authenticated account starts with an empty canonical database
- **THEN** the system SHALL discover folders and persist a bounded recent Inbox metadata page before historical synchronization
- **AND** Renderer SHALL become usable without waiting for bodies, attachments, AI, or full history

#### Scenario: Existing local account starts
- **WHEN** a previously synchronized account starts
- **THEN** Renderer SHALL serve committed local data immediately and Mail Core SHALL use QRESYNC, CONDSTORE, MODSEQ, UIDNext, or a bounded fallback window for remote deltas
- **AND** it SHALL not clear visible local pages or rescan the full mailbox synchronously

#### Scenario: Metadata batch is committed
- **WHEN** an account worker produces normalized metadata and cursor changes
- **THEN** Mail Core SHALL submit one or more bounded typed Writer commands
- **AND** canonical message, remote instances, memberships, counters, cursor, commit, and change facts SHALL be transactionally consistent

#### Scenario: New mail emits a typed event
- **WHEN** Writer commits a message not previously represented by a compatible canonical identity
- **THEN** DB Service SHALL publish a post-commit change event containing identifiers and versions
- **AND** the event SHALL not contain body or attachment bytes

### Requirement: Repository-backed mail API
Desktop mail list, detail, folder, category, search, and mutation APIs SHALL be backed by typed DB Service query/command clients. They SHALL return committed local state and SHALL NOT call IMAP synchronously, instantiate DB Service mail API, execute SQL, or fall back to an inline database adapter.

#### Scenario: List returns persisted mail
- **WHEN** Renderer requests a mail list
- **THEN** a scoped DB Service list reader SHALL return an anchored keyset page from committed local data
- **AND** IMAP availability SHALL not affect the query

#### Scenario: Detail returns a missing body
- **WHEN** Renderer requests a known message whose local body state is missing
- **THEN** the Detail Reader SHALL return metadata and the missing state immediately
- **AND** the interactive ensure command SHALL promote the durable body job without returning network content directly to Renderer

### Requirement: MCP synchronization shares the account coordinator
The system SHALL route `sync_mail_account` through the canonical account scheduler, role sessions, durable jobs, checkpoints, resource admission, and idempotency contract.

#### Scenario: Equivalent sync is already scheduled or running
- **WHEN** MCP requests an account or folder sync equivalent to existing work
- **THEN** it SHALL observe or promote the existing durable operation
- **AND** it SHALL not create another provider, scheduler, watcher, database writer, or historical pipeline

#### Scenario: Sync continues beyond tool latency
- **WHEN** admitted work cannot settle within the tool response deadline
- **THEN** MCP SHALL return accepted/shared state, identifiers, phase, counters, and authoritative health
- **AND** the tool session SHALL not remain blocked until history completes

## ADDED Requirements

### Requirement: Interactive body fetch bypasses history
Opening a locally missing body SHALL use reserved interactive account capacity and SHALL commit the result through the same idempotent Writer path used by background hydration.

#### Scenario: History hydration is active
- **WHEN** the user opens a different missing message during background body work
- **THEN** the interactive body SHALL start through its reserved role or preempt cooperative background work
- **AND** both results SHALL remain idempotent if eventually committed

### Requirement: Attachments are lazy by default
Initial and historical synchronization SHALL persist attachment metadata without downloading attachment bytes unless an explicit policy or user action requests them.

#### Scenario: Message has a large attachment
- **WHEN** its metadata is synchronized
- **THEN** the message SHALL become locally listable and readable without downloading the attachment
- **AND** attachment download SHALL use a separate bounded durable job

