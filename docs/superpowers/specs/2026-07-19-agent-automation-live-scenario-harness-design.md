# Configurable Temporal Fields and Agent Automation Live Scenarios Design

## Context

WeMail can create automation rules through chat, persist confirmed rules,
match incoming mail, defer execution, and upload invoice attachments through
WeCLI. It already supports immediate and mail-received-relative scheduling, but
users cannot choose enriched business fields such as invoice issue date when
describing when an action should run.

Invoice issue date is not itself a mandatory business policy. It is one
additional field users may reference in a rule. These are both valid and must
remain independent choices:

> 收到发票类型邮件 24 小时后，通过 wecli 把发票上传至发票平台。

> 收到发票类型邮件后，等邮件中所有发票的最晚开票日期满 24 小时，再通过 wecli 把发票上传至发票平台。

If a user explicitly says that missing issue dates should fall back to the mail
received time, the rule may express that too. The platform must not add that
fallback implicitly.

This change must also introduce a reusable live integration-test mechanism
that sends such requests to a real configured LLM while replacing the final
external WeCLI process with a recorder.

## Design Principles

- **Capability, not policy:** expose fields and operators; do not choose the
  user's business timing rule.
- **Composable but bounded:** add the smallest temporal expression language
  needed for field reference, collection aggregation, fallback, and duration
  arithmetic.
- **Domain enrichment behind generic fields:** invoice code produces
  `invoice.issueDate`; automation code only resolves registered field paths.
- **No implicit semantics:** aggregation, fallback, timezone, and duration come
  from the persisted rule.
- **Dependency-driven waiting:** only rules that reference asynchronous fields
  wait for their enrichment.
- **Reusable scenario orchestration:** new live scenarios declare inputs and
  expectations rather than copy application setup and workflow code.

## Goals

- Add a discoverable automation field catalog containing both native and
  enriched temporal fields.
- Register `mail.receivedAt` as an immediate scalar `datetime` field.
- Register `invoice.issueDate` as an asynchronously enriched,
  attachment-scoped collection of `date` values.
- Add a minimal temporal expression AST supporting field reference,
  `max`/`min`, explicit `coalesce`, and duration addition.
- Let the Agent translate natural language into this AST through the existing
  automation proposal tools.
- Preserve existing immediate, fixed-delay, and next-day rule behavior.
- Extract issue dates from machine-readable invoice PDFs and retain status and
  provenance.
- Schedule durable execution when the selected expression resolves.
- Prove both received-time and latest-issue-date choices through reusable live
  scenarios with real LLM calls.
- Prevent all real invoice-platform mutations in tests.

## Non-Goals

- Enforcing that invoice mail always uses invoice issue date.
- Automatically falling back from issue date to received time.
- Automatically choosing `max` instead of another supported aggregation.
- Replacing all existing execution modes with the expression AST.
- Building an arbitrary boolean or general-purpose expression interpreter.
- Supporting OCR or model-based PDF extraction in the first iteration.
- Adding invoice-specific columns to the canonical `mail_messages` table.
- Making live LLM tests part of the default test command or mandatory CI.

## Rule Model

### Existing Behavior Remains Valid

Existing execution choices such as immediate execution, fixed delay after mail
receipt, and next-day-at-time remain supported. A rule generated from “收到邮件
24 小时后执行” may continue to use the existing fixed-delay representation if
it is semantically equivalent to `mail.receivedAt + 24 hours`.

### Temporal Expression Execution

Add one new execution variant:

```ts
interface AtExpressionExecution {
  type: "atExpression";
  expression: TemporalExpression;
  timezone: string;
}
```

The bounded AST is:

```ts
type TemporalExpression =
  | {
      type: "field";
      path: string;
      scope?: "mail" | "matchingAttachments";
    }
  | {
      type: "aggregate";
      operator: "max" | "min";
      values: TemporalExpression;
    }
  | {
      type: "coalesce";
      values: TemporalExpression[];
    }
  | {
      type: "addDuration";
      base: TemporalExpression;
      duration: {
        amount: number;
        unit: "minute" | "hour" | "day";
      };
    };
```

The validator checks expression shape and types:

- a scalar field cannot be aggregated;
- a collection must be reduced before it can be used as `addDuration.base`;
- `coalesce` operands must resolve to compatible temporal scalar types;
- duration amount must be a positive finite integer;
- expression depth and node count are bounded;
- every field path must exist in the field catalog; and
- the execution timezone must be a valid supported IANA timezone.

The AST is intentionally not a general condition language. The existing
mail-received event and matching conditions still decide which mail instances
enter automation. The temporal expression computes `dueAt` for each matched
instance.

## Automation Field Catalog

### Definition

Fields exposed to users and the Agent are registered:

```ts
interface AutomationFieldDefinition {
  path: string;
  label: string;
  description: string;
  valueType: "date" | "datetime";
  cardinality: "one" | "many";
  scope: "mail" | "attachment";
  availability: "immediate" | "enriched";
}
```

Initial entries:

```ts
[
  {
    path: "mail.receivedAt",
    label: "收到邮件的时间",
    description: "邮件进入邮箱的精确时间",
    valueType: "datetime",
    cardinality: "one",
    scope: "mail",
    availability: "immediate"
  },
  {
    path: "invoice.issueDate",
    label: "发票开票日期",
    description: "从发票附件中抽取的开票日期；一封邮件可能有多个值",
    valueType: "date",
    cardinality: "many",
    scope: "attachment",
    availability: "enriched"
  }
]
```

The same definitions drive runtime validation, Agent tool descriptions, prompt
guidance, and deterministic semantic assertions. This avoids maintaining
separate lists that drift.

### Resolution States

The generic resolver returns one of:

```ts
type TemporalResolution =
  | { status: "ready"; valueType: "date" | "datetime"; values: string[] }
  | { status: "pending"; dependencies: SemanticFieldDependency[] }
  | { status: "unavailable"; reasons: FieldUnavailableReason[] };
```

- `mail.receivedAt` is always immediately ready.
- `invoice.issueDate` is pending while any matching invoice attachment still
  requires extraction.
- It is ready only when every matching invoice attachment has a valid issue
  date.
- It is unavailable when any matching attachment is terminal without a usable
  issue date. This prevents `max` from silently ignoring an unknown invoice.
- `max` and `min` operate only on ready collections.
- `coalesce` tries its next operand only when the previous operand is
  unavailable, never while it is pending.
- Without an explicit `coalesce`, unavailable input leaves the execution in an
  auditable `blocked_missing_field` state instead of inventing a fallback.

### Temporal Semantics

`mail.receivedAt` is a timestamp. Adding 24 hours means 24 elapsed hours from
that timestamp.

`invoice.issueDate` is an ISO calendar date (`YYYY-MM-DD`). When a date must
become an instant for duration arithmetic, it is anchored at `00:00` in the
rule's timezone. Therefore, issue date plus 24 hours is the next local
calendar day's midnight. The timezone and conversion are stored with the rule
and scheduling snapshot.

If the calculated `dueAt` is already past when the expression resolves, the
execution becomes runnable immediately.

## Example Rules

### Received Time Plus 24 Hours

The user request:

> 收到发票类型邮件 24 小时后上传。

may remain represented by the existing delay:

```ts
{
  type: "delay",
  amount: 24,
  unit: "hour"
}
```

or by the equivalent expression:

```ts
{
  type: "atExpression",
  timezone: "Asia/Shanghai",
  expression: {
    type: "addDuration",
    base: {
      type: "field",
      path: "mail.receivedAt",
      scope: "mail"
    },
    duration: { amount: 24, unit: "hour" }
  }
}
```

Both are valid. Semantic tests compare meaning rather than requiring one JSON
shape.

### Latest Invoice Issue Date Plus 24 Hours

The user request:

> 等邮件中所有发票的最晚开票日期满 24 小时后上传。

is represented by:

```ts
{
  type: "atExpression",
  timezone: "Asia/Shanghai",
  expression: {
    type: "addDuration",
    base: {
      type: "aggregate",
      operator: "max",
      values: {
        type: "field",
        path: "invoice.issueDate",
        scope: "matchingAttachments"
      }
    },
    duration: { amount: 24, unit: "hour" }
  }
}
```

This rule does not fall back to `mail.receivedAt`.

### Explicit Fallback

Only a request such as:

> 优先按最晚开票日期，取不到时按收件时间，满 24 小时后上传。

adds:

```ts
{
  type: "addDuration",
  base: {
    type: "coalesce",
    values: [
      {
        type: "aggregate",
        operator: "max",
        values: {
          type: "field",
          path: "invoice.issueDate",
          scope: "matchingAttachments"
        }
      },
      {
        type: "field",
        path: "mail.receivedAt",
        scope: "mail"
      }
    ]
  },
  duration: { amount: 24, unit: "hour" }
}
```

## Invoice Issue-Date Enrichment

Invoice-specific code is responsible only for producing the registered
semantic field:

```ts
interface MailSemanticAttribute {
  emailId: string;
  attachmentId: string;
  fieldPath: "invoice.issueDate";
  valueType: "date";
  value?: string;
  status: "pending" | "ready" | "unavailable";
  source?: "pdf-text";
  confidence?: number;
  extractorVersion: number;
  extractedAt?: string;
  reasonCode?: string;
}
```

An `InvoiceMetadataExtractor` processes every matching invoice PDF:

1. fetch the attachment through the existing attachment boundary;
2. extract machine-readable PDF text;
3. recognize and validate the issue date;
4. persist a terminal attribute per attachment with provenance; and
5. notify deferred automation that a field dependency changed.

The first implementation may persist this document through the existing
intelligence-result JSON repository behind a generic semantic-attribute reader.
It does not add `invoiceIssueDate` to the raw mail model.

Attachment bytes and extracted PDF text must never be logged. A terminal
failure is represented as unavailable with a bounded reason code after the
extractor's retry policy.

Enrichment is dependency driven:

- a received-time-only rule schedules without waiting for PDF extraction;
- a rule referencing `invoice.issueDate` creates a waiting dependency and
  starts or joins invoice enrichment; and
- repeated events and scheduler ticks are idempotent.

## Deferred Execution

Expression-driven executions use these durable states:

```text
waiting_fields -> pending -> running -> succeeded
                    |          \-> failed
                    \-> blocked_missing_field
```

1. Mail matching creates one idempotent execution.
2. The expression evaluator returns ready, pending, or unavailable.
3. Ready produces a `dueAt`; past due times are immediately runnable.
4. Pending stores field dependencies and waits for enrichment notification.
5. Unavailable without a resolvable `coalesce` becomes
   `blocked_missing_field`.
6. A field-ready notification reevaluates the complete persisted expression.
7. Reevaluation and scheduler ticks cannot create duplicate action execution.

The execution stores a scheduling snapshot containing:

- the persisted temporal expression and timezone;
- resolved field values without document contents;
- aggregate and fallback decisions;
- calculated `dueAt`; and
- any missing-field reason.

## Agent Integration

The automation proposal tool schema exposes `atExpression` and the bounded AST.
The Agent prompt receives the field catalog with Chinese labels, descriptions,
types, cardinality, and examples.

The Agent must preserve user choice:

- “收到后 24 小时” maps to received-time delay semantics;
- “最晚开票日期满 24 小时” maps to `max(invoice.issueDate) + 24h`;
- a fallback is emitted only when the request states one;
- an aggregation is emitted only when stated or grammatically necessary for a
  collection field; and
- when a collection field is referenced without a resolvable aggregation, the
  Agent asks for clarification instead of silently choosing.

Rule preview presents the selected timing in user language so confirmation is
meaningful.

## Reusable Live Scenario Harness

### Architecture

Add a test-only stage runner with four layers:

1. **Environment gate**
   - resolve existing WeMail LLM configuration;
   - require `WEMAIL_LIVE_LLM=1`; and
   - skip clearly when configuration is absent.

2. **Application fixture**
   - use a temporary database and data directory;
   - compose real Agent, pending-action, automation, enrichment, attachment,
     allowance, and audit services;
   - inject a virtual clock and fixture-backed attachment provider.

3. **External boundary recorder**
   - replace only the final WeCLI process runner;
   - record executable and argument vectors;
   - return successful JSON without external mutation; and
   - preserve command classification, staging, and audit behavior.

4. **Declarative scenarios**
   - declare chat request, expected semantic rule, mail/PDF fixtures, clock
     steps, and expected external calls;
   - reuse stages for chat, proposal confirmation, mail ingestion, enrichment,
     scheduling, clock advancement, and due execution.

### Test-Only Contracts

```ts
interface AgentAutomationLiveScenario {
  name: string;
  chat: {
    userText: string;
    expectedRule: SemanticRuleExpectation;
  };
  incomingMail: ScenarioMailFixture;
  expectedSemanticAttributes?: ScenarioSemanticExpectation[];
  clockSteps: ScenarioClockStep[];
  expectedExternalCalls: ScenarioExternalCallExpectation[];
}

type SemanticRuleExpectation =
  | {
      timingMeaning: "received-at-plus-duration";
      duration: { amount: 24; unit: "hour" };
      forbiddenFields?: ["invoice.issueDate"];
    }
  | {
      timingMeaning: "latest-invoice-issue-date-plus-duration";
      duration: { amount: 24; unit: "hour" };
      fallbackField?: "mail.receivedAt";
    };
```

Semantic assertions inspect normalized meaning, not incidental JSON shape.
Every failure includes a named scenario stage.

### Required Live Scenarios

The dedicated live suite runs one real Agent conversation per scenario. The
Agent may make multiple model requests while previewing and proposing the rule:

1. **Received-time choice**
   - prompt: “收到发票类型邮件 24 小时后，通过 wecli 把发票上传至发票平台”;
   - rule must use existing delay or `mail.receivedAt + 24h`;
   - rule must not acquire an `invoice.issueDate` dependency;
   - mail received at `2026-07-20T10:00:00+08:00` becomes due exactly at
     `2026-07-21T10:00:00+08:00`.

2. **Latest-issue-date choice**
   - prompt: “收到发票类型邮件后，等邮件中所有发票的最晚开票日期满 24 小时，再通过 wecli 把发票上传至发票平台”;
   - rule must use `max(invoice.issueDate) + 24h` with no implicit fallback;
   - two real, minimal PDF fixtures contain issue dates `2026-07-18` and
     `2026-07-20`;
   - the production PDF and invoice extractors must produce both attributes;
   - the mail becomes due at `2026-07-21T00:00:00+08:00`.

Both scenarios confirm the pending Agent action through the production
executor, persist and enable the rule, prove no early WeCLI call, run due work,
and stage the expected PDF bytes. The received-time scenario records one
allowance-upload invocation for its one PDF. The latest-issue-date scenario
still has one mail-level rule execution, but records two WeCLI invocations
because the existing allowance service uploads each PDF separately.

Deterministic companion tests cover:

- expression validation and depth/node limits;
- received timestamp plus elapsed duration;
- date-only anchoring in the configured timezone;
- `max`/`min` aggregation;
- pending propagation;
- explicit `coalesce` behavior;
- unavailable input without fallback;
- field-ready reevaluation and idempotency;
- machine-readable PDF issue-date extraction; and
- semantic comparison of existing delay and received-time expressions.

## Failure Reporting and Safety

Named failures include:

- `model-did-not-propose-rule`
- `proposed-rule-not-semantic-match`
- `rule-confirmation-failed`
- `unexpected-field-dependency`
- `semantic-extraction-did-not-complete`
- `execution-did-not-wait-for-fields`
- `field-driven-due-time-mismatch`
- `wecli-ran-before-due`
- `due-execution-did-not-upload`
- `uploaded-attachment-mismatch`

Credentials, attachment contents, extracted PDF text, full real mail bodies,
and absolute staging paths must not be logged.

The executable is
`server/wemail/agent/AgentAutomationScenario.live.ts`. Its filename does not
end in `.test.ts`, so default discovery excludes it. A dedicated command runs
it:

```text
npm run test:live:agent-automation
```

The command skips clearly unless the opt-in flag and LLM configuration exist.
Completion requires at least one successful local run of both scenarios with a
real model.

## Complexity Controls

- Reuse existing delay behavior for received-time rules.
- Add one bounded AST variant rather than replacing the existing rule model.
- Keep the field catalog as the single source for validation and Agent
  descriptions.
- Keep invoice knowledge out of the expression evaluator and scheduler.
- Keep fallback explicit in the AST.
- Keep asynchronous waiting limited to referenced enriched fields.
- Upload a multi-invoice mail as one batch; partial attachment execution is
  outside this iteration.
- Keep Harness orchestration under test/support paths.
- Add scenario DSL fields only for concrete scenarios.
- Do not alter production code solely to expose test state.

## Acceptance Criteria

- Both natural-language choices produce distinct, semantically correct rules
  through real configured LLM calls.
- A received-time rule retains exact 24-hour delay behavior and does not wait
  for invoice enrichment.
- A latest-issue-date rule resolves all matching attachment dates, selects the
  maximum, anchors the date in the rule timezone, and adds 24 hours.
- The platform never adds a received-time fallback unless the rule contains
  one.
- `invoice.issueDate` is discoverable as a user-configurable automation field
  and is not a canonical email-table column.
- Existing execution modes remain valid.
- Pending enriched fields cannot cause early execution.
- Missing fields without fallback are auditable and do not execute.
- Confirmation persists and enables each rule.
- Due execution stages the expected PDFs and records exactly one external
  allowance-upload call per matching attachment.
- No real WeCLI process or invoice-platform mutation occurs.
- Default tests exclude the live suite.
- Future field-based scenarios reuse the catalog, evaluator, and Harness
  without copying orchestration.
