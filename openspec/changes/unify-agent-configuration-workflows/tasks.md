## 1. Shared Configuration Contracts

- [x] 1.1 Add shared task kind, operation, status, canonical phase, and step-state contracts.
- [x] 1.2 Add shared structured issue category, severity, responsibility, retryability, and privacy contracts.
- [x] 1.3 Add shared effect-state, recovery-action, preview-authorization, and verification contracts.
- [x] 1.4 Add revisioned configuration snapshot and lifecycle event contracts.
- [x] 1.5 Add REST request and response contracts for start, inspect, recover, confirm, cancel, and retry operations.
- [x] 1.6 Add contract tests for valid state combinations and reject contradictory task, issue, and effect states.

## 2. Issue Catalog and Failure Boundaries

- [x] 2.1 Implement the central configuration issue catalog with stable registered codes and safe default metadata.
- [x] 2.2 Register initial codes for missing information, dependency/provider/resource availability, authentication, permission, unsupported capability, validation, conflict, stale preview, drift, confirmation, policy, transient failure, execution failure, and unknown outcome.
- [x] 2.3 Implement provider-neutral succeeded, unavailable, and failed operation results with declared effect state.
- [x] 2.4 Implement compatibility adapters for `AgentTerminalToolError`, ordinary Agent errors, provider errors, and legacy REST errors.
- [x] 2.5 Add bounded privacy-safe diagnostic extraction and prohibit credentials, content, prompts, environment dumps, and absolute temporary paths.
- [x] 2.6 Add telemetry for unclassified failures and catalog misses.
- [x] 2.7 Add tests proving raw error wording cannot change canonical task status.

## 3. Persistence and Repositories

- [x] 3.1 Add database migrations for configuration tasks, steps, issues, recoveries, and effects.
- [x] 3.2 Implement account-scoped repositories with optimistic task revisions.
- [x] 3.3 Implement the active-task uniqueness key across account, kind, target, and operation.
- [x] 3.4 Implement equivalent-intent deduplication and active-task resume lookup.
- [x] 3.5 Persist scoped draft, preview, committed-resource, and external-audit references without embedding sensitive payloads.
- [x] 3.6 Implement retention metadata and cleanup for active, completed, failed/cancelled, and outcome-unknown tasks.
- [x] 3.7 Add repository tests for account isolation, revision conflicts, deduplication, restart loading, retention, and prohibited stored fields.

## 4. Workflow Engine

- [x] 4.1 Implement the canonical phase reducer and allowed task/step transition table.
- [x] 4.2 Implement delayed durable task creation after kind, target, and operation become actionable.
- [x] 4.3 Implement domain substeps while keeping top-level phases canonical.
- [x] 4.4 Implement prerequisite, capability, compile, validate, preview, confirmation, commit, and verification orchestration hooks.
- [x] 4.5 Implement skipped downstream steps when a prerequisite blocks before execution.
- [x] 4.6 Implement effect-aware retry rules and prohibit blind retry for partial or unknown effects.
- [x] 4.7 Implement completion only after authoritative identity, ownership, revision, and state verification.
- [x] 4.8 Implement verification-incomplete and outcome-unknown behavior without erasing known committed effects.
- [x] 4.9 Add state-machine tests for blocked, needs-input, retryable, failed, completed-with-warning, cancelled, and outcome-unknown paths.

## 5. Recovery and Confirmation

- [x] 5.1 Implement typed recovery-action registration and server-side transition handlers.
- [x] 5.2 Implement earliest-invalidated-phase calculation for installation, authentication, permission, resource, conflict, stale-preview, and drift recovery.
- [x] 5.3 Revalidate account, ownership, authentication, permission, provider state, resources, source revision, preview, capability fingerprints, and authorization during resume.
- [x] 5.4 Bind confirmations to task revision, account, operation, normalized draft hash, preview ID/hash, source revision, capability fingerprints, authorization limits, and expiry.
- [x] 5.5 Invalidate confirmation and return to preview after every material bound-value change.
- [x] 5.6 Adapt pending actions to reference configuration tasks and immutable authorization snapshots.
- [x] 5.7 Deduplicate recovery pending actions and reject stale recovery or confirmation revisions.
- [x] 5.8 Add tests proving recovery never blindly replays a failed tool call or duplicates a side effect.

## 6. Provider Discovery and Automation Pilot

- [x] 6.1 Change automation provider discovery to isolate provider results and return partial capabilities plus provider statuses.
- [x] 6.2 Block discovery only when the normalized goal depends on an unavailable provider.
- [x] 6.3 Adapt WeCLI binary-missing and spawn failures into registered dependency issues with install and path-configuration recoveries.
- [x] 6.4 Preserve unrelated WeMail and automation capabilities when WeCLI is unavailable.
- [x] 6.5 Route Agent automation create and update through task creation, discovery, compile, validation, preview, confirmation, commit, and verification.
- [x] 6.6 Integrate stale preview, source revision conflict, and capability drift with canonical recovery phases.
- [ ] 6.7 Add automation scenario tests for missing WeCLI, unsupported capabilities, partial discovery, expired preview, drift, commit conflict, and verified completion.
- [ ] 6.8 Add a live scenario proving installation recovery resumes prerequisite checking and creates no duplicate rule.

## 7. Connection Configuration Pilot

- [ ] 7.1 Adapt mailbox authentication expiry and reauthentication to canonical tasks and recovery actions.
- [ ] 7.2 Adapt supported Feishu, WeCom, and bot connection setup and repair to canonical tasks.
- [ ] 7.3 Model permission denial separately from authentication and provider unavailability.
- [ ] 7.4 Verify connection identity, active account ownership, and usable status after commit.
- [ ] 7.5 Add Settings and Agent parity tests for authentication, permission, cancellation, provider unavailability, and successful recovery.
- [ ] 7.6 Add restart tests proving blocked connection tasks resume without repeating external mutations.

## 8. APIs and Event Delivery

- [x] 8.1 Add task-oriented routes for start, read, recover, confirm, cancel, and safe retry.
- [x] 8.2 Enforce account scope, expected task revision, allowed transition, and confirmation binding on every mutation route.
- [x] 8.3 Emit revisioned lifecycle events for task creation, phase changes, issues, recovery availability, preview readiness, and completion.
- [x] 8.4 Add snapshot retrieval for clients that reconnect or miss events.
- [x] 8.5 Keep simple non-actionable read checks synchronous without creating tasks.
- [ ] 8.6 Route migrated Agent tools, Settings handlers, and REST mutations through the same workflow service.
- [ ] 8.7 Add API tests for stale revisions, cross-account access, missed-event recovery, duplicate requests, and direct-write prevention.

## 9. Deterministic Outcome Projection and UI

- [x] 9.1 Implement a deterministic outcome projector for headline state, current need, completed and unattempted work, impact, unaffected scope, actions, and diagnostics.
- [x] 9.2 Add conflict checks that reject LLM wording which contradicts canonical workflow facts.
- [x] 9.3 Extend Agent events and stream reduction with configuration task snapshots and task-linked conclusions.
- [x] 9.4 Render one Agent configuration card updated in place by task ID and revision.
- [x] 9.5 Demote tool names, redacted commands, call IDs, and internal codes to an expandable diagnostic section.
- [ ] 9.6 Add compact Settings presentation that consumes the same status, issues, effects, and actions.
- [x] 9.7 Add accessible loading, blocked, needs-input, awaiting-confirmation, verifying, completed, warning, outcome-unknown, and cancelled states.
- [ ] 9.8 Add renderer tests proving Agent and Settings present identical canonical facts and do not depend on LLM finalizer availability.

## 10. Action-Required Messages and Notifications

- [ ] 10.1 Reference durable intervention tasks from application messages instead of copying mutable task state.
- [ ] 10.2 Deep-link action-required messages and notifications to the current task and valid recovery surface.
- [ ] 10.3 Update or close referenced messages when the task resolves or is cancelled.
- [ ] 10.4 Suppress desktop notification for inline validation, safe automatic retries, short transient failures, and already-cancelled tasks.
- [ ] 10.5 Add privacy and delivery tests for safe summaries, stale message content, invalid actions, and notification preference behavior.

## 11. Migration, Observability, and Release Gates

- [ ] 11.1 Add independent `configuration_workflow_domain`, `configuration_workflow_agent`, and `configuration_workflow_settings` feature flags.
- [ ] 11.2 Implement shadow task creation and canonical-versus-legacy outcome comparison without duplicate user presentation.
- [ ] 11.3 Add metrics for state disagreement, unclassified issues, recovery completion, duplicate prevention, verification failure, and outcome-unknown frequency.
- [ ] 11.4 Define and automate parity, privacy, restart recovery, cross-surface consistency, and no-duplicate-effect release gates.
- [ ] 11.5 Enable the automation and connection pilot cohorts after server contract and scenario tests pass.
- [ ] 11.6 Enable Agent presentation, then Settings presentation, as separate rollout steps.
- [ ] 11.7 Onboard provider-model, notification, and directory configuration after pilot gates pass.
- [ ] 11.8 Remove migrated direct writes and string-matched configuration outcomes only after rollback and telemetry gates pass.
- [ ] 11.9 Verify rollback preserves task records, committed configuration, and audit facts without replaying effects.
- [ ] 11.10 Run server, renderer, shared typecheck, desktop build, and focused Electron/E2E configuration scenarios.
