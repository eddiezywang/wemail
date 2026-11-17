## ADDED Requirements

### Requirement: Email and thread summaries

Summary SHALL support email-level and thread-level modes.

#### Scenario: Email summary is structured

- **WHEN** summary is requested for a single email
- **THEN** the result SHALL include bullets, action items, urgency, and evidence references

#### Scenario: Thread summary is chronological

- **WHEN** summary is requested for a thread
- **THEN** context SHALL be built in chronological order
- **AND** the result SHALL cite source email ids or source sections

### Requirement: Summary language preference

Summary SHALL respect configured summary language.

#### Scenario: Chinese profile receives Chinese summary

- **WHEN** `AiProfileSettings.summaryLanguage` is Chinese
- **THEN** generated summary text SHALL be Chinese unless the source content cannot be safely summarized

### Requirement: No fabricated action items

Summary SHALL not fabricate action items when no actionable content exists.

#### Scenario: Marketing or notification mail has no action

- **WHEN** source mail contains no user action request
- **THEN** `actionItems` SHALL be empty or explicitly non-actionable

### Requirement: Idempotent retry

Summary retry SHALL not create duplicate results for the same scope.

#### Scenario: Retry failed summary

- **WHEN** a failed summary is retried for the same email/thread, mode, and processor version
- **THEN** the system SHALL reuse or replace the existing failed state
- **AND** it SHALL NOT create duplicate successful results
