## Context

WeMail is a pure Electron client with a React renderer, local TypeScript API, SQLite persistence, a PI-based Agent, an existing V1 condition/action automation engine, and a newer V2 immutable sequential pipeline runtime. The completed local Skill Center and automation-authoring change established the canonical model:

```text
execution pipeline = data selection + analysis + artifact + delivery
one-shot task      = run the pipeline now
automation rule    = trigger + confirmed pipeline
```

The foreground Automation Center has already moved toward a list/detail management layout, but it still queries, edits, and renders only V1 rules. Agent authoring creates V2 rules through a versioned draft, preview/review, exact confirmation, commit, and verification path. Separate `/rules` and `/v2/rules` endpoints therefore expose a product split: work created successfully in chat is not guaranteed to be visible or manageable in the foreground center.

The existing collection UI also makes `mailDigest` and `invoiceReadinessAnalysis` look like the primary extensibility model. A separate handoff correctly identifies that a complete “邮箱速览” workflow needs its own bounded selection, grouping, result contract, renderer, provenance, and typed actions rather than another patch to `MailDigestService`.

The competitor reference is useful for its navigation hierarchy, installed/recommended grouping, detail metrics, run history, run-detail overlay, and contained editor. It is not a suitable runtime model: WeMail must not make raw prompts, Cron, model selection, or token consumption the primary automation abstraction.

Constraints:

- Electron and local SQLite remain the only product runtime and persistence model.
- No enterprise tenant, organization, cloud marketplace, or server-managed policy layer is introduced.
- Existing V1 rules continue to execute and remain recoverable.
- Templates, Skills, capabilities, recipes, providers, and rules must retain distinct responsibilities.
- Agent and structured editing must not create separate sources of truth.
- Existing mail bodies, credentials, and external-operation secrets must not leak into run traces or retained manifests.

## Goals / Non-Goals

**Goals:**

- Make every V1 and V2 rule visible through one foreground management model.
- Preserve one execution primitive: a template compiles to the existing canonical pipeline; it never owns a second executor or scheduler.
- Provide an intentional list/detail Automation Center with installed rules, recommended templates, rule health, latest output, configuration, and auditable runs.
- Make Agent edits and structured edits converge on one versioned pipeline draft and exact confirmation lifecycle.
- Add step-level run observability and localized partial-failure recovery without surfacing internal provider identities.
- Support local-profile-owned rules that explicitly select current, selected, or all connected accounts.
- Deliver “邮箱速览” as the first full built-in template with a dedicated result and renderer.
- Bind every confirmed rule to exact template, Skill, capability, recipe, and renderer versions and require previewed upgrades.
- Keep advanced controls available without making them the default mental model.

**Non-Goals:**

- Replacing the pipeline runtime with scenario-specific orchestration.
- A visual arbitrary DAG editor, unrestricted scripting, or user-authored executable code.
- A cloud template marketplace, team sharing, or organization administration.
- Silently converting every V1 rule to V2.
- Replacing single-mail summaries or changing `MailDigestService` behavior.
- Making raw Prompt text, Cron syntax, provider IDs, or token accounting the primary configuration surface.
- Automatically executing unsubscribe, destructive mail mutation, or external side effects from model output.

## Decisions

### 1. Templates are declarative pipeline blueprints, not a new runtime

The product-facing concept is `AutomationTemplateDefinition`, not an executable scenario service:

```ts
interface AutomationTemplateDefinition {
  schemaVersion: 1;
  id: string;
  version: string;
  scope: "builtin" | "personal";
  metadata: LocalizedTemplateMetadata;
  configurationSchema: JsonSchema;
  uiSchema: AutomationTemplateUiSchema;
  pipelineBlueprint: PipelineBlueprint;
  resultSchemaId: string;
  rendererId: string;
  defaultTrigger?: TriggerSuggestion;
  defaultDelivery?: DeliverySuggestion;
  contentHash: string;
}
```

Instantiating a template resolves defaults and user configuration into an `ExecutionPipelineDraft`. Compilation, review, confirmation, persistence, scheduling, and execution remain owned by existing services.

Alternative considered: register a dedicated executor per scenario. Rejected as the default because it creates a second orchestration model and makes composition, preview parity, and step audit inconsistent. A specialized capability may still implement bounded domain logic inside a normal pipeline step.

### 2. User terminology is template, automation, and run

The foreground UI uses only:

- template: a reusable starting point;
- automation: an enabled or disabled configured rule;
- run: one occurrence and its result.

“Skill”, “capability”, “recipe”, “provider”, “executor”, “snapshot”, and “renderer” are technical details shown only in collapsed advanced diagnostics where useful. “场景” may remain an internal product taxonomy but is not required for ordinary interaction.

### 3. One unified read projection fronts both rule schemas

Add a query service that projects V1 and V2 rules into `AutomationListItem` and `AutomationDetail` contracts. It performs a stable union without modifying stored rules. The projection supplies localized summaries, health, next occurrence, latest run, template binding, workflow stages, delivery destinations, and upgrade availability.

V1 details are derived from conditions, processing, and actions. V2 details are derived from the immutable trigger, recipes, pipeline, snapshots, and delivery plan. The renderer never switches on database rows or reconstructs provider semantics.

Alternative considered: teach the React components to call both endpoints and branch by schema version. Rejected because it duplicates compatibility logic in the UI and makes health, filtering, and future schema versions fragile.

### 4. Structured editing and Agent editing share one draft

“请 Agent 修改” and the structured configuration editor both create or resume the same `ExecutionPipelineDraft`. Every mutation uses optimistic revision checks. Structured controls write typed fields; Agent Skills produce the same typed fields. Both paths use the same validation, preview, review invalidation, exact confirmation snapshot, commit, and reload verification.

Legacy V1 rules can be toggled and run in place. A material edit first creates a V2 upgrade draft while the V1 rule remains active until confirmation.

Alternative considered: retain a direct V1 form for manual editing and V2 only for Agent work. Rejected because it preserves two products and makes one rule behave differently depending on entry point.

### 5. Keep the existing list/detail shell and add three detail views

The page remains nested inside WeMail’s global navigation:

```text
global navigation | automation list/templates | selected automation detail
```

The list contains the Agent creation entry, installed rules, and a bounded recommended-template section. The detail surface has:

1. 概览 — health, schedule, workflow rail, latest result, and recent runs;
2. 运行记录 — filterable run summaries and detail entry;
3. 配置 — structured current configuration and advanced settings.

On narrow windows, list and detail become a drill-in stack; run detail and editing use a full-height sheet rather than a desktop-sized modal squeezed into mobile width.

### 6. The workflow rail is the signature and authoritative progress component

The foreground representation is a quiet horizontal or vertical rail:

```text
触发 -> 数据 -> 分析 -> 产物 -> 投递
```

At rest it summarizes the confirmed workflow. During a run it projects current stage and completion. On failure it marks only the affected stage, states the user impact, and offers a localized recovery action. Provider names, tool-call IDs, and stack traces remain collapsed.

This replaces generic “four cards” as the primary structural device and gives the product one automation-specific visual identity.

### 7. Health is derived from authoritative rule and run state

The center uses a bounded health vocabulary:

```text
healthy
running
needs_attention
paused
disabled
never_run
```

The latest generic Agent turn status cannot override rule or run state. `needs_attention` includes partial delivery, unavailable required capability, stale authorization, repeated failure, or an unresolved uncertain side effect. A disabled rule with a failed historical run is displayed as disabled with the historical warning available, not “running”.

### 8. Runs have separate summary and detail projections

`AutomationRunSummary` is bounded for list rendering. `AutomationRunDetail` includes:

- planned occurrence, actual start/end, delay, status, and duration;
- frozen rule/template/pipeline/model identities;
- account and input counts, truncation, and missing-input warnings;
- per-step status, duration, bounded input/output summaries, warnings, and retry safety;
- generated result and artifact references;
- each delivery destination and outcome;
- resource/model usage where available;
- privacy-safe recovery actions and technical details.

Active progress is delivered through the existing local event/SSE pattern or short polling with stable run revision. The database remains authoritative after restart.

### 9. Local-profile ownership is explicit

Rules and application messages support:

```ts
type AutomationOwner =
  | { type: "account"; accountId: string }
  | { type: "localProfile"; profileId: "default" };

type AutomationAccountScope =
  | { type: "currentAccount"; accountId: string }
  | { type: "selectedAccounts"; accountIds: string[] }
  | { type: "allConnectedAccounts" };
```

Cross-account rules are owned by the local profile, not a fabricated account. Every mail or attachment reference carries `accountId` plus its object ID. Global application messages appear once in Message Center and can deep-link to the correct account.

The creation flow never silently expands current-account scope to all accounts. “All connected accounts” is disclosed in preview and exact confirmation.

### 10. Frozen manifests are reference-based and content-bound

At run claim time, the runtime resolves a bounded manifest with account fairness:

```ts
interface AutomationInputManifestItem {
  accountId: string;
  emailId: string;
  messageId?: string;
  receivedAt: string;
  contentHash: string;
  selectedReason: string[];
}
```

Retries reuse the same manifest. If a source is deleted or its content hash no longer matches, the step records an explicit missing/changed-input warning and applies the confirmed stop/partial policy. Run records do not duplicate mail bodies.

### 11. Results use a typed envelope and renderer registry

Every template output is wrapped in:

```ts
interface AutomationRunResultEnvelope<T> {
  resultType: string;
  schemaVersion: number;
  rendererId: string;
  rendererVersion: string;
  data: T;
  provenance: AutomationProvenance[];
  actionCandidates: AutomationActionCandidate[];
}
```

The renderer registry validates support for the exact result and renderer version. Unsupported or invalid output is never published as unstructured prose. Existing generic application-message blocks remain a compatibility renderer.

Alternative considered: store rendered HTML as the only result. Rejected because it loses semantic actions, localization, accessibility reconstruction, and future renderer upgrades.

### 12. Action candidates are discriminated and server-resolved

Template result schemas cannot emit arbitrary `target: Record<string, unknown>`. Each action type has a registered target schema. The model may recommend an action and cite source references; the server resolves a stable action candidate and applies the existing pending-action risk policy.

Opening source mail is read-only. Unsubscribe, muting, duplicate-delivery changes, destructive mail operations, and external mutations require the appropriate preview and confirmation. A missing verified target removes the action rather than guessing.

### 13. “邮箱速览” is a composed pipeline with one specialized analysis capability

The built-in `subscription-daily-insight` template compiles to:

```text
freeze schedule window and account scope
-> page candidate metadata fairly across accounts
-> extract deterministic list/bulk/platform/security signals
-> classify only ambiguous candidates
-> exclude private/business/spam/phishing/consumed-unchanged mail
-> group by message/thread/campaign/sender/link fingerprint
-> analyze bounded signal groups
-> validate SubscriptionInsightResult
-> render SubscriptionInsightView
-> publish Message Center result
-> notify only according to risk/action policy
```

The specialized capability accepts and returns typed bounded values; it does not query an independent rolling window or invoke `MailDigestService`.

The result separates localized UI labels from generated user-language content, retains complete provenance, and projects no more than four highlighted source links in the card.

### 14. Empty, truncated, partial, and urgent outcomes are distinct

- `empty`: successful run with no useful items; retained in history, not published or notified by default.
- `truncated`: successful or partial output with a visible coverage warning and exact scanned/selected counts.
- `partial`: useful result exists but an account, analysis group, renderer, or delivery destination failed.
- `failed`: no valid publishable result was produced.
- urgent security signals: separately create immediate attention work; the daily result may reference them but is not their only channel.

### 15. Advanced configuration is available but subordinate

Ordinary configuration exposes account scope, trigger/timezone, data preferences, output preferences, delivery, and preview. Advanced settings contain model policy, Cron, catch-up, retention, instruction override, limits, and template version.

Instruction overrides can refine the analysis recipe but cannot modify system safety, account scope, capability authorization, output schema, renderer contract, or delivery permission. The resolved model is frozen in each confirmed rule version even when policy says “follow global default”.

### 16. Version upgrades are explicit and reversible

Rules bind exact template ID/version/hash, renderer ID/version, Skills, capabilities, reviews, recipes, and compiled pipeline hash. A newer template appears as “可升级”. Upgrade creates a draft, shows semantic differences, regenerates affected previews, requires exact confirmation, and creates a new rule version.

The previous version remains available for rollback. An application update never silently changes existing automatic behavior.

### 17. Retention is local, bounded, and reference-aware

Recommended defaults:

- rule/run summary and immutable rule versions: retained while referenced;
- detailed step summaries, manifests, and generated artifacts: 30 days;
- archived rules: retained with history until explicit permanent deletion;
- mail bodies and credentials: never copied into run audit or template metadata;
- permanent deletion: blocked or warned while application messages, pending actions, or artifacts still reference the rule/run.

Retention configuration may later be exposed, but the first implementation uses one documented local default.

### 18. Rollout is additive and feature-flagged

The migration first adds contracts and projection tables, then the unified API, then foreground reads, templates, cross-account ownership, and “邮箱速览”. Rollback flags can restore the legacy center read path and hide template creation without deleting V2 rules, template bindings, or run data.

No V1 rule is rewritten during migration. Existing `mailDigest` rules remain compatible and are labeled as legacy/custom automations until explicitly upgraded.

## Risks / Trade-offs

- [A unified projection hides schema-specific detail] → Keep schema version and a bounded compatibility section in detail diagnostics while ensuring ordinary UI uses stable semantics.
- [Template becomes another name for Skill] → Template owns user configuration, UI schema, pipeline blueprint, and result renderer; Skill owns Agent reasoning and review only.
- [Cross-account scans increase latency and model cost] → Page fairly per account, prefilter deterministically, classify ambiguity only, group before analysis, expose truncation, and freeze bounded limits.
- [A run disappears after restart while the UI showed progress] → Persist every stage transition before emitting progress and reconstruct active state from SQLite.
- [Result renderer upgrade cannot display historical output] → Bind renderer version and retain compatible renderer implementations or a safe generic fallback.
- [Agent and form race on the same draft] → Require optimistic revisions, show a conflict summary, and never silently merge material recipe edits.
- [Advanced instruction override causes prompt injection] → Treat it as untrusted recipe input below fixed safety policy and validate output against a fixed result schema.
- [Recommended templates clutter the rule list] → Bound the initial section; move to a dedicated template view only when catalog size warrants it.
- [Retention breaks provenance] → Retain lightweight account-qualified references and hashes after detailed artifacts expire, and show “source no longer available” explicitly.
- [Typed actions create false confidence in unsafe model suggestions] → Re-resolve every target server-side and reuse pending-action confirmation for mutations.
- [Competitor-inspired UI becomes a visual clone] → Reuse the proven information hierarchy but use WeMail tokens, conversational editing, typed result previews, and the workflow rail as the distinctive interaction.

## Migration Plan

1. Add shared unified summary/detail, template, owner/scope, result-envelope, run-detail, and action-candidate contracts.
2. Add additive SQLite migrations for local-profile ownership, template bindings, frozen manifests, result envelopes, run revisions, and retention metadata.
3. Implement the V1/V2 projection service and unified read endpoints; keep existing endpoints unchanged.
4. Switch Automation Center reads to the unified projection behind a feature flag and verify V1 parity before exposing V2 management.
5. Add run-detail and active-progress APIs, then replace the shallow recent-run rows with stage-aware summaries and detail.
6. Route structured edits and Agent edits through the same draft/update/confirmation services; keep direct V1 toggle/run compatibility.
7. Add the local template registry and template-instantiation API; ship templates hidden until validation and migration tests pass.
8. Add local-profile ownership and cross-account source navigation, then enable selected/all-account scopes.
9. Implement and quality-evaluate the “邮箱速览” template, specialized selection/grouping capability, result validator, renderer, and typed actions.
10. Enable recommended templates and explicit upgrade preview in the foreground center.
11. Reconcile existing V2 Agent-authored rules into the unified list and mark compatible legacy rules with upgrade availability.
12. Run migrations, server/renderer/Electron E2E, restart/idempotency, cross-account, accessibility, privacy, content-quality, and rollback acceptance before removing the legacy-center flag.

Rollback disables unified foreground reads and template creation while preserving all newly persisted rules and runs. Existing V1 execution and V2 scheduler execution remain available.

## Open Questions

The product defaults accepted for the first implementation are:

- user-facing name “邮箱速览”;
- default daily time 08:30;
- current account as the initial scope, with explicit confirmation for all accounts;
- empty successful runs remain in history but do not publish or notify;
- desktop notification only for risk or actionable results;
- archive alone does not mean “handled”;
- global model policy resolves and freezes an exact model per rule version;
- template upgrades require explicit preview and confirmation;
- disabled rules may be side-effect-free tested, while production “立即运行” is separately confirmed and does not enable the schedule;
- advanced instructions, Cron, cost, retention, and catch-up remain collapsed.

The following can be finalized during implementation without changing architecture:

- exact 30-day retention copy and whether users can override it in the first release;
- whether recommended templates remain inline after the catalog grows beyond five;
- whether the desktop-wide run-detail surface is a modal or side sheet, provided narrow windows use a full-height drill-in view.
