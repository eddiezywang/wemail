## 1. Shared contracts and persistence

- [x] 1.1 Add shared Skill package, manifest, version, activation, compatibility, permission, dependency, and usage-reference contracts.
- [x] 1.2 Add shared capability catalog contracts for trigger, timing, data, analysis, output, delivery, readiness, risk, preview, and recovery.
- [x] 1.3 Add shared pipeline contracts for data selection, analysis recipes, artifact recipes, delivery plans, steps, Skill snapshots, and capability snapshots.
- [x] 1.4 Add shared review checkpoint contracts with target, policy, version, hash, status, feedback, preview, and dependency fields.
- [x] 1.5 Extend configuration contracts with the canonical authoring states, effect state, next interaction, preview links, and goal-authoritative outcome.
- [x] 1.6 Extend automation rule snapshots with compiled recipes, exact Skill versions/hashes, accepted review hashes, and delivery policy.
- [x] 1.7 Add SQLite migrations for Skill packages, versions, activation, permissions, dependencies, usage references, drafts, and review state.
- [x] 1.8 Add migration and serialization tests covering upgrades from the current schema and restart recovery.

## 2. Local Skill package store and registry

- [x] 2.1 Add the `skills/builtin` product-package source tree and Electron build-copy configuration.
- [x] 2.2 Implement built-in resource discovery through `process.resourcesPath` with a development-source fallback.
- [x] 2.3 Implement personal package storage under Electron `userData` with immutable version directories and atomic installation.
- [x] 2.4 Implement `SkillPackageRepository` for local registry metadata, activation, version history, compatibility, and usage references.
- [x] 2.5 Implement package hashing and load-time tamper detection.
- [x] 2.6 Implement Skill lookup, list, inspect, enable, disable, activate-version, export, and guarded-delete services.
- [x] 2.7 Prevent personal IDs from shadowing protected built-in Skill IDs while allowing explicit personal copies.
- [x] 2.8 Add focused repository and package-store tests for application upgrades, version immutability, tampering, and referenced-version retention.

## 3. Skill import, validation, and security

- [x] 3.1 Implement validation for `SKILL.md`, `wemail.skill.json`, optional `agents/openai.yaml`, one-level references, assets, and package limits.
- [x] 3.2 Implement safe folder and ZIP staging with traversal, unsafe-link, expansion-ratio, file-count, encoding, and size defenses.
- [x] 3.3 Implement conservative import of portable `SKILL.md` packages that lack a WeMail manifest.
- [x] 3.4 Implement tool and permission compatibility analysis against registered WeMail internal capabilities.
- [x] 3.5 Make imported personal scripts inert and reject declarations of arbitrary shell, process, network, IPC, or unrestricted filesystem execution.
- [x] 3.6 Implement exact-hash install confirmation and post-install verification.
- [x] 3.7 Add malicious-package, unsupported-tool, script-inertness, and interrupted-install tests.

## 4. Pi-native Skill discovery and loading

- [x] 4.1 Integrate pi-coding-agent's native Skill discovery and standard metadata prompt formatting.
- [x] 4.2 Expose validated active versions, or exact task-bound versions for reproducible automation, without keyword routing.
- [x] 4.3 Keep typed dependency closure, cycle, compatibility, and content-hash validation in the package governance layer.
- [x] 4.4 Register pi's native `read` tool with a WeMail package-root allowlist so the Agent progressively reads `SKILL.md` and referenced files.
- [x] 4.5 Remove global Skill body concatenation and the parallel WeMail `load_skill` protocol.
- [x] 4.6 Record privacy-safe Skill IDs, versions, and hashes only after successful reads.
- [x] 4.7 Add runtime tests for metadata-only prompts, on-demand body/reference reads, access denial, task-bound versions, conflicts, and policy preservation.

## 5. Built-in composable Skills

- [x] 5.1 Package `wemail-data-selection` with structured output guidance, bounded mail scope, matching samples, and relevant references.
- [x] 5.2 Package `wemail-analysis-design` with structured metrics, model-task, conclusion, provenance, and sample-review guidance.
- [x] 5.3 Package `wemail-artifact-review` with HTML, chart, image, PDF, accessibility, empty-state, and natural-language revision guidance.
- [x] 5.4 Package `wemail-delivery-planning` with Message Center, Feishu, WeCom, content projection, fallback, and partial-failure guidance.
- [x] 5.5 Package `wemail-automation-authoring` with intent routing, trigger compilation, readiness, exact confirmation, commit, and verification guidance.
- [x] 5.6 Package protected `wemail-skill-authoring` with reusable-procedure extraction, secret removal, draft review, validation, and exact installation guidance.
- [x] 5.7 Validate each package structure and generate matching Agent UI metadata.
- [x] 5.8 Add forward behavior tests for each Skill alone and for representative composed Skill sets.

## 6. Capability catalog and structured pipeline services

- [x] 6.1 Implement the Agent-facing capability catalog over current trigger, mail, processor, design, Message Center, Bot, and optional WeCLI executors.
- [x] 6.2 Remove Provider ID requirements from Agent discovery and draft schemas while preserving internal executor adapters.
- [x] 6.3 Distinguish unknown capability, ready, not installed, not connected, authentication required, permission required, and temporary failure.
- [x] 6.4 Implement pipeline draft persistence with optimistic revision checks and typed Skill input/output merges.
- [x] 6.5 Implement pipeline validation for schemas, value kinds, scope bounds, step ordering, external effects, and unavailable capabilities.
- [x] 6.6 Implement one-shot pipeline compilation and execution without creating an automation rule.
- [x] 6.7 Implement trigger compilation for scheduled daily/interval, mail-received matching, immediate, delay, next-day, and manual forms.
- [x] 6.8 Add capability and pipeline contract tests proving one-shot and automated requests share the same pipeline representation.

## 7. Interactive preview and review

- [x] 7.1 Implement review-policy derivation for ambiguous data matching, subjective analysis, formatted artifacts, delivery content, and external effects.
- [x] 7.2 Implement versioned side-effect-free data-match and analysis previews with bounded sample provenance.
- [x] 7.3 Implement actual HTML, chart, image, PDF, and Bot-message preview artifacts using runtime-compatible recipe semantics.
- [x] 7.4 Implement natural-language accept, reject, revise, and ambiguous classification bound to one current checkpoint.
- [x] 7.5 Implement server-side validation that accepted checkpoint version and hash are current.
- [x] 7.6 Implement dependency-aware invalidation from data selection through analysis, artifact, and delivery content.
- [x] 7.7 Persist accepted reusable recipes rather than sample data values.
- [x] 7.8 Add tests for multi-round chart revision, ambiguous acceptance, upstream invalidation, unrelated delivery changes, and restart recovery.

## 8. Agent automation configuration state machine

- [x] 8.1 Add intent routing for one-shot execution, durable automation, preview revision, and Skill authoring.
- [x] 8.2 Implement authoring transitions for collecting, resolving capabilities, compiling, reviewing, awaiting final confirmation, committing, verifying, and terminal/recoverable states.
- [x] 8.3 Deduplicate issues and recovery actions by task, phase, code, and affected scope.
- [x] 8.4 Implement readiness evaluation across trigger, pipeline completeness, capability availability, current reviews, validation, preview, delivery, and unresolved issues.
- [x] 8.5 Implement the immutable final confirmation snapshot with trigger, recipes, Skill/capability hashes, accepted reviews, risks, defaults, and authorization bounds.
- [x] 8.6 Bind natural-language final confirmation to the exact unexpired snapshot ID and rule hash.
- [x] 8.7 Implement exact create/update commit and reject stale drafts, reviews, Skills, capabilities, previews, and source revisions.
- [x] 8.8 Implement post-commit reload and verification of rule, enabled state, next occurrence, pipeline, recipes, Skill snapshots, and delivery policy.
- [x] 8.9 Make the latest configuration goal outcome authoritative over generic PI turn completion.
- [x] 8.10 Add state-machine tests for cancellation, needs-input, blocking, partial effects, retries, duplicate issues, stale confirmation, and false-success prevention.

## 9. Deterministic runtime and delivery behavior

- [x] 9.1 Update automatic occurrences to consume immutable compiled recipes and Skill snapshots without loading PI or authoring Skills.
- [x] 9.2 Persist per-step bounded input summaries, outputs, warnings, side effects, capability identity, duration, and privacy-safe errors.
- [x] 9.3 Implement `bot.sendConnected` resolution for one ready Bot, no ready Bot, both-ready explicit policy, and confirmed fallback order.
- [x] 9.4 Keep Message Center publication and Bot delivery as distinct auditable steps with partial-success semantics.
- [x] 9.5 Localize missing WeCLI, Bot, authentication, permission, and temporary service failures to dependent steps.
- [x] 9.6 Add runtime tests proving Skill updates do not alter existing rules and schema drift fails or pauses without silent redesign.
- [x] 9.7 Add restart, catch-up, idempotency, Message-Center-success/Bot-failure, and no-general-Agent execution tests.

## 10. Agent conversation and preview UI

- [x] 10.1 Replace unconditional active-chat `ConfigurationTaskCard` rendering with the canonical inline configuration interaction.
- [x] 10.2 Render concise stage messages, natural-language questions, preview links, recovery choices, and collapsed technical details.
- [x] 10.3 Open report links in the existing safe artifact viewer rather than a configuration table or confirmation modal.
- [x] 10.4 Keep exact final rule authorization visually distinct from intermediate preview acceptance.
- [x] 10.5 Update conclusion formatting so blocked, needs-input, awaiting-confirmation, partial, failed, and verified-complete states cannot contradict the configuration task.
- [x] 10.6 Add renderer tests for review loops, inline blockers, no duplicate recovery actions, no large diagnostic card, and no false success.

## 11. Skill Center Settings and conversational authoring

- [x] 11.1 Add local Skill Center routes for list, inspect, import, export, create draft, validate, install, enable, disable, version activation, usage references, and guarded deletion.
- [x] 11.2 Add the Settings Skill Center with built-in/personal filtering, search, compatibility, permissions, source, versions, and automation references.
- [x] 11.3 Add local folder and ZIP import UX with validation and exact-install confirmation.
- [x] 11.4 Add personal Skill creation/editing UX with draft preview, version creation, testing, export, rollback, and deletion.
- [x] 11.5 Implement conversational “save this workflow as a Skill” draft creation from a successful pipeline.
- [x] 11.6 Strip mail bodies, credentials, tokens, temporary paths, call IDs, and sample values from conversational Skill drafts.
- [x] 11.7 Require exact installation confirmation and verify the installed personal Skill before reporting success.
- [x] 11.8 Add Settings and Agent integration tests for import, incompatibility, create-from-chat, revision, rollback, referenced deletion, and restart persistence.

## 12. Migration, reconciliation, and acceptance

- [x] 12.1 Add compatibility adapters so existing automation rules continue to read and execute unchanged.
- [x] 12.2 Migrate hard-coded automation-authoring and design prompt content to built-in packages and prove prompt/output parity before removing old modules.
- [x] 12.3 Reconcile persisted configuration tasks by deduplicating issues and marking tasks superseded by verified later rules without losing audit history.
- [x] 12.4 Add feature flags and rollback paths for dynamic Skill loading, new capability discovery, inline interaction, and new authoring sessions.
- [x] 12.5 Add an acceptance fixture with bank telemarketing conversation-analysis alerts and execution-report mail for a complete calendar day.
- [x] 12.6 Add E2E acceptance for one-shot “organize today and send an image” with preview revision and no rule creation.
- [x] 12.7 Add E2E acceptance for daily 21:00 collection, analysis, line-chart HTML preview revision, Message Center publication, connected-Bot delivery, final confirmation, commit, and verification.
- [x] 12.8 Add E2E acceptance for no Bot, both Bots, missing optional WeCLI, stale review, declined final confirmation, and partial delivery.
- [x] 12.9 Run shared, server, renderer, desktop typechecks; server and renderer suites; desktop build; and relevant Electron/E2E checks.
- [x] 12.10 Document the conflicting unfinished tasks in older Provider-facing automation and diagnostic-card changes as superseded by this change before implementation completion.
