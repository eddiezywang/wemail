# Automation Condition Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixed structured condition fields with flexible condition rows that support all/any matching and negative operators.

**Architecture:** Add `conditionMode` and `conditionRules` to the shared rule contract while keeping legacy `conditions` as a fallback. Backend matching evaluates rule rows first, then falls back to legacy conditions; the frontend renders rows inside the hidden condition rule builder.

**Tech Stack:** TypeScript shared contracts, Node ESM control-plane tests with `node:test`, React + Vite desktop UI, existing Hono route handlers and repository pattern.

---

### Task 1: Shared Condition Rule Contract

**Files:**
- Modify: `shared/wemail/automation.ts`
- Modify: `app/queries/automationRules.ts`

- [ ] **Step 1: Add shared types**

In `shared/wemail/automation.ts`, add:

```ts
export type AutomationConditionMode = "all" | "any";

export type AutomationConditionField =
  | "sender"
  | "recipient"
  | "cc"
  | "subject"
  | "body"
  | "hasAttachment"
  | "aiTag";

export type AutomationConditionOperator =
  | "contains"
  | "notContains"
  | "equals"
  | "notEquals"
  | "exists"
  | "notExists";

export interface AutomationConditionRule {
  id: string;
  field: AutomationConditionField;
  operator: AutomationConditionOperator;
  value?: string | boolean;
}
```

Extend `AutomationRule`:

```ts
conditionMode?: AutomationConditionMode;
conditionRules?: AutomationConditionRule[];
```

- [ ] **Step 2: Update frontend mutation types**

In `app/queries/automationRules.ts`, import `AutomationConditionMode` and `AutomationConditionRule`. Add optional `conditionMode?: AutomationConditionMode` and `conditionRules?: AutomationConditionRule[]` to create and update mutation input types.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

### Task 2: Matcher Semantics

**Files:**
- Create: `server/wemail/automation/AutomationRuleMatcher.test.ts`
- Modify: `server/wemail/automation/AutomationRuleMatcher.ts`

- [ ] **Step 1: Write failing matcher tests**

Create tests for:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesConditionRules,
  matchesStructuredConditions,
} from "./AutomationRuleMatcher.js";
import type { AutomationConditionRule } from "../../../shared/wemail/automation.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";

const message = {
  id: "email-1",
  accountId: "acct-1",
  threadId: "thread-1",
  folder: "inbox",
  from: { email: "alerts@github.com", name: "GitHub" },
  to: [{ email: "me@example.com", name: "Me" }],
  cc: [],
  subject: "Build failed",
  snippet: "CI pipeline failed",
  bodyText: "CI pipeline failed on main",
  hasAttachments: true,
  date: "2026-06-26T00:00:00.000Z",
  read: false,
  starred: false,
  important: false,
} as MailMessage;

test("matches all condition rules", () => {
  const rules: AutomationConditionRule[] = [
    { id: "r1", field: "sender", operator: "contains", value: "github.com" },
    { id: "r2", field: "subject", operator: "notContains", value: "unsubscribe" },
  ];
  assert.equal(matchesConditionRules("all", rules, message), true);
});

test("matches any condition rule", () => {
  const rules: AutomationConditionRule[] = [
    { id: "r1", field: "sender", operator: "contains", value: "stripe.com" },
    { id: "r2", field: "body", operator: "contains", value: "main" },
  ];
  assert.equal(matchesConditionRules("any", rules, message), true);
});

test("supports exists and notExists operators", () => {
  assert.equal(
    matchesConditionRules("all", [
      { id: "r1", field: "hasAttachment", operator: "exists" },
    ], message),
    true,
  );
  assert.equal(
    matchesConditionRules("all", [
      { id: "r1", field: "cc", operator: "notExists" },
    ], message),
    true,
  );
});

test("supports aiTag condition rules", () => {
  assert.equal(
    matchesConditionRules(
      "all",
      [{ id: "r1", field: "aiTag", operator: "equals", value: "devops" }],
      message,
      (emailId, tagName) => emailId === "email-1" && tagName === "devops",
    ),
    true,
  );
});

test("keeps legacy structured condition fallback", () => {
  assert.equal(
    matchesStructuredConditions({ sender: "github.com" }, message),
    true,
  );
});
```

Run: `node --import tsx --test server/wemail/automation/AutomationRuleMatcher.test.ts`

Expected: FAIL because `matchesConditionRules` is not implemented.

- [ ] **Step 2: Implement matcher**

In `AutomationRuleMatcher.ts`, add exported `matchesConditionRules(mode, rules, message, messageHasTag?)`. Implement helpers:

```ts
function fieldValues(field: AutomationConditionField, message: MailMessage): string[] | boolean[] {
  switch (field) {
    case "sender": return [message.from.email, message.from.name].filter(Boolean);
    case "recipient": return message.to.flatMap((addr) => [addr.email, addr.name].filter(Boolean));
    case "cc": return message.cc.flatMap((addr) => [addr.email, addr.name].filter(Boolean));
    case "subject": return [message.subject].filter(Boolean);
    case "body": return [`${message.snippet}\n${message.bodyText ?? ""}`];
    case "hasAttachment": return [message.hasAttachments];
    case "aiTag": return [];
  }
}
```

Rules:

- `contains`: any text value contains the string value.
- `notContains`: no text value contains the string value.
- `equals`: for `aiTag`, use `messageHasTag`; otherwise any text or boolean value equals the rule value.
- `notEquals`: inverse of equals.
- `exists`: field has a non-empty text value, true boolean, or matching AI tag when value is present.
- `notExists`: inverse of exists.

- [ ] **Step 3: Verify matcher tests**

Run: `node --import tsx --test server/wemail/automation/AutomationRuleMatcher.test.ts`

Expected: PASS.

### Task 3: Persistence and API

**Files:**
- Modify: `server/wemail/db/migrations.ts`
- Modify: `server/wemail/automation/AutomationRuleRepository.ts`
- Modify: `server/wemail/automation/AutomationRuleRepository.test.ts`
- Modify: `server/api/routes/automationRoutes.ts`
- Modify: `server/api/routes/automationRoutes.test.ts`

- [ ] **Step 1: Add repository tests**

Extend `AutomationRuleRepository.test.ts` with a test that creates a rule with:

```ts
conditionMode: "any",
conditionRules: [
  { id: "rule-row-1", field: "sender", operator: "contains", value: "github.com" },
],
```

Assert that `repo.get(rule.id)` and `repo.list(accountId)` preserve both fields.

- [ ] **Step 2: Add migration columns**

In migration id `34`, extend `automation_rules` with:

```sql
ALTER TABLE automation_rules ADD COLUMN condition_mode TEXT;
ALTER TABLE automation_rules ADD COLUMN condition_rules_json TEXT;
```

Use the same guarded migration pattern already used in the file.

- [ ] **Step 3: Persist new fields**

Update `AutomationRuleRepository`:

- Row type includes `condition_mode` and `condition_rules_json`.
- `create(input)` accepts optional `conditionMode` and `conditionRules`.
- `update(id, patch)` accepts optional `conditionMode` and `conditionRules`.
- `rowToRule(row)` returns `conditionMode: parseConditionMode(row.condition_mode)` and `conditionRules: parseConditionRules(row.condition_rules_json)`.
- Only emit `conditionRules` as `[]` when the DB value is null or invalid.

- [ ] **Step 4: Parse route bodies**

In `automationRoutes.ts`:

- Import `AutomationConditionMode` and `AutomationConditionRule`.
- Add `parseConditionMode(value)` accepting only `"all"` or `"any"`, defaulting to `"all"` when condition rules are present.
- Add `parseConditionRules(value)` accepting arrays of objects with string `id`, allowed `field`, allowed `operator`, and optional string/boolean `value`.
- In create and update, automatic rules are valid when any of these exists: natural-language condition, legacy `conditions`, or non-empty `conditionRules`.

- [ ] **Step 5: Verify backend tests**

Run:

```bash
node --import tsx --test server/wemail/automation/AutomationRuleRepository.test.ts
node --import tsx --test server/api/routes/automationRoutes.test.ts
```

Expected: PASS.

### Task 4: Execution Uses Rule Rows

**Files:**
- Modify: `server/wemail/automation/AutomationRuleExecutionService.ts`
- Modify: `server/wemail/automation/AutomationRuleExecutionService.test.ts`

- [ ] **Step 1: Add execution test**

Add a test that creates an enabled `mailReceived` rule with:

```ts
conditionMode: "all",
conditionRules: [
  { id: "row-1", field: "sender", operator: "contains", value: "github.com" },
  { id: "row-2", field: "subject", operator: "notContains", value: "unsubscribe" },
],
conditions: {},
```

Trigger `runForMailReceived(accountId, emailId)` and assert `matchedCount === 1` and `appliedCount === 1`.

- [ ] **Step 2: Switch execution filter**

In `evaluateAndApply`, replace direct legacy call with:

```ts
const structuredMatched =
  rule.conditionRules && rule.conditionRules.length > 0
    ? matchesConditionRules(
        rule.conditionMode ?? "all",
        rule.conditionRules,
        message,
        this.messageHasTag,
      )
    : matchesStructuredConditions(rule.conditions, message, this.messageHasTag);

if (!structuredMatched) return skippedResult();
```

- [ ] **Step 3: Verify execution tests**

Run: `node --import tsx --test server/wemail/automation/AutomationRuleExecutionService.test.ts`

Expected: PASS.

### Task 5: Advanced Filter UI

**Files:**
- Modify: `app/components/automation/AutomationRuleForm.tsx`

- [ ] **Step 1: Add form state and helpers**

Import condition rule types. Add state:

```ts
const [conditionMode, setConditionMode] = useState<AutomationConditionMode>("all");
const [conditionRules, setConditionRules] = useState<AutomationConditionRule[]>([]);
```

Hydration:

- Editing: use `editing.conditionMode ?? "all"` and `editing.conditionRules ?? legacyConditionsToRules(editing.conditions)`.
- Creating: use `"all"` and `legacyConditionsToRules(defaults?.conditions ?? {})`.
- Expand the condition rule builder when `conditionRules.length > 0`.

Add helpers:

```ts
function createConditionRule(): AutomationConditionRule {
  return { id: `condition-${Date.now()}-${Math.random().toString(36).slice(2)}`, field: "sender", operator: "contains", value: "" };
}
```

`legacyConditionsToRules` maps sender, recipient, cc, subjectKeyword, bodyKeyword, aiTag, and hasAttachment to equivalent rows.

- [ ] **Step 2: Replace fixed fields with row builder**

Inside “条件规则”, render:

- Match mode buttons: `全部满足`, `任一满足`.
- Rows with three controls: field select, operator select, value input when needed, delete button.
- Add button: `添加规则`.

Operators for `hasAttachment`: only `exists` and `notExists`.
Operators for text fields: `contains`, `notContains`, `equals`, `notEquals`, `exists`, `notExists`.

- [ ] **Step 3: Submit new fields**

Create and update payloads include:

```ts
conditionMode,
conditionRules: normalizeConditionRules(conditionRules),
conditions: {},
```

`normalizeConditionRules` drops rows with empty required values.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

### Task 6: Full Verification

**Files:**
- No source edits unless verification exposes defects.

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
node --import tsx --test server/wemail/automation/AutomationRuleMatcher.test.ts
node --import tsx --test server/wemail/automation/AutomationRuleRepository.test.ts
node --import tsx --test server/wemail/automation/AutomationRuleExecutionService.test.ts
node --import tsx --test server/api/routes/automationRoutes.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm run typecheck
npm run typecheck:server
npm run test:server
```

Expected: PASS.
