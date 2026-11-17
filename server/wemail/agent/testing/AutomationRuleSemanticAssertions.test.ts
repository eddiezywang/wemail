import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AutomationRule,
  MailReceivedExecutionTiming,
} from "../../../../shared/wemail/automation.js";
import { assertRuleTimingMeaning } from "./AutomationRuleSemanticAssertions.js";

function rule(execution: MailReceivedExecutionTiming): AutomationRule {
  return {
    id: "rule-1",
    accountId: "acct-1",
    name: "Invoice upload",
    enabled: true,
    trigger: { type: "mailReceived", execution },
    conditions: {},
    actions: [],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

const duration = { amount: 24, unit: "hour" } as const;
const receivedField = {
  type: "field",
  path: "mail.receivedAt",
  scope: "mail",
} as const;
const latestIssueDate = {
  type: "aggregate",
  operator: "max",
  values: {
    type: "field",
    path: "invoice.issueDate",
    scope: "matchingAttachments",
  },
} as const;

test("received delay and received field expression have equivalent meaning", () => {
  const delayRule = rule({ type: "delay", ...duration });
  const expressionRule = rule({
    type: "atExpression",
    timezone: "Asia/Shanghai",
    expression: {
      type: "addDuration",
      base: receivedField,
      duration,
    },
  });
  const expectation = {
    timingMeaning: "received-at-plus-duration",
    duration,
    forbiddenFields: ["invoice.issueDate"],
  } as const;

  assert.doesNotThrow(() => assertRuleTimingMeaning(delayRule, expectation));
  assert.doesNotThrow(() =>
    assertRuleTimingMeaning(expressionRule, expectation),
  );
});

test("latest issue-date expectation accepts max and rejects min", () => {
  const maxRule = rule({
    type: "atExpression",
    timezone: "Asia/Shanghai",
    expression: {
      type: "addDuration",
      base: latestIssueDate,
      duration,
    },
  });
  assert.doesNotThrow(() =>
    assertRuleTimingMeaning(maxRule, {
      timingMeaning: "latest-invoice-issue-date-plus-duration",
      duration,
    }),
  );

  const minRule = rule({
    type: "atExpression",
    timezone: "Asia/Shanghai",
    expression: {
      type: "addDuration",
      base: { ...latestIssueDate, operator: "min" },
      duration,
    },
  });
  assert.throws(
    () =>
      assertRuleTimingMeaning(minRule, {
        timingMeaning: "latest-invoice-issue-date-plus-duration",
        duration,
      }),
    /timing-meaning-mismatch:unsupported-temporal-base/,
  );
});

test("latest issue-date expectation rejects implicit fallback", () => {
  const fallbackRule = rule({
    type: "atExpression",
    timezone: "Asia/Shanghai",
    expression: {
      type: "addDuration",
      base: {
        type: "coalesce",
        values: [latestIssueDate, receivedField],
      },
      duration,
    },
  });

  assert.throws(
    () =>
      assertRuleTimingMeaning(fallbackRule, {
        timingMeaning: "latest-invoice-issue-date-plus-duration",
        duration,
      }),
    /unexpected-fallback-field:mail\.receivedAt/,
  );
  assert.doesNotThrow(() =>
    assertRuleTimingMeaning(fallbackRule, {
      timingMeaning: "latest-invoice-issue-date-plus-duration",
      duration,
      fallbackField: "mail.receivedAt",
    }),
  );
});

test("expected fallback accepts only an exact direct field alternative", () => {
  const computedFallbackRule = rule({
    type: "atExpression",
    timezone: "Asia/Shanghai",
    expression: {
      type: "addDuration",
      base: {
        type: "coalesce",
        values: [
          latestIssueDate,
          {
            type: "addDuration",
            base: receivedField,
            duration: { amount: 1, unit: "hour" },
          },
        ],
      },
      duration,
    },
  });

  assert.throws(
    () =>
      assertRuleTimingMeaning(computedFallbackRule, {
        timingMeaning: "latest-invoice-issue-date-plus-duration",
        duration,
        fallbackField: "mail.receivedAt",
      }),
    /unsupported-fallback-expression:direct-field-required/,
  );
});

test("received-time expectation rejects forbidden fields and duration drift", () => {
  const fallbackRule = rule({
    type: "atExpression",
    timezone: "Asia/Shanghai",
    expression: {
      type: "addDuration",
      base: {
        type: "coalesce",
        values: [receivedField, latestIssueDate],
      },
      duration,
    },
  });
  assert.throws(
    () =>
      assertRuleTimingMeaning(fallbackRule, {
        timingMeaning: "received-at-plus-duration",
        duration,
        forbiddenFields: ["invoice.issueDate"],
      }),
    /forbidden-field:invoice\.issueDate/,
  );
  assert.throws(
    () =>
      assertRuleTimingMeaning(rule({ type: "delay", amount: 1, unit: "day" }), {
        timingMeaning: "received-at-plus-duration",
        duration,
      }),
    /timing-duration-mismatch/,
  );
});

test("semantic timing rejects wrong primary and fallback field scopes", () => {
  assert.doesNotThrow(() =>
    assertRuleTimingMeaning(
      rule({
        type: "atExpression",
        timezone: "Asia/Shanghai",
        expression: {
          type: "addDuration",
          base: { type: "field", path: "mail.receivedAt" },
          duration,
        },
      }),
      {
        timingMeaning: "received-at-plus-duration",
        duration,
      },
    ),
  );
  assert.doesNotThrow(() =>
    assertRuleTimingMeaning(
      rule({
        type: "atExpression",
        timezone: "Asia/Shanghai",
        expression: {
          type: "addDuration",
          base: {
            type: "aggregate",
            operator: "max",
            values: { type: "field", path: "invoice.issueDate" },
          },
          duration,
        },
      }),
      {
        timingMeaning: "latest-invoice-issue-date-plus-duration",
        duration,
      },
    ),
  );

  const wrongReceivedScope = rule({
    type: "atExpression",
    timezone: "Asia/Shanghai",
    expression: {
      type: "addDuration",
      base: {
        ...receivedField,
        scope: "matchingAttachments",
      },
      duration,
    },
  });
  assert.throws(
    () =>
      assertRuleTimingMeaning(wrongReceivedScope, {
        timingMeaning: "received-at-plus-duration",
        duration,
      }),
    /field-scope-mismatch:mail\.receivedAt:expected-mail:actual-matchingAttachments/,
  );

  const wrongInvoiceScope = rule({
    type: "atExpression",
    timezone: "Asia/Shanghai",
    expression: {
      type: "addDuration",
      base: {
        ...latestIssueDate,
        values: {
          ...latestIssueDate.values,
          scope: "mail",
        },
      },
      duration,
    },
  });
  assert.throws(
    () =>
      assertRuleTimingMeaning(wrongInvoiceScope, {
        timingMeaning: "latest-invoice-issue-date-plus-duration",
        duration,
      }),
    /field-scope-mismatch:invoice\.issueDate:expected-matchingAttachments:actual-mail/,
  );

  const wrongFallbackScope = rule({
    type: "atExpression",
    timezone: "Asia/Shanghai",
    expression: {
      type: "addDuration",
      base: {
        type: "coalesce",
        values: [
          latestIssueDate,
          {
            ...receivedField,
            scope: "matchingAttachments",
          },
        ],
      },
      duration,
    },
  });
  assert.throws(
    () =>
      assertRuleTimingMeaning(wrongFallbackScope, {
        timingMeaning: "latest-invoice-issue-date-plus-duration",
        duration,
        fallbackField: "mail.receivedAt",
      }),
    /field-scope-mismatch:mail\.receivedAt:expected-mail:actual-matchingAttachments/,
  );
});
