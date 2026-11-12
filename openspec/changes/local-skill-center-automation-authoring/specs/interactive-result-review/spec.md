## ADDED Requirements

### Requirement: Review checkpoints are selected by subjectivity and impact

The workflow compiler SHALL require or recommend intermediate review for ambiguous matching, subjective model analysis, visual or formatted artifacts, user-visible delivery content, and high-impact external actions, while avoiding redundant confirmation of simple deterministic read-only steps.

#### Scenario: Workflow contains an HTML chart report

- **WHEN** a workflow requests an HTML report with charts
- **THEN** the system SHALL create an artifact-review checkpoint before final automation confirmation

#### Scenario: Workflow only reads one known message

- **WHEN** a one-shot workflow performs a deterministic read with no subjective output or side effect
- **THEN** the system SHALL NOT require an intermediate design review

### Requirement: Artifact previews render the actual output form

Chart, image, HTML, PDF, and message-template checkpoints SHALL provide a safe side-effect-free preview rendered through the same compatible recipe semantics intended for execution.

#### Scenario: User opens a chart preview

- **WHEN** the Agent provides a report preview link
- **THEN** the link SHALL open the rendered report or chart rather than a configuration table or confirmation dialog
- **AND** the chat SHALL remain the place where the user gives feedback

### Requirement: Review is conversational and version-bound

The Agent SHALL interpret natural-language feedback as accept, reject, revise, or ambiguous for the currently referenced preview, and acceptance SHALL bind to the exact target, version, and content hash.

#### Scenario: User requests a visual change

- **WHEN** the user asks to make failure rate red and move the alert table
- **THEN** the system SHALL create a new artifact recipe and preview version
- **AND** the previous preview SHALL remain unaccepted for final compilation

#### Scenario: User clearly accepts the current preview

- **WHEN** the user unambiguously says the current version is acceptable
- **THEN** the current version and hash SHALL be recorded as accepted
- **AND** this acceptance SHALL NOT by itself authorize rule creation or external delivery

#### Scenario: User response is ambiguous

- **WHEN** the response cannot be safely classified as acceptance or rejection of the current preview
- **THEN** the Agent SHALL ask a concise clarification
- **AND** SHALL not mark the checkpoint accepted

### Requirement: Accepted reviews invalidate along dependencies

When an upstream data, analysis, or presentation contract materially changes, the system SHALL mark only affected downstream review checkpoints stale and require new previews where necessary.

#### Scenario: Data scope changes after chart acceptance

- **WHEN** the user adds a new mail category that changes the analysis dataset
- **THEN** dependent analysis and artifact checkpoints SHALL become stale
- **AND** an unrelated destination-selection checkpoint MAY remain accepted

#### Scenario: Only Bot priority changes

- **WHEN** the user changes delivery priority without changing report content
- **THEN** accepted data, analysis, and artifact reviews SHALL remain valid

### Requirement: Preview acceptance stores a recipe, not sample values

The system SHALL persist the accepted analysis or artifact recipe and its schema expectations rather than treating sample data values as the future automatic output.

#### Scenario: Daily data changes

- **WHEN** a confirmed report runs on a later day with different metric values but a compatible schema
- **THEN** the runtime SHALL render those values using the accepted recipe
- **AND** SHALL preserve the accepted structure and presentation semantics

### Requirement: Active-chat review uses inline interaction

The renderer SHALL present review questions, preview links, concise choices, and optional collapsed technical details inline in the conversation and SHALL NOT require a large durable diagnostic card for an ordinary review or recoverable authoring issue.

#### Scenario: Preview generation is unavailable

- **WHEN** one preview step cannot currently run
- **THEN** the chat SHALL identify that step, state what remains incomplete, and offer relevant recovery or adjustment choices
- **AND** SHALL not duplicate the same issue and recovery actions in a separate large card
