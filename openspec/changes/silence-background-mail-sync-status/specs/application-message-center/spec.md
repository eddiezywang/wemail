## MODIFIED Requirements

### Requirement: Historical synchronization never becomes a mail-notification burst

The system SHALL treat initial synchronization, historical backfill, folder
rebuilding, body hydration, and automatic recovery as internal maintenance and
SHALL NOT create application-message-center progress entries or completion
summaries for them.

#### Scenario: Initial synchronization imports historical mail

- **WHEN** an initial synchronization imports any number of historical messages
- **THEN** it SHALL NOT create per-message notifications
- **AND** it SHALL NOT create a synchronization progress or completion message
- **AND** synchronized mail SHALL become available through the normal mail UI

#### Scenario: Live mail arrives during historical synchronization

- **WHEN** genuinely new mail arrives beyond the live-delivery watermark while
  historical synchronization remains active
- **THEN** the new mail MAY follow ordinary live-mail notification policy
- **AND** historical synchronization itself SHALL remain silent
