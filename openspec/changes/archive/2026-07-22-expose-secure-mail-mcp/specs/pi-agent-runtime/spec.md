## ADDED Requirements

### Requirement: Internal Agent and public MCP projections remain isolated

The system SHALL reuse bounded domain handlers where appropriate while maintaining separate internal Agent and public MCP registries, schemas, descriptions, risk metadata, and allowlists.

#### Scenario: Internal registry gains a tool

- **WHEN** a tool is added to the built-in Agent registry
- **THEN** it SHALL remain unavailable to MCP until an explicit public-registry entry and MCP contract tests are added

#### Scenario: Public MCP schema evolves

- **WHEN** a public MCP input or output schema is changed compatibly
- **THEN** the Pi runtime and renderer SHALL not be required to consume MCP protocol types
- **AND** the shared domain handler SHALL continue to enforce account ownership and semantic risk policy

#### Scenario: MCP attempts an internal-only tool

- **WHEN** an MCP client calls an internal Agent, Curator, WeCLI, directory, workspace, automation, configuration, or intelligence-only tool name
- **THEN** the MCP registry SHALL reject the call before the internal registry is consulted

### Requirement: Public MCP cannot bypass Agent action safety

The system SHALL apply the same or stricter semantic confirmation policy to public MCP operations as to built-in Agent operations.

#### Scenario: MCP prepares a high-risk operation

- **WHEN** an MCP tool prepares send, delete, move, archive, spam, or batch mutation work
- **THEN** it SHALL create a WeMail-owned pending operation for user approval
- **AND** it SHALL not invoke provider dispatch through an alternate Agent handler
