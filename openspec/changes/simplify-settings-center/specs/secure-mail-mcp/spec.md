## MODIFIED Requirements

### Requirement: Live MCP connection management UI
The system SHALL provide live MCP enablement, credential, protocol, tool, session, and pending-operation state from the local server through an Advanced integration surface that presents simple connection setup before technical diagnostics.

#### Scenario: User opens Advanced integrations
- **WHEN** the user opens the MCP integration from Advanced settings
- **THEN** the default layer SHALL show whether MCP is enabled, whether it is ready, and a guided setup action
- **AND** fixed port, raw endpoint, token metadata, sessions, operations, and tool catalog SHALL remain behind an explicit diagnostics disclosure

#### Scenario: User enables and configures MCP
- **WHEN** the user enables MCP and creates a token
- **THEN** the flow SHALL present a copyable connection configuration containing the current local endpoint and one-time token
- **AND** it SHALL clearly state that the token grants mailbox access and should be kept secret

#### Scenario: User revisits the integration
- **WHEN** the integration is reopened after token creation
- **THEN** the default layer SHALL show connection health without plaintext token material
- **AND** diagnostics SHALL show only the token fingerprint and lifecycle metadata

#### Scenario: Tool catalog changes
- **WHEN** server public-tool availability or provider capability changes
- **THEN** the diagnostics layer SHALL render live server metadata rather than a hard-coded legacy list

#### Scenario: User revokes access
- **WHEN** the user disables MCP, revokes a token, or terminates a session
- **THEN** the integration SHALL reflect the new state promptly
- **AND** affected clients SHALL no longer be able to call tools
