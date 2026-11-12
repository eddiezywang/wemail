## ADDED Requirements

### Requirement: IMAP sync into local SQLite

The system SHALL fetch recent messages from the configured IMAP account's Inbox and SHALL persist normalized copies into the local `mail_messages` table through `DB Service mail API.upsertMessage`.

#### Scenario: Initial sync of recent messages

- **WHEN** `Mail Core sync worker.syncRecent()` runs after a successful account login
- **THEN** it SHALL fetch the most recent messages from Inbox via `ImapSmtpMailProvider`
- **AND** each message SHALL be normalized and upserted into the `mail_messages` table
- **AND** a sync cursor SHALL be written so the next run resumes from the latest UID / internalDate

#### Scenario: New mail emits a typed event

- **WHEN** a sync run discovers a message that is not already in the local DB
- **THEN** `Mail Core sync worker` SHALL emit a "new mail" event containing the message id
- **AND** it SHALL NOT enqueue intelligence jobs itself (that responsibility belongs to Package C)

### Requirement: SMTP send for reviewed drafts

The system SHALL expose `MailProvider.sendDraft(input)` that sends reviewed drafts through SMTP using `nodemailer`, and SHALL NOT permit automatic sending without an explicit reviewed-draft call.

#### Scenario: Send a reviewed draft

- **WHEN** a renderer-initiated request invokes `MailProvider.sendDraft` with a reviewed `DraftInput`
- **THEN** the SMTP implementation SHALL transmit the message using the configured SMTP endpoint
- **AND** success or failure SHALL be returned to the caller without side effects on the `mail_messages` table beyond recording the sent copy if configured

### Requirement: Repository-backed mail API

The system SHALL back `GET /api/mail/messages` and `GET /api/mail/messages/:id` with `DB Service mail API`, returning the locally persisted normalized messages.

#### Scenario: List returns persisted mail

- **WHEN** the renderer calls `GET /api/mail/messages`
- **THEN** the server SHALL return the current `listMessages()` result from `DB Service mail API`
- **AND** it SHALL NOT call IMAP synchronously to satisfy the request

#### Scenario: Detail returns a single persisted message

- **WHEN** the renderer calls `GET /api/mail/messages/:id` for a known id
- **THEN** the server SHALL return the normalized message via `DB Service mail API.getMessageById`

### Requirement: No mail body in logs

The system SHALL NOT write mail body content, attachments, or reviewed-draft body text to application logs.

#### Scenario: Logger receives only metadata

- **WHEN** any module under `server/wemail/mail/*` emits a log line
- **THEN** the payload SHALL contain only identifiers, counts, or truncated subjects (<=80 chars)
- **AND** it SHALL NOT contain the message body or attachment bytes
