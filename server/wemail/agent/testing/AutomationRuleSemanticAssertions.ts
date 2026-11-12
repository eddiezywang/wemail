import type {
  AutomationRule,
  TemporalExpression,
} from "../../../../shared/wemail/automation.js";

export type SemanticRuleExpectation =
  | {
      timingMeaning: "received-at-plus-duration";
      duration: { amount: number; unit: "minute" | "hour" | "day" };
      forbiddenFields?: readonly string[];
    }
  | {
      timingMeaning: "latest-invoice-issue-date-plus-duration";
      duration: { amount: number; unit: "minute" | "hour" | "day" };
      fallbackField?: "mail.receivedAt";
    };

interface NormalizedTiming {
  meaning:
    | "received-at-plus-duration"
    | "latest-invoice-issue-date-plus-duration";
  duration: SemanticRuleExpectation["duration"];
  fields: Set<string>;
  fallbackAlternatives: TemporalExpression[];
}

export function assertRuleTimingMeaning(
  rule: AutomationRule,
  expectation: SemanticRuleExpectation,
): void {
  if (rule.trigger.type !== "mailReceived") {
    throw new Error("timing-meaning-requires-mail-received-trigger");
  }

  const normalized = normalizeTiming(rule);
  if (normalized.meaning !== expectation.timingMeaning) {
    throw new Error(
      `timing-meaning-mismatch:expected-${expectation.timingMeaning}:actual-${normalized.meaning}`,
    );
  }
  if (
    normalized.duration.amount !== expectation.duration.amount ||
    normalized.duration.unit !== expectation.duration.unit
  ) {
    throw new Error(
      `timing-duration-mismatch:expected-${expectation.duration.amount}-${expectation.duration.unit}` +
        `:actual-${normalized.duration.amount}-${normalized.duration.unit}`,
    );
  }

  if (expectation.timingMeaning === "received-at-plus-duration") {
    for (const field of expectation.forbiddenFields ?? []) {
      if (normalized.fields.has(field)) {
        throw new Error(`forbidden-field:${field}`);
      }
    }
    if (normalized.fallbackAlternatives.length > 0) {
      throw new Error(
        `unexpected-fallback-field:${directFallbackField(normalized.fallbackAlternatives[0]!)}`,
      );
    }
    return;
  }

  const expectedFallback = expectation.fallbackField;
  const actualFallback = normalized.fallbackAlternatives[0]
    ? directFallbackField(normalized.fallbackAlternatives[0])
    : undefined;
  if (!expectedFallback && actualFallback) {
    throw new Error(`unexpected-fallback-field:${actualFallback}`);
  }
  if (expectedFallback && actualFallback !== expectedFallback) {
    throw new Error(
      `fallback-field-mismatch:expected-${expectedFallback}:actual-${actualFallback ?? "none"}`,
    );
  }
  if (normalized.fallbackAlternatives.length > (expectedFallback ? 1 : 0)) {
    throw new Error(
      `unexpected-fallback-field:${directFallbackField(normalized.fallbackAlternatives[1]!)}`,
    );
  }
}

function normalizeTiming(rule: AutomationRule): NormalizedTiming {
  const execution =
    rule.trigger.type === "mailReceived" ? rule.trigger.execution : undefined;
  if (!execution) {
    throw new Error("timing-meaning-mismatch:mail-received-execution-missing");
  }
  if (execution.type === "delay") {
    return {
      meaning: "received-at-plus-duration",
      duration: { amount: execution.amount, unit: execution.unit },
      fields: new Set(["mail.receivedAt"]),
      fallbackAlternatives: [],
    };
  }
  if (execution.type !== "atExpression") {
    throw new Error(`unsupported-timing-meaning:${execution.type}`);
  }

  const expression = execution.expression;
  if (expression.type !== "addDuration") {
    throw new Error("timing-meaning-mismatch:add-duration-required");
  }
  const fields = collectFields(expression);
  const alternatives =
    expression.base.type === "coalesce"
      ? flattenCoalesce(expression.base)
      : [expression.base];
  const primary = alternatives[0];
  if (!primary) {
    throw new Error("timing-meaning-mismatch:temporal-base-required");
  }

  let meaning: NormalizedTiming["meaning"];
  if (isField(primary, "mail.receivedAt", "mail")) {
    meaning = "received-at-plus-duration";
  } else if (isLatestInvoiceIssueDate(primary)) {
    meaning = "latest-invoice-issue-date-plus-duration";
  } else {
    throw new Error("timing-meaning-mismatch:unsupported-temporal-base");
  }

  return {
    meaning,
    duration: expression.duration,
    fields,
    fallbackAlternatives: alternatives.slice(1),
  };
}

function directFallbackField(expression: TemporalExpression): string {
  if (expression.type !== "field") {
    throw new Error("unsupported-fallback-expression:direct-field-required");
  }
  if (expression.path === "mail.receivedAt") {
    assertFieldScope(expression, "mail.receivedAt", "mail");
  } else if (expression.path === "invoice.issueDate") {
    assertFieldScope(expression, "invoice.issueDate", "matchingAttachments");
  }
  return expression.path;
}

function isField(
  expression: TemporalExpression,
  path: string,
  expectedScope: "mail" | "matchingAttachments",
): boolean {
  if (expression.type !== "field" || expression.path !== path) return false;
  assertFieldScope(expression, path, expectedScope);
  return true;
}

function isLatestInvoiceIssueDate(expression: TemporalExpression): boolean {
  return (
    expression.type === "aggregate" &&
    expression.operator === "max" &&
    isField(expression.values, "invoice.issueDate", "matchingAttachments")
  );
}

function assertFieldScope(
  expression: Extract<TemporalExpression, { type: "field" }>,
  path: string,
  expectedScope: "mail" | "matchingAttachments",
): void {
  if (expression.scope !== undefined && expression.scope !== expectedScope) {
    throw new Error(
      `field-scope-mismatch:${path}:expected-${expectedScope}` +
        `:actual-${expression.scope}`,
    );
  }
}

function flattenCoalesce(expression: TemporalExpression): TemporalExpression[] {
  if (expression.type !== "coalesce") return [expression];
  return expression.values.flatMap(flattenCoalesce);
}

function collectFields(
  expression: TemporalExpression,
  fields = new Set<string>(),
): Set<string> {
  if (expression.type === "field") {
    fields.add(expression.path);
  } else if (expression.type === "aggregate") {
    collectFields(expression.values, fields);
  } else if (expression.type === "coalesce") {
    for (const value of expression.values) collectFields(value, fields);
  } else {
    collectFields(expression.base, fields);
  }
  return fields;
}
