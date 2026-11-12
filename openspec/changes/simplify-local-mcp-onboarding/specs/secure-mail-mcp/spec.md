## MODIFIED Requirements

### Requirement: Opt-in loopback Streamable HTTP transport

The system SHALL expose a standards-compatible Streamable HTTP MCP endpoint from the existing local API process only while MCP is enabled, SHALL bind it to a stable configurable loopback listener independent from the renderer API's ephemeral port, and SHALL preserve that endpoint across normal application restarts.

#### Scenario: Disabled MCP is unreachable

- **WHEN** the user has not enabled MCP or has disabled it
- **THEN** `/mcp` SHALL NOT accept initialization or tool calls
- **AND** disabling MCP SHALL terminate active MCP sessions without requiring deletion of the encrypted managed credential

#### Scenario: MCP is enabled for the current account

- **WHEN** the user enables MCP and no decryptable managed credential exists
- **THEN** WeMail SHALL provision one account-bound managed credential without asking the user to create or save a token
- **AND** the listener SHALL start only after credential persistence and verifier activation succeed

#### Scenario: Desktop restarts with MCP enabled

- **WHEN** WeMail restarts normally with MCP enabled and the configured MCP port available
- **THEN** the MCP listener SHALL return on the same loopback endpoint
- **AND** previously copied host configuration SHALL remain valid without an ephemeral-port or credential update

#### Scenario: Configured MCP port is occupied

- **WHEN** the stable MCP loopback port cannot be bound
- **THEN** MCP SHALL remain unavailable and the panel SHALL expose a safe actionable port-conflict state
- **AND** the normal renderer API and mailbox UI SHALL still start
- **AND** a valid managed credential SHALL remain reusable after the conflict is resolved

#### Scenario: Client initializes a supported session

- **WHEN** an authenticated client sends `initialize` with a supported protocol version
- **THEN** the server SHALL return its server identity, negotiated protocol version, and accurately advertised capabilities
- **AND** the returned session id SHALL be cryptographically random, bearer-bound, and idle-expiring

#### Scenario: Unsupported protocol feature is requested

- **WHEN** a client requests an unadvertised Resources, Prompts, Tasks, Sampling, or other unsupported method
- **THEN** the server SHALL return a protocol-correct method or capability error
- **AND** it SHALL NOT execute a fallback operation

#### Scenario: Session is terminated

- **WHEN** a client deletes its MCP session, its credential is revoked, the idle timeout elapses, MCP is disabled, or WeMail shuts down
- **THEN** the server SHALL cancel cancellable in-flight reads and release session resources
- **AND** it SHALL NOT cancel a provider mutation whose durable commit has already begun

### Requirement: Revocable MCP access credentials

The system SHALL authenticate every MCP protocol request using an MCP-specific bearer credential, SHALL automatically manage one recoverable device credential for the current account, and SHALL support explicit reset, revocation, and redacted lifecycle metadata without requiring users to manage raw API keys.

#### Scenario: Managed credential is provisioned

- **WHEN** MCP is enabled or configuration copy is requested and no managed credential exists
- **THEN** WeMail SHALL generate a cryptographically random bearer credential
- **AND** SHALL persist its recoverable value only with OS-backed encryption
- **AND** SHALL persist only verifier, fingerprint, kind, status, and lifecycle metadata in SQLite
- **AND** SHALL NOT return the plaintext credential to renderer state

#### Scenario: Managed credential is reused

- **WHEN** the user copies configuration again after navigation or a normal restart
- **THEN** WeMail SHALL reuse the same active managed credential
- **AND** SHALL NOT rotate it or invalidate previously copied configuration

#### Scenario: Invalid or revoked credential is used

- **WHEN** a request contains a missing, malformed, unknown, expired, or revoked bearer credential
- **THEN** the request SHALL fail before session or tool processing
- **AND** the response and logs SHALL NOT reveal whether any mailbox account exists

#### Scenario: User resets connection credentials

- **WHEN** the user explicitly resets the MCP connection credential
- **THEN** all prior credentials for the current account SHALL be revoked
- **AND** sessions authenticated by those credentials SHALL be terminated
- **AND** when MCP remains enabled, one replacement managed credential SHALL be provisioned atomically from the user's perspective

#### Scenario: Mail account is logged out or replaced

- **WHEN** the active mail account logs out or is replaced
- **THEN** all MCP access credentials and sessions SHALL be revoked
- **AND** the encrypted managed credential SHALL be deleted
- **AND** no prior MCP credential SHALL gain access to a subsequently configured mailbox

#### Scenario: Server is configured for a non-loopback address

- **WHEN** MCP startup resolves to a non-loopback bind address without a future explicit secure-remote mode
- **THEN** MCP startup SHALL fail closed
- **AND** the normal local API and mailbox SHALL remain usable

#### Scenario: Legacy credential exists during upgrade

- **WHEN** an active one-time credential predates managed credential storage
- **THEN** WeMail SHALL continue accepting it until explicit reset, revocation, logout, replacement, or data clear
- **AND** provisioning the first managed credential SHALL NOT silently revoke the legacy credential

### Requirement: Live MCP connection management UI

The system SHALL present live MCP enablement, readiness, protocol, tool, session, pending-operation, and redacted credential state from the local server while making connection configuration copy the primary onboarding action.

#### Scenario: User enables MCP

- **WHEN** the user turns on MCP for a configured mail account
- **THEN** the panel SHALL automatically provision or reuse the managed credential
- **AND** it SHALL show listener readiness without presenting create-token or save-token steps

#### Scenario: User copies the primary configuration

- **WHEN** the listener and managed credential are ready and the user activates `Copy MCP configuration`
- **THEN** Electron main SHALL place a complete supported-host JSON configuration containing the current endpoint and bearer authorization on the system clipboard
- **AND** the renderer SHALL receive only copy success or a safe error
- **AND** the visible configuration preview SHALL mask the bearer value

#### Scenario: User copies another supported host format

- **WHEN** the user selects a supported alternate host format
- **THEN** WeMail SHALL serialize that host's required JSON wrapper using the same endpoint and managed credential
- **AND** selecting a format SHALL NOT create or rotate a credential

#### Scenario: User revisits the panel

- **WHEN** the panel is reopened after a managed credential has been provisioned
- **THEN** the copy action SHALL remain available while OS-backed decryption is available
- **AND** the panel SHALL show only redacted fingerprint and lifecycle metadata

#### Scenario: Tool catalog changes

- **WHEN** server public-tool availability or provider capability changes
- **THEN** the panel SHALL render live server metadata rather than a hard-coded legacy list

#### Scenario: User opens advanced connection controls

- **WHEN** the user opens advanced MCP controls
- **THEN** the panel SHALL expose credential reset, redacted legacy credential metadata, active sessions, session termination, diagnostics, and port configuration
- **AND** it SHALL NOT reveal plaintext authorization values

#### Scenario: User disables or resets access

- **WHEN** the user disables MCP, resets connection credentials, revokes a legacy credential, or terminates a session
- **THEN** the panel SHALL reflect the new state promptly
- **AND** affected clients SHALL no longer be able to call tools

#### Scenario: OS-backed credential access fails

- **WHEN** system encryption is unavailable, the encrypted blob is corrupt, or decryption fails
- **THEN** configuration copy and new managed provisioning SHALL fail closed with an actionable local-credential state
- **AND** WeMail SHALL NOT fall back to plaintext or obfuscated recoverable storage
