## ADDED Requirements

### Requirement: Run lists use bounded summaries and run details are loaded separately

The system SHALL expose bounded `AutomationRunSummary` records for lists and a separate account-authorized `AutomationRunDetail` for inspection.

#### Scenario: Automation detail loads recent runs

- **WHEN** the center opens a rule overview
- **THEN** it SHALL receive bounded run summaries containing status, planned and actual time, duration, input/result counts, and delivery summary
- **AND** it SHALL not download step outputs or mail-derived content for every row

#### Scenario: User opens one run

- **WHEN** the user selects a run summary
- **THEN** the system SHALL load its frozen occurrence metadata, step details, result/artifact references, delivery outcomes, usage, warnings, and recovery actions

### Requirement: Every run freezes its occurrence and execution identity

At claim time the runtime SHALL persist the rule and template versions, planned occurrence key and boundaries, account scope, exact input manifest, pipeline and recipe hashes, model resolution, renderer version, and delivery policy.

#### Scenario: Daily run starts late

- **WHEN** a planned 08:30 run starts at 10:00
- **THEN** run detail SHALL retain 08:30 as the planned occurrence
- **AND** collection boundaries SHALL remain based on the planned occurrence

#### Scenario: Retry begins after configuration changes

- **WHEN** a failed run is retried after the rule or global model changes
- **THEN** the retry SHALL reuse the original frozen execution identity and manifest

### Requirement: Step progress is durable and restart-safe

Every stage and pipeline step transition SHALL be persisted before active progress is emitted to the renderer.

#### Scenario: Application restarts during analysis

- **WHEN** WeMail restarts after analysis began
- **THEN** the center SHALL reconstruct the run from SQLite
- **AND** recovery SHALL not claim that an unpersisted later stage completed

#### Scenario: Active run advances

- **WHEN** a persisted step revision changes
- **THEN** the foreground MAY receive SSE or polling updates
- **AND** duplicate revisions SHALL not append duplicate progress entries

### Requirement: Step detail is bounded, typed, and privacy-safe

Each step record SHALL include capability identity, status, duration, bounded input/output summaries, output references, warnings, side-effect evidence, retry safety, and sanitized error metadata.

#### Scenario: Analysis consumes mail bodies

- **WHEN** a model step analyzes selected mail
- **THEN** its run detail SHALL record counts, schema, hashes, model, token usage if known, and duration
- **AND** it SHALL NOT persist body text in the step audit

#### Scenario: Error contains a token or local path

- **WHEN** an executor returns secret-like values or temporary paths in an error
- **THEN** run persistence SHALL redact those values before storage and projection

### Requirement: Overall status preserves useful partial results

The runtime SHALL distinguish `running`, `succeeded`, `empty`, `partial`, `failed`, `cancelled`, and `outcome_unknown`, and SHALL derive overall status from persisted step and side-effect state.

#### Scenario: Message Center succeeds and Bot fails

- **WHEN** a valid result is published locally but Bot delivery fails
- **THEN** the run SHALL be `partial`
- **AND** the center SHALL link the available result and identify only the failed destination

#### Scenario: No useful input exists

- **WHEN** selection completes successfully with no useful items
- **THEN** the run SHALL be `empty`
- **AND** it SHALL not be displayed as a failure

#### Scenario: External timeout has uncertain effect

- **WHEN** an external mutation times out without idempotency proof
- **THEN** the run SHALL be `outcome_unknown` or `partial`
- **AND** automatic retry SHALL be prohibited

### Requirement: Recovery is step-scoped and retry-safe

The system SHALL offer retry only for failed steps whose side effects are proven absent or idempotent and whose immutable inputs and capability fingerprints remain valid.

#### Scenario: Retry-safe Bot delivery failed

- **WHEN** a Bot send failed before dispatch and its exact output artifact remains available
- **THEN** the center MAY offer “重试投递”
- **AND** it SHALL not rerun data collection or analysis

#### Scenario: Input or capability drifted

- **WHEN** source content hash, capability fingerprint, authorization, or required artifact no longer matches the run snapshot
- **THEN** step retry SHALL be rejected
- **AND** the center SHALL offer a new run or rule revision instead

### Requirement: Run detail presents business result before diagnostics

The foreground run detail SHALL show the output preview, source coverage, stage outcomes, and delivery impact before model usage and collapsed technical diagnostics.

#### Scenario: User opens successful report run

- **WHEN** a run generated an HTML report with a line chart
- **THEN** run detail SHALL link or embed the safe artifact preview
- **AND** model, token, and capability metadata SHALL remain secondary

#### Scenario: Run has no artifact

- **WHEN** a rule only performs mail actions
- **THEN** run detail SHALL summarize matched and applied actions without displaying an empty report panel

### Requirement: Run and artifact retention is explicit

The system SHALL attach expiry and retention class metadata to detailed manifests, step records, and generated artifacts while retaining lightweight run summaries and referenced rule versions.

#### Scenario: Detailed retention expires

- **WHEN** a run’s detail retention period elapses
- **THEN** body-free summaries, status, hashes, and durable references SHALL remain as required
- **AND** expired artifacts or detailed manifests SHALL return an explicit unavailable state
