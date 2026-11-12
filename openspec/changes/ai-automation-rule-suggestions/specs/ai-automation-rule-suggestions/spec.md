## ADDED Requirements

### Requirement: Draft-only rule suggestions

Rule suggestion SHALL create draft only, not enabled rule.

#### Scenario: Suggest similar-mail rule

- **WHEN** AI suggests a rule
- **THEN** the returned rule SHALL be disabled or unsaved as a draft
- **AND** it SHALL NOT execute

### Requirement: Explained dry-run

Dry-run SHALL explain why each matched email matched.

#### Scenario: Dry-run matches sender

- **WHEN** dry-run evaluates a sender condition
- **THEN** each matched email SHALL include a sender-condition reason

### Requirement: Audited rule run

Rule run SHALL be audited with matched and applied counts.

#### Scenario: Rule run completes

- **WHEN** a rule is executed
- **THEN** an audit entry SHALL record matched count and applied count

### Requirement: Dangerous action confirmation

Dangerous actions SHALL require explicit confirmation.

#### Scenario: Archive without confirmation

- **WHEN** a rule with archive/trash/spam action is run without confirmation
- **THEN** the API SHALL reject the request
