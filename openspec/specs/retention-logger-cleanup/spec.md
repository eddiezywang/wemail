# retention-logger-cleanup Specification

## Purpose
TBD - created by archiving change wemail-pkg-h-retention-logger-cleanup. Update Purpose after archive.
## Requirements
### Requirement: Scheduled retention of ephemeral local data

The system SHALL delete rows older than the configured retention window for mail body cache, attachment cache, app logs, and WeCLI audit logs, preserving tag feedback rules and the draft feedback Markdown log.

#### Scenario: Mail body older than 30 days is purged

- **WHEN** `DataRetentionService.run()` executes
- **THEN** any mail body cache entry with `created_at` older than 30 days SHALL be deleted
- **AND** the corresponding metadata rows MAY be retained if required by intelligence history, but the body content SHALL be purged

#### Scenario: WeCLI audit log older than 30 days is purged

- **WHEN** `DataRetentionService.run()` executes
- **THEN** any `wecli_audit_logs` row with `created_at` older than 30 days SHALL be deleted

#### Scenario: Long-retention stores are not purged

- **WHEN** `DataRetentionService.run()` executes
- **THEN** `mail_tag_feedback_rules` rows SHALL NOT be deleted
- **AND** the draft feedback Markdown file SHALL NOT be truncated or rotated by this service

### Requirement: Logger rejects mail body content

The system SHALL expose `AppLogger.log(level, event, meta)` and SHALL reject (drop or assert in development) any `meta` payload that appears to contain mail body content.

#### Scenario: Allow-listed metadata logs normally

- **WHEN** a caller invokes `AppLogger.log('info', 'summary.done', { messageId, durationMs, model })`
- **THEN** the log SHALL be written to the configured sink

#### Scenario: Body-like payloads are rejected

- **WHEN** a caller invokes `AppLogger.log` with a `meta` value that exceeds the size threshold or uses a forbidden key such as `body`, `content`, or `rfc822`
- **THEN** the logger SHALL drop the field (production) or assert (development)
- **AND** no body text SHALL be written to any log sink

### Requirement: Retention does not interfere with logout semantics

The system SHALL NOT use logout as a signal to purge more data than the time-based retention window allows.

#### Scenario: Logout leaves retained data untouched

- **WHEN** `POST /api/account/logout` is called
- **THEN** `DataRetentionService` SHALL NOT execute as a consequence of logout
- **AND** retained rows SHALL remain until their own time-based expiry

