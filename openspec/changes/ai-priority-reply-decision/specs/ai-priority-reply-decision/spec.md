## ADDED Requirements

### Requirement: Deterministic priority

Priority SHALL be deterministic for identical stored inputs and prompt version.

#### Scenario: Same input produces same decision

- **WHEN** the same stored mail and prompt version are evaluated twice
- **THEN** priority score, level, reply decision, deadline, reason, and signals SHALL be equivalent

### Requirement: Explainable reply decision

Reply decision SHALL explain why reply is or is not required.

#### Scenario: Reply required includes signals

- **WHEN** a message requires a reply
- **THEN** the result SHALL include `replyRequired=true`, a human-readable reason, and supporting signals

### Requirement: Bulk mail low priority default

Bulk, newsletter, and marketing mail SHALL default to low priority unless strong contrary evidence exists.

#### Scenario: Newsletter with no direct request

- **WHEN** a newsletter contains no direct personal request
- **THEN** the result SHALL be low priority and `replyRequired=false`

### Requirement: Direct deadline high priority

Direct requests with deadlines SHALL be high priority.

#### Scenario: Direct request has deadline

- **WHEN** a message asks the user directly to act by a deadline
- **THEN** priority SHALL be high and the deadline SHALL be captured when explicit or strongly implied
