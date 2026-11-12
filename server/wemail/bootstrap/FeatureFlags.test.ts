import assert from "node:assert/strict";
import test from "node:test";
import { readWemailFeatureFlags } from "./FeatureFlags.js";

test("automation feature flags are enabled by default", () => {
  const flags = readWemailFeatureFlags({});
  assert.equal(flags.unifiedAutomationCenter, true);
  assert.equal(flags.structuredAutomationEditing, true);
  assert.equal(flags.automationTemplateCatalog, true);
  assert.equal(flags.crossAccountAutomation, true);
  assert.equal(flags.subscriptionInsight, true);
});

test("automation feature flags can be rolled back independently", () => {
  const flags = readWemailFeatureFlags({
    WEMAIL_UNIFIED_AUTOMATION_CENTER: "0",
    WEMAIL_STRUCTURED_AUTOMATION_EDITING: "0",
    WEMAIL_AUTOMATION_TEMPLATE_CATALOG: "0",
    WEMAIL_CROSS_ACCOUNT_AUTOMATION: "0",
    WEMAIL_SUBSCRIPTION_INSIGHT: "0",
  });
  assert.equal(flags.unifiedAutomationCenter, false);
  assert.equal(flags.structuredAutomationEditing, false);
  assert.equal(flags.automationTemplateCatalog, false);
  assert.equal(flags.crossAccountAutomation, false);
  assert.equal(flags.subscriptionInsight, false);
});
