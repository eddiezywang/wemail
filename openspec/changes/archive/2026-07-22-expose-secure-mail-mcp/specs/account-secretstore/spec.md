## ADDED Requirements

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
