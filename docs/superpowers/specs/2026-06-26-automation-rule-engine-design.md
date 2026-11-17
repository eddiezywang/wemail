# Automation Rule Engine Design

## Summary

Upgrade the existing automation feature into a real rule engine. Rules can
trigger automatically when new mail is received or on a schedule. Users describe
the matching rule in natural language, the model decides whether the rule
matches, and matched rules execute configured actions automatically.

The first implementation extends the current `server/wemail/automation` system
instead of creating a parallel subsystem. Existing structured conditions,
automation CRUD, dry-run, and manual run behavior remain compatible.

External actions are part of the rule/action contract in this design, but the
first implementation does not execute them. They are recorded as unsupported so
future external action adapters can be added without changing the rule model.

## Goals

- Support automatic rule triggers for new incoming mail and scheduled runs.
- Support natural-language rule conditions evaluated by the configured model.
- Execute mailbox actions automatically when a rule matches.
- Represent external actions in the action model without executing them yet.
- Centralize rule matching and action execution outside HTTP route handlers.
- Preserve compatibility for existing automation rules.
- Record enough audit detail to explain what ran, what matched, and what failed.

## Non-Goals

- Do not implement external action adapters, HTTP calls, scripts, MCP, or WeCLI
  execution in the first version.
- Do not require user confirmation at trigger time for automatic rules.
- Do not migrate to a separate rule-engine subsystem.
- Do not log full mail body content in application logs.

## Architecture

Add a domain service, `AutomationRuleExecutionService`, under
`server/wemail/automation`. This service becomes the single execution path for:

- incoming-mail triggers,
- scheduled triggers,
- manual API runs.

The service depends on the existing rule repository and mail repository, plus
two new collaborators:

- `NaturalLanguageRuleEvaluator`: evaluates a natural-language condition against
  a mail context using the configured LLM client.
- `AutomationActionExecutor`: executes supported mailbox actions and records
  unsupported external actions.

`server/api/routes/automationRoutes.ts` should keep CRUD and manual endpoints,
but matching and action application should move out of the route file into the
execution service.

Incoming-mail triggers attach to `Mail Core sync worker`'s `"new-mail"` event in the
per-account lifecycle composition. Scheduled triggers attach to the existing
60-second scheduler tick pattern in the composition root or mail composition.

## Rule Model

Extend `AutomationRule` in `shared/wemail/automation.ts`:

```ts
export type AutomationTrigger =
  | { type: "manual" }
  | { type: "mailReceived" }
  | {
      type: "scheduled";
      intervalMinutes: number;
      timezone?: string;
      nextRunAt?: string;
    };

export interface AutomationRule {
  id: string;
  accountId: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  naturalLanguageCondition?: string;
  conditions: AutomationConditions;
  actions: AutomationAction[];
  createdAt: string;
  updatedAt: string;
}
```

`conditions` remains the structured pre-filter and compatibility layer. Existing
rules without trigger data should default to `{ type: "manual" }` when read, so
they do not unexpectedly begin executing automatically.

New UI should expose `mailReceived` and `scheduled` for new automatic rules.
`manual` exists for compatibility and direct API/manual-run behavior.

## Action Model

Keep existing mailbox actions and add an external action declaration:

```ts
export type AutomationAction =
  | { type: "applyLabel"; label: string }
  | { type: "star" }
  | { type: "archive" }
  | { type: "trash" }
  | { type: "spam" }
  | { type: "notSpam" }
  | { type: "markImportant" }
  | { type: "markNotImportant" }
  | { type: "markRead" }
  | { type: "markUnread" }
  | { type: "suppressTodoCreation" }
  | { type: "external"; adapter: string; input: Record<string, unknown> };
```

The first implementation stores and reports external actions but does not run
them. Execution result:

```json
{
  "type": "external",
  "status": "unsupported",
  "reason": "external-action-adapter-not-implemented"
}
```

## Database Changes

Extend `automation_rules`:

- `trigger_json TEXT`
- `natural_language_condition TEXT`

Extend `automation_rule_runs`:

- `trigger_kind TEXT`
- `trigger_key TEXT`
- `status TEXT`
- `action_results_json TEXT`

Add a unique index on `(rule_id, trigger_key)` for automatic trigger
idempotency.

Trigger key examples:

- `mailReceived:<emailId>`
- `scheduled:<ruleId>:<windowStartIso>`

Repository reads should tolerate older rows with null trigger fields and return a
manual trigger default.

## Execution Flow

### Incoming Mail

1. `Mail Core sync worker` inserts a new message and emits `"new-mail"`.
2. Per-account lifecycle listener calls
   `executionService.runForMailReceived(accountId, emailId)`.
3. The service lists enabled `mailReceived` rules for the account.
4. For each rule, it checks idempotency with `mailReceived:<emailId>`.
5. Structured conditions run as a local pre-filter.
6. If `naturalLanguageCondition` is present, the evaluator asks the model for a
   strict JSON decision: `matched`, `confidence`, and `reason`.
7. Matched rules execute actions in order.
8. A run row records match status, action results, and failure details.

### Scheduled

1. A scheduler tick calls `executionService.runDueScheduled(accountId)`.
2. The service finds enabled scheduled rules with `nextRunAt <= now`.
3. It builds a window key such as
   `scheduled:<ruleId>:<nextRunAt>`.
4. It skips windows already recorded for that rule.
5. The first version evaluates scheduled rules against the recent mailbox
   collection, defaulting to the most recent 200 messages for the account.
6. For each candidate message, it applies the same pre-filter, model evaluation,
   and action execution path used by incoming mail.
7. It updates `nextRunAt` by adding `intervalMinutes`.
8. It records a run summary and per-action results.

### Manual Run

`POST /api/automation/rules/:id/run` remains available, but delegates to
`AutomationRuleExecutionService.runRuleManually`. Manual dangerous-action
confirmation remains supported for route compatibility. Automatic triggers do
not ask for confirmation at trigger time.

## Natural-Language Evaluation

`NaturalLanguageRuleEvaluator` receives:

- rule id and natural-language condition,
- trigger kind,
- account id,
- mail metadata,
- subject,
- snippet,
- truncated plain text body.

It must not include full HTML or attachments. It returns:

```ts
interface NaturalLanguageRuleDecision {
  matched: boolean;
  confidence: number;
  reason: string;
}
```

Failure behavior is fail-closed. Missing model configuration, invalid JSON,
timeouts, and provider errors all produce a non-match with an audit reason such
as `llm-unavailable` or `evaluation-failed`.

## Error Handling

- A failing rule does not block other rules.
- A failing action does not roll back earlier actions.
- The first implementation continues executing later actions after a failed or
  unsupported action and records each action result.
- Structured-condition mismatch should skip LLM evaluation.
- LLM evaluation failure must not execute actions.
- External actions are always marked `unsupported` in the first version.
- Logs must not include message bodies.

## Safety And Idempotency

Automatic rules execute real mailbox actions, including destructive actions like
trash and spam. Safety comes from creation-time validation, explicit action
lists, fail-closed evaluation, and idempotent execution.

Creation and update validation should reject automatic rules that have no
structured conditions and no natural-language condition. This prevents broad
rules from accidentally applying actions to every new or recent message.

The execution service should guard against duplicate work with both database
idempotency (`rule_id + trigger_key`) and an in-memory per-rule in-flight guard
for scheduler overlap.

Existing rules are treated as manual by default so migration does not cause
unexpected automatic execution.

## UI Impact

Update `AutomationRuleForm` to support:

- trigger timing: incoming mail or scheduled interval,
- natural-language condition text,
- existing structured conditions,
- existing mailbox actions,
- external action declarations as stored-but-not-executed entries.

The UI should make clear that external actions are saved for future adapter
support and are not executed in the first version.

## Testing Strategy

Backend tests should drive implementation:

- Repository tests for trigger fields, natural-language condition fields, legacy
  defaults, and run-result fields.
- Execution service tests for:
  - incoming-mail trigger executing mailbox actions,
  - duplicate incoming-mail trigger idempotency,
  - disabled rules skipping execution,
  - structured mismatch skipping LLM evaluation,
  - natural-language non-match skipping actions,
  - evaluator errors failing closed,
  - external actions producing unsupported results,
  - scheduled rules running when due and updating `nextRunAt`.
- Route tests to verify manual run delegates to the execution service and keeps
  compatibility behavior.
- Composition/lifecycle tests to verify `"new-mail"` wires to automation
  execution.

Frontend verification should include `npm run typecheck`. Add component tests if
the trigger/natural-language UI behavior becomes non-trivial.
