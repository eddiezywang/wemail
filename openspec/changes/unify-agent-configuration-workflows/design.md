## Context

WeMail currently represents Agent completion with a run-level conclusion and allows tools to return ordinary failures or richer terminal failures. Settings handlers and automation providers use separate error and recovery paths. As a result, a failed local probe can become the apparent outcome of a broader user goal, provider discovery is vulnerable to all-or-nothing aggregation, completed and unattempted phases are not preserved, and recovery often restarts an ad hoc tool call rather than a validated configuration process.

This change introduces a control-plane workflow for persistent configuration: automation rules, mail accounts, external connections, Agent providers, notifications, directory initialization, and integrations. The same domain facts serve Agent, Settings, REST, and durable action-required messages. One-time operational work such as sending or moving mail remains outside this state machine.

The design must preserve existing exact-preview confirmation, account isolation, capability fingerprints, pending actions, application messages, and privacy restrictions. It must work without WeCLI or any other optional provider and remain recoverable across Electron application restarts.

## Goals / Non-Goals

**Goals:**

- Preserve the user's configuration goal, phase progress, issues, side effects, and recovery choices independently of individual tool calls.
- Give Agent, Settings, REST, and notifications one canonical task state and deterministic user-facing projection.
- Distinguish blocked, needs-input, retryable, failed, outcome-unknown, and completed-with-warning states.
- Permit partial capability discovery while blocking only when the requested goal depends on an unavailable capability.
- Resume safely after installation, authentication, permission, conflict, stale preview, or capability drift.
- Bind mutation confirmation to the exact account, operation, preview, source revision, capabilities, authorization scope, and expiry.
- Introduce the domain incrementally with dual-write comparison and reversible feature flags.

**Non-Goals:**

- Generalize every Agent operation into a configuration workflow.
- Replace automation execution-run or mail-operation audit models.
- Let the LLM decide task state, retry safety, effects, or recovery controls.
- Store credentials, mail bodies, attachment content, raw provider payloads, prompts, or unrestricted filesystem paths in task records.
- Automatically install dependencies, authenticate, request permissions, or repeat unsafe external mutations.

## Decisions

### 1. Use one cross-surface configuration domain

`ConfigurationWorkflowService` owns canonical tasks used by Agent, Settings, REST, and recovery entry points. Surfaces may render different densities, but they consume the same revisioned snapshot and invoke the same recovery commands.

Alternative considered: add an Agent-only outcome envelope. Rejected because Settings and REST would retain different facts and recovery semantics for the same account or connection.

### 2. Create durable tasks only after intent becomes actionable

Natural-language exploration remains ephemeral. A task is created when kind, target, and operation are known and the process enters prerequisite checking or another actionable phase. Any state waiting for input, confirmation, or later recovery is durable.

This avoids abandoned records for speculative conversation while ensuring that actionable interruption survives navigation and restart.

### 3. Use fixed phases and domain-specific substeps

The canonical phases are:

```text
understand_goal
collect_requirements
check_prerequisites
discover_capabilities
compile_configuration
validate_configuration
generate_preview
await_confirmation
commit_configuration
verify_configuration
```

Domains may skip phases or record substeps inside them, but may not invent synonymous top-level phases. Steps use `pending`, `running`, `completed`, `blocked`, `failed`, `skipped`, or `cancelled`. A downstream step not attempted because a prerequisite blocked is `skipped`, not `failed`.

### 4. Keep task status separate from issue and effect state

Task status describes the user's goal: drafting, needs input, checking prerequisites, blocked, preparing preview, awaiting confirmation, committing, verifying, completed, completed with warnings, retryable failure, failed, outcome unknown, or cancelled.

Issues describe why progress changed. Effects independently record `none`, `planned`, `started`, `committed`, `rolled_back`, `partial`, or `unknown`. This prevents a transport failure after a confirmed commit from being presented as “nothing was created.”

### 5. Centralize issue semantics

A `ConfigurationIssueCatalog` registers every user-visible issue code with category, safe default message, severity, responsibility, retryability, privacy classification, eligible recovery types, and notification policy. Core categories cover missing information, unavailable dependency/provider/resource, authentication, permission, unsupported capability, validation, conflict, stale preview, drift, confirmation, policy, transient failure, execution failure, and unknown outcome.

Provider and tool boundaries convert local exceptions into structured operation results before they reach the orchestrator. A compatibility adapter accepts legacy errors temporarily. Unclassified failures use a stable fallback code and are counted; raw text never decides the primary task status.

Alternative considered: expand the existing regular-expression classifier. Rejected because wording changes erase semantics and cannot represent partial results, effects, or responsibility.

### 6. Discover providers independently

Registry discovery isolates provider results using settled aggregation. It returns available capabilities plus per-provider status. An unavailable provider blocks a task only when the normalized goal requires it; unrelated failures become bounded warnings.

Capability descriptors and issue results remain account-scoped and privacy-safe. A discovery refresh cannot silently substitute another provider or materially different behavior.

### 7. Resume from the earliest invalidated phase

A recovery action declares the earliest phase it invalidates. Resumption preserves the user's intent and canonical draft but rechecks all environment-derived facts at and after that phase: active account, ownership, authentication, permission, provider availability, resource references, source revision, preview expiry/hash, capability fingerprints, and authorization.

Recovery never blindly replays the failed tool call. Read-only and explicitly idempotent checks may resume automatically. Installation, authentication, permission requests, configuration changes, commits, and uncertain side effects require user action or confirmation.

### 8. Bind confirmation to an immutable preview authorization

Mutation confirmation binds task ID and revision, account, kind, target, operation, normalized draft hash, preview ID/hash, source revision, capability fingerprints, risk and authorization limits, and expiry. Any material change invalidates confirmation and returns the workflow to preview.

Pending actions reference the configuration task and authorization snapshot rather than retransmitting a mutable rule or connection payload.

### 9. Verify after commit

A successful commit moves the task to verification. Completion requires an authoritative read proving the expected identity, revision, ownership, and state. If commit is known to have succeeded but verification fails, the projection says the configuration was saved but verification is incomplete.

If the external outcome cannot be established, the task enters `outcome_unknown`; automatic retry is forbidden until reconciliation proves whether an effect occurred.

### 10. Persist revisioned snapshots and bounded references

The storage model adds records equivalent to:

```text
configuration_tasks
configuration_task_steps
configuration_task_issues
configuration_task_recoveries
configuration_task_effects
```

Every mutation uses optimistic task revision checks. One active task is allowed per account, configuration kind, target, and operation key. Duplicate intent resumes the active task; competing mutations enter a configuration conflict rather than overwriting.

Drafts, previews, committed resources, and external audits are referenced through scoped IDs and hashes. Task rows store bounded metadata only.

Retention defaults are: actionable tasks until resolved or cancelled; completed tasks 30 days; ordinary failed/cancelled tasks 14 days; outcome-unknown or externally effectful tasks 90 days. Cleanup never deletes committed configuration, rule versions, or independent audit facts.

### 11. Project user outcomes deterministically

`ConfigurationOutcomeProjector` derives headline status, current need, completed and unattempted work, impact, unaffected scope, available actions, and diagnostics from task facts. The LLM may translate intent into drafts and supply bounded business wording, but cannot change status, steps, effects, retry policy, or controls.

The primary UI is one task card updated by task ID and revision. Tool calls are optional diagnostic children. Settings may use a compact layout while retaining identical facts. Action-required messages reference the task instead of copying mutable state.

### 12. Use task-oriented APIs and events

Mutation entry points return a task ID, revisioned snapshot, and current actions. Clients observe configuration lifecycle events or fetch the latest snapshot. Simple read-only checks may remain synchronous.

All mutating surfaces call the workflow service; the Agent may not use a workflow-shaped prompt as a substitute for the service, and Settings may not bypass the service with direct database writes.

### 13. Keep notifications narrow

Durable states requiring later user intervention may publish an action-required message and eligible desktop notification with a safe summary and deep link. Short transient retries, inline validation errors, and already-cancelled tasks do not notify. Resolving or cancelling the task updates the referenced message.

### 14. Roll out by domain and surface

Feature flags independently control the domain write path, Agent projection, and Settings projection. The first cohort covers Agent automation authoring, WeCLI discovery/install/path recovery, mailbox authentication, external platform connections, stale previews, and capability drift. Provider-model, notification, and directory flows follow after the first cohort passes parity.

During dual-write, the system compares legacy and canonical outcomes without exposing duplicate UI. Legacy exceptions map through adapters, and unclassified rates and state disagreements are observable.

## Risks / Trade-offs

- **The task model becomes a broad control-plane abstraction.** → Keep one-time operations out of scope, use fixed phases, and require capability specs before onboarding a new configuration kind.
- **Persisted tasks can accumulate or expose sensitive context.** → Store only bounded metadata and scoped references, enforce retention, and test prohibited fields.
- **Dual-write can produce conflicting state.** → Treat the canonical path as shadow-only initially, record comparison telemetry, and switch readers only after parity gates.
- **Recovery can act on stale environmental facts.** → Resume from the earliest invalidated phase and revalidate all derived facts before preview or commit.
- **Verification may be unavailable after a real commit.** → Preserve committed effect facts, enter verification-incomplete or outcome-unknown, and prohibit misleading rollback or blind retry.
- **Central issue registration can slow feature development.** → Provide a small registration API, a safe unclassified fallback, and tests that make missing semantics explicit.
- **Cross-surface UI parity can be mistaken for identical layouts.** → Require identical facts and actions while allowing density and navigation differences.

## Migration Plan

1. Add shared contracts, reducers, catalog interfaces, effect rules, projector tests, and persistence migrations behind `configuration_workflow_domain`.
2. Add compatibility adapters for `AgentTerminalToolError`, ordinary Agent errors, provider errors, and legacy REST errors; start shadow task creation and comparison telemetry.
3. Route automation capability discovery through settled provider results and onboard automation authoring through preview, confirmation, commit, and verification.
4. Onboard WeCLI installation/path recovery, mailbox authentication, external connections, stale-preview, and capability-drift flows.
5. Enable the Agent task card and task-based conclusion projection behind `configuration_workflow_agent`.
6. Enable Settings consumption and recovery actions behind `configuration_workflow_settings`; stop direct writes for migrated flows.
7. Connect durable intervention states to application messages and notifications.
8. Expand to provider-model, notification, and directory configuration after parity, privacy, restart recovery, and no-duplicate-effect gates pass.
9. Remove string-matched configuration outcomes and migrated direct-write routes only after unclassified and disagreement metrics remain below the release threshold.

Rollback disables new readers and entry points while retaining task records for diagnostics. It does not delete committed configuration or replay effects. Legacy paths remain available until the final removal gate.

## Open Questions

None. The scope, persistence boundary, phase model, issue taxonomy, partial discovery, recovery rules, LLM boundary, retention, rollout, and first adoption cohort were explicitly reviewed and accepted.
