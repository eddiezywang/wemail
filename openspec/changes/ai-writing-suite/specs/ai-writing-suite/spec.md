## ADDED Requirements

### Requirement: Draft-only writing

AI writing SHALL only create drafts and SHALL never send mail.

#### Scenario: Writing processor completes

- **WHEN** AI writing succeeds
- **THEN** it SHALL persist or return a draft only
- **AND** it SHALL NOT call send, delete, move, archive, or automation execution APIs

### Requirement: Reply draft format

Reply drafts SHALL not include subject lines, headers, or fake signatures.

#### Scenario: Reply draft generated

- **WHEN** a reply draft is generated
- **THEN** the body SHALL contain only the proposed reply content

### Requirement: Compose clarification

Compose SHALL ask clarifying questions when the writing purpose is missing or
the model cannot safely draft without additional facts. A recipient is not
required until the user sends the message.

#### Scenario: Recipient not filled yet

- **WHEN** compose is requested without recipients
- **AND** a usable writing purpose is present
- **THEN** AI SHALL generate an editable draft
- **AND** the recipient field SHALL remain empty

#### Scenario: Missing purpose

- **WHEN** compose is requested without a usable writing purpose
- **THEN** the result SHALL be `needsClarification`
- **AND** no draft SHALL be persisted as ready

### Requirement: Writing style integrity

Writing style SHALL affect tone without changing factual content.

#### Scenario: Style applied

- **WHEN** a valid style id is supplied
- **THEN** the generated draft SHALL match the style tone
- **AND** SHALL preserve source facts

### Requirement: Conversational compose control

AI compose SHALL support clarification without overwriting the current draft.

#### Scenario: Ambiguous instruction

- **WHEN** the model returns `needsClarification`
- **THEN** the clarification question SHALL appear next to the AI input
- **AND** the current editor body SHALL remain unchanged
- **AND** no body version SHALL be created

#### Scenario: Explicit AI submission

- **WHEN** the user presses Enter or activates “发送给 AI”
- **THEN** the current instruction SHALL be submitted
- **AND** Shift+Enter SHALL insert a newline without submitting

### Requirement: Separate prompt and body histories

Prompt recall and generated-body versions SHALL be independent.

#### Scenario: Recall a prompt

- **WHEN** the user selects a recent prompt
- **THEN** it SHALL fill the AI input
- **AND** it SHALL NOT submit automatically

#### Scenario: Generate from an older body version

- **WHEN** the user navigates to an older body version and generates again
- **THEN** the new result SHALL replace the forward branch

### Requirement: Protected compose regions

AI writing SHALL preserve the user's signature and quoted original email.

#### Scenario: Rewrite an existing reply

- **WHEN** an existing reply contains a signature or quoted original message
- **THEN** those regions SHALL be excluded from AI rewrite input
- **AND** they SHALL be merged back unchanged after generation

### Requirement: Durable compose drafts

An AI-generated compose body saved by the user SHALL remain available in the
normal Drafts mailbox workflow.

#### Scenario: Reopen a saved AI draft

- **WHEN** the user saves an AI-generated compose draft
- **THEN** it SHALL appear in the Drafts folder and folder count
- **AND** reopening it SHALL restore its subject, recipients, body, reply link,
  attachments, and protected compose markers
- **AND** deleting or sending the saved draft SHALL remove the local draft row
