## MODIFIED Requirements

### Requirement: Secret storage outside the accounts table
The system SHALL store IMAP/SMTP credentials and other secret material exclusively in Electron safeStorage through ElectronSecretStore. SQLite SHALL contain only a credential reference and generation, Mail Core SHALL receive an ephemeral generation-bound credential envelope through a trusted Main-to-Mail-Core MessagePort, and no Mail Core or account worker SHALL read or write a file-backed placeholder secret store.

#### Scenario: Password is not in the accounts table
- **WHEN** an account has been saved through the account login flow
- **THEN** inspecting the account row SHALL show no plaintext or encrypted password value
- **AND** the current credential SHALL be retrievable only by Electron Main through ElectronSecretStore

#### Scenario: Mail Core starts an account runtime
- **WHEN** Main starts or reloads the runtime for an authenticated account
- **THEN** Main SHALL resolve the credential reference and send an ephemeral credential envelope over a trusted MessagePort
- **AND** the receiving runtime SHALL keep it only in memory and SHALL not persist or log it

#### Scenario: Credential is rotated
- **WHEN** the user saves a new mailbox credential
- **THEN** safeStorage SHALL be committed before the credential generation is advanced
- **AND** old provider sessions SHALL close, the authentication circuit SHALL clear, and a new account runtime SHALL use only the new generation

#### Scenario: Legacy secret file exists
- **WHEN** a `secrets.json` file remains from a demo build
- **THEN** Mail Core SHALL ignore it
- **AND** normal startup SHALL not copy, compare, or fall back to its mailbox values

## ADDED Requirements

### Requirement: Credential failure does not retry automatically
Mailbox authentication failure SHALL transition the account to `auth_required`, redact provider details, pause related network jobs, and wait for a credential-generation change.

#### Scenario: IMAP rejects credentials
- **WHEN** the account runtime receives an authentication failure
- **THEN** it SHALL stop automatic login attempts and publish one authoritative auth-required state
- **AND** local cached mail SHALL remain readable

