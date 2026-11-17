## ADDED Requirements

### Requirement: AI result metadata

AI result persistence SHALL include metadata identifying processor, version, model, context references, creation time, duration, and token usage.

#### Scenario: Metadata persisted with result

- **WHEN** a supported AI processor stores a result
- **THEN** the stored result SHALL include `processor`, `version`, `model`, `contextRefs`, `createdAt`, `durationMs`, and `tokenUsage`
- **AND** it MAY include `confidence` when the processor can compute one

### Requirement: AI feedback events

AI feedback SHALL be persisted without storing full mail body content.

#### Scenario: Feedback is body-free

- **WHEN** a user accepts, rejects, edits, confirms, deletes, or rates an AI output
- **THEN** an `AiFeedbackEvent` SHALL be stored with account id, feature, event type, related ids, and sanitized payload
- **AND** it SHALL NOT store `bodyText`, `bodyHtml`, prompt text, or raw LLM response text

### Requirement: Controlled context builder

AI processors SHALL use a controlled context builder for bounded and log-safe context.

#### Scenario: Context is redacted and referenced

- **WHEN** `ContextBuilder` creates context for an AI feature
- **THEN** it SHALL redact unsafe data, produce section references, and estimate tokens
- **AND** logging the build result SHALL NOT write the prompt body or mail body

### Requirement: Deterministic eval runner

The eval runner SHALL produce deterministic machine-readable pass/fail output for fixture cases.

#### Scenario: Fixture report is machine-checkable

- **WHEN** the eval runner executes fixed fixtures
- **THEN** each fixture result SHALL include fixture id, feature, status, violations, and token estimate
- **AND** the process SHALL fail when any required fixture fails
