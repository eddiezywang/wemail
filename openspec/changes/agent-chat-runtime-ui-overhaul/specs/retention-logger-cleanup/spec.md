## MODIFIED Requirements

### Requirement: Scheduled retention of ephemeral local data

The system SHALL apply store-specific retention: existing mail and audit retention rules SHALL remain in force; unreferenced Agent attachments SHALL have a seven-day grace period; inactive attachment `.part` files SHALL expire after 24 hours; raw Agent user-behavior events SHALL expire after 180 days; temporary diagnostic packages SHALL expire after seven days; and derived preferences SHALL persist until decayed, corrected, or explicitly cleared.

#### Scenario: Unreferenced Agent attachment expires

- **WHEN** an Agent attachment has no references and its seven-day grace period has elapsed
- **THEN** the canonical file and attachment metadata SHALL be deleted

#### Scenario: Raw learning event expires

- **WHEN** a user behavior event is older than 180 days
- **THEN** the raw event SHALL be deleted
- **AND** ordinary mail and conversation records SHALL remain unchanged

#### Scenario: Long-lived preference remains active

- **WHEN** a derived preference remains valid and has not been cleared or contradicted
- **THEN** scheduled raw-event retention SHALL NOT delete the preference solely because its source event expired

### Requirement: Logger rejects mail body content

The system SHALL expose structured logging that drops or rejects prompts, mail bodies, attachment content, assistant answers, raw tool inputs and outputs, credentials, and other content-like fields during normal operation. Diagnostic capture SHALL require explicit activation, remain local, preserve credential filtering, expire automatically, and never upload without user action.

#### Scenario: Allow-listed metadata logs normally

- **WHEN** a caller logs message ID, run ID, event type, duration, model, count, or outcome code
- **THEN** the metadata SHALL be written to the configured sink

#### Scenario: Content-like payload is submitted

- **WHEN** a caller logs a forbidden field such as `body`, `content`, `prompt`, `authorization`, or attachment text
- **THEN** the logger SHALL drop the field in production or assert in development
- **AND** the content SHALL NOT reach the normal log sink

#### Scenario: Diagnostic package reaches expiry

- **WHEN** a locally generated diagnostic package becomes older than seven days
- **THEN** retention SHALL delete it unless the user previously exported it outside the managed diagnostic directory
