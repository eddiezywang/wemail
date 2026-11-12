## RENAMED Requirements

FROM: `Fixed phase-one tool surface`
TO: `WeMail-owned Agent tool and event boundary`

## MODIFIED Requirements

### Requirement: WeMail-owned Agent tool and event boundary

The system SHALL expose Agent tools through a WeMail-owned registry and SHALL translate Pi runtime events through a versioned WeMail adapter. Tool availability MAY evolve without requiring the renderer to consume Pi-specific types, but unknown or unregistered tools SHALL never execute.

#### Scenario: Unknown tool is rejected

- **WHEN** PI invokes a tool name not present in the active WeMail tool registry
- **THEN** the runtime SHALL return an error and SHALL NOT execute anything

#### Scenario: Pi event is delivered to the renderer

- **WHEN** PI emits reasoning, text, tool, retry, or completion activity
- **THEN** the server SHALL map it to `WeMail AgentEvent` before transport
- **AND** the renderer SHALL NOT require the original Pi event shape

### Requirement: Agent never sends mail

The system SHALL NOT allow the model or an unconfirmed tool call to trigger SMTP send. The Agent MAY create an exact-parameter pending send operation, and SMTP MAY execute only through the user-confirmed, idempotent action execution path.

#### Scenario: Model requests send without confirmation

- **WHEN** PI attempts to send mail without a confirmed pending operation
- **THEN** no call SHALL be made to `MailProvider.sendDraft`
- **AND** the runtime SHALL return or create a confirmation requirement

#### Scenario: User confirms exact send operation

- **WHEN** the user confirms the displayed recipients, subject, body, attachments, and idempotency key
- **THEN** the safe action executor MAY send the message once
- **AND** the model SHALL NOT directly own the SMTP call

### Requirement: Agent traces exclude mail bodies

Default Agent traces SHALL contain only identifiers, event types, argument-shape summaries, counts, durations, outcome codes, and redacted error metadata. They SHALL exclude prompts, mail bodies, attachment text, assistant output, raw tool payloads, credentials, and absolute local paths.

#### Scenario: Trace entries are metadata-only

- **WHEN** the agent runtime writes a normal trace
- **THEN** the trace SHALL contain operational metadata sufficient for health diagnosis
- **AND** it SHALL NOT contain user or mail content

#### Scenario: Explicit diagnostic mode is active

- **WHEN** an internal user explicitly enables diagnostic mode
- **THEN** richer local Agent events MAY be captured for no more than 24 hours
- **AND** credential filtering SHALL remain active
