# pi-agent-runtime Specification

## Purpose
TBD - created by archiving change wemail-pkg-j-pi-agent-runtime. Update Purpose after archive.
## Requirements
### Requirement: Fixed phase-one tool surface

The system SHALL expose exactly the following tools to the PI agent in phase one: `list_mail`, `read_mail`, `search_mail`, `get_summary`, `draft_reply`, `wecli_query`, `wecli_action_preview`.

#### Scenario: Unknown tool is rejected

- **WHEN** PI invokes a tool name not in the phase-one list
- **THEN** the runtime SHALL return an error and SHALL NOT execute anything

### Requirement: Agent never sends mail

The system SHALL route all drafting through local persistence only and SHALL NOT allow any agent-reachable path to trigger SMTP send.

#### Scenario: draft_reply does not send

- **WHEN** PI invokes `draft_reply({ messageId })`
- **THEN** the runtime SHALL persist a local draft and return it to the agent
- **AND** no call SHALL be made to `MailProvider.sendDraft`

### Requirement: wecli_query enforces auto-approve rule

The system SHALL only execute WeCLI commands through `wecli_query` when the classifier returns `auto`.

#### Scenario: Non-ls command rejected by wecli_query

- **WHEN** PI invokes `wecli_query({ args: ['ticket', 'close', '1'] })`
- **THEN** the runtime SHALL return an error and point PI at `wecli_action_preview`
- **AND** no process SHALL be spawned

### Requirement: wecli_action_preview never executes

The system SHALL provide `wecli_action_preview` that returns a plan (classification + intended args) without spawning `wecli`.

#### Scenario: Preview returns plan only

- **WHEN** PI invokes `wecli_action_preview({ args: ['ticket','close','1'] })`
- **THEN** the runtime SHALL return `{ classification: 'requires-confirmation', plannedArgs, executed: false }`
- **AND** no process SHALL have been spawned

### Requirement: Agent uses PI, not Claude Code

The system's built-in agent runtime SHALL be the PI implementation; the `AgentRuntime` interface exists to allow later swaps, but phase one SHALL wire `PiAgentRuntime`.

#### Scenario: Default runtime is PI

- **WHEN** the server boots with default configuration
- **THEN** `agentRoutes` SHALL resolve to `PiAgentRuntime`

### Requirement: Agent traces exclude mail bodies

The system SHALL NOT include mail body content in agent trace logs.

#### Scenario: Trace entries are metadata-only

- **WHEN** the agent runtime writes a trace
- **THEN** the trace SHALL include tool names, argument shape summaries, and outcome codes
- **AND** it SHALL NOT include mail body text

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

