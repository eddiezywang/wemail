## MODIFIED Requirements

### Requirement: MCP credentials use SecretStore isolation

The system SHALL isolate MCP authorization material from mailbox passwords, OAuth tokens, and provider sessions; SHALL keep verifier pepper or equivalent non-recoverable material behind the `SecretStore` abstraction; and SHALL protect any recoverable managed MCP credential with OS-backed encryption bound to the local desktop user.

#### Scenario: Managed MCP credential is persisted

- **WHEN** a managed MCP credential is provisioned
- **THEN** its recoverable value SHALL be encrypted through Electron `safeStorage` or an equivalent OS-backed desktop credential facility
- **AND** SQLite SHALL contain no plaintext bearer credential
- **AND** the production desktop SHALL NOT use the obfuscating `FileSecretStore` as fallback storage for the recoverable value

#### Scenario: Managed MCP credential is recovered

- **WHEN** configuration copy is requested after navigation or application restart
- **THEN** only the privileged desktop main process SHALL decrypt the recoverable credential
- **AND** the renderer SHALL NOT receive, cache, persist, or log the plaintext credential

#### Scenario: OS-backed encryption is unavailable

- **WHEN** the production desktop cannot encrypt or decrypt the managed MCP credential using the current OS user boundary
- **THEN** managed credential provisioning and configuration copy SHALL fail closed
- **AND** the system SHALL expose a non-secret actionable error without persisting a recoverable fallback

#### Scenario: Mail account logs out

- **WHEN** the active mail account logs out
- **THEN** mailbox credentials SHALL be removed according to existing logout behavior
- **AND** all MCP credentials and sessions SHALL be revoked
- **AND** the account-bound encrypted managed credential SHALL be deleted so it cannot inherit a future account

#### Scenario: MCP credential is reset or data is cleared

- **WHEN** the user resets MCP access or invokes the MCP credential clear action
- **THEN** MCP verifier material and the encrypted managed credential SHALL be deleted through their respective protected stores
- **AND** mailbox/provider secret material SHALL remain unchanged
