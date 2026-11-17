## Context

WeMail is a pure Electron client with a React renderer, Electron main/preload bridge, local TypeScript API, SQLite persistence, a PI-based conversational Agent, local mail services, an automation engine, design artifact generation, application messages, Bot connections, and an audited WeCLI integration.

Three different concepts currently use the word “skill”:

- `.agents/skills` contains repository-development instructions for Codex and OpenSpec.
- `server/wemail/skills` contains WeCLI runtime and audit implementation.
- `AutomationAuthoringSkill.ts`, `WemailDesignSkill.ts`, and similar modules inject product workflow instructions as TypeScript string constants into every PI prompt.

Automation has a similar split. Core triggers, schedules, conditions, and scopes live in a static catalog, while pipeline actions are exposed through a provider registry. Agent instructions tell PI that core capabilities are not providers, which makes a plausible `provider=wemail` plan fail as if an external dependency were missing. Configuration task snapshots are durable, but the active chat unconditionally renders a large task card and the generic Agent conclusion can still say “success” when the canonical task is blocked.

The accepted product model is simpler:

```text
execution pipeline = data selection + analysis + artifact + delivery
one-shot task      = run the pipeline now
automation rule    = trigger + confirmed pipeline
```

Skills guide Agent reasoning and review. Capabilities describe executable operations. Executors implement capabilities. Recipes capture accepted analysis, artifact, and delivery decisions. Rules persist a trigger plus immutable compiled pipeline. Provider identity, if retained internally, is not an Agent or user authoring concept.

## Goals / Non-Goals

**Goals:**

- Provide a local Skill Center for packaged built-in Skills and versioned personal Skills.
- Support portable `SKILL.md` packages while keeping WeMail permissions, interfaces, versions, and hashes in a separate manifest.
- Load Skills progressively and compose them through structured inputs and outputs.
- Reuse the same pipeline for one-shot work and durable automation.
- Let users review charts, HTML, images, model analysis, matching samples, and delivery content through real previews and natural-language feedback.
- Make review acceptance versioned and dependency-aware.
- Drive automation authoring through a persistent state machine and a single authoritative goal outcome.
- Require one separate final confirmation for the exact durable rule after all required intermediate reviews pass.
- Execute confirmed automatic occurrences without the general Agent.
- Keep missing Bot, WeCLI, authentication, or another capability failure localized to dependent steps.
- Migrate existing built-in prompt strings, automation discovery, task projection, and stale configuration records safely.

**Non-Goals:**

- Enterprise, organization, workspace, team, marketplace, or cloud Skill distribution.
- Arbitrary user scripts, shell, PowerShell, Node.js, Python, HTTP, Electron IPC, or unrestricted filesystem access.
- Allowing a Skill package to grant itself tools or permissions.
- Invoking a general-purpose Agent during every confirmed automatic occurrence.
- A general DAG, parallel branches, arbitrary expression language, or dynamic code generation in automation rules.
- Replacing WeMail’s existing pending-action policy for send, delete, external mutation, or other high-risk work.
- Silently upgrading existing rules when a Skill or capability implementation changes.

## Decisions

### 1. Separate Skill, capability, executor, recipe, and rule

The shared contracts will use five distinct concepts:

```ts
interface SkillPackageManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  entry: "SKILL.md";
  scope: "builtin" | "personal";
  inputKinds: WorkflowValueKind[];
  outputKinds: WorkflowValueKind[];
  dependencies: SkillDependency[];
  toolAllowlist: string[];
  requestedPermissions: string[];
  reviewPolicy: ReviewPolicy;
  contentHash: string;
}

interface CapabilityDescriptor {
  id: string;
  category: "trigger" | "timing" | "data" | "analysis" | "output" | "delivery";
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  availability: CapabilityAvailability;
  risk: CapabilityRisk;
  previewSupport: "full" | "plan_only" | "none";
  executorKey: string; // internal, not projected to PI
}
```

Skills can recommend and compose capability IDs, but only the capability registry and policy engine can validate and execute them.

Alternative considered: expose dynamic provider IDs and lifecycle contracts directly to PI. Rejected because the user-facing task is capability selection, core behavior became a special case, and internal implementation identity leaked into repair UX.

### 2. Store product Skills as managed packages

Repository source will live under:

```text
skills/builtin/<skill-id>/<package files>
```

The desktop build copies built-ins to:

```text
process.resourcesPath/skills/builtin
```

Personal packages live under:

```text
app.getPath("userData")/skills/packages/personal/<skill-id>/<version>
```

SQLite stores the package index, activation, permissions, compatibility, dependencies, hashes, version history, and usage references. Package contents remain on disk because references and assets are naturally file-backed.

Installed versions are immutable. Editing creates a new version. Imports copy into the managed directory instead of executing from the original location.

Alternative considered: store complete packages as database blobs. Rejected because asset/reference inspection, export, packaging, version diffing, and Electron resource handling are simpler and safer with immutable managed directories.

### 3. Keep portable frontmatter minimal

`SKILL.md` frontmatter contains only portable `name` and `description`. WeMail-specific metadata belongs in `wemail.skill.json`; UI metadata remains optional in `agents/openai.yaml`.

This preserves compatibility with common Agent Skill packages and keeps product permission semantics out of a field that another runtime might interpret differently.

### 4. Pi-native progressive Skill loading replaces global prompt concatenation

WeMail passes validated active package paths to pi-coding-agent's native Skill
discovery. Pi parses portable `name` and `description` metadata, formats the
standard `<available_skills>` prompt section, and lets the Agent decide whether
to use its `read` tool for a matching `SKILL.md`. References, scripts, and
assets are read through relative paths only when the Skill instructions point
to them. WeMail does not select Skills from keywords and does not implement a
parallel `load_skill` protocol.

WeMail remains responsible for package activation, compatibility, immutable
versions, content hashes, and task-bound automation snapshots. The native
`read` adapter is constrained to the validated package roots exposed for the
current run; successful reads provide the privacy-safe Skill usage audit.
Dependency closure is validated for installation and reproducible automation,
but dependency bodies are not automatically added to model context.

Built-in safety policy always remains in the PI base prompt and cannot be
shadowed by a personal Skill.

Alternative considered: concatenate bodies or introduce a WeMail routing and
loading tool. Rejected because both duplicate the Agent harness, increase
prompt/tool overhead, and take the loading decision away from the Agent.

### 5. Use structured pipeline artifacts between Skills

The canonical authoring draft is:

```ts
interface ExecutionPipelineDraft {
  id: string;
  revision: number;
  mode: "one_shot" | "automation";
  dataSelection?: DataSelectionSpec;
  analysis?: AnalysisRecipe;
  artifact?: ArtifactRecipe;
  delivery?: DeliveryPlan;
  steps: PipelineStepDraft[];
  skillSnapshots: SkillSnapshot[];
  capabilitySnapshots: CapabilitySnapshot[];
  reviews: ReviewCheckpoint[];
  validation: PipelineValidationState;
}
```

Skill outputs merge through typed fields with optimistic revision checks. Free-form assistant prose is not a source of truth for downstream steps.

The initial built-in Skills are:

- `wemail-data-selection`
- `wemail-analysis-design`
- `wemail-artifact-review`
- `wemail-delivery-planning`
- `wemail-automation-authoring`
- `wemail-skill-authoring`

Simple deterministic operations remain tools/capabilities rather than Skills.

### 6. Replace Agent-facing providers with a capability catalog

The API returns task-oriented capability categories and current readiness. Internal executor registration may adapt existing provider classes, but PI tool schemas and authoring drafts use stable capability IDs only.

Example:

```text
trigger.scheduled
timing.daily
mail.collect
model.analyze
report.renderHtml
chart.renderImage
messageCenter.publish
bot.sendConnected
wecli.allowanceUpload
```

Availability distinguishes:

- known and ready;
- known but not installed;
- known but not connected;
- authentication or permission required;
- temporarily unavailable;
- unknown capability.

An unknown capability generated by PI is a compile/repair error, not a user environment blocker. A known unavailable capability can produce a targeted interaction.

### 7. Model triggers as event, match, and timing

The trigger contract supports:

```ts
type AutomationTriggerDraft =
  | {
      event: "schedule";
      timing: DailyTiming | IntervalTiming;
    }
  | {
      event: "mail.received";
      match: MailMatchSpec;
      timing: ImmediateTiming | DelayTiming | NextDayTiming;
    }
  | {
      event: "manual";
      timing: ImmediateTiming;
    };
```

This makes “invoice mail plus two-hour delay” one trigger rather than two unrelated configuration concepts.

Material defaults such as timezone, calendar-day versus rolling-window scope, catch-up policy, and both-Bot behavior are disclosed or clarified before final confirmation.

### 8. Review checkpoints are first-class and version-bound

```ts
interface ReviewCheckpoint {
  id: string;
  target: "data" | "analysis" | "artifact" | "delivery";
  policy: "none" | "recommended" | "required";
  status: "pending" | "accepted" | "rejected" | "stale";
  draftRevision: number;
  targetVersion: number;
  contentHash: string;
  previewId?: string;
  feedback?: string;
  acceptedAt?: string;
}
```

The compiler derives checkpoints from subjectivity, ambiguity, presentation, user-visible content, external side effects, and capability policy. Deterministic read-only steps avoid redundant review.

Artifact links open the actual sandboxed HTML, image, chart, PDF, or message preview. Feedback remains in chat. PI classifies feedback as accept, reject, revise, or ambiguous, but the server validates that the referenced checkpoint and hash are current.

Acceptance authorizes only that intermediate design. It does not authorize delivery or rule creation.

### 9. Invalidate review through explicit dependencies

Draft fields and checkpoints declare upstream dependencies. A material change computes the affected closure:

```text
data selection -> analysis -> artifact -> delivery content
```

Changing Bot priority does not invalidate a chart. Changing data schema invalidates dependent analysis and artifact acceptance. Stale checkpoints cannot satisfy readiness.

### 10. Save recipes, not sample results

Sample mail and datasets generate side-effect-free previews, but accepted state stores reusable recipes:

- `AnalysisRecipe` defines fields, dimensions, metrics, model tasks, conclusions, prompts, limits, and output schema.
- `ArtifactRecipe` defines report kind, component bindings, chart encodings, layout, theme, accessibility, empty/error behavior, and output format.
- `DeliveryPlan` defines destinations, content projection, fallback, and partial-failure policy.

Automatic occurrences bind current data into these recipes. Runtime schema incompatibility fails or pauses according to the confirmed policy rather than silently redesigning the output.

### 11. Use one persistent configuration state machine

The authoring state machine is:

```text
collecting
  -> resolving_capabilities
  -> compiling
  -> reviewing
  -> awaiting_final_confirmation
  -> committing
  -> verifying
  -> completed
```

Terminal or recoverable alternatives are `needs_input`, `blocked`, `failed`, `cancelled`, and resumed prior states.

Each transition records:

- canonical draft revision;
- effect state (`none`, `partial`, `completed`);
- current issues deduplicated by phase/code/affected scope;
- next interaction;
- active preview and review versions;
- pending exact confirmation snapshot.

The workflow service, not PI, decides readiness and transition validity.

### 12. Project an interaction, not the entire task

The backend projector returns:

```ts
interface ConfigurationInteraction {
  goalStatus: ConfigurationGoalStatus;
  stage: string;
  message: string;
  impact?: string;
  actions: InteractionAction[];
  previewLinks: PreviewLink[];
  technicalDetails?: TechnicalDetails;
}
```

The active chat renders this inline. Technical identifiers remain collapsed. The durable task remains available to Settings, diagnostics, recovery, and audit but is not unconditionally rendered as a large card below the conversation.

The final PI run conclusion consults the latest linked configuration interaction:

- blocked configuration -> incomplete/blocked;
- needs input -> waiting for information;
- awaiting confirmation -> asks for confirmation;
- verified completion -> success.

Internal “turn finished” status stays in telemetry and cannot override the goal outcome.

### 13. Separate intermediate review from final durable authorization

After readiness passes, the system creates an immutable confirmation snapshot containing:

- account and configuration session;
- trigger and catch-up policy;
- complete compiled pipeline;
- Skill IDs, versions, and hashes;
- capability contracts and fingerprints;
- accepted recipe and review hashes;
- sample preview references;
- delivery destinations and partial-failure policy;
- risk and authorization limits;
- rule hash and expiry.

The Agent summarizes this snapshot in natural language. Explicit user confirmation commits only the snapshot ID and hash. A stale draft, expired preview, changed capability, changed Skill, or changed source rule forces re-preview.

### 14. Verify commit before success

After create/update, the service reloads rule and runtime state and compares:

- rule ID and revision;
- enabled state;
- trigger and next occurrence;
- compiled pipeline hash;
- recipe hashes;
- Skill snapshots;
- delivery policy.

Only a verified match transitions to `completed`. Known side effects plus failed verification produce an explicit partial/uncertain state rather than a false retry or success.

### 15. Automatic execution is deterministic

The scheduler or mail event claims an occurrence for an immutable rule revision and executes registered capabilities with fixed recipes. It does not load authoring Skills or invoke PI.

Step audit records bounded inputs, output references, duration, warnings, side effects, capability identity, and privacy-safe errors. Message Center and Bot delivery are separate steps so partial success is visible.

For `bot.sendConnected`:

- one ready Bot resolves to that destination;
- no ready Bot blocks delivery planning;
- both ready Bots require “both” or a priority policy before confirmation;
- runtime uses only the confirmed resolution policy.

### 16. Personal Skill authoring is an exact-draft workflow

`wemail-skill-authoring` can start from explicit requirements or a successful task. It extracts reusable procedure and structured interfaces while excluding mail bodies, credentials, tokens, local temporary paths, tool call IDs, and sample values.

The draft lifecycle is:

```text
draft -> validate -> preview/diff -> revise -> confirm -> install -> verify
```

The server owns package rendering, manifest normalization, content hashing, compatibility validation, and installation. PI cannot write directly into the managed Skill directory.

### 17. Personal packages are non-executable

Import validation rejects unsafe paths, links, file counts, expansion ratios, oversized files, invalid encodings, and incompatible manifests. Personal scripts remain inert. Personal assets are treated as untrusted input and validated when used.

Tool allowlists are requests, not grants. The standard account, mailbox-scope, pending-action, and external-mutation policies remain authoritative.

Alternative considered: sandbox arbitrary user scripts. Rejected for the first version because Electron desktop privilege, filesystem access, supply-chain risk, and Windows process behavior make a meaningful sandbox a separate security project.

### 18. Existing rules retain compatibility

Existing V1/V2 rules remain readable and executable through current compatibility adapters. Editing an existing rule through the new Agent flow compiles a new canonical snapshot and requires preview plus confirmation.

Existing hard-coded Skill string modules remain available behind a rollout flag until their package equivalents pass parity tests. Existing provider executors can be adapted behind capability descriptors before internal naming cleanup.

## Risks / Trade-offs

- [Imported Skill instructions contain prompt injection] → Treat package content as untrusted, keep immutable system policy separate, allow only registered tools, bound loaded content, and expose permissions before installation.
- [Skill routing chooses an unexpected personal Skill] → Prefer explicit invocation and bound task versions, show selected Skill in expandable trace, and allow disable/test controls.
- [Too many review checkpoints make workflows tedious] → Derive checkpoints from subjectivity and impact; do not review deterministic read-only steps.
- [Natural-language acceptance is misclassified] → Bind to one current checkpoint, require unambiguous acceptance, and clarify ambiguous responses.
- [Upstream edits leave stale acceptance] → Maintain dependency edges and compute invalidation in the server, not in PI prose.
- [Preview differs from runtime output] → Compile reusable recipes and render previews through the same compatible executor semantics.
- [Skill update changes existing automation] → Snapshot exact versions and compiled recipes; require explicit upgrade preview.
- [Rule commit succeeds but response is lost] → Verify persisted rule/effect state before retrying or reporting failure.
- [Both Bot channels are connected] → Require an explicit “both” or priority policy rather than guessing.
- [Migration overlaps active OpenSpec changes] → Treat this change as the authoritative replacement for conflicting unfinished Provider-facing authoring and diagnostic-card tasks; preserve compatible runtime/artifact work.
- [Local package directories are manually edited] → Verify hashes at load, disable tampered versions, and require reinstall or a new managed version.
- [Diverse imported Skill formats] → Support standard `SKILL.md` conservatively and report unsupported tools/resources instead of pretending full compatibility.

## Migration Plan

1. Add shared contracts and database migrations without changing current behavior.
2. Add the Skill package store, registry, resolver, loader, and built-in package build-copy step.
3. Package current automation-authoring and design instructions and run parity tests behind a feature flag.
4. Add the task-oriented capability catalog as an adapter over existing built-in and provider executors.
5. Introduce structured pipeline drafts, recipes, reviews, and interaction projection alongside current configuration snapshots.
6. Implement one-shot pipeline composition and artifact review before enabling durable rule mutation.
7. Enable new automation authoring for new configuration sessions while retaining old rule execution.
8. Switch Agent conclusions and active-chat rendering to canonical goal outcomes and inline interactions.
9. Add Skill Center Settings, import/export, personal authoring, versioning, and usage references.
10. Reconcile stale blocked tasks: deduplicate issues, close tasks superseded by verified rules, and preserve audit history.
11. Remove hard-coded Skill prompt concatenation and Provider-facing Agent authoring only after trace and E2E parity.
12. Retain a rollback flag that restores the old authoring UI/runtime selection without deleting new package or task data.

## Open Questions

- Whether the first personal Skill editor should expose raw Markdown, a guided form, or both can be decided during renderer implementation; storage and validation support either.
- Whether exported personal Skill archives include inactive historical versions by default is a UX choice and does not affect the package contract.
- Renaming `server/wemail/skills` to an integration/executor directory can occur in this change or as a follow-up cleanup, provided product Skill package paths remain unambiguous.
