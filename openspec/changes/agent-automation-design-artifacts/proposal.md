## Why

WeMail now has the foundations for Agent-confirmed automation rules, mail-received and scheduled triggers, bounded collection processing, persistent application messages, and audited WeCLI execution. The remaining gap is that automation actions are still represented by a closed union and executed through hard-coded branches. This caused the Agent to invent an unsupported `wecliCommand` action even though the requested WeCLI operation could have been discovered and represented as a reusable command template.

The same limitation blocks a broader user workflow: collecting information from mail on a schedule, turning it into charts or a designed report, publishing a concise notification, and opening the complete HTML result inside WeMail. Implementing each WeCLI command, processor, chart report, and delivery target as a new special case would make the automation system progressively less flexible and harder to keep capability-identical across Agent, UI, REST, preview, and execution.

## What Changes

- Upgrade newly authored automation rules to a versioned, sequential pipeline whose steps call capabilities from a dynamic Action Provider Registry.
- Add typed step outputs and structured bindings for trigger data, mail collections, attachments, processor datasets, prior step outputs, and run metadata. Raw `${...}` string interpolation and arbitrary shell command strings are not valid bindings.
- Add generic WeCLI capability discovery that turns command help/schema into safe argv templates, input schemas, risk metadata, and fingerprints without hard-coding each WeCLI business command in WeMail.
- Add durable schedule runtime state and a local restart recovery policy. When WeMail was closed at the due time, the scheduler catches up only the latest eligible occurrence, up to 72 hours by default, with idempotent occurrence keys and an explicit delayed-run marker.
- Add an internal `wemail-automation-authoring` skill and capability-discovery tool flow so PI discovers, compiles, previews, repairs, and proposes the exact normalized rule snapshot instead of guessing action schemas.
- Add an internal `wemail-design` skill and Design Provider. During configuration/preview it compiles a reusable declarative `DesignRecipe`; during automatic execution a trusted deterministic renderer binds the latest dataset and creates a `brief`, `report`, `dashboard`, or `deck` artifact.
- Add a versioned Message Artifact store for manifests, sanitized HTML/CSS, data snapshots, chart specifications, provenance, and local assets. Model-generated arbitrary JavaScript, remote active resources, Electron/Node access, and unrestricted navigation remain prohibited.
- Extend application messages so their list item remains lightweight while an optional artifact reference opens a complete isolated HTML viewer with built-in trusted chart, filtering, table, collapse, and deck-navigation runtime capabilities.
- Preserve existing V1 rules and structured application-message blocks through compatibility compilation. Editing a V1 rule through the Agent or settings upgrades it to the V2 pipeline after preview and confirmation.

## Capabilities

### New Capabilities

- `automation-provider-registry`: Discoverable, typed, fingerprinted, risk-aware providers and capability descriptors for mail, processors, WeCLI, design, application-message delivery, and future registered integrations.
- `automation-pipeline-runtime`: Versioned sequential automation pipelines, structured value bindings, collection expansion, durable scheduling, restart catch-up, step audit, idempotency, and capability-aware failure behavior.
- `design-artifact-generation`: The internal `wemail-design` skill, declarative DesignRecipe and ChartSpec contracts, deterministic trusted rendering, artifact validation, provenance, and the four output modes.
- `application-message-artifact-viewer`: Persistent Message Artifact references, safe artifact APIs, lightweight notification summaries, and isolated in-workbench HTML viewing.

### Modified Capabilities

- `agent-automation-configuration`: Replace closed action guessing with Provider discovery, two-level preview, bounded automatic repair, and confirmation of the exact compiled rule snapshot.
- `application-message-center`: Permit validated, locally stored Message Artifacts while continuing to reject unscoped arbitrary HTML and active remote content.
- `pi-agent-runtime`: Load the internal automation-authoring and design skills without exposing their internal mutation tools through public MCP.

## Impact

- Shared contracts under `shared/wemail/automation.ts`, `shared/wemail/applicationMessages.ts`, and new design/artifact contracts.
- Automation normalization, validation, preview snapshots, repositories, scheduling, pipeline execution, step run audit, compatibility adapters, and capability fingerprints under `server/wemail/automation`.
- A new provider layer for mail, processors, WeCLI, design, application messages, artifact storage, and later registered integrations.
- WeCLI runtime discovery and safe attachment materialization while retaining `spawn(..., { shell: false })`, confirmation, and audit boundaries.
- New internal skills and deterministic validators under `server/wemail/agent/skills` and `server/wemail/design`.
- Artifact persistence, APIs, cleanup, content hashing, and account-scoped access control.
- Agent tool schemas, prompts, error-repair behavior, confirmation presentation, and live scenario harnesses.
- Message-center list/detail UI, an isolated Artifact Viewer, trusted local rendering runtime, deep links, loading/error states, and accessibility behavior.
- Focused server, renderer, security, migration, Agent scenario, scheduling, and end-to-end tests.
