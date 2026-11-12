import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeTemporalExpression,
  assertValidAutomationRuleDraft,
} from "./AutomationRuleValidation.js";

// P2.6: the invoice.issueDate field definition is an edition module
// contribution; the open tests inject it explicitly so the (generic)
// temporal validation mechanism stays covered with a collection-scope field.
const INVOICE_ISSUE_DATE_DEFINITIONS = [
  {
    path: "invoice.issueDate",
    label: "发票开票日期",
    description: "从发票附件中抽取的开票日期；一封邮件可能有多个值",
    valueType: "date" as const,
    cardinality: "many" as const,
    scope: "attachment" as const,
    availability: "enriched" as const,
  },
];

const base = {
  accountId: "acct-1",
  name: "Latest invoice issue date",
  enabled: true,
  conditions: { hasAttachment: true },
  actions: [{
    type: "external" as const,
    adapter: "wecli.allowance.upload",
    input: { attachmentPolicy: "invoice" as const },
  }],
};

test("validator accepts max(invoice.issueDate) plus 24 hours", () => {
  assert.doesNotThrow(() => assertValidAutomationRuleDraft({
    ...base,
    trigger: {
      type: "mailReceived",
      execution: {
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
              scope: "matchingAttachments",
            },
          },
          duration: { amount: 24, unit: "hour" },
        },
      },
    },
  }, INVOICE_ISSUE_DATE_DEFINITIONS));
});

test("validator rejects an unreduced collection and unknown field", () => {
  assert.throws(() => assertValidAutomationRuleDraft({
    ...base,
    trigger: {
      type: "mailReceived",
      execution: {
        type: "atExpression",
        timezone: "Asia/Shanghai",
        expression: {
          type: "addDuration",
          base: {
            type: "field",
            path: "invoice.issueDate",
            scope: "matchingAttachments",
          },
          duration: { amount: 24, unit: "hour" },
        },
      },
    },
  }, INVOICE_ISSUE_DATE_DEFINITIONS), /temporal-expression-requires-scalar/);
});

test("validator rejects unknown fields and field scopes that do not match the catalog", () => {
  assert.throws(() => assertValidAutomationRuleDraft({
    ...base,
    trigger: {
      type: "mailReceived",
      execution: {
        type: "atExpression",
        timezone: "Asia/Shanghai",
        expression: { type: "field", path: "mail.sentAt", scope: "mail" },
      },
    },
  }), /temporal-expression-unknown-field/);

  assert.throws(() => assertValidAutomationRuleDraft({
    ...base,
    trigger: {
      type: "mailReceived",
      execution: {
        type: "atExpression",
        timezone: "Asia/Shanghai",
        expression: { type: "field", path: "mail.receivedAt", scope: "matchingAttachments" },
      },
    },
  }), /temporal-expression-field-scope-mismatch/);
});

test("validator preserves action, timing, and automatic-condition safeguards", () => {
  assert.throws(() => assertValidAutomationRuleDraft({
    ...base,
    conditions: {},
    trigger: { type: "mailReceived", execution: { type: "immediate" } },
  }), /automatic-rule-condition-required/);

  assert.throws(() => assertValidAutomationRuleDraft({
    ...base,
    trigger: { type: "mailReceived", execution: { type: "delay", amount: 0, unit: "hour" } },
  }), /invalid-mail-received-delay/);

  assert.throws(() => assertValidAutomationRuleDraft({
    ...base,
    trigger: {
      type: "mailReceived",
      execution: { type: "nextDayAt", localTime: "24:00", timezone: "Asia/Shanghai" },
    },
  }), /invalid-next-day-local-time/);
});

test("temporal expression analysis rejects unknown node types", () => {
  assert.throws(() => analyzeTemporalExpression(
    { type: "subtractDuration" } as never,
  ), /temporal-expression-invalid-node/);
});

test("temporal expression analysis rejects unsupported aggregate operators", () => {
  assert.throws(() => analyzeTemporalExpression({
    type: "aggregate",
    operator: "median",
    values: { type: "field", path: "invoice.issueDate", scope: "matchingAttachments" },
  } as never), /temporal-expression-invalid-aggregate-operator/);
});

test("temporal expression analysis rejects malformed and null nodes", () => {
  for (const expression of [
    null,
    { type: "aggregate", operator: "max", values: null },
    { type: "coalesce", values: [null] },
    { type: "addDuration", base: null, duration: null },
  ]) {
    assert.throws(() => analyzeTemporalExpression(expression as never), /temporal-expression-invalid-node/);
  }
});

test("validator rejects invalid legacy timing units and missing expression timezones", () => {
  assert.throws(() => assertValidAutomationRuleDraft({
    ...base,
    trigger: {
      type: "mailReceived",
      execution: { type: "delay", amount: 1, unit: "week" },
    },
  } as never), /invalid-mail-received-delay/);

  assert.throws(() => assertValidAutomationRuleDraft({
    ...base,
    trigger: {
      type: "mailReceived",
      execution: { type: "nextDayAt", localTime: "09:00", timezone: "" },
    },
  } as never), /invalid-next-day-timezone/);

  assert.throws(() => assertValidAutomationRuleDraft({
    ...base,
    trigger: {
      type: "mailReceived",
      execution: {
        type: "atExpression",
        timezone: "",
        expression: { type: "field", path: "mail.receivedAt", scope: "mail" },
      },
    },
  } as never), /invalid-at-expression-timezone/);
});

test("validator rejects malformed rule containers with stable domain errors", () => {
  const cases = [
    {
      rule: null,
      error: /invalid-automation-rule/,
    },
    {
      rule: { ...base, trigger: undefined },
      error: /automation-rule-trigger-required/,
    },
    {
      rule: { ...base, accountId: 42, trigger: { type: "manual" } },
      error: /automation-rule-account-required/,
    },
    {
      rule: { ...base, name: null, trigger: { type: "manual" } },
      error: /automation-rule-name-required/,
    },
    {
      rule: { ...base, conditions: undefined, trigger: { type: "manual" } },
      error: /automation-rule-conditions-required/,
    },
    {
      rule: { ...base, conditions: [], trigger: { type: "manual" } },
      error: /automation-rule-conditions-required/,
    },
    {
      rule: { ...base, actions: undefined, trigger: { type: "manual" } },
      error: /automation-rule-actions-required/,
    },
    {
      rule: { ...base, trigger: { type: "mailDeleted" } },
      error: /automation-rule-trigger-required/,
    },
    {
      rule: {
        ...base,
        trigger: {
          type: "mailReceived",
          execution: { type: "afterBusinessDays", amount: 1 },
        },
      },
      error: /invalid-mail-received-execution/,
    },
  ];

  for (const item of cases) {
    assert.throws(
      () => assertValidAutomationRuleDraft(item.rule as never),
      item.error,
    );
  }
});

test("validator rejects malformed optional and action shapes without raw TypeErrors", () => {
  const cases = [
    {
      rule: { ...base, trigger: { type: "manual" }, enabled: "yes" },
      error: /invalid-automation-rule-enabled/,
    },
    {
      rule: { ...base, trigger: { type: "manual" }, conditionMode: "none" },
      error: /invalid-automation-condition-mode/,
    },
    {
      rule: { ...base, trigger: { type: "manual" }, conditionRules: {} },
      error: /invalid-automation-condition-rules/,
    },
    {
      rule: { ...base, trigger: { type: "manual" }, naturalLanguageCondition: 42 },
      error: /invalid-automation-natural-language-condition/,
    },
    {
      rule: { ...base, trigger: { type: "manual" }, actions: [null] },
      error: /invalid-automation-action/,
    },
    {
      rule: {
        ...base,
        trigger: { type: "manual" },
        actions: [{ type: "external", adapter: "wecli.operation", input: null }],
      },
      error: /invalid-automation-action/,
    },
    {
      rule: { ...base, trigger: { type: "manual" }, actions: [{ type: "teleport" }] },
      error: /invalid-automation-action/,
    },
  ];

  for (const item of cases) {
    assert.throws(
      () => assertValidAutomationRuleDraft(item.rule as never),
      item.error,
    );
  }
});

test("validator sends null atExpression nodes through the stable analyzer error", () => {
  assert.throws(() => assertValidAutomationRuleDraft({
    ...base,
    trigger: {
      type: "mailReceived",
      execution: {
        type: "atExpression",
        timezone: "Asia/Shanghai",
        expression: null,
      },
    },
  } as never), /temporal-expression-invalid-node/);
});
