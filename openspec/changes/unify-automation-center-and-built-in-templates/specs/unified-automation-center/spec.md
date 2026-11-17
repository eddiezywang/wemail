## ADDED Requirements

### Requirement: The Automation Center lists every manageable rule through one projection

The system SHALL expose one account-aware Automation Center list that projects compatible V1 rules and immutable V2 pipeline rules into a stable summary contract without duplicating or mutating either stored rule.

#### Scenario: Agent-created V2 rule becomes visible

- **WHEN** the Agent verifies creation of a V2 automation rule
- **THEN** the unified list SHALL include that rule without requiring application restart
- **AND** the user SHALL be able to open its detail from the same list as V1 rules

#### Scenario: Legacy V1 rule remains manageable

- **WHEN** an existing V1 rule is loaded after the unified center is enabled
- **THEN** the list SHALL project its trigger, purpose, enabled state, health, and latest run
- **AND** the rule SHALL continue to execute without an implicit schema upgrade

#### Scenario: Rule belongs outside the current scope

- **WHEN** a rule is owned by another account and is not local-profile-visible
- **THEN** the current account list SHALL exclude it

### Requirement: The Automation Center uses a list and detail management hierarchy

The renderer SHALL preserve WeMail’s global navigation and provide an automation list with installed rules and bounded recommended templates beside a selected-rule detail surface.

#### Scenario: Desktop window opens Automation Center

- **WHEN** the window has sufficient width
- **THEN** the rule list and selected detail SHALL be visible together
- **AND** selecting another rule SHALL update the detail without navigating away from Automation Center

#### Scenario: Narrow window opens a rule

- **WHEN** the viewport cannot display list and detail accessibly
- **THEN** selecting a rule SHALL open a drill-in detail view
- **AND** an explicit accessible back action SHALL return to the list

#### Scenario: No rules exist

- **WHEN** the unified list is empty
- **THEN** the center SHALL explain how to create an automation through the Agent or a template
- **AND** it SHALL NOT display an empty diagnostic card

### Requirement: Rule detail separates overview, runs, and configuration

The selected-rule detail SHALL provide overview, run-history, and configuration views using user-recognizable language rather than provider or executor identities.

#### Scenario: User opens overview

- **WHEN** a configured rule is selected
- **THEN** overview SHALL show its purpose, enablement, next occurrence, latest outcome, workflow stages, latest output, and recent runs

#### Scenario: User opens configuration

- **WHEN** the user selects configuration
- **THEN** the center SHALL show account scope, trigger, data, analysis, output, and delivery decisions
- **AND** raw Prompt, Cron, model, catch-up, retention, and version details SHALL remain in an explicitly labeled advanced section

### Requirement: The workflow rail represents structure and live stage state

The center SHALL render the canonical stages `触发`, `数据`, `分析`, `产物`, and `投递` as one workflow rail whose state is derived from confirmed rule or persisted run state.

#### Scenario: Rule is idle and healthy

- **WHEN** no run is active
- **THEN** the rail SHALL summarize the confirmed workflow without implying execution progress

#### Scenario: One delivery destination fails

- **WHEN** report generation and Message Center publication succeed but Bot delivery fails
- **THEN** only the delivery stage SHALL indicate a problem
- **AND** the detail SHALL state that the report remains available

#### Scenario: Technical failure is expanded

- **WHEN** the user opens technical details for a failed stage
- **THEN** the center MAY show privacy-safe capability and error metadata
- **AND** it SHALL NOT expose mail bodies, credentials, provider secrets, stack traces by default, or tool-call IDs

### Requirement: Rule health is authoritative and non-contradictory

The unified projection SHALL derive one health value from persisted rule, runtime, authorization, and latest-run state using `healthy`, `running`, `needs_attention`, `paused`, `disabled`, or `never_run`.

#### Scenario: Latest Agent turn finishes while rule commit is blocked

- **WHEN** generic Agent processing ends but the automation remains blocked
- **THEN** the center SHALL show `needs_attention` or `paused`
- **AND** it SHALL NOT show the rule as successfully configured

#### Scenario: Disabled rule has an old failure

- **WHEN** a disabled rule’s latest historical run failed
- **THEN** its primary health SHALL be `disabled`
- **AND** the historical failure SHALL remain available in run history

### Requirement: Structured edits and conversational edits share one versioned draft

The structured configuration surface and “请 Agent 修改” SHALL read and mutate the same canonical pipeline draft with optimistic revisions, current previews, review invalidation, exact confirmation, commit, and reload verification.

#### Scenario: User starts in form and continues in Agent

- **WHEN** the user changes delivery in the structured editor and asks the Agent to revise the chart
- **THEN** the Agent SHALL resume the same draft revision
- **AND** both changes SHALL be represented in the next preview

#### Scenario: Concurrent revision conflicts

- **WHEN** a stale form or Agent turn attempts to update an older draft revision
- **THEN** the server SHALL reject the mutation as stale
- **AND** the UI SHALL offer to reload and explain which current decisions would be replaced

#### Scenario: Material edit to V1 rule

- **WHEN** the user materially edits a legacy V1 rule
- **THEN** the system SHALL create a V2 upgrade draft while the active V1 rule remains unchanged
- **AND** only exact confirmation SHALL activate the new version

### Requirement: Enable, run, archive, and delete controls have explicit semantics

The center SHALL distinguish schedule enablement, side-effect-free test, immediate production run, archive, and permanent deletion.

#### Scenario: Test a disabled rule

- **WHEN** the user requests a test for a disabled rule
- **THEN** the system SHALL allow a side-effect-free preview without enabling its schedule

#### Scenario: Run a disabled rule now

- **WHEN** the user requests a production run for a disabled rule
- **THEN** the center SHALL require the applicable run authorization
- **AND** successful execution SHALL NOT enable the future schedule

#### Scenario: Archive a referenced rule

- **WHEN** the user archives a rule with retained runs or messages
- **THEN** the rule SHALL stop scheduling and leave its history navigable
- **AND** the center SHALL NOT permanently delete referenced records

### Requirement: Foreground automation interactions are accessible

The Automation Center SHALL support keyboard navigation, visible focus, semantic labels, reduced motion, localized status text, and non-color-only state communication.

#### Scenario: Keyboard-only user inspects a failed run

- **WHEN** the user navigates the list, tabs, workflow rail, and run detail using a keyboard
- **THEN** every action SHALL be reachable in a predictable order
- **AND** stage and run state SHALL be announced in text
