## ADDED Requirements

### Requirement: No remote fetch

Link extraction SHALL never fetch remote URLs.

#### Scenario: HTML contains external links

- **WHEN** link extraction processes the message
- **THEN** it SHALL parse local content only
- **AND** it SHALL NOT issue network requests

### Requirement: Explained risk

Risk result SHALL explain suspicious domain, mismatch, shortener, or unsafe scheme.

#### Scenario: Display domain mismatch

- **WHEN** link text shows one domain but href points to another
- **THEN** risk reasons SHALL include the mismatch

### Requirement: Unsubscribe identification

Unsubscribe links SHALL be identified when present in headers or body.

#### Scenario: List-Unsubscribe header

- **WHEN** a message includes an unsubscribe header
- **THEN** link metadata SHALL include an unsubscribe category entry

### Requirement: Sensitive URL log safety

Link metadata SHALL not include credential-bearing query values in logs.

#### Scenario: URL contains token query

- **WHEN** link extraction logs metadata
- **THEN** query values such as tokens SHALL be redacted or omitted
