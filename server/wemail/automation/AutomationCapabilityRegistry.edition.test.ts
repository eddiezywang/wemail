import assert from "node:assert/strict";
import { test } from "node:test";
import { automationCapabilityDiscovery, automationCapabilityFingerprint } from "./AutomationCapabilityRegistry.js";

test("open capability catalog excludes private automation entries", () => {
  const catalog = automationCapabilityDiscovery({});
  assert.ok(!catalog.processors.some((entry) => entry.id === "invoiceReadinessAnalysis"));
  assert.ok(!catalog.actions.some((entry) => entry.id === "external"));
  assert.equal(catalog.fingerprint, automationCapabilityFingerprint({}));
});

test("edition contributions affect discovery and its fingerprint", () => {
  const contribution = { processors: [{ id: "private-processor", label: "Private", description: "Edition", risk: "low" as const, configurable: true }] };
  const catalog = automationCapabilityDiscovery(contribution);
  assert.ok(catalog.processors.some((entry) => entry.id === "private-processor"));
  assert.notEqual(catalog.fingerprint, automationCapabilityFingerprint({}));
});
