## ADDED Requirements

### Requirement: Single account configuration

The system SHALL persist exactly one WeMail account configuration (IMAP + SMTP endpoints, username, display name, and related non-secret fields) in the local SQLite `accounts` table, and SHALL expose it through `AccountService.getCurrent()` and `GET /api/account/current`.

#### Scenario: Save and read back the account

- **WHEN** the renderer calls `POST /api/account/login` with a valid IMAP/SMTP configuration
- **THEN** the server SHALL store the non-secret fields in the `accounts` table
- **AND** a subsequent `GET /api/account/current` SHALL return the stored configuration with the password field omitted or redacted

#### Scenario: Reject a second account

- **WHEN** a second `POST /api/account/login` is issued while a current account already exists
- **THEN** the server SHALL either replace the current account (single-account semantics) or reject with a clear error
- **AND** it SHALL NOT create a second concurrent account row

### Requirement: Secret storage outside the accounts table

The system SHALL store the IMAP/SMTP password (and any other secret material) through a `SecretStore` abstraction whose keys are namespaced per account, and SHALL NOT write the plaintext password into the `accounts` table.

#### Scenario: Password is not in the accounts table

- **WHEN** an account has been saved via `POST /api/account/login`
- **THEN** inspecting the `accounts` row SHALL show no plaintext password column value
- **AND** the password SHALL be retrievable only via `SecretStore.getSecret(key)`

#### Scenario: Stable SecretStore interface

- **WHEN** any caller uses `SecretStore`
- **THEN** it SHALL have the methods `saveSecret(key, value)`, `getSecret(key)`, and `deleteSecret(key)`
- **AND** the backing implementation (Electron safeStorage or placeholder file) SHALL be swappable without changing callers

### Requirement: Logout preserves local mail cache

The system SHALL, on logout, delete only the current session and secret material, and SHALL preserve all locally cached mail, intelligence results, tag feedback rules, and WeCLI audit logs.

#### Scenario: Logout does not wipe local data

- **WHEN** the renderer calls `POST /api/account/logout` on an account that has synced mail and intelligence results
- **THEN** the server SHALL delete the account's secrets via `SecretStore.deleteSecret`
- **AND** the `mail_messages`, `mail_jobs`, `mail_ai_artifacts`, `mail_tag_feedback_rules`, and `wecli_audit_logs` tables SHALL retain their rows
