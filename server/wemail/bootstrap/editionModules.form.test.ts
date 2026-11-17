import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAutomationFormContributions, type EditionModules } from "./editionModules.js";

test("automation form contributions require every declared feature", () => {
  const modules: EditionModules = { automationFormContributions: [{
    requires: ["allowanceInvoice", "wecli"],
    contributions: { processors: [], externalActions: [{ label: "Edition action", action: { type: "external", adapter: "edition.action", input: {} } }] },
  }] };
  assert.equal(resolveAutomationFormContributions(modules, undefined).externalActions.length, 0);
  assert.equal(resolveAutomationFormContributions(modules, { allowanceInvoice: true, wecli: false }).externalActions.length, 0);
  assert.equal(resolveAutomationFormContributions(modules, { allowanceInvoice: true, wecli: true }).externalActions.length, 1);
});
