# account-secretstore Specification

## Purpose
TBD - created by archiving change wemail-pkg-a-account-secretstore. Update Purpose after archive.
## Requirements
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

### Requirement: MCP credentials use SecretStore isolation

The system SHALL store MCP bearer-token verifier pepper or equivalent secret material through `SecretStore` under MCP-specific keys and SHALL never derive MCP authorization from mailbox passwords, OAuth tokens, or provider sessions.

#### Scenario: MCP token is persisted

- **WHEN** a new token is created
- **THEN** secret material SHALL be written through `SecretStore`
- **AND** SQLite metadata SHALL contain no plaintext token

#### Scenario: Mail account logs out

- **WHEN** the active mail account logs out
- **THEN** mailbox credentials SHALL be removed according to existing logout behavior
- **AND** all MCP tokens and sessions SHALL be revoked so they cannot inherit a future account

#### Scenario: MCP token is revoked or data is cleared

- **WHEN** the user revokes MCP access or invokes the MCP credential clear action
- **THEN** MCP secret material SHALL be deleted through `SecretStore.deleteSecret`
- **AND** mailbox/provider secret material SHALL remain unchanged

### Requirement: MCP authorization values are never observable

The system SHALL redact MCP token plaintext, bearer headers, token verifiers, and operation approval material from normal logs, audit payloads, renderer persistence, crash reports, and exported diagnostics.

#### Scenario: Authentication fails

- **WHEN** a malformed bearer token produces an authentication error
- **THEN** logs MAY record a redacted fingerprint or failure category
- **AND** they SHALL not record the submitted authorization value

