# PI Agent Domain Tools Design

## Goal

Make PI able to manage WeMail business configuration and reach all mail operations through explicit domain tools. The first delivery must close the user-visible gap where PI can understand an automation request but cannot create the rule.

The representative acceptance scenario is:

> When an invoice email arrives, upload its PDF attachments to the monthly invoice platform through wecli at 03:00 on the following calendar day.

PI configures and proposes the rule. After the user confirms the rule once, WeMail's automation engine owns matching, scheduling, execution, retries, and reporting. PI is not involved in individual rule runs.

## Scope

### PI-managed business capabilities

- User-defined smart tags.
- Automation rules.
- Mail drafts and mail operations.
- Writing styles.
- Notification preferences.
- Read-only mailbox and intelligence capabilities that already exist.

### Explicit exclusions

PI must not read or modify:

- Account passwords, OAuth credentials, or mailbox tokens.
- SMTP or IMAP security configuration.
- AI provider API keys.
- Security policy and authorization policy.

These exclusions must be enforced in the tool and service layers, not only by prompts.

## Delivery Batches

### Batch 1: Core configuration and send loop

- Smart tag list, create, update, and delete tools.
- Automation rule list, preview, dry-run, create, update, enable, disable, and delete tools.
- Mail-received execution timing: immediate, relative delay, and next-day local time.
- Structured wecli automation actions.
- New mail, reply draft, and draft update tools.
- Confirmed mail sending.
- Shared risk classification, pending-action handling, audit records, and actionable errors.

### Batch 2: Complete operational coverage

- Read/unread, star/unstar, important/not-important, apply/remove tag, move, archive, spam/not-spam, trash, restore, and permanent-delete operations.
- Scheduled send, scheduled-send cancellation, attachment operations, and batch mail operations.
- Writing-style and notification-preference tools.
- Rule-run inspection, retry, and PI-assisted diagnostics.
- Capability-inventory enforcement for all supported mail and business configuration features.

## Chosen Architecture

Use explicit domain tools rather than a generic API proxy or UI automation.

Create a `WemailAgentTools` composition layer whose tools are divided into focused modules:

- Smart-tag tools.
- Automation tools.
- Draft and send tools.
- Mail-operation tools.
- Business-settings tools.

The modules register their tools with `PiAgentRuntime`. Existing read and intelligence tools remain available, but the current large `MailAgentTools` module should be reduced incrementally as related capabilities move behind focused boundaries.

Tools must not call WeMail's HTTP routes. Validation and orchestration currently embedded in routes must move into reusable application services. HTTP routes and PI tools call the same services and therefore produce the same validation, authorization, and domain behavior.

Each tool declares:

- A stable name and purpose.
- A strict structured input schema.
- A structured output schema.
- Its risk level.
- Whether confirmation is required.
- A redacted audit summary.

PI selects a domain operation and supplies business parameters. It must not invent database identifiers, construct internal HTTP calls, or execute arbitrary commands.

The interactive path is:

`user intent -> PI domain tool -> application service validation/preview -> pending action when required -> user confirmation -> application service execution`

The automatic path is independent:

`mail received -> rule match -> durable scheduled execution -> mail/wecli action -> result, retry, and notification`

## Automation Trigger Model

Extend the mail-received trigger with an execution-timing discriminator:

```ts
type MailReceivedExecutionTiming =
  | { type: "immediate" }
  | { type: "delay"; amount: number; unit: "minute" | "hour" | "day" }
  | { type: "nextDayAt"; localTime: string; timezone: string };
```

The existing immediate behavior remains the compatibility default for stored rules without execution timing.

### Timing semantics

- `immediate` executes as soon as a message matches.
- `delay` executes at `receivedAt + duration`; for example, 24 hours after receipt.
- `nextDayAt` executes on the next calendar day at the configured local time; for example, 03:00 in `Asia/Shanghai`.
- Rules using calendar-local timing must store an IANA timezone.
- Calendar calculations must handle month boundaries, year boundaries, and daylight-saving transitions.
- A rule and message pair may create at most one scheduled execution for a given rule version.

Matching happens when the mail-received event is processed. A match creates a durable execution record containing the rule version, message reference, due time, action authorization snapshot, and status. Restarting the app or missing the exact due time must not lose the execution; overdue work runs promptly after recovery.

Disabling or deleting a rule cancels its pending executions. Updating a rule creates a new version and does not silently expand the authorization of already scheduled work.

## Structured wecli Automation Actions

wecli is an action adapter for supported office sites, including the monthly invoice platform. It does not own scheduling or rule matching.

Automation rules must store structured wecli action data, not arbitrary shell strings. A structured action includes:

- Site or capability identifier.
- Operation identifier.
- Validated operation parameters.
- Message-field and attachment mappings.
- Attachment selection policy.

The adapter converts this structure into an approved wecli invocation. The initial invoice upload action defaults to PDF attachments from the matched email unless the user explicitly authorizes a broader selection.

The representative rule is:

- Condition: an invoice email, expressed through natural-language and/or structured sender, subject, attachment, and tag conditions.
- Trigger: mail received with `nextDayAt`, `03:00`, and `Asia/Shanghai` unless the user selects another timezone.
- Action: monthly invoice platform upload through the structured wecli adapter.
- Attachment policy: matching PDF attachments only by default.

External actions that cannot be represented by a registered structured adapter are rejected during preview or creation.

## Confirmation and Authorization

Use risk-based confirmation.

### Direct execution

- Queries and searches.
- Reading configuration.
- Creating and modifying drafts.
- Rule preview and dry-run.

### Configuration confirmation

- Create, update, or delete a smart tag.
- Create, update, enable, disable, or delete an automation rule.
- Change writing-style or notification configuration.

### Per-operation high-risk confirmation

- Send mail.
- Permanent delete.
- Move, archive, and spam handling outside an authorized automation rule.
- Any mutating wecli operation outside an authorized automation rule.

An automation-rule confirmation card must clearly state:

- Which messages can match.
- When each match will execute.
- Which mail or wecli actions will run.
- Which attachments may be used.
- The account and timezone.

Confirming a rule creates an immutable authorization snapshot. Automatic executions may perform only operations and parameter ranges included in that snapshot and do not request confirmation again.

Any change that expands scope requires a new confirmation. Examples include changing PDF-only selection to all attachments, selecting another platform, widening message conditions, or adding a destructive action. Non-expanding metadata edits still follow the normal business-configuration confirmation policy.

## Persistence and Execution States

Scheduled automation work must use durable storage. Each record needs enough information to support idempotency, restart recovery, cancellation, audit, and diagnosis without copying mail bodies into logs.

Recommended states are:

- `pending`
- `running`
- `succeeded`
- `retry_wait`
- `failed`
- `cancelled`

Use bounded retries with recorded next-attempt time. Authentication expiry, missing permission, invalid adapter parameters, or removed attachments should produce actionable terminal failures when retrying cannot help. Transient process, network, or availability errors may retry according to policy.

## Errors and User Feedback

Domain tools return stable error codes plus concise user-action guidance. PI should be able to explain failures without exposing internal IDs, command construction, stack traces, credentials, or raw mail bodies.

Important failure classes include:

- Missing account or ambiguous account.
- Invalid rule condition or timing.
- Unsupported wecli capability.
- Rule authorization no longer matching its action.
- Mail or attachment no longer available.
- wecli authentication expired.
- Missing platform permission.
- Duplicate execution prevented by idempotency.

Rule creation must fail before confirmation when its trigger or action cannot execute reliably.

## Auditing and Privacy

Record configuration changes and automatic executions with:

- Actor source (`user`, `pi-agent`, or `automation`).
- Account reference.
- Tool or rule capability.
- Rule version and authorization version where applicable.
- Redacted input summary.
- Result status and actionable error code.
- Timestamps and retry metadata.

Do not record message bodies, secrets, API keys, credential material, or unrestricted attachment contents in agent traces or audit logs.

## Capability Inventory

Maintain a centralized inventory of PI-manageable capabilities. Each entry records its domain, tool name, availability batch, risk class, confirmation policy, and service implementation.

Tests must fail for:

- Duplicate tool names.
- Missing risk metadata.
- A sensitive capability appearing in the PI inventory.
- A capability marked delivered without a registered tool and service.
- A mail operation supported by the product but absent from either the delivered or planned inventory.

This makes PI reachability part of the definition of done for future WeMail business features.

## Testing Strategy

### Unit tests

- Tool schemas and validation.
- Risk and confirmation classification.
- Timing parsing and timezone calculations.
- Authorization-snapshot comparisons.
- Structured wecli adapter validation.
- Capability-inventory completeness and exclusions.

### Application-service tests

- UI routes and PI tools produce consistent results through shared services.
- Configuration changes require the intended confirmation level.
- Draft changes remain non-sending operations.
- Confirmed sends execute once.

### Persistence and scheduler tests

- One durable task per rule version and message.
- Restart recovery and overdue execution.
- Retry, failure, cancellation, and rule-disable behavior.
- Rule updates do not broaden existing authorization.
- Month, year, and daylight-saving timing boundaries.

### Integration tests

- PI tool call to pending action to confirmation to rule creation.
- PI draft creation to confirmed send.
- Smart-tag CRUD through shared services.
- Matching mail to scheduled wecli action without PI involvement at runtime.

### Regression tests

- Existing immediate mail-received rules continue to execute.
- Existing fixed scheduled rules continue to execute.
- Existing PI read and intelligence tools keep their contracts.
- Sensitive settings remain unreachable.

## Batch 1 Acceptance Scenario

1. The user asks PI to upload invoice-email PDF attachments through wecli at 03:00 on the following day.
2. PI calls the automation preview tool with structured conditions, `nextDayAt` timing, timezone, and a structured monthly-invoice upload action.
3. WeMail returns a readable preview and PI proposes rule creation.
4. The UI shows the complete configuration-confirmation card.
5. The user confirms, and WeMail creates and enables the rule with its authorization snapshot.
6. A matching email creates one durable execution due at the correct next-day local time.
7. At the due time, the automation engine calls the wecli adapter without another confirmation or PI run.
8. Success, retry, terminal failure, disable, cancellation, and restart recovery are observable and tested.
9. The same batch also verifies smart-tag CRUD, direct draft creation and modification, and confirmed sending.

## Migration and Compatibility

- Stored `mailReceived` rules without execution timing deserialize as `immediate`.
- Existing fixed scheduled triggers keep their current behavior.
- Existing generic external actions remain readable but cannot be newly created as executable actions unless a structured adapter exists.
- Database migrations must be additive and preserve existing rules and run history.

## Non-Goals

- Giving PI arbitrary HTTP, database, shell, or filesystem access.
- Making PI a participant in each automatic rule execution.
- Allowing unconfirmed expansion of an automation rule's authority.
- Managing credentials or security policy through natural language.
- Completing Batch 2 in the Batch 1 change set.
