## Why

WeMail currently lets individual Agent tools, providers, settings screens, and REST handlers turn local execution failures directly into the outcome of a user's broader configuration goal. This loses process context, produces inconsistent `failed` versus `blocked` semantics, and makes recovery depend on tool-specific error strings instead of a durable, user-understandable configuration workflow.

## What Changes

- Introduce one account-scoped configuration-task domain shared by the Agent, Settings UI, REST APIs, and recovery entry points.
- Standardize configuration phases, task and step statuses, structured issues, side-effect states, retry safety, recovery actions, preview/confirmation binding, commit verification, concurrency, and resume behavior.
- Delay durable task creation until the configuration target and operation are known and the workflow enters prerequisite checking or another actionable phase.
- Make provider capability discovery tolerant of partial availability so an unrelated provider failure does not erase usable capabilities or block an unrelated goal.
- Generate progress, outcome, impact, and recovery presentation deterministically from task state; restrict the LLM to intent translation and bounded business-language summaries.
- Persist actionable configuration tasks so installation, authentication, permission, conflict, stale-preview, and capability-drift recovery can continue safely after navigation or restart.
- Add stable task-oriented APIs and event snapshots, and render one updating configuration card across Agent and Settings surfaces with tool diagnostics demoted to optional detail.
- Project durable user-intervention states into the existing application-message/action-required channel without duplicating task state.
- Migrate automation-rule authoring and connection recovery first, then remove string-matched configuration outcome handling after compatibility telemetry proves coverage.

## Capabilities

### New Capabilities

- `configuration-workflow-domain`: Canonical configuration task, phase, status, step, effect, concurrency, preview, confirmation, commit, verification, and resume semantics.
- `configuration-issue-recovery`: Central issue catalog, structured provider failure boundary, retry policy, responsibility, and typed recovery actions.
- `configuration-task-persistence`: Durable account-scoped task snapshots, revisions, references, retention, recovery, deduplication, and privacy controls.
- `configuration-outcome-experience`: Deterministic user-facing progress and outcome projection shared by Agent, Settings, and action-required delivery.
- `configuration-workflow-api`: Task-oriented REST and event contracts used by all configuration entry points.
- `configuration-workflow-migration`: Phased adoption, compatibility adapters, feature flags, dual-write comparison, observability, and removal gates for legacy paths.

### Modified Capabilities

- `pi-agent-runtime`: Configuration requests use durable workflow state and structured conclusions instead of promoting a failed tool call directly to the user's task outcome.

## Impact

- Shared contracts in `shared/wemail` gain configuration-task, issue, recovery, effect, API, and event types.
- Server composition gains a configuration workflow service, repositories, issue catalog, provider adapters, deterministic outcome projector, and recovery handlers.
- Automation authoring, provider discovery, pending actions, connection setup, Agent runtime conclusions, Settings sections, application messages, and notification routing integrate with the shared task model.
- Database migrations add configuration task, step, issue, recovery, and effect records containing bounded metadata and references rather than credentials or business content.
- Existing direct configuration APIs and string-based Agent error classification remain behind compatibility adapters during rollout, then are removed after parity and safety gates pass.
