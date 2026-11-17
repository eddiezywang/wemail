# Local Skill Center and Agent automation

WeMail is a pure Electron client. Skill packages, capability metadata,
pipeline drafts, previews, configuration tasks, rules, and execution audit
records are stored locally; this design has no enterprise-management plane.

## Concepts

- A **Skill** tells the Agent how to reason about and review reusable work.
- A **capability** is a stable business operation the pipeline can execute.
- An **executor** implements a capability. Existing Provider classes are
  executor adapters and are not part of Agent or user-authored configuration.
- A **pipeline** is data selection, optional analysis, optional artifact
  generation, and delivery.
- A **one-shot task** runs a reviewed pipeline now and creates no rule.
- An **automation rule** adds a trigger to the same pipeline and stores exact
  recipe, Skill, capability, review, delivery-policy, and authorization
  snapshots.

## Skill packages

Application Skills live in `skills/builtin/<skill-id>/` and are copied into
Electron resources during packaging. Personal immutable versions live under
the Electron `userData` Skill store. Every package has:

- `SKILL.md`;
- `wemail.skill.json`;
- optional `agents/openai.yaml`;
- optional one-level `references/`, inert `scripts/`, and bounded assets.

Settings → Skill Center keeps the product surface small: import is first,
organization structure is the default detail, and users may switch to the
frontmatter-free `SKILL.md` preview. It supports search, enable/disable and
personal export without rendering version, source, compatibility, automation
references, or internal hashes. Personal package scripts never execute. A Skill cannot grant itself
mailbox scope, external delivery, shell, process, arbitrary network, Electron
IPC, or unrestricted filesystem authority.

`wemail.skill.json` is WeMail's governance source of truth for identity,
version, dependencies, input/output kinds, tools, permissions, and content hash.
`agents/openai.yaml` is optional interoperability/UI metadata only; it cannot
override the manifest or grant tools and permissions.

Agent loading uses pi-coding-agent's native Skill protocol. WeMail exposes the
validated active package paths; pi discovers `name`, `description`, and the
`SKILL.md` location and formats that metadata into the system prompt. The
Agent decides whether a Skill matches and uses pi's `read` tool to load the
`SKILL.md`, then follows relative references only when its instructions require
them. WeMail does not provide a selector, routing service, or `load_skill`
tool. The read adapter is restricted to enabled Skill package roots.

The Agent can also turn a successful pipeline into a personal Skill draft.
The draft contains reusable procedure and interfaces only; mail bodies, sample
values, credentials, tokens, local temporary paths, and tool-call identifiers
are removed. Installation is a second action bound to the validated hash.
Dependencies are validated for installation and immutable automation
snapshots, but their bodies are never preloaded. Skill use is audited from
successful `read` calls. Provider-reported model token usage remains the
authoritative token measure; WeMail does not maintain a parallel body-byte
counter.

## Agent authoring flow

1. Read the lightweight pi Skill metadata catalog and decide which Skill, if
   any, is relevant; progressively read its `SKILL.md` and only the referenced
   files needed for the task.
2. Classify one-shot, durable automation, preview revision, Skill authoring, or
   general conversation, then read the task-oriented capability catalog. The Agent sees trigger, timing,
   data, analysis, output, and delivery IDs, schemas, readiness, risk, preview,
   and recovery information. It does not author Provider IDs.
3. Save a typed pipeline draft and validate scope, schemas, value kinds,
   ordering, capability availability, external effects, and delivery policy.
4. Generate real bounded previews as required: matching mail samples,
   analysis rows with provenance, HTML/chart/image/PDF artifacts, and Bot
   message content.
5. Ask one concise natural-language question for the current checkpoint.
   “符合” accepts that exact preview only. Revision feedback creates a new
   version and invalidates dependent downstream reviews.
6. For a one-shot request, ask whether to execute once, run the pipeline, show
   its artifact, and record that no rule was created.
7. For durable automation, compute readiness and show a separate immutable
   final summary of trigger, scope, analysis, artifact, destinations, defaults,
   failure policy, risks, and authorization bounds.
8. Only an explicit response such as “确认创建并启用” authorizes the exact
   unexpired snapshot and rule hash. Commit, reload, and verify before
   reporting success.

Missing Bot connections, authentication, permission, or temporary service
availability blocks only dependent steps. The chat shows the current stage,
affected scope, and recovery choices inline. Technical identifiers stay
collapsed. A generic Agent turn completion cannot override a blocked,
needs-input, awaiting-confirmation, partial, failed, or verifying
configuration outcome.

Automatic occurrences load the immutable confirmed rule and execute its fixed
pipeline without invoking the general conversational Agent or dynamically
selecting new Skills. Message Center and Bot delivery are distinct audited
steps, so one can succeed while the other fails. `first_available` Bot delivery
persists an ordered fallback chain: a terminal primary failure activates the
next target without duplicating successful sends, and final queue outcomes are
reconciled back to succeeded, partial, or failed run status.

## Rollout and rollback

All flags default to enabled. Set a value to `0` before starting the desktop
process to roll back that slice:

- `WEMAIL_DYNAMIC_SKILLS=0`: disable Agent-facing Skill discovery and reads.
- `WEMAIL_AGENT_CAPABILITY_CATALOG=0`: use legacy Provider-facing Agent tools.
- `WEMAIL_PIPELINE_AUTHORING=0`: use the legacy rule authoring session.
- `VITE_WEMAIL_INLINE_CONFIGURATION=0`: hide the new inline configuration
  interaction in a renderer build.

Existing V1 and V2 rules remain readable and executable regardless of these
flags. Flags affect new Agent sessions only.

## Acceptance data

To create a full day of local bank telemarketing conversation-analysis
monitoring mail for the active account:

```powershell
npm run dev:seed:monitoring -- --data-dir="<Electron userData>\data" --date=2026-07-29
```

The fixture creates twelve 09:00–20:00 execution-report and alert messages
containing the `WEMAIL_MONITORING_REPORT:` marker. It is deterministic and
idempotent. The acceptance suites cover:

- one-shot image preview, natural-language review, execution, and no rule;
- daily 21:00 calendar-day collection, monitoring analysis, line-chart HTML,
  Message Center, connected Bot, exact final confirmation, commit, reload, and
  verification;
- no Bot, one Bot, both Bots with explicit all/priority policy,
  stale review/final snapshots, cancellation, partial delivery,
  schema drift, catch-up, restart, and idempotency.
