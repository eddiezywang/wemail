# replydraft-markdown-feedback Specification

## Purpose
TBD - created by archiving change wemail-pkg-g-replydraft-markdown-feedback. Update Purpose after archive.
## Requirements
### Requirement: Reply-need classification

The system SHALL classify each incoming message as requiring a reply or not, defaulting to "no reply" for mass / notification-class mail when confidence is low.

#### Scenario: Notification mail is marked as no-reply

- **WHEN** `ReplyDraftProcessor.handle(job)` runs on a notification-class message
- **THEN** the persisted `mail_ai_artifacts` row SHALL include `shouldReply = false`
- **AND** no draft body SHALL be generated

#### Scenario: Question mail gets a draft

- **WHEN** the message is a direct question to the user
- **THEN** `shouldReply` SHALL be `true`
- **AND** a draft with `subject` and `body` SHALL be persisted

### Requirement: Drafts are local, never auto-sent

The system SHALL generate drafts locally and SHALL NOT invoke SMTP send from the draft processor or agent path.

#### Scenario: Processor does not call SMTP

- **WHEN** `ReplyDraftProcessor.handle(job)` completes
- **THEN** no `MailProvider.sendDraft` call SHALL have been made from the processor
- **AND** the send path SHALL only be reachable through the renderer's reviewed-send action

### Requirement: Draft feedback logged to Markdown

The system SHALL append an entry to a local Markdown feedback log for each of the following draft lifecycle events: `generated`, `accepted`, `edited_and_sent`, `deleted`.

#### Scenario: Accept appends a Markdown entry

- **WHEN** the renderer calls `POST /api/mail/messages/:id/draft/accept`
- **THEN** `DraftFeedbackLog.append` SHALL write an `accepted` entry to the Markdown file
- **AND** the entry SHALL NOT contain the incoming mail body

#### Scenario: Delete appends a Markdown entry

- **WHEN** the renderer calls `POST /api/mail/messages/:id/draft/delete`
- **THEN** `DraftFeedbackLog.append` SHALL write a `deleted` entry
- **AND** the entry SHALL reference the message id and truncated subject only

### Requirement: API exposes draft and verdict

The system SHALL include `shouldReply` and (when applicable) the generated draft in the `/api/intelligence/messages/:id` response.

#### Scenario: API returns draft payload

- **WHEN** the renderer fetches intelligence for a message that the processor flagged `shouldReply = true`
- **THEN** the response SHALL include the draft subject and body

### Requirement: No incoming mail body in feedback log

The system SHALL NOT write the incoming mail body into the Markdown feedback log.

#### Scenario: Log entries are body-free

- **WHEN** any event is appended by `DraftFeedbackLog`
- **THEN** the rendered Markdown SHALL contain only metadata (ids, timestamps, event type, truncated subject) and optionally the outbound draft text
- **AND** it SHALL NOT contain the incoming mail body text

