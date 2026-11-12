## ADDED Requirements

### Requirement: Event-driven durable scheduling
The system SHALL schedule durable work from enqueue, promotion, completion, connectivity, credential, resource, and next-due events. Business work MUST NOT be claimed by a periodic polling interval.

#### Scenario: Queue is empty
- **WHEN** no ready or future job exists
- **THEN** the scheduler SHALL perform no claim query and no business wakeup
- **AND** it SHALL remain dormant until an explicit event arrives

#### Scenario: Future job is persisted
- **WHEN** the earliest job is due in the future
- **THEN** the scheduler SHALL maintain one nearest-due timer
- **AND** it SHALL not create one timer per job

### Requirement: Bounded scheduler drain
Each scheduler wake SHALL cap claims and scheduler CPU time before yielding to its event loop, and queue admission SHALL apply backpressure before unbounded work is loaded into memory.

#### Scenario: Large retry population becomes due
- **WHEN** many jobs share a due window
- **THEN** the scheduler SHALL release bounded waves subject to account, provider, process, and Writer capacity
- **AND** it SHALL not dispatch the whole population in one turn

### Requirement: Idempotent priority promotion
Jobs SHALL use stable idempotency keys. An interactive request for existing non-terminal work SHALL promote that work rather than insert a duplicate, while a passive read SHALL not revive terminal work.

#### Scenario: User opens a background-queued body
- **WHEN** a P3 body job already exists and the user opens that message
- **THEN** the existing job SHALL be promoted to P0 and made immediately available
- **AND** no second fetch job SHALL be created

#### Scenario: Passive read observes terminal failure
- **WHEN** message detail reads a terminal body failure
- **THEN** it SHALL return the failure state without changing the job
- **AND** only explicit retry or a changed remote revision SHALL start a new retry cycle

### Requirement: Reserved interactive account capacity
Each account SHALL isolate realtime observation, interactive transfer, and background transfer roles so a user-opened body or mutation cannot wait behind a batch of historical work.

#### Scenario: Interactive body arrives during background fetch
- **WHEN** P0 body work arrives while background transfer is active
- **THEN** a reserved interactive session SHALL start it immediately where provider limits allow
- **OR** the background command SHALL be cooperatively aborted and requeued without attempt penalty under a two-session profile

### Requirement: Classified retry and circuit breaking
Authentication, rate-limit, connection, protocol, locator, and terminal-content failures SHALL have distinct durable policies with bounded attempts, jitter, shared account reconnect state, and provider backpressure.

#### Scenario: IMAP authentication fails
- **WHEN** a provider rejects account credentials
- **THEN** the account circuit breaker SHALL enter `auth_required` without automatic credential retries
- **AND** related jobs SHALL remain paused until credential generation changes

#### Scenario: Provider rate limits requests
- **WHEN** a provider returns Retry-After
- **THEN** the account/provider schedule SHALL honor it and reduce dispatch capacity
- **AND** individual jobs SHALL not create independent retry loops

### Requirement: Crash-safe leases without retry inflation
Claimed work SHALL use durable leases so a crashed worker can be recovered, and cooperative cancellation or process shutdown SHALL not consume a failure attempt.

#### Scenario: Worker exits during a body fetch
- **WHEN** its lease expires after restart
- **THEN** the scheduler SHALL make the job eligible under its prior retry budget
- **AND** no duplicate active fetch SHALL remain

