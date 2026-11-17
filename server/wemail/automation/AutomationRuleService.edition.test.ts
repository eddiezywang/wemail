import assert from "node:assert/strict";
import { test } from "node:test";
import { AutomationRuleService } from "./AutomationRuleService.js";

test("rule service uses its own edition capability and validation context", () => {
  const dependencies = {} as ConstructorParameters<typeof AutomationRuleService>[0];
  const rule = { accountId: "acct", name: "Rule", enabled: true, trigger: { type: "manual" as const }, conditions: {},
    actions: [{ type: "external" as const, adapter: "private", input: {} }] };
  const open = new AutomationRuleService({ ...dependencies, editionValidation: {}, editionCapabilities: {} });
  assert.throws(() => open.validateDraft(rule), /invalid-automation-action/);
  const internal = new AutomationRuleService({ ...dependencies,
    editionValidation: { validateAction: () => true },
    editionCapabilities: { actions: [{ id: "external", label: "Private", description: "Edition action", risk: "high", configurable: true }] },
  });
  assert.doesNotThrow(() => internal.validateDraft(rule));
  assert.ok(internal.capabilities().actions.some((action) => action.id === "external"));
  assert.ok(!open.capabilities().actions.some((action) => action.id === "external"));
});

test("temporal field definitions stay scoped to the composition", () => {
  const dependencies = {} as ConstructorParameters<typeof AutomationRuleService>[0];
  const field = { path: "edition.date", label: "Edition date", description: "Edition field", valueType: "date" as const,
    cardinality: "one" as const, scope: "mail" as const, availability: "immediate" as const };
  const open = new AutomationRuleService({ ...dependencies, editionValidation: {}, editionFieldDefinitions: [] });
  const internal = new AutomationRuleService({ ...dependencies, editionValidation: {}, editionFieldDefinitions: [field] });
  assert.ok(!open.fieldDefinitions().some((item) => item.path === field.path));
  assert.ok(internal.fieldDefinitions().some((item) => item.path === field.path));
  const rule = { accountId: "acct", name: "Timed", enabled: true, conditions: { hasAttachment: true },
    actions: [{ type: "star" as const }], trigger: { type: "mailReceived" as const, execution: { type: "atExpression" as const,
      timezone: "UTC", expression: { type: "field" as const, path: field.path, scope: "mail" as const } } } };
  assert.throws(() => open.validateDraft(rule), /temporal-expression-unknown-field/);
  assert.doesNotThrow(() => internal.validateDraft(rule));
});
