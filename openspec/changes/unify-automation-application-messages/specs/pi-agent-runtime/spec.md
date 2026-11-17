## MODIFIED Requirements

### Requirement: Fixed phase-one tool surface

The system SHALL expose only tools registered in the built-in PI registry and SHALL include canonical automation tools for listing and explaining rules, previewing normalized rule drafts, proposing confirmed rule changes, inspecting run history, and proposing manual runs. Automation tools SHALL remain internal to PI unless separately approved for another registry.

#### Scenario: Unknown tool is rejected

- **WHEN** PI invokes a tool name that is not registered in the built-in PI registry
- **THEN** the runtime SHALL return an error and SHALL NOT execute anything

#### Scenario: PI configures automation

- **WHEN** PI needs to create or update an automation rule from natural language
- **THEN** it SHALL use the canonical automation preview and proposal tools
- **AND** the proposal SHALL require a WeMail-owned pending-action confirmation before persistence

#### Scenario: Public MCP requests an internal automation tool

- **WHEN** a public MCP client requests a PI-only automation configuration tool
- **THEN** the MCP registry SHALL reject it before the internal PI registry is consulted
