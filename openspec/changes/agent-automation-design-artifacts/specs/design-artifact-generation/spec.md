## ADDED Requirements

### Requirement: WeMail provides a dedicated internal design skill
The system SHALL provide an internal skill named `wemail-design` that converts typed datasets into validated reusable DesignRecipes for `brief`, `report`, `dashboard`, and `deck` artifacts.

#### Scenario: Scheduled report is configured
- **WHEN** a user requests a recurring mail aggregation report
- **THEN** the design skill SHALL compile a DesignRecipe against preview data
- **AND** automatic executions SHALL reuse that confirmed recipe rather than starting a general-purpose Agent to rewrite the artifact

#### Scenario: Skill context is loaded
- **WHEN** the design skill selects a mode or chart
- **THEN** it SHALL load only the directly relevant mode, chart, accessibility, security, and quality references
- **AND** trusted runtime implementation SHALL remain application-owned rather than model-editable skill content

### Requirement: Design mode selection follows explicit intent and data characteristics
The design skill SHALL choose an output mode from the user's intent, audience, content length, schema stability, and interaction needs, with report as the default for narrative multi-section analysis.

#### Scenario: User requests a management alert
- **WHEN** the result has one main conclusion and a small bounded set of metrics
- **THEN** the skill SHOULD choose `brief`

#### Scenario: User requests a weekly analytical summary
- **WHEN** the result needs context, evidence, multiple sections, and variable-length reading
- **THEN** the skill SHALL choose `report` unless the user explicitly requests another mode

#### Scenario: User requests a presentation
- **WHEN** the user explicitly asks for slides, PPT, a meeting deck, or fullscreen presentation
- **THEN** the skill SHALL choose `deck`
- **AND** SHALL NOT choose deck merely because the dataset contains charts

### Requirement: DesignRecipes are declarative and versioned
The system SHALL persist a versioned declarative DesignRecipe containing narrative, sections, allowlisted components, bindings, design-system identity, token overrides, notification summary, runtime capabilities, security requirements, and quality requirements without executable code.

#### Scenario: Recipe includes a chart
- **WHEN** a section visualizes a dataset field
- **THEN** the recipe SHALL use a validated ChartSpec
- **AND** SHALL contain no library-native callback, formatter function, event handler, or arbitrary script

#### Scenario: Rule design changes
- **WHEN** a user confirms a new recipe revision
- **THEN** future runs SHALL use the new revision
- **AND** historical artifacts SHALL retain the recipe revision with which they were rendered

### Requirement: Chart selection is semantically appropriate and bounded
The design skill SHALL select charts according to the analytical question and SHALL enforce chart-type, category, series, aggregation, and count limits.

#### Scenario: Values are compared across many categories
- **WHEN** categories exceed the bounded donut threshold
- **THEN** the skill SHALL use a bar or table representation rather than an unreadable donut

#### Scenario: No quantitative relationship exists
- **WHEN** the dataset does not contain a meaningful numeric comparison, trend, distribution, or relationship
- **THEN** the skill SHALL not manufacture a chart for decoration

### Requirement: Designed outputs are grounded in dataset provenance
Every displayed metric, chart, table, and factual conclusion SHALL resolve to existing dataset fields or declared aggregations and SHALL retain provenance to source processor steps and source references where available.

#### Scenario: Required field is missing
- **WHEN** the recipe requests a field that is absent from the production dataset
- **THEN** rendering SHALL show a safe unavailable or partial-data state
- **AND** SHALL NOT invent a value

#### Scenario: User inspects a metric source
- **WHEN** a metric is derived from mail or attachment data
- **THEN** its provenance SHALL identify the processor operation and bounded source references needed for inspection

### Requirement: Automatic rendering is deterministic and quality-gated
Given one confirmed recipe revision, one dataset snapshot, one design-system version, and one renderer version, the renderer SHALL produce reproducible artifact content and SHALL validate data, visual, accessibility, overflow, and security requirements before persistence.

#### Scenario: Dataset is empty
- **WHEN** no mail matches a successfully executed rule
- **THEN** the artifact SHALL render a meaningful empty state with the data window and rule status
- **AND** SHALL not produce a blank or broken report

#### Scenario: Deck content overflows a page
- **WHEN** a deck page exceeds its fixed canvas budget
- **THEN** validation SHALL fail or split the content according to the confirmed recipe policy
- **AND** SHALL not hide content using scrolling or clipping

#### Scenario: User prefers reduced motion
- **WHEN** the operating environment requests reduced motion
- **THEN** artifact transitions and animated charts SHALL be disabled or reduced without losing information

### Requirement: Message Artifacts are immutable versioned bundles
The system SHALL persist formal designed output as an account-scoped immutable artifact manifest and bounded resources including sanitized HTML/CSS, data, charts, provenance, and local assets.

#### Scenario: Artifact is published to a message
- **WHEN** a design step succeeds and the message provider publishes its artifact
- **THEN** the application message SHALL reference the exact artifact ID and version
- **AND** later rule or recipe changes SHALL not alter that artifact

#### Scenario: Preview artifact expires
- **WHEN** an unconfirmed preview artifact reaches its expiry
- **THEN** scheduled cleanup MAY remove it
- **AND** SHALL not remove a formal artifact still referenced by a retained application message

### Requirement: Artifact generation never executes model-authored code
The artifact builder SHALL accept only allowlisted HTML structure, CSS, declarative specifications, and local resources and SHALL inject only application-owned trusted runtime modules requested by the validated manifest.

#### Scenario: Generated content contains a script or handler
- **WHEN** generated artifact content contains `<script>`, an inline event handler, an executable URL, or another executable construct
- **THEN** validation SHALL reject or remove it before persistence
- **AND** the construct SHALL never execute in preview or formal viewing

#### Scenario: Chart interaction is required
- **WHEN** an artifact requests chart, filter, table, collapse, copy, or deck interaction
- **THEN** the renderer SHALL provide the interaction through a versioned trusted local runtime capability
- **AND** SHALL not use artifact-authored JavaScript
