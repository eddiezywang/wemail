## ADDED Requirements

### Requirement: Automation capabilities are supplied by registered providers
The system SHALL expose automation sources, processors, actions, design operations, and delivery sinks through a canonical Provider Registry whose descriptors contain stable identity, version, input schema, output schema, risk, side effects, preview support, idempotency support, discovery confidence, and fingerprint.

#### Scenario: Agent searches for an invoice upload capability
- **WHEN** the Agent searches the registry for a capability that uploads invoice attachments
- **THEN** the registry SHALL return matching registered descriptors and their schemas
- **AND** the Agent SHALL NOT need or be permitted to invent an alternate action type

#### Scenario: Capability is not registered
- **WHEN** a rule references a provider or capability that the registry cannot resolve
- **THEN** compilation SHALL fail with a structured unavailable-capability error
- **AND** no previewed or automatic execution SHALL substitute materially different behavior

### Requirement: Provider lifecycle is canonical across authoring and execution
Every registered provider SHALL implement discovery, compilation, validation, preview, execution, and compatibility behavior through the canonical provider lifecycle.

#### Scenario: UI and Agent preview the same capability
- **WHEN** the settings UI and Agent submit semantically identical steps
- **THEN** both surfaces SHALL use the same provider descriptor, compiler, validator, and preview implementation
- **AND** their normalized step and risk presentation SHALL be equivalent

#### Scenario: Preview supports plans only
- **WHEN** a capability declares `plan-only` preview support
- **THEN** preview SHALL show the resolved bounded operation without executing its side effect

### Requirement: Capability drift is classified before execution
The system SHALL compare each confirmed capability snapshot with the current descriptor before automatic execution and SHALL distinguish compatible metadata or optional-input changes from material schema, identity, availability, and risk changes.

#### Scenario: Optional input is added
- **WHEN** a provider adds an optional input without changing existing input meaning or risk
- **THEN** the rule MAY continue using its confirmed bindings
- **AND** the refreshed descriptor metadata MAY be cached without user reconfirmation

#### Scenario: Input type or command identity changes
- **WHEN** a confirmed input changes type, a required input is renamed, the command path changes, or the provider identity changes
- **THEN** the rule SHALL pause before side effects
- **AND** the system SHALL require a new preview and confirmation

#### Scenario: Risk increases
- **WHEN** a capability's risk changes to a higher level
- **THEN** the existing authorization SHALL NOT cover the new risk
- **AND** the rule SHALL pause and disclose the change

### Requirement: Authorization is capability-scoped and bounded
Rule confirmation SHALL authorize exact provider capabilities, fingerprints, binding sources, risk levels, and configured limits rather than granting provider-wide or command-wide authority.

#### Scenario: Rule authorizes one WeCLI command
- **WHEN** a user confirms a rule using discovered `allowance upload`
- **THEN** the authorization SHALL cover only that command template and its confirmed bounds
- **AND** another WeCLI command SHALL require separate discovery, preview, and confirmation

#### Scenario: Runtime input exceeds a confirmed bound
- **WHEN** resolved attachments, bytes, messages, or another input exceed the authorization limit
- **THEN** the step SHALL fail closed before execution
- **AND** the run audit SHALL record a bounded privacy-safe reason

### Requirement: Generic WeCLI capabilities are discovered as safe argv templates
The WeCLI Provider SHALL derive capabilities from the installed WeCLI command tree or schema, persist command-path and typed-slot templates, and execute only array arguments through the audited shell-free runtime.

#### Scenario: Structured command schema is available
- **WHEN** WeCLI exposes a structured schema for a command
- **THEN** the Provider SHALL classify its discovery confidence as declared
- **AND** SHALL derive required inputs, argument expansion, risk, and fingerprint from that schema

#### Scenario: Only human-readable help is available
- **WHEN** the Provider must infer a descriptor from restricted help output
- **THEN** it SHALL classify confidence as inferred
- **AND** SHALL fail closed when mutation arguments are ambiguous
- **AND** SHALL NOT enable inferred destructive capabilities for automatic execution in this version

#### Scenario: WeCLI command executes
- **WHEN** a confirmed command template is executed
- **THEN** the Provider SHALL call the existing audited WeCLI runtime with `shell: false`
- **AND** SHALL NOT construct a shell, PowerShell, or command-interpreter script

### Requirement: Attachment materialization is run-scoped and temporary
The WeCLI Provider SHALL resolve AttachmentReferences only at execution time into an application-controlled run directory after validating account ownership, existence, type, size, hash when available, and authorization limits.

#### Scenario: Attachment is valid
- **WHEN** a confirmed attachment reference is resolved
- **THEN** the provider SHALL materialize a safe generated filename under the run directory
- **AND** SHALL remove the file after the step completes or fails

#### Scenario: Attachment reference is stale or malicious
- **WHEN** the attachment no longer exists, belongs to another account, exceeds limits, fails hash validation, or attempts path traversal
- **THEN** the provider SHALL execute no external command
- **AND** SHALL return a typed resource-unavailable or invalid-input error
