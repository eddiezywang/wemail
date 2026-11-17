## ADDED Requirements

### Requirement: Agent configuration uses canonical workflow state
For migrated configuration kinds, the PI Agent SHALL translate user intent into the canonical configuration workflow and SHALL use task snapshots as the source of progress and outcome truth.

#### Scenario: Internal tool call fails during configuration
- **WHEN** an internal tool call fails but the workflow classifies the task as blocked with no side effect
- **THEN** the Agent conclusion SHALL report the blocked configuration task
- **AND** SHALL NOT promote the tool failure to a generic failed user goal

### Requirement: Agent preserves actionable configuration tasks
Once kind, target, and operation are known and configuration processing begins, the Agent SHALL create or resume the durable task before running prerequisite or capability checks.

#### Scenario: Equivalent task already exists
- **WHEN** the user repeats a configuration request represented by an active task
- **THEN** the Agent SHALL resume or present that task
- **AND** SHALL NOT create a duplicate rule proposal or recovery action

### Requirement: Agent configuration wording is subordinate to task facts
PI and the finalizer MAY provide concise business-language summaries but SHALL NOT alter canonical task state, completed or skipped phases, effects, retry policy, or available actions.

#### Scenario: Finalizer returns contradictory status wording
- **WHEN** finalizer text contradicts the task snapshot
- **THEN** the runtime SHALL use deterministic projected wording for the contradictory fields

### Requirement: Agent diagnostics do not dominate configuration outcomes
The Agent SHALL retain privacy-safe tool name, redacted command, and call identifier for diagnosis when available, but SHALL present them only after the task goal, issue, progress, impact, and recovery actions.

#### Scenario: Missing local provider executable
- **WHEN** a required executable is missing during configuration discovery
- **THEN** the Agent SHALL explain which configuration capability is unavailable and what remains unperformed
- **AND** MAY expose the probe command and call ID only in diagnostic detail

### Requirement: Agent resumes configuration through workflow recovery
The Agent SHALL invoke typed workflow recovery actions and SHALL NOT directly replay a failed tool call after installation, authentication, permission, stale preview, conflict, or capability drift.

#### Scenario: User completes dependency installation
- **WHEN** the user asks the Agent to continue after installing the dependency
- **THEN** the Agent SHALL resume from the recovery action's invalidated phase
- **AND** SHALL require a new preview and confirmation if environment-derived authorization changed
