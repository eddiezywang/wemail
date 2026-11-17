import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AutomationCapabilityDescriptor,
  AutomationProvider,
} from "./providers/AutomationProvider.js";
import {
  AutomationProviderRegistry,
  descriptorFingerprint,
} from "./providers/AutomationProviderRegistry.js";
import { AutomationPipelineExecutor } from "./AutomationPipelineExecutor.js";

function provider(): AutomationProvider {
  const descriptorBase = {
    provider: "delivery-test",
    version: "1",
    kind: "sink" as const,
    label: "测试投递",
    description: "测试投递",
    inputSchema: {},
    outputSchema: { automationValue: "scalar" },
    risk: "external-mutation" as const,
    sideEffects: ["publish-message" as const],
    previewSupport: "full" as const,
    idempotency: "keyed" as const,
    discoveryConfidence: "declared" as const,
  };
  const descriptors: AutomationCapabilityDescriptor[] = ["succeed", "fail"].map((id) => {
    const value = { ...descriptorBase, id };
    return { ...value, fingerprint: descriptorFingerprint(value) };
  });
  return {
    id: "delivery-test",
    version: "1",
    async discover() {
      return descriptors;
    },
    async compile(capability, step) {
      return { ...step, descriptor: capability };
    },
    async validate() {
      return [];
    },
    async preview() {
      return {
        plannedOperation: "preview",
        resolvedInputSummary: {},
        warnings: [],
        sideEffects: ["publish-message"],
      };
    },
    async execute(step) {
      const now = "2026-08-02T00:00:00.000Z";
      return step.capability === "fail"
        ? {
            status: "failed",
            error: {
              code: "execution-failed",
              message: "target unavailable",
              retryable: false,
              retrySafe: false,
            },
            warnings: [],
            sideEffects: [],
            audit: {
              provider: step.provider,
              capability: step.capability,
              capabilityFingerprint: step.descriptor.fingerprint,
              startedAt: now,
              completedAt: now,
              durationMs: 0,
            },
          }
        : {
            status: "succeeded",
            output: { type: "scalar", value: { delivered: true } },
            warnings: [],
            sideEffects: [{ type: "publish-message", summary: "delivered" }],
            audit: {
              provider: step.provider,
              capability: step.capability,
              capabilityFingerprint: step.descriptor.fingerprint,
              startedAt: now,
              completedAt: now,
              durationMs: 0,
            },
          };
    },
    checkCompatibility(previous, current) {
      return previous === current.fingerprint ? "identical" : "breaking";
    },
  };
}

test("delivery execution reports partial success when one continuing destination fails", async () => {
  const registry = new AutomationProviderRegistry();
  registry.register(provider());
  const descriptors = new Map(
    (await registry.discover()).map((descriptor) => [descriptor.id, descriptor]),
  );
  const steps = ["succeed", "fail"].map((capability, index) => ({
    id: `delivery-${index}`,
    provider: "delivery-test",
    capability,
    capabilityFingerprint: descriptors.get(capability)!.fingerprint,
    input: {},
    onError: { policy: "continue" as const, retries: 0 },
  }));
  const result = await new AutomationPipelineExecutor(registry).execute(steps, {
    run: {
      id: "run-1",
      ruleId: "rule-1",
      ruleVersion: 1,
      accountId: "account-1",
      occurrenceKey: "occurrence-1",
      actualStartedAt: "2026-08-02T00:00:00.000Z",
      delayed: false,
    },
    trigger: {},
    steps: {},
    dryRun: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "partially_succeeded");
  assert.equal(result.steps.length, 2);
});
