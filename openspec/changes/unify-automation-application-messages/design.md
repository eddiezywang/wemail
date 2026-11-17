## Context

The current `AutomationRule` contract contains `trigger`, legacy `conditions`, composable `conditionRules`, `naturalLanguageCondition`, and per-message `actions`. `AutomationRuleExecutionService` handles incoming mail, interval schedules, deferred mail execution, version checks, idempotency, and run logging. PI already exposes list, preview, and propose tools, with confirmed changes committed by `MailActionExecutor`.

The seams are real but inconsistent. Scheduled and manual runs scan up to 200 messages and invoke actions once per message; the dry runner ignores composable and natural-language conditions; REST, form, and Agent schemas are handwritten separately; calendar-time schedules are not represented; and Agent proposals are not cryptographically or transactionally bound to the preview shown to the user. Existing mail digests already provide useful aggregation logic, but their lifecycle is separate from automation and they are not delivered through a general persistent application-message surface.

This change affects users configuring rules through settings, users configuring rules conversationally through PI, the automation scheduler/executor, message-center readers, and maintainers adding future trigger/condition/processor/action capabilities.

## Goals / Non-Goals

**Goals:**

- Preserve existing trigger and condition behavior while adding calendar schedules, collection scopes, collection processors, and persistent application-message delivery.
- Make UI, REST, and Agent configuration capability-identical and backed by one normalization and validation path.
- Bind preview, confirmation, persistence, and subsequent execution to one canonical rule revision.
- Reuse digest and invoice intelligence instead of implementing parallel summarizers.
- Keep automatic execution explainable, idempotent, account-scoped, and safe.

**Non-Goals:**

- Replacing the existing automation subsystem or introducing a separate “scheduled task” engine.
- Allowing arbitrary scripts, arbitrary HTML/JavaScript, or unregistered processor/action types in rules.
- Exposing internal automation tools through public MCP as part of this change.
- Sending every persistent application message as an OS notification.
- Requiring PI to participate when a confirmed automation executes.

## Decisions

### 1. Extend the existing rule aggregate rather than create a second task model

`AutomationRule` remains the source of truth. Existing `manual`, `mailReceived`, and interval `scheduled` triggers remain readable. The scheduled trigger gains a discriminated schedule payload that can represent interval and calendar recurrence while legacy `intervalMinutes` rows normalize to an interval schedule.

Rules gain optional canonical fields resembling:

```ts
interface AutomationRuleSelection {
  mode: "triggerMail" | "collection";
  scope?: AutomationCollectionScope;
}

interface AutomationRuleProcessing {
  mode: "perMessage" | "collection";
  processors?: AutomationProcessor[];
}
```

The exact field names may be refined during implementation, but persisted rules MUST explicitly distinguish per-message work from one-per-run collection work. This avoids overloading action implementations with implicit batching.

Alternative considered: create a separate scheduled-task subsystem. Rejected because it would duplicate triggers, conditions, lifecycle, confirmation, audit, and Agent configuration while confusing the user-facing automation model.

### 2. Introduce a canonical automation capability registry and application service

Trigger schedules, condition fields/operators, scopes, processors, and actions are registered as typed capability definitions. Definitions carry stable IDs, labels, descriptions, parameter schemas, risk metadata, preview support, and renderer metadata.

An `AutomationRuleService` (or equivalently named domain service) owns normalization, validation, preview creation, CRUD mutation, optimistic concurrency, and capability discovery. UI routes and Agent tools call this service instead of validating and writing repositories independently. TypeScript contracts remain the compile-time source while runtime schemas are generated or assembled from the same registry.

Alternative considered: continue synchronizing handwritten schemas with tests. Rejected because existing REST/Agent/preview drift demonstrates that parity tests alone do not prevent omissions.

### 3. Separate selection, processing, and delivery

A collection run follows:

```text
trigger window
  -> resolve immutable data window and candidate scope
  -> evaluate structured and natural-language conditions per candidate
  -> create matched-set manifest
  -> run collection processors once
  -> execute delivery/actions once with processor outputs
  -> persist run and references
```

Per-message rules continue to evaluate and execute as they do today. Collection processors receive bounded message projections and explicit references; they do not receive secrets or unbounded raw mailbox data. Initial processors are `mailDigest` and `invoiceReadinessAnalysis`. Initial collection delivery is `publishApplicationMessage`.

Processor output is typed data, not presentation HTML. This allows the same output to be rendered in the message center, summarized in a desktop notification, or consumed by later typed actions.

Alternative considered: implement digest generation inside the notification action. Rejected because processing and delivery have different retry/idempotency behavior and future deliveries may reuse the same result.

### 4. Resolve schedule windows deterministically

Calendar schedules persist local recurrence plus an IANA timezone. Each due run resolves an immutable `windowStart`, `windowEnd`, and trigger key before querying mail. Daily “past 24 hours” uses a rolling duration; “since the previous scheduled run” uses the previous successful or claimed schedule boundary according to the selected scope mode.

The scheduler continues using the existing 60-second process tick. A restart may execute one latest missed window, but MUST NOT fan out an unbounded backlog. Trigger keys and claimed run rows prevent duplicate execution. `nextRunAt` is derived from the recurrence anchor, not from completion time, to prevent schedule drift.

### 5. Persist application messages as safe structured content

Add account-scoped application message and reference tables. A message stores source kind, source rule/run IDs, type, title, preview, structured content JSON, typed interaction JSON, severity, unread/read/archive timestamps, and creation time. References link to emails, attachments, rules, runs, drafts, or external-operation audit IDs.

Content uses an allowlisted block model (headings, paragraphs, lists, tables, callouts, status badges, and reference groups). Markdown may be accepted as processor input, but is parsed and sanitized into structured blocks before persistence or rendering. Arbitrary HTML, inline event handlers, scripts, remote embeds, and model-supplied executable links are rejected.

Alternative considered: persist arbitrary HTML. Rejected because it creates XSS, CSS isolation, remote tracking, and unstable interaction semantics inside the desktop client.

### 6. Treat desktop notifications as an optional delivery projection

Publishing an application message always persists it first. Desktop delivery is handled by one shared notification coordinator rather than by individual mail, Agent, automation, or renderer call sites. Producers publish typed facts; the coordinator owns eligibility, privacy, aggregation, deduplication, native Toast XML, and activation routing.

The coordinator exposes two independent policies:

- `actionRequired` is enabled by default and covers durable states that explicitly wait for user intervention, including Agent confirmations, mail send failures, invalid mailbox credentials, and automation failures that cannot continue without the user.
- `newMail` is disabled by default. When enabled, every genuinely live message is eligible without importance, VIP, category, smart-tag, or AI filtering. Foreground focus does not suppress delivery.

New-mail notifications contain sender and subject only. Action-required notifications contain only an allowlisted safe summary and may deep-link to the exact confirmation or recovery surface, but they cannot approve risky operations directly. Failures to emit the OS notification do not roll back the owning mail, pending action, application message, account state, or automation run.

Live mail is aggregated per account over a short fixed window. Initial synchronization, historical backfill, folder rebuilds, and manual full synchronization are separate synchronization sessions: they update one in-app progress state and one final in-app summary, and never emit one notification per historical message. A live-delivery watermark allows genuinely new mail arriving during history synchronization to follow the ordinary new-mail preference.

Electron renders supported native Windows Toast content through custom `toastXml`, using shared single-mail, aggregate-mail, and action-required templates. Windows continues to own the outer container, Notification Center, Focus Assist, animation, and accessibility behavior.

### 7. Bind Agent proposals to canonical preview snapshots

Preview creates a short-lived, account-scoped snapshot containing the normalized rule, rule hash, capability-version fingerprint, match summary, warnings, source rule ID/version for updates, and expiry. Agent proposal tools accept the preview ID and hash rather than retransmitting a second free-form rule.

The pending-action card renders the canonical snapshot. Confirmation verifies account ownership, expiry, hash, capability versions, and optimistic source revision before committing exactly that rule. Any changed intent requires a new preview. UI may use the same preview mechanism; direct UI commit is allowed only when it submits the exact preview revision through the same service.

Alternative considered: trust the Agent to reproduce its preview in the proposal call. Rejected because the previewed, confirmed, and persisted payloads could differ.

### 8. Preserve the current authorization boundary

Reading capabilities, listing rules/runs/messages, explaining rules, and previewing are read operations. Creating, updating, enabling, disabling, deleting, or manually running rules creates a WeMail-owned pending confirmation when initiated by PI. Confirmation of a rule authorizes future executions within that exact normalized scope; widening scope, changing processing, changing delivery, or increasing action risk requires a new confirmed revision.

Typed actions embedded in application messages do not inherit the automation rule's authority. A follow-up send, deletion, mailbox mutation, or WeCLI mutation follows its normal confirmation policy.

## Risks / Trade-offs

- **[Risk] Collection rules scan too much mail or consume excessive model tokens.** → Require indexed time/scope queries, candidate/result caps, prompt budgets, truncation indicators, and run diagnostics.
- **[Risk] Calendar schedules behave unexpectedly across DST or downtime.** → Persist IANA timezone and recurrence anchor, test DST boundaries, cap catch-up to the latest eligible window, and expose resolved next-run time.
- **[Risk] Legacy and canonical conditions produce different results.** → Normalize legacy conditions, replace the divergent dry runner with the production matcher in preview mode, and add parity fixtures.
- **[Risk] Capability registry changes invalidate pending previews.** → Fingerprint capability versions and require re-preview when the fingerprint changes.
- **[Risk] Rich content introduces injection or tracking.** → Persist allowlisted blocks, sanitize Markdown, disallow arbitrary HTML and remote active content, and test hostile payloads.
- **[Risk] Existing daily digest UX overlaps with application messages.** → Reuse `MailDigestService` as a processor adapter and link existing digest history to produced messages rather than maintaining two independent generation paths.
- **[Risk] A persistent rule can authorize destructive future work too broadly.** → Keep automatic-rule condition requirements, show exact scope/action risk in confirmation, fail closed on evaluation errors, and require reconfirmation for material revisions.

## Migration Plan

1. Add capability discovery and canonical normalization around the existing rule contract without changing execution.
2. Route REST, Agent preview/proposal, and form preview through the shared service; retain legacy reads and normalize legacy rows in memory.
3. Add preview snapshots, canonical confirmation payloads, and optimistic revision checks.
4. Add application-message storage/API/UI with no automation producer enabled.
5. Add collection scope/run persistence and processors behind explicit new rule fields.
6. Add `publishApplicationMessage`, calendar schedules, optional desktop delivery, and Agent/UI configuration surfaces.
7. Migrate existing digest settings into equivalent system-managed automation rules only if product migration is explicitly enabled; otherwise preserve them and use the shared processor adapter.

Rollback disables creation/execution of collection rules and message publication while retaining new tables. Legacy per-message rules remain readable and executable. Application-message rows are retained so rollback does not destroy user-visible history.

## Open Questions

- Compatibility decision: current daily digest settings remain a compatibility producer for this release. Both legacy digests and new collection rules reuse `MailDigestService`; only new collection rules publish into application messages. Automatic migration is intentionally deferred so an upgrade cannot create duplicate daily deliveries. A later opt-in migration may create editable rules after disabling the corresponding legacy schedule transactionally.
- Should long application-message detail open in a modal, the existing detail column, or use a responsive combination of both? The data contract is independent of this UI choice.
- What default retention period should apply to application messages and their email references?
- Which collection scopes beyond rolling time window, folder, smart tag, and account should be included in the first release?
