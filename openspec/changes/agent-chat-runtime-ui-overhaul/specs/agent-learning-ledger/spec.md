## ADDED Requirements

### Requirement: Learning ledger records meaningful user behavior

The Action Center learning ledger SHALL record user inputs, follow-up requirements, acceptance, rejection, edits, confirmations, and actual mail operations with their context and outcome.

#### Scenario: User edits and sends an Agent draft

- **WHEN** the user changes an Agent-generated draft and sends it
- **THEN** the ledger SHALL record the user edit and real send outcome as behavior evidence

### Requirement: Learning ledger excludes assistant presentation data

The ledger SHALL NOT store assistant final answers, reasoning, tool traces, card snapshots, scroll state, expansion state, or other presentation-only events as learning evidence.

#### Scenario: User expands a reasoning panel

- **WHEN** the user expands or collapses reasoning
- **THEN** no Harness learning event SHALL be created solely for that UI interaction

### Requirement: Raw events and derived preferences have separate retention

Raw user behavior events SHALL expire after 180 days. Derived preferences MAY persist longer but SHALL include provenance, confidence, and last-confirmed time.

#### Scenario: Raw evidence expires

- **WHEN** a user behavior event becomes older than 180 days
- **THEN** retention SHALL remove the raw event
- **AND** any retained preference SHALL remain reviewable with its confidence and provenance state

### Requirement: Preferences are reviewable and correctable

Users SHALL be able to inspect, delete, and correct derived preferences, and low-confidence or contradicted preferences SHALL decay.

#### Scenario: User rejects an inferred writing preference

- **WHEN** the user deletes or corrects a derived preference
- **THEN** Harness SHALL stop applying the rejected value
- **AND** the correction SHALL become new user behavior evidence

### Requirement: Chat deletion and learning deletion are independent

Deleting a conversation SHALL NOT automatically clear learning data. WeMail SHALL provide a separate clear-learning action that removes raw learning events and derived preferences.

#### Scenario: User clears AI learning data

- **WHEN** the user confirms the dedicated clear-learning action
- **THEN** raw behavior events and derived preferences SHALL be removed
- **AND** mail and ordinary conversation data SHALL remain unchanged

### Requirement: Learning data remains local and filtered

Learning data SHALL remain local by default and SHALL filter passwords, verification codes, authorization values, tokens, cookies, and other known secret patterns before persistence.

#### Scenario: User input contains a verification code

- **WHEN** a user message contains a detected verification code
- **THEN** the persisted learning event SHALL omit or redact the code
