## MODIFIED Requirements

### Requirement: Internal Agent and public MCP projections remain isolated
The system SHALL maintain separate internal Agent and public MCP tool projections. Internal automation-authoring skills, capability discovery, preview snapshots, provider compilation, DesignRecipe generation, rule mutation proposals, run diagnostics, artifact creation, and artifact-resource mutation SHALL NOT become public MCP tools merely because PI can use the corresponding internal workflow.

#### Scenario: Internal registry gains provider discovery
- **WHEN** `discover_automation_capabilities` or another internal authoring tool is registered for PI
- **THEN** the public MCP catalog SHALL remain unchanged unless a separate MCP specification explicitly adds a safe projection

#### Scenario: Internal design skill is loaded
- **WHEN** PI uses `wemail-design` during a rule preview
- **THEN** public MCP clients SHALL NOT gain direct access to internal artifact storage, trusted renderer injection, rule authorization, or application-message publication

#### Scenario: Public MCP attempts an internal provider operation
- **WHEN** a public MCP client invokes an unprojected provider, pipeline execution, capability refresh, artifact mutation, or rule commit tool
- **THEN** the request SHALL be rejected as unknown or unauthorized
- **AND** SHALL NOT enter the internal pending-action or provider execution path

### Requirement: Agent artifact delivery uses structured protocol events
The WeMail-owned Agent protocol SHALL represent completed formal artifacts as structured, persisted message parts containing bounded display metadata and an application-message-backed viewer reference.

#### Scenario: One-shot execution returns an artifact
- **WHEN** the execution tool completes with an application-message-backed artifact result
- **THEN** the protocol adapter SHALL emit one structured artifact event per distinct result
- **AND** replaying persisted conversation events SHALL reconstruct the same artifact cards
- **AND** the renderer SHALL NOT infer executable artifacts from arbitrary Markdown or HTML code fences
