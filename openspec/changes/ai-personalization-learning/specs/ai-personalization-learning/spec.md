## ADDED Requirements

### Requirement: Queryable feedback

User feedback SHALL be queryable by account and feature.

#### Scenario: Query writing feedback

- **WHEN** feedback is queried for account and writing feature
- **THEN** only matching feedback events SHALL be returned

### Requirement: Private prompt builder

Prompt builder SHALL consume profile without exposing private feedback in logs.

#### Scenario: Prompt built with learning summary

- **WHEN** prompt builder uses learned preferences
- **THEN** logs SHALL include only ids, feature, version, and outcome metadata
- **AND** SHALL NOT include raw private feedback text

### Requirement: Stable usage grouping

Usage SHALL be grouped by fixed UI buckets and by processorVersion.

#### Scenario: Usage route called

- **WHEN** usage statistics are requested
- **THEN** the response SHALL include stable UI buckets and detailed processor-version rows

### Requirement: Reset learned preferences

User SHALL be able to reset learned preferences.

#### Scenario: Reset requested

- **WHEN** learned preferences are reset for an account
- **THEN** learning summary SHALL be empty for future prompt building
