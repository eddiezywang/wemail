## ADDED Requirements

### Requirement: No direct high-risk actions

Agent SHALL never send, delete, move, or run automation directly.

#### Scenario: User asks agent to delete mail

- **WHEN** the user asks the agent to perform a high-risk action
- **THEN** the response SHALL contain a `pendingAction`
- **AND** the underlying mutation SHALL NOT be executed

### Requirement: Cited mail answers

Agent answers about mail content SHALL cite tool results.

#### Scenario: Agent summarizes a mail fact

- **WHEN** the agent states a fact from an email
- **THEN** it SHALL include citations with email id, tool name, and result path

### Requirement: State-aware suggestions

Suggestions SHALL be derived from current email/account intelligence state.

#### Scenario: Reply required but no draft

- **WHEN** current state has `replyRequired=true` and no draft
- **THEN** suggestions SHALL include drafting a reply

### Requirement: Missing context termination

Missing context SHALL terminate with clear reason, not hallucinated action.

#### Scenario: Email tool lacks email id

- **WHEN** an email-scoped agent operation has no email context
- **THEN** the agent SHALL return a missing-context reason
