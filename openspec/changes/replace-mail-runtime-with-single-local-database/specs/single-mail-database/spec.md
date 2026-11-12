## ADDED Requirements

### Requirement: One canonical database
The system SHALL use `wemail.sqlite` as its only application database and SHALL NOT contain runtime historical/candidate path selection, dual-write, mirror, migration, backup activation, or legacy database fallback behavior.

#### Scenario: Canonical startup
- **WHEN** WeMail starts with a canonical database
- **THEN** DB Service SHALL open `wemail.sqlite`
- **AND** no other database implementation or compatibility path SHALL be initialized

#### Scenario: Incompatible demo database
- **WHEN** startup finds an incompatible schema
- **THEN** startup SHALL fail with an actionable demo-reset instruction
- **AND** it SHALL NOT migrate, rename, mirror, or fall back to the incompatible database

### Requirement: Exclusive DB Service ownership
Only DB Service SHALL open the database file. Renderer, Electron Main, Mail Core, local API adapters, Bot Core, AI workers, and account workers MUST use typed DB Service requests and MUST NOT create SQLite connections.

#### Scenario: Mail Core persists metadata
- **WHEN** Mail Core receives a normalized IMAP metadata batch
- **THEN** it SHALL submit a typed Writer command to DB Service
- **AND** Mail Core SHALL NOT execute SQL or open the database

### Requirement: SQL-free gateway and isolated lanes
DB Service SHALL route validated typed requests without executing SQL on its gateway event loop and SHALL provide exactly one Writer Thread plus isolated Detail, List, Search, and Aggregate Reader Threads with independent connections.

#### Scenario: Search reader stalls
- **WHEN** a Search Reader request exceeds its deadline
- **THEN** DB Service SHALL terminate and recreate only the Search Reader
- **AND** Detail, List, Writer, Mail Core, and Renderer SHALL remain available

#### Scenario: Concurrent detail and background writes
- **WHEN** Writer commits a bounded synchronization batch while Renderer opens a cached message
- **THEN** the Detail Reader SHALL complete from a read-only WAL snapshot without waiting for the batch to finish

### Requirement: Single bounded writer
All mutations SHALL be serialized through one read-write connection. Normal Writer transactions MUST be bounded by a configured mutation count and active transaction-time budget and MUST yield between bulk batches.

#### Scenario: Large initial synchronization
- **WHEN** synchronization produces more messages than one Writer batch permits
- **THEN** Writer SHALL commit multiple bounded transactions
- **AND** an interactive mutation admitted between batches SHALL not wait for the entire import

### Requirement: Canonical message storage
The schema SHALL separate logical messages from remote IMAP instances and SHALL store list metadata, content/body state, addresses, headers, memberships, counters, attachments, blobs, jobs, mutations, drafts, FTS, and AI artifacts in purpose-specific structures.

#### Scenario: Same mail appears in multiple folders
- **WHEN** compatible remote instances in multiple folders represent one logical message
- **THEN** all-mail and search SHALL expose one canonical message
- **AND** folder views SHALL retain the independent instance and membership facts

#### Scenario: Ambiguous duplicate identity
- **WHEN** duplicate or missing RFC Message-ID values cannot be reconciled safely
- **THEN** the system SHALL preserve separate canonical messages
- **AND** it SHALL NOT merge content based only on the ambiguous identifier

### Requirement: Transactional projections and change feed
Writer SHALL update source facts, memberships, counters, body state, FTS state, job state, and related projections atomically and SHALL allocate one monotonic commit version with bounded change records before publishing an event.

#### Scenario: Body becomes ready
- **WHEN** a fetched body is committed
- **THEN** content, body state, job completion, FTS state, commit metadata, and change records SHALL be durable in one transaction
- **AND** the body-ready event SHALL be published only after commit

### Requirement: Bounded indexed queries
List and time-ordered search SHALL use anchored keyset pagination; hot queries SHALL use indexes and bounded limits; `OFFSET`, unbounded JavaScript materialization, wide-table body scans, and interactive counter aggregation SHALL be prohibited.

#### Scenario: New mail arrives during scrolling
- **WHEN** a client continues an anchored list after newer mail is committed above the anchor
- **THEN** the continuation SHALL contain no duplicate or skipped item within that anchored session

### Requirement: Managed blob storage
Raw MIME and attachment bytes SHALL be stored in managed external blob storage with checksum, size, reference, and lifecycle metadata and SHALL be streamed rather than returned as ordinary in-memory RPC payloads.

#### Scenario: Large attachment is opened
- **WHEN** Renderer requests a large attachment
- **THEN** the system SHALL provide a bounded stream or file-backed handle
- **AND** it SHALL NOT copy the entire attachment through Main or a JSON RPC response

