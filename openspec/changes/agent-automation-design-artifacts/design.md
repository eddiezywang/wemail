## Context

The active `unify-automation-application-messages` change established the correct base direction: one automation aggregate, canonical preview snapshots, bounded collection scopes, calendar schedules, collection processors, persistent application messages, and no PI participation in individual confirmed runs. The current implementation already contains `mailReceived` and `scheduled` triggers, deferred execution persistence, rule preview hashes, Agent proposal confirmation, collection processors, an application-message repository and UI, `wecli.operation`, and audited shell-free WeCLI spawning.

The remaining seams are still closed and coupled:

- `AutomationAction` is a fixed union and `AutomationActionExecutor` contains adapter-specific branches.
- `runCollectionRule()` directly knows about digest and invoice processors and constructs application-message presentation blocks itself.
- `wecli.operation` accepts static string args, so mail fields, selected attachments, processor datasets, and prior outputs cannot be bound safely at execution time.
- `AutomationCapabilityRegistry` is a static catalog rather than a provider registry with input/output schemas and execution contracts.
- Agent tool schemas allow generic action objects but do not give PI a discoverable canonical action schema, which makes unsupported action invention likely.
- Application messages render safe structured blocks but cannot reference a complete designed HTML report or chart dashboard.

This change extends those foundations. It does not introduce a separate scheduled-task engine, a second Agent runtime, arbitrary scripts, or unrestricted browser content.

## Goals / Non-Goals

**Goals:**

- Let Agent chat configure durable mail-received and scheduled workflows by discovering real capabilities and compiling exact rule snapshots.
- Allow WeCLI and later providers to add capabilities without one hard-coded WeMail action type per business command.
- Support ordered multi-step workflows whose later steps consume typed outputs from earlier steps.
- Recover eligible local scheduled work after application downtime without unbounded backlog or duplicate execution.
- Turn mail-derived datasets into consistent, accessible, provenance-backed HTML reports, dashboards, briefs, or decks.
- Deliver a lightweight persistent application message that opens the complete artifact inside an isolated WeMail viewer.
- Keep execution account-scoped, bounded, explainable, previewable, auditable, and fail-closed.

**Non-Goals:**

- Cloud-hosted always-on scheduling while the desktop application is closed.
- Arbitrary shell, PowerShell, JavaScript, Python, HTTP webhook, or user-supplied executable actions.
- DAG execution, parallel branches, implicit Cartesian products, or a general expression language in the first version.
- Starting PI or another general-purpose Agent for each automatic run.
- Allowing model-generated JavaScript, remote CDN dependencies, remote fonts/images, popups, forms, top navigation, Node integration, Electron IPC, or unrestricted network access in artifacts.
- Importing the complete Open Design or Open Slide platforms, their project workspaces, or their agent runtimes.
- Replacing safe structured application-message blocks for messages that do not need a full artifact.

## Architecture

```text
Agent conversation
  -> automation capability discovery
  -> V2 rule compilation
  -> static validation
  -> sample dry-run
  -> bounded repair
  -> exact confirmation snapshot
  -> durable rule version + runtime state

mail event / scheduler / restart recovery
  -> immutable run context and occurrence key
  -> sequential provider pipeline
  -> typed datasets and references
  -> deterministic Design Provider render
  -> Message Artifact store
  -> application-message publish
  -> lightweight list item
  -> isolated complete HTML viewer
```

The system is split into six independently testable boundaries:

1. **Automation authoring:** natural-language understanding, capability discovery, rule compilation, preview, repair, and confirmation.
2. **Rule and schedule runtime:** durable rule versions, runtime state, trigger claiming, catch-up, and pipeline orchestration.
3. **Provider registry:** capability discovery, schemas, compilation, validation, preview, execution, fingerprints, risk, and compatibility.
4. **Design generation:** sample-time DesignRecipe compilation and deterministic run-time rendering from typed datasets.
5. **Artifact store:** immutable account-scoped bundles, hashes, provenance, validation, retention, and safe read APIs.
6. **Delivery and viewing:** application-message summaries, desktop projection, deep links, and isolated complete artifact rendering.

## Decisions

### 1. Extend the existing automation aggregate with a V2 pipeline

Newly authored rules use `schemaVersion: 2` and replace the split `processing.processors[]` plus `actions[]` representation with one ordered `pipeline[]`. Existing V1 rules remain readable and executable through a compatibility compiler. Editing a V1 rule produces a V2 preview and confirmed revision; there is no bulk forced migration.

Conceptually:

```ts
interface AutomationRuleV2 {
  schemaVersion: 2;
  id: string;
  version: number;
  accountId: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: AutomationTriggerV2;
  match?: AutomationMatchSpec;
  collection?: AutomationCollectionSpec;
  pipeline: AutomationPipelineStep[];
  authorization: AutomationAuthorization;
  capabilitySnapshots: CapabilitySnapshot[];
  createdAt: string;
  updatedAt: string;
}
```

The pipeline is sequential. A step may depend only on the trigger, collection, run metadata, literals, or earlier step outputs. The first version has no branches or parallelism. `onError.policy` is `stop` or `continue`; retries are attempted only when both the provider and concrete error declare them safe.

### 2. Store rule configuration separately from mutable schedule state

Schedule cursors do not live inside the immutable confirmed rule version. A separate runtime-state record stores `lastScheduledAt`, `lastStartedAt`, `lastCompletedAt`, `nextRunAt`, consecutive failures, and a pause reason. This prevents scheduler progress from changing the confirmed rule hash and makes restart recovery explicit.

Scheduled rules default to:

```ts
misfirePolicy: {
  type: "catchUpLatest";
  maxAgeHours: 72;
}
```

At startup, the scheduler claims at most the latest eligible missed occurrence. It does not enqueue one run for every missed interval. A run delayed by application downtime records `delayed: true` and the original `scheduledAt`. If the latest missed occurrence is older than the configured maximum, the scheduler advances the cursor and publishes or records a safe warning instead of processing stale data.

`previousScheduleWindow` uses planned schedule boundaries, not application restart time. This prevents data gaps and duplicate windows when a daily report runs late.

Occurrence keys include the rule revision:

```text
scheduled:{ruleId}:{ruleVersion}:{scheduledOccurrence}
mailReceived:{ruleId}:{ruleVersion}:{emailId}:{dueAt}
```

### 3. Introduce a dynamic Action Provider Registry

The static capability catalog becomes the compatibility and built-in seed for a provider registry. Each provider exposes discoverable descriptors and one lifecycle:

```ts
interface AutomationProvider {
  id: string;
  version: string;
  discover(query?: CapabilityDiscoveryQuery): Promise<AutomationCapabilityDescriptor[]>;
  compile(capability: AutomationCapabilityDescriptor, step: AutomationPipelineStep): Promise<CompiledAutomationStep>;
  validate(step: CompiledAutomationStep, context: AutomationValidationContext): Promise<AutomationValidationResult>;
  preview(step: CompiledAutomationStep, context: AutomationPreviewContext): Promise<AutomationStepPreview>;
  execute(step: CompiledAutomationStep, context: AutomationExecutionContext): Promise<AutomationStepResult>;
  checkCompatibility(snapshot: CapabilitySnapshot, current: AutomationCapabilityDescriptor): CapabilityCompatibility;
}
```

Descriptors carry stable provider/capability IDs, input and output schemas, risk, side effects, preview support, idempotency support, discovery confidence, version, and fingerprint. The initial providers are `mail`, `processor`, `wecli`, `design`, and `application-message`; `artifact-store` is an internal service/provider boundary. HTTP and generic local-script providers are reserved but disabled.

### 4. Use typed automation values and structured bindings

Pipeline steps exchange allowlisted typed values rather than arbitrary process-local objects or strings. Initial value kinds include scalar values, mail references, mail collections, attachment references, attachment collections, datasets, artifact references, and external-operation results. Large datasets are persisted as blob/artifact references instead of being copied into run rows.

Bindings are structured:

```ts
type BindingExpression =
  | { type: "literal"; value: unknown }
  | {
      type: "path";
      from: "trigger" | "collection" | "step" | "run";
      stepId?: string;
      path: string;
    }
  | { type: "coalesce"; values: BindingExpression[] };
```

`${attachments}` and similar free-form interpolation are invalid. Selection, filtering, mapping, and aggregation belong in registered processor/mail capabilities rather than an embedded expression language.

Collection expansion is explicit:

- `single`: the binding resolves to one value and the provider runs once.
- `all`: the complete collection is passed once.
- `each`: the provider runs once per item.

Only one independently expanded `each` collection is permitted in a step. If paired values are required, an earlier step must emit an explicit array of pair objects. This prevents accidental Cartesian products.

### 5. Make WeCLI discovery generic but execution constrained

The WeCLI Provider locates the binary, reads its version, discovers relevant command paths through structured help or restricted `--help` calls, normalizes arguments into a descriptor, classifies risk, and computes a fingerprint. A command such as `allowance upload` may produce capability ID `wecli/allowance.upload`, but that ID is derived from discovery rather than compiled into WeMail source code.

The stored template contains a command path, literal argv fragments, typed slots, required flags, expansion rules, schemas, risk, and fingerprint. It never contains a shell script. Execution remains `spawn(binary, argv, { shell: false })` through the audited `WecliSkillRuntime`.

If structured help is available, discovery confidence is `declared`. Plain-help parsing produces `inferred` confidence. Inferred destructive capabilities are unavailable for automatic execution in the first version; inferred mutation capabilities require an exact preview of resolved argv and fail closed when parsing is ambiguous.

Attachment bindings remain `AttachmentReference` values in rules. Immediately before execution, the provider validates account ownership, existence, size, MIME type, optional hash, and authorization limits, materializes files into a run-scoped application directory, passes only those paths as argv, and cleans the directory after execution. Startup cleanup removes abandoned expired run directories.

### 6. Fingerprint authorization and pause on material drift

Confirmation authorizes exact provider capabilities, fingerprints, risk levels, binding sources, and configured limits. It does not authorize all future commands from a provider.

Compatibility behavior is:

- Identical descriptor: execute normally.
- Label, description, or other non-semantic metadata change: execute and refresh cached metadata.
- Added optional input: compatible execution.
- Removed/renamed input, changed type, changed command path, missing provider, or missing command: pause the rule.
- Risk increase or provider identity change: pause and require preview plus reconfirmation.

Paused rules produce an account-scoped warning message or run status explaining that no side effect occurred.

### 7. PI is a rule author, not a run-time worker

The internal `wemail-automation-authoring` skill instructs PI to:

1. Resolve the user's trigger, timing, timezone, data range, condition, processing goal, delivery, and risk intent.
2. Query `discover_automation_capabilities` rather than invent action types.
3. Compile a complete V2 draft using discovered schemas.
4. Call `preview_automation_rule` for static validation and sample dry-run.
5. Repair structured validation failures at most twice, never repeating the same invalid payload or deleting a core user requirement to make validation pass.
6. Render one confirmation card from the canonical preview.
7. Call `propose_automation_rule_change` with `previewId` and `ruleHash` only.

The preview snapshot stores the compiled rule, provider snapshots, sample window/mail references, per-step plan, resolved input summaries, warnings, repair history, source revision, hash, and expiry. Confirmation commits exactly the snapshot. PI cannot retransmit a materially different rule after the user has reviewed it.

The confirmation card shows rule state, trigger and restart catch-up, collection scope and limits, ordered steps, sample results, planned external side effects, capability risks, and warnings. Defaults such as 09:00, the system timezone, or the 72-hour catch-up window are visually disclosed rather than silently assumed.

### 8. Compile design once and render current data deterministically

The `design` provider exposes `design.brief`, `design.report`, `design.dashboard`, and `design.deck`. The internal `wemail-design` skill runs during rule preview/configuration against a sample Dataset and produces a reusable declarative `DesignRecipe`. Automatic executions load the confirmed recipe and bind the current Dataset through a trusted deterministic renderer; they do not start a general-purpose Agent to write new code on every run.

This creates visual consistency, keeps automatic execution bounded, and ensures that the previewed structure matches production. A future explicitly confirmed `regenerate` mode may be added later, but it is not part of this change.

Mode selection rules are:

- `brief`: one main conclusion, up to a small number of metrics, warnings, and execution results.
- `report`: default for narrative, multi-section, variable-length, vertically scrolling analysis.
- `dashboard`: stable schemas with repeated KPI, trend, distribution, comparison, and filtering needs.
- `deck`: explicit presentation, slides, PPT, meeting, or fullscreen intent; not selected merely because charts exist.

### 9. Keep the design skill concise and progressively disclosed

The internal skill is structured as:

```text
wemail-design/
  SKILL.md
  references/
    mode-selection.md
    information-hierarchy.md
    chart-selection.md
    report-layouts.md
    dashboard-layouts.md
    deck-layouts.md
    accessibility.md
    artifact-security.md
    quality-checklist.md
  assets/
    recipes/*.json
    themes/*.json
  scripts/
    validate-design-recipe.mjs
```

`SKILL.md` contains only the core workflow and routing to references. Layout catalogs, chart rules, security details, and quality rubrics are loaded only when relevant. Deterministic recipe validation is implemented as a script/service. Trusted runtime JavaScript is application-owned and is not a model-editable skill asset.

The skill borrows patterns, not platform code, from market projects: Open Design's separation of design system, craft rules, templates, and artifacts; Open Slide's deck canvas, navigation, overflow, and presentation quality rules; HTML-slide skills' self-contained delivery and chart storytelling. The internal product capability remains named `wemail-design`, not `rich-*`.

### 10. Use an internal DesignRecipe and ChartSpec, not library-native JavaScript

A DesignRecipe declares kind, title bindings, design system, token overrides, narrative structure, sections, components, notification summary, runtime capabilities, security policy, and quality requirements. Components come from an allowlist such as heading, paragraph, metric, metric grid, chart, table, callout, timeline, mail references, attachment references, and divider.

ChartSpec is also declarative. Initial types are line, area, bar, stacked bar, donut, scatter, and heatmap. It declares dataset source, fields, aggregation, sorting, limit, orientation, legend, value labels, and number formatting. It cannot contain formatter functions, click handlers, arbitrary tooltips, or arbitrary library configuration.

The renderer may initially use one bundled chart library, but persisted artifacts depend on WeMail ChartSpec rather than that library's public API. This keeps storage stable if the underlying chart implementation changes.

Design validation requires:

- Every metric, chart, table, and conclusion is derived from existing Dataset fields or declared aggregation.
- Provenance links outputs to processor steps, mail IDs, and attachment IDs where applicable.
- Missing data is disclosed rather than invented.
- Empty datasets render a meaningful empty state.
- Partial processor failure is visible without discarding valid results.
- Key conclusions appear early, charts are non-duplicative, and report/deck overflow constraints pass.
- Text contrast, keyboard operation, chart summaries, non-color status cues, and reduced-motion behavior pass.

### 11. Persist immutable Message Artifact bundles

A formal artifact contains:

```text
manifest.json
index.html
styles.css
data.json
charts.json
provenance.json
assets/*
```

The exact physical storage may use files plus database metadata, but consumers receive only an `ArtifactReference` containing artifact ID, version, content hash, and kind. Rules and messages never receive an unrestricted filesystem path.

The manifest includes kind, title, preview, recipe ID/version, design-system ID, resource list, requested trusted runtime capabilities, source rule/run IDs, creation time, and content hash. Formal run artifacts are immutable. Updating a rule or recipe affects future runs only; historical messages retain their original artifacts.

Preview artifacts are short-lived and visibly marked. Formal artifacts remain while referenced by retained application messages. Dataset size, artifact size, asset count, chart count, and source-reference count are bounded.

### 12. Keep message-list delivery lightweight

`application-message.publish` accepts either the existing safe content blocks, a validated artifact reference, or both. When an artifact is supplied, the provider derives a bounded title, preview, severity, key metrics, source references, and a typed `openArtifact` interaction from the manifest. The list API does not return the complete HTML bundle.

Formal artifacts are durable user results, not transient chat formatting. Therefore a successful one-shot Agent pipeline automatically ensures one application message exists for every distinct formal artifact even when the authored pipeline omitted an explicit delivery step. If a delivery step already published the artifact, the Agent reuses that message rather than creating a duplicate. The tool result exposes bounded artifact and application-message metadata, the WeMail Agent protocol persists it as an artifact message part, and the conversation renders a card that opens the same isolated viewer. Markdown and HTML code fences are never promoted into executable artifacts by inference.

The message-center list shows title, short preview, time, unread state, severity, delayed-catch-up status when relevant, and a small bounded set of key metrics. Selecting the item marks it read and opens the existing structured detail or the Artifact Viewer. Desktop notifications continue to be a projection of the persisted message and contain only an allowlisted title/preview; selecting one deep-links to the persisted message, never directly executes a risky action.

### 13. Render complete artifacts in an isolated viewer

The desktop viewer is an in-workbench browser surface optimized for reading, dashboard interaction, and deck presentation. The initial implementation should reuse the product's existing sandboxed iframe experience and only introduce an Electron `WebContentsView` if profiling or isolation requirements cannot be met safely with the iframe. A `webview` tag is not used.

The viewer provides loading, invalid/expired artifact, unavailable source reference, print/export where supported, open rule, and open referenced-mail states. Report and dashboard artifacts scroll vertically. Deck artifacts use a fixed 16:9 stage, keyboard navigation, fullscreen mode, page count, reduced-motion support, and strict overflow validation.

The renderer may inject only trusted, versioned local runtime modules explicitly requested by the manifest: charts, collapse, filter, table sort, copy value, or deck navigation. Artifact-authored scripts never run.

### 14. Enforce an artifact security boundary independent of mail HTML

Message Artifact HTML is generated from structured data and a confirmed DesignRecipe. Raw sender HTML is never copied into the artifact. Mail bodies and attachment-extracted text are treated as data and escaped before rendering.

Before persistence and before serving, the artifact pipeline enforces:

- HTML element and attribute allowlists.
- Removal of scripts, inline event handlers, forms, iframes, object/embed, unsafe SVG features, executable URLs, and unsupported elements.
- CSS property/value validation and size limits.
- No remote images, fonts, stylesheets, scripts, frames, media, fetch/XHR, WebSocket, service workers, or navigation.
- A restrictive Content Security Policy with `default-src 'none'`; only approved local/data/blob resources and nonce/hash-bound trusted runtime are allowed as required.
- An opaque-origin iframe without `allow-same-origin`, popup, form, download, or top-navigation permissions unless a future reviewed export surface explicitly requires one.
- Host message handlers verify the exact iframe window and accept only typed allowlisted events such as open a referenced mail or request a bounded filter operation.
- No Node integration, preload bridge, Electron IPC, clipboard write, filesystem access, shell open, or permission prompts inside the artifact.

Sanitized sender HTML and artifact HTML use separate builders and policies. An email iframe cannot be promoted into a Message Artifact.

### 15. Standardize provider execution, errors, audit, and retry safety

Each step persists provider/capability/fingerprint, start/end time, status, bounded input summary, output reference, warnings, side-effect records, external audit ID where applicable, and a privacy-safe error. Standard error codes distinguish unavailable provider/capability, capability drift, invalid input, expired authorization, unavailable resource, authentication, permission, timeout, and execution failure.

Automatic retry requires all of:

- The error is retryable.
- The provider says repeating the concrete operation is safe.
- The capability has native or keyed idempotency, or the provider proves no side effect occurred.
- The step's confirmed retry limit has not been reached.

External upload defaults to no blind retry. `onError: continue` permits later independent steps to run, but bindings to a failed step become unavailable and dependent steps are skipped or fail according to validation; the runtime does not fabricate fallback values.

### 16. Add canonical APIs and Agent tools without exposing implementation details

Representative service/API surfaces are:

```text
GET  /api/automation/capabilities
POST /api/automation/capabilities/refresh
POST /api/automation/previews
POST /api/automation/rules
GET  /api/automation/runs/:id
GET  /api/automation/runs/:id/steps

GET  /api/application-messages
GET  /api/application-messages/:id
GET  /api/artifacts/:id/manifest
GET  /api/artifacts/:id/content/:resource
```

Artifact resource routes verify the active account, message/reference ownership or another authorized context, artifact version, resource manifest, content hash, and safe content type. They do not offer directory listing or arbitrary relative-path reads.

PI receives `discover_automation_capabilities`, the upgraded `preview_automation_rule`, existing rule list/proposal tools, and read-only run explanation surfaces. Provider execution and artifact mutation tools remain internal and are not projected through public MCP.

### 17. Persist versioned rule, run, provider, and artifact records

The target data model adds or evolves records equivalent to:

```text
automation_rules
automation_rule_versions
automation_rule_runtime_state
automation_preview_snapshots
automation_runs
automation_step_runs
automation_capability_snapshots
automation_provider_cache
message_artifacts
message_artifact_resources
application_messages.artifact_id / artifact_version
```

Rule versions and formal artifacts are immutable. Runtime state, provider cache, read/archive state, and retention metadata are mutable. Database rows store bounded metadata and JSON contracts; large resource bytes use the existing application data/workspace storage patterns with account and path policy enforcement.

### 18. Preserve privacy and make diagnostics useful

Default logs and telemetry contain IDs, counts, sizes, durations, status, error codes, capability IDs, fingerprints, and hashes. They do not contain mail bodies, attachment content, full datasets, generated HTML, credentials, temporary file paths, or raw WeCLI stdout when it may contain business data. Full user-visible results live only in account-scoped stores.

Run history explains schedule claim, delayed catch-up, candidate and match counts, truncation, per-step outcomes, artifact/message IDs, capability drift, authentication failures, and skipped dependencies. The Agent can explain this history in user-facing language without re-running side effects.

## Data Flow Examples

### Mail-received invoice upload

```text
mailReceived
  -> production matcher: invoice mail + PDF attachment
  -> mail.attachments.select
  -> wecli/allowance.upload with files=previousStep.attachments and expansion=all
  -> application-message.publish execution result
```

The saved rule contains no attachment paths and no free-form command string. The WeCLI capability must have been discovered, previewed, fingerprinted, and confirmed.

### Daily mail aggregation and chart report

```text
scheduled daily 09:00 Asia/Shanghai
  -> previousScheduleWindow
  -> production matcher
  -> processor.mail-digest or domain-specific extraction
  -> processor.dataset-normalize
  -> design.report/dashboard using confirmed DesignRecipe
  -> artifact-store persistence
  -> application-message.publish
  -> optional privacy-safe desktop notification
  -> isolated viewer on selection
```

If the application was closed at 09:00, a launch at 11:00 claims the 09:00 occurrence, uses the planned previous-to-current schedule window, marks the run delayed, and advances to the next recurrence without creating separate runs for every missed tick.

## Risks / Trade-offs

- **Provider discovery from human-oriented Help may be ambiguous.** Use confidence levels, schema validation, exact argv preview, conservative risk classification, and fail closed for unclear destructive operations.
- **A general pipeline increases contract surface.** Keep the first version sequential, use a small typed value algebra, forbid arbitrary expressions, and require provider schemas.
- **Design output could become nondeterministic or expensive.** Compile DesignRecipe during preview and use deterministic rendering for automatic runs.
- **HTML artifacts increase attack surface.** Keep raw mail HTML out, disallow artifact-authored scripts and network access, sanitize twice, use strict CSP and opaque-origin isolation, and expose only typed host events.
- **Artifacts and datasets can consume local storage.** Bound resource sizes, retain formal artifacts only with retained messages or supported protected state, expire previews, and schedule cleanup.
- **Capability drift can interrupt useful automations.** Distinguish compatible metadata/optional-input changes from material schema, identity, and risk changes; explain pauses clearly and offer Agent-assisted re-preview.
- **Local scheduling cannot run while the application is closed.** Make this explicit in confirmation, persist schedule state, catch up the latest eligible occurrence, and label delayed results.
- **V1 and V2 behavior may diverge during migration.** Compile V1 rules through adapters into the same execution primitives where possible and add parity fixtures before routing production execution.

## Migration Plan

1. Add V2 shared contracts, provider interfaces, typed values, bindings, and compatibility compilation without changing active V1 execution.
2. Wrap existing mail actions, collection processors, application-message publication, and `wecli.operation` behind built-in providers; run parity tests against existing behavior.
3. Add provider discovery, capability snapshots, structured validation errors, and Agent discovery while keeping V2 rule creation behind a feature flag.
4. Add durable runtime-state separation and restart catch-up for new V2 scheduled rules; preserve legacy schedule normalization.
5. Add sequential pipeline execution and step-run audit, then enable V2 rules for internal scenarios.
6. Add `wemail-design`, recipe compilation, deterministic rendering, artifact storage, and preview artifacts with no message-center exposure.
7. Add artifact references to application messages, resource APIs, and the isolated viewer behind a separate feature flag.
8. Add Agent confirmation cards and end-to-end conversational creation for invoice upload and scheduled chart-report scenarios.
9. Enable V2 authoring by default. Existing V1 rules continue to run; editing upgrades them through a confirmed preview.
10. Remove adapter-specific execution branches only after parity, migration, rollback, and live scenario gates pass.

Rollback disables V2 creation and execution, Design Provider publication, and artifact viewing while leaving V1 rules, structured application messages, stored rule versions, artifacts, and audit rows intact. Formal artifacts are not deleted during rollback.

## Verification Strategy

- Contract tests for schemas, binding paths, collection expansion, capability fingerprints, authorization limits, and V1 compatibility.
- Provider tests for discovery, declared/inferred confidence, compile/validate/preview/execute behavior, drift, unavailable capabilities, and retry safety.
- Scheduler tests for restart catch-up, 72-hour expiry, occurrence idempotency, planned windows, DST, interval anchors, and concurrent claims.
- Agent tool and live scenario tests for discovery-before-use, unsupported capability refusal, two repair attempts, exact preview confirmation, stale previews, and no duplicate rule creation.
- Design tests for mode selection, recipe validation, chart selection, no fabricated fields, provenance, empty states, partial failure, accessibility, report overflow, and deck overflow.
- Security tests with scripts, event handlers, remote beacons, dangerous URLs, CSS escapes, SVG payloads, frames, forms, navigation attempts, host-message spoofing, and cross-account artifact access.
- Renderer component tests for message summaries, loading/error states, keyboard navigation, reduced motion, deep links, unavailable references, and unread/archive behavior.
- End-to-end browser and desktop scenarios for a daily scheduled report, restart catch-up, complete HTML opening, artifact isolation, and an invoice upload rule discovered from WeCLI help.

## Open Questions

None. The design review selected local durable scheduling with latest eligible catch-up, sequential pipelines, explicit collection expansion, dynamic Provider discovery, exact preview confirmation, a separate `wemail-design` skill, deterministic run-time rendering, lightweight message summaries, and isolated complete HTML viewing.
