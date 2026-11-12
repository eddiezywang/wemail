## ADDED Requirements

### Requirement: Local and mail attachment sources are supported

The attachment pipeline SHALL accept both files selected from the local filesystem and attachments already associated with a mail message. Both sources SHALL produce the same canonical attachment record and message-reference contract after successful intake.

#### Scenario: User attaches an existing mail attachment

- **WHEN** the user selects an attachment from an existing mail message
- **THEN** WeMail SHALL intake or reuse it through the deterministic attachment store
- **AND** the resulting user message SHALL reference the canonical stored attachment

#### Scenario: User attaches a local file

- **WHEN** the user selects a supported local file
- **THEN** WeMail SHALL intake it through the same readiness, validation, and storage lifecycle used for mail attachments

### Requirement: Readable attachments are required for send

An attachment SHALL count as added only after WeMail can read, validate, and classify it, and SHALL be revalidated before the user message is submitted.

#### Scenario: Selected file is unreadable

- **WHEN** the user selects a missing, damaged, encrypted, or unsupported file
- **THEN** the attachment SHALL NOT enter the ready state
- **AND** the UI SHALL explain the reason

### Requirement: Supported attachment limits

The initial attachment pipeline SHALL support images, plain text, Markdown, PDF, and DOCX with at most 10 files, 25 MB per file, 50 MB total, 200 PDF pages, 200,000 extracted characters per file, and 400,000 extracted characters per message. It SHALL NOT silently truncate over-limit content.

#### Scenario: PDF exceeds the page limit

- **WHEN** a PDF contains more than 200 pages
- **THEN** the attachment SHALL be rejected with a page-limit explanation
- **AND** partial content SHALL NOT be silently submitted

### Requirement: Attachments are message-scoped

Each attachment SHALL belong to the user message that sends it and SHALL NOT be implicitly attached to later turns.

#### Scenario: User sends a later follow-up without attachments

- **WHEN** the prior message contained attachments and the next message contains none
- **THEN** the next run SHALL NOT reread or resend the prior attachments unless the user explicitly reuses them

### Requirement: Deterministic account-isolated storage

The system SHALL derive a stable account-scoped storage key from attachment source identity and SHALL reuse an already validated canonical file for the same source within that account. It SHALL NOT share canonical references across accounts.

#### Scenario: Same mail attachment is used twice in one account

- **WHEN** the same source attachment has already completed intake
- **THEN** the system SHALL reuse its relative canonical path
- **AND** it SHALL NOT write a duplicate canonical file

### Requirement: Atomic attachment intake

Attachment intake SHALL write to a `.part` file, verify size and hash, atomically rename to `content`, and commit metadata and references only after validation.

#### Scenario: Process crashes during attachment write

- **WHEN** intake stops before atomic completion
- **THEN** the `.part` file SHALL NOT be treated as a ready attachment
- **AND** a later intake SHALL retry or replace the incomplete write safely

### Requirement: Database stores attachment references, not blobs

The database SHALL store attachment identity, account scope, relative path, source metadata, MIME type, size, hash, and parse state, and SHALL NOT store file binary content.

#### Scenario: Conversation history loads an attachment

- **WHEN** a stored message references an attachment
- **THEN** the renderer SHALL resolve the file from the managed relative path
- **AND** it SHALL not depend on the user's original file path

### Requirement: Reference-aware delayed cleanup

The system SHALL remove attachment references with their messages, retain unreferenced canonical files for seven days, remove stale inactive `.part` files after 24 hours, and immediately remove all Agent-managed attachments when the user clears all Agent data.

#### Scenario: Last message reference is deleted

- **WHEN** an attachment loses its final reference
- **THEN** it SHALL become eligible for deletion after seven days
- **AND** it SHALL remain available during the grace period

### Requirement: First release excludes remote and complex formats

The first release SHALL NOT ingest URLs, cloud-drive resources, XLSX, PPTX, ZIP, OCR-only scanned PDFs, or complex Office online previews.

#### Scenario: User selects an excluded format

- **WHEN** the selected attachment requires an excluded format or OCR capability
- **THEN** WeMail SHALL reject it with a supported-format explanation
