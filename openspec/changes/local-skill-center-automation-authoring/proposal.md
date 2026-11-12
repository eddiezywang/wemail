## Why

WeMail currently hard-codes several Agent skills into the runtime prompt, splits automation authoring across a static capability catalog and a provider-oriented registry, and projects durable configuration internals as large diagnostic cards. This makes one-shot analysis, iterative report design, reusable personal skills, and natural-language automation configuration difficult to compose and allows the Agent run result to contradict the actual configuration outcome.

We need one local-first model in which reusable skills compose a stable execution pipeline, users can review subjective outputs such as charts before authorizing anything durable, and automation is simply a confirmed trigger around that reviewed pipeline.

## What Changes

- Add a pure-client Skill Center for immutable built-in skills and versioned personal skills stored under Electron `userData`.
- Adopt portable `SKILL.md` packages with WeMail-specific manifests, progressive loading, local registry metadata, version history, import/export, enable/disable, and usage references.
- Allow users to create and refine personal skills from Agent conversation, with exact-draft installation confirmation, validation, secret removal, and no arbitrary script execution.
- Replace the static all-skills-in-prompt model with metadata-first routing and on-demand skill/dependency loading.
- Introduce structured, composable Agent workflow artifacts for data selection, analysis recipes, artifact recipes, delivery plans, review checkpoints, and execution-pipeline drafts.
- Introduce an Agent-facing capability catalog organized by trigger, timing, data, analysis, output, and delivery. Provider identities become an internal executor concern and are not part of user-facing authoring.
- Support both one-shot execution and durable automation authoring from the same reviewed pipeline.
- Add iterative, natural-language result review for charts, images, HTML, PDF, analysis samples, matching samples, and delivery content, including version binding and dependency-aware invalidation.
- Replace the configuration diagnostic card as the primary chat interaction with inline questions, preview links, concise recovery actions, and collapsed technical details.
- Add a canonical automation-authoring state machine from intent collection through capability resolution, intermediate review, final rule confirmation, exact commit, and post-commit verification.
- Make the configuration goal outcome authoritative over the generic Agent turn conclusion.
- Persist exact skill versions and compiled recipes in confirmed automation snapshots so later skill updates do not silently alter existing rules.
- Keep confirmed automation execution deterministic and Agent-free at run time.
- **BREAKING**: Agent automation authoring no longer accepts or exposes provider IDs as the primary capability-selection model.

## Capabilities

### New Capabilities

- `local-skill-center`: Built-in and personal Skill package storage, discovery, import/export, versioning, validation, activation, permissions, references, and local settings management.
- `composable-agent-workflows`: Structured reusable pipeline drafts and skill composition for data selection, analysis, artifact generation, delivery, one-shot execution, and automation authoring.
- `interactive-result-review`: Versioned previews and natural-language review loops for subjective or high-impact intermediate results, with dependency-aware acceptance invalidation.
- `agent-automation-authoring`: End-to-end natural-language automation configuration using triggers plus reviewed pipelines, readiness gates, exact final confirmation, commit, verification, and deterministic future execution.

### Modified Capabilities

- `pi-agent-runtime`: Replace globally concatenated skill instructions with metadata-first on-demand loading, and make linked configuration outcomes authoritative over generic run conclusions.

## Impact

- New product Skill packages under `skills/builtin` and packaged Electron resources.
- New local Skill package store, registry, resolver, loader, authoring service, validation policy, API routes, database migrations, and Settings UI.
- Shared contracts for skills, capabilities, pipelines, recipes, reviews, configuration interactions, and exact automation snapshots.
- Agent runtime, tool schemas, prompt assembly, configuration workflow, conclusion projection, and conversation rendering.
- Automation capability discovery, preview, commit, scheduling, pipeline execution, design artifact generation, application messages, and Bot delivery.
- Migration of hard-coded Agent skill strings and reconciliation of stale configuration tasks.
- Existing `.agents/skills` remain repository-development skills; existing WeCLI runtime code is treated as an integration/executor rather than a product Skill package.
