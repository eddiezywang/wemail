## Why

WeMail can now author and execute immutable V2 automation pipelines through the Agent, but the foreground Automation Center still lists and edits only legacy V1 rules. Users therefore lack one trustworthy place to discover Agent-created rules, understand what they do, inspect partial failures, revise them through either conversation or structured controls, and adopt reusable built-in workflows such as “邮箱速览”.

This change closes that product gap without introducing a second automation runtime: user-facing templates compile into the existing pipeline draft and confirmed-rule model, while the Automation Center becomes the unified management and run-observability surface for both legacy and pipeline rules.

## What Changes

- Add one unified Automation Center read model and API projection for V1 compatibility rules and V2 pipeline rules.
- Reshape the existing list/detail page into a management surface with installed automations, recommended templates, health, next occurrence, latest output, configuration, and run history.
- Add a declarative, local built-in automation-template registry. Templates provide localized metadata, configuration/UI schemas, a pipeline blueprint, result schema, renderer identity, and default trigger/delivery suggestions; they never execute outside the existing pipeline runtime.
- Make Agent edits and structured editor changes operate on the same versioned pipeline draft, preview, review, exact-confirmation, commit, and verification lifecycle.
- Add detailed rule-run and step-run projections, including active progress, frozen occurrence metadata, bounded input/output summaries, model usage, artifacts, delivery outcomes, warnings, and localized recovery actions.
- Add local-profile ownership and explicit current/selected/all-connected account scopes so a single automation result can safely reference mail across accounts.
- Add the first complete built-in template, “邮箱速览”, with deterministic subscription-signal selection, bounded semantic classification, grouping/deduplication, a dedicated structured result, renderer, provenance, and typed follow-up actions.
- Add explicit template-version binding and upgrade preview. Existing rules do not silently adopt template, Skill, capability, recipe, or renderer changes.
- Preserve existing V1 execution and project legacy rules into the new center until users explicitly upgrade them.
- Keep raw prompts, Cron, model overrides, retention, and catch-up controls under advanced settings rather than making internal configuration the primary user experience.

## Capabilities

### New Capabilities

- `unified-automation-center`: Unified list, detail, configuration, lifecycle, template discovery, and legacy/V2 management behavior for the foreground Automation Center.
- `automation-template-registry`: Declarative local built-in and personal automation templates that compile into the canonical pipeline draft without creating another executor or scheduler.
- `automation-run-observability`: Rule-run and step-run summaries, live stage progress, result previews, partial-success semantics, retention, retry, and privacy-safe diagnostics.
- `cross-account-automation`: Local-profile ownership, explicit multi-account scope, frozen cross-account manifests, and account-qualified source links.
- `subscription-insight-automation`: The “邮箱速览” template, selection and grouping behavior, dedicated result contract and renderer, notification policy, provenance, and typed actions.

### Modified Capabilities

- `pi-agent-runtime`: Agent-created and Agent-revised automations must use the same canonical draft and verified version lifecycle as structured foreground edits, and their authoritative state must be visible in the unified center.
- `retention-logger-cleanup`: Automation run detail, generated artifacts, input manifests, and archived-rule history require explicit local retention behavior without copying mail bodies into logs.

## Impact

- Renderer: the existing Automation Center, rule editor, application-message/artifact viewer, Agent handoff, navigation state, queries, and localized copy.
- Shared contracts: unified rule summaries/details, template manifests, local-profile/account scopes, run/step projections, result envelopes, account-qualified references, and typed actions.
- Local API: unified list/detail endpoints, template catalog, draft/edit operations, run detail and retry endpoints, active progress, template upgrade preview, and cross-account source navigation.
- SQLite: template metadata, rule ownership/scope, template binding, frozen run manifests, structured results, action candidates, retention metadata, and compatibility indexes/migrations.
- Runtime: adapters for legacy V1 projection, existing V2 pipeline execution, cross-account collection, immutable occurrence inputs, result validation/rendering, and step-localized partial failure.
- Product packages: a built-in “邮箱速览” template and dedicated renderer/result contract; existing `MailDigestService` and single-mail summary behavior remain unchanged.
- Testing: migration, V1/V2 coexistence, Agent/manual draft parity, cross-account isolation, restart/idempotency, content-quality fixtures, partial delivery, accessibility, renderer, and Electron E2E coverage.
