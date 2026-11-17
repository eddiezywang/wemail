## ADDED Requirements

### Requirement: New mail creates three intelligence jobs

The system SHALL, whenever a new mail message is inserted into the local `mail_messages` table via `DB Service mail API.upsertMessage`, create one `summary`, one `tags`, and one `replyDraft` row in `mail_jobs` inside the same transaction.

#### Scenario: First sync enqueues three jobs per new message

- **WHEN** `Mail Core sync worker` inserts a brand-new message
- **THEN** the `mail_jobs` table SHALL contain exactly three rows for that `messageId`, one per kind, each in `pending` status

#### Scenario: Re-sync does not duplicate jobs

- **WHEN** the same message is re-observed during a later sync
- **THEN** no additional `mail_jobs` rows SHALL be created for that `messageId`

### Requirement: Durable queue runner

The system SHALL provide a `QueueRunner` that claims pending jobs from `mail_jobs`, dispatches them through `MailIntelligenceBus`, and persists status transitions so that pending jobs resume after an app restart.

#### Scenario: Restart resumes pending jobs

- **WHEN** the app is restarted with pending jobs in `mail_jobs`
- **THEN** `QueueRunner` SHALL discover those rows and dispatch them
- **AND** any expired in-flight leases from a prior crash SHALL be reclaimed as pending

#### Scenario: Empty processor registry is safe

- **WHEN** `QueueRunner` dispatches a job whose kind has no registered processor
- **THEN** the runner SHALL NOT throw
- **AND** the job SHALL either remain `pending` or transition to a documented terminal state, and a metadata-only warning SHALL be logged

### Requirement: Intelligence bus processor registration

The system SHALL expose `MailIntelligenceBus.registerProcessor(kind, processor)` and a stable `MailIntelligenceProcessor` interface for Packages E/F/G to implement.

#### Scenario: Registered processor receives jobs

- **WHEN** a processor is registered for kind `summary` and a `summary` job runs
- **THEN** the bus SHALL invoke that processor's `handle(job, context)` exactly once per run
- **AND** the returned result SHALL be used to update the job row's status and `last_error`

### Requirement: Jobs carry no mail body

The system SHALL represent each job row's payload using `messageId` references only; processors SHALL re-fetch message bodies from `DB Service mail API` on demand.

#### Scenario: Job payload is body-free

- **WHEN** inspecting any row in `mail_jobs`
- **THEN** the payload SHALL contain only ids, kinds, and processor-scoped hints
- **AND** it SHALL NOT contain the message body or attachment bytes
