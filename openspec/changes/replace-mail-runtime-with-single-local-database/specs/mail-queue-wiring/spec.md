## MODIFIED Requirements

### Requirement: New mail creates three intelligence jobs
The system SHALL create idempotent summary, tags, and replyDraft jobs as transactional downstream references when a new canonical message with eligible content is committed. Job payloads SHALL contain stable IDs and source versions only, and intelligence work SHALL not delay the source mail transaction or Renderer visibility.

#### Scenario: First eligible content commit creates jobs
- **WHEN** Writer commits ready content for a new eligible canonical message
- **THEN** exactly one pending job per registered intelligence kind SHALL exist for its message ID and content hash
- **AND** the mail commit SHALL be visible before any processor completes

#### Scenario: Re-sync does not duplicate jobs
- **WHEN** the same message and content hash are re-observed
- **THEN** no additional equivalent intelligence job SHALL be created

#### Scenario: Content changes
- **WHEN** a later body revision produces a new content hash
- **THEN** new version-bound jobs MAY be created
- **AND** stale results SHALL not become the current artifact for the new content

### Requirement: Durable queue runner
The system SHALL provide one event-driven durable scheduler that claims bounded work, dispatches it to role-specific workers, and persists state, leases, retry classification, next-due time, and terminal policy. It SHALL recover expired leases once after restart and MUST NOT poll an empty queue on a business interval.

#### Scenario: Restart resumes pending jobs
- **WHEN** the app restarts with ready jobs or expired leases
- **THEN** startup recovery SHALL reclaim eligible work in bounded waves
- **AND** each idempotency key SHALL have at most one active claim

#### Scenario: Empty processor registry is safe
- **WHEN** the scheduler observes a job with no registered processor
- **THEN** it SHALL transition the job to a documented paused or terminal state and emit a metadata-only diagnostic
- **AND** it SHALL not repeatedly redispatch it

#### Scenario: Queue remains empty
- **WHEN** no job is ready or scheduled
- **THEN** no claim SQL SHALL run until enqueue or another explicit wake event occurs

### Requirement: Jobs carry no mail body
Every durable job payload SHALL contain only IDs, versions, kinds, idempotency keys, and bounded processor hints. Processors SHALL fetch committed bodies or attachment streams from DB Service on demand.

#### Scenario: Job payload is inspected
- **WHEN** any mail, indexing, intelligence, automation, attachment, or maintenance job row is inspected
- **THEN** it SHALL not contain message body, raw MIME, attachment bytes, or credentials

## ADDED Requirements

### Requirement: All durable work shares scheduler policy
Body hydration, metadata sync, remote mutations, outbox, indexing, intelligence, automation, attachment, and maintenance work SHALL share the same priority, idempotency, admission, lease, retry, circuit-breaker, and observability contracts.

#### Scenario: Resource pressure begins
- **WHEN** the whole-process governor pauses background work
- **THEN** P3/P4 claims SHALL stop while P0 and admitted realtime work continue
- **AND** paused durable jobs SHALL not consume attempts or create retry timers

