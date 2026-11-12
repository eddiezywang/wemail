import assert from "node:assert/strict";
import { test } from "node:test";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import { AutomationFieldRegistry } from "./AutomationFieldRegistry.js";
import {
  canonicalizeTemporalValue,
  evaluateTemporalExpression,
} from "./TemporalExpressionEvaluator.js";

const message = {
  id: "mail-1",
  receivedAt: "2026-07-20T02:00:00.000Z",
  attachments: [],
} as unknown as MailMessage;

test("canonicalizeTemporalValue normalizes datetimes and anchors local dates", () => {
  assert.equal(
    canonicalizeTemporalValue(
      "2026-07-21T01:00:00-08:00",
      "datetime",
      "UTC",
    ),
    "2026-07-21T09:00:00.000Z",
  );
  assert.equal(
    canonicalizeTemporalValue("2026-07-21", "date", "Asia/Shanghai"),
    "2026-07-20T16:00:00.000Z",
  );
  assert.throws(
    () => canonicalizeTemporalValue("not-a-date", "datetime", "UTC"),
    /invalid-temporal-date/,
  );
});

test("canonicalizeTemporalValue rejects permissive non-RFC3339 datetimes", () => {
  for (const value of [
    "2026-02-30T10:00:00Z",
    "2026-07-21T10:00:00",
    "July 21, 2026 10:00:00 GMT",
    "1784628000000",
    "2026-07-21T24:00:00Z",
    "2026-07-21T10:60:00Z",
    "2026-07-21T10:00:00+24:00",
    "2026-07-21T10:00:00+08:60",
  ]) {
    assert.throws(
      () => canonicalizeTemporalValue(value, "datetime", "UTC"),
      /invalid-temporal-date/,
      value,
    );
  }
  assert.equal(
    canonicalizeTemporalValue(
      "2026-07-21T10:15:30.125+08:30",
      "datetime",
      "UTC",
    ),
    "2026-07-21T01:45:30.125Z",
  );
});

test("received timestamp plus 24 hours is an elapsed duration", async () => {
  const registry = AutomationFieldRegistry.withNativeFields();
  const result = await evaluateTemporalExpression({
    type: "addDuration",
    base: { type: "field", path: "mail.receivedAt", scope: "mail" },
    duration: { amount: 24, unit: "hour" },
  }, { message, timezone: "Asia/Shanghai" }, registry);
  assert.deepEqual(result, {
    status: "ready",
    valueType: "datetime",
    values: ["2026-07-21T02:00:00.000Z"],
  });
});

test("max issue date anchors at local midnight before adding 24 hours", async () => {
  const registry = AutomationFieldRegistry.withNativeFields();
  registry.register({
    definition: {
      path: "invoice.issueDate",
      label: "发票开票日期",
      description: "test",
      valueType: "date",
      cardinality: "many",
      scope: "attachment",
      availability: "enriched",
    },
    async resolve() {
      return {
        status: "ready",
        valueType: "date",
        values: ["2026-07-18", "2026-07-20"],
      };
    },
  });
  const result = await evaluateTemporalExpression({
    type: "addDuration",
    base: {
      type: "aggregate",
      operator: "max",
      values: { type: "field", path: "invoice.issueDate", scope: "matchingAttachments" },
    },
    duration: { amount: 24, unit: "hour" },
  }, { message, timezone: "Asia/Shanghai" }, registry);
  assert.deepEqual(result, {
    status: "ready",
    valueType: "datetime",
    values: ["2026-07-20T16:00:00.000Z"],
  });
});

test("coalesce stops on pending and advances only on unavailable", async () => {
  const definition = {
    path: "invoice.issueDate",
    label: "发票开票日期",
    description: "test",
    valueType: "date" as const,
    cardinality: "many" as const,
    scope: "attachment" as const,
    availability: "enriched" as const,
  };
  const expression = {
    type: "coalesce" as const,
    values: [
      {
        type: "aggregate" as const,
        operator: "max" as const,
        values: {
          type: "field" as const,
          path: "invoice.issueDate",
          scope: "matchingAttachments" as const,
        },
      },
      { type: "field" as const, path: "mail.receivedAt", scope: "mail" as const },
    ],
  };

  const pendingRegistry = AutomationFieldRegistry.withNativeFields();
  pendingRegistry.register({
    definition,
    async resolve() {
      return { status: "pending", dependencies: [{ fieldPath: "invoice.issueDate", emailId: "mail-1" }] };
    },
  });
  assert.equal((await evaluateTemporalExpression(expression, { message, timezone: "Asia/Shanghai" }, pendingRegistry)).status, "pending");

  const unavailableRegistry = AutomationFieldRegistry.withNativeFields();
  unavailableRegistry.register({
    definition,
    async resolve() {
      return { status: "unavailable", reasons: ["missing-date"] };
    },
  });
  assert.deepEqual(await evaluateTemporalExpression(expression, { message, timezone: "Asia/Shanghai" }, unavailableRegistry), {
    status: "ready",
    valueType: "datetime",
    values: ["2026-07-20T02:00:00.000Z"],
  });
});

test("aggregate reduces ready collections", async () => {
  const registry = new AutomationFieldRegistry();
  registry.register({
    definition: {
      path: "test.dates", label: "dates", description: "test", valueType: "date", cardinality: "many", scope: "mail", availability: "immediate",
    },
    async resolve() {
      return { status: "ready", valueType: "date", values: ["2026-07-20", "2026-07-18"] };
    },
  });
  assert.deepEqual(await evaluateTemporalExpression({
    type: "aggregate", operator: "min", values: { type: "field", path: "test.dates" },
  }, { message, timezone: "UTC" }, registry), {
    status: "ready", valueType: "date", values: ["2026-07-18"],
  });
});

test("aggregate fails closed for a ready empty collection", async () => {
  const registry = new AutomationFieldRegistry();
  registry.register({
    definition: {
      path: "test.dates", label: "dates", description: "test", valueType: "date", cardinality: "many", scope: "mail", availability: "immediate",
    },
    async resolve() {
      return { status: "ready", valueType: "date", values: [] };
    },
  });

  assert.deepEqual(await evaluateTemporalExpression({
    type: "aggregate", operator: "min", values: { type: "field", path: "test.dates" },
  }, { message, timezone: "UTC" }, registry), {
    status: "unavailable", reasons: ["empty-temporal-values"],
  });
});

test("a date provider cannot bypass date-only timezone anchoring", async () => {
  const registry = new AutomationFieldRegistry();
  registry.register({
    definition: {
      path: "test.date", label: "date", description: "test", valueType: "date", cardinality: "one", scope: "mail", availability: "immediate",
    },
    async resolve() {
      return { status: "ready", valueType: "datetime", values: ["2026-07-20T00:00:00.000Z"] };
    },
  });

  assert.deepEqual(await evaluateTemporalExpression({
    type: "addDuration",
    base: { type: "field", path: "test.date" },
    duration: { amount: 1, unit: "day" },
  }, { message, timezone: "Asia/Shanghai" }, registry), {
    status: "unavailable",
    reasons: ["automation-field-value-type-mismatch:test.date"],
  });
});

test("date-only invalid dates and skipped local midnights fail closed", async () => {
  const registry = new AutomationFieldRegistry();
  registry.register({
    definition: {
      path: "test.date", label: "date", description: "test", valueType: "date", cardinality: "one", scope: "mail", availability: "immediate",
    },
    async resolve() {
      return { status: "ready", valueType: "date", values: ["2026-02-30"] };
    },
  });
  const expression = {
    type: "addDuration" as const,
    base: { type: "field" as const, path: "test.date" },
    duration: { amount: 1, unit: "day" as const },
  };
  await assert.rejects(evaluateTemporalExpression(expression, { message, timezone: "UTC" }, registry), /invalid-temporal-date/);

  registry.register({
    definition: {
      path: "test.skippedDate", label: "skipped", description: "test", valueType: "date", cardinality: "one", scope: "mail", availability: "immediate",
    },
    async resolve() {
      return { status: "ready", valueType: "date", values: ["2011-12-30"] };
    },
  });
  await assert.rejects(evaluateTemporalExpression({
    ...expression,
    base: { type: "field", path: "test.skippedDate" },
  }, { message, timezone: "Pacific/Apia" }, registry), /invalid-temporal-date/);
});
