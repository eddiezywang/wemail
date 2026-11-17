import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AutomationCapabilityDescriptor,
  AutomationProvider,
  AutomationProviderContext,
  AutomationStepPreview,
  AutomationStepResult,
  CompiledAutomationStep,
} from "./AutomationProvider.js";
import { BaseAutomationProvider } from "./BaseAutomationProvider.js";
import {
  AutomationProviderRegistry,
  descriptorFingerprint,
  legacyDescriptorFingerprint,
} from "./AutomationProviderRegistry.js";

const fixtureBaseProvider = new class extends BaseAutomationProvider {
  readonly id = "fixture";
  readonly version = "1";
  protected capabilities(): AutomationCapabilityDescriptor[] { return []; }
  async preview(): Promise<AutomationStepPreview> {
    return {
      plannedOperation: "fixture",
      resolvedInputSummary: {},
      warnings: [],
      sideEffects: [],
    };
  }
  async execute(): Promise<AutomationStepResult> {
    throw new Error("not-used");
  }
}();

function provider(id: string, fail = false): AutomationProvider {
  const base = {
    provider: id,
    id: "capability",
    version: "1",
    kind: "processor" as const,
    label: `${id} capability`,
    description: "fixture",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    risk: "read" as const,
    sideEffects: ["read-mail" as const],
    previewSupport: "full" as const,
    idempotency: "native" as const,
    discoveryConfidence: "declared" as const,
  };
  const descriptor = {
    ...base,
    fingerprint: descriptorFingerprint(base),
  };
  return {
    id,
    version: "1",
    async discover() {
      if (fail) throw new Error(`${id} provider temporarily unavailable`);
      return [descriptor];
    },
    async compile(_capability, step) {
      return { ...step, descriptor };
    },
    async validate() {
      return [];
    },
    async preview(
      _step: CompiledAutomationStep,
      _input: Record<string, unknown>,
      _context: AutomationProviderContext,
    ): Promise<AutomationStepPreview> {
      return {
        plannedOperation: "fixture",
        resolvedInputSummary: {},
        warnings: [],
        sideEffects: [],
      };
    },
    async execute(): Promise<AutomationStepResult> {
      const now = new Date().toISOString();
      return {
        status: "succeeded",
        warnings: [],
        sideEffects: [],
        audit: {
          provider: id,
          capability: "capability",
          capabilityFingerprint: descriptor.fingerprint,
          startedAt: now,
          completedAt: now,
          durationMs: 0,
        },
      };
    },
    checkCompatibility(previousFingerprint) {
      return previousFingerprint === descriptor.fingerprint
        ? "identical"
        : "breaking";
    },
  };
}

test("capability contract fingerprints ignore display copy but reject schema changes", () => {
  const base = {
    provider: "bot-message",
    id: "publish-connected",
    version: "1",
    kind: "sink" as const,
    label: "Bot delivery",
    description: "Old help copy",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    risk: "external-mutation" as const,
    sideEffects: ["publish-message" as const],
    previewSupport: "full" as const,
    idempotency: "keyed" as const,
    discoveryConfidence: "declared" as const,
  };

  assert.equal(
    descriptorFingerprint(base),
    descriptorFingerprint({
      ...base,
      label: "发送到企微",
      description: "New help copy",
      previewSupport: "plan-only",
      discoveryConfidence: "inferred",
    }),
  );
  assert.notEqual(
    legacyDescriptorFingerprint(base),
    legacyDescriptorFingerprint({ ...base, description: "New help copy" }),
  );
  assert.notEqual(
    descriptorFingerprint(base),
    descriptorFingerprint({
      ...base,
      inputSchema: {
        type: "object",
        required: ["title"],
      },
    }),
  );
});

test("base providers accept their legacy display-inclusive fingerprint", () => {
  const descriptor = {
    provider: "fixture",
    id: "deliver",
    version: "1",
    kind: "sink" as const,
    label: "Delivery",
    description: "Help copy",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    risk: "local-write" as const,
    sideEffects: ["publish-message" as const],
    previewSupport: "full" as const,
    idempotency: "keyed" as const,
    discoveryConfidence: "declared" as const,
  };
  const current = { ...descriptor, fingerprint: descriptorFingerprint(descriptor) };

  assert.equal(
    fixtureBaseProvider.checkCompatibility(
      legacyDescriptorFingerprint(descriptor),
      current,
    ),
    "compatible",
  );
});

test("provider discovery preserves successful capabilities when one provider fails", async () => {
  const registry = new AutomationProviderRegistry();
  registry.register(provider("mail"));
  registry.register(provider("optional", true));

  const result = await registry.discoverWithStatus();
  assert.deepEqual(
    result.capabilities.map((item) => `${item.provider}/${item.id}`),
    ["mail/capability"],
  );
  assert.deepEqual(
    result.providers.map((item) => [item.provider, item.status]),
    [
      ["mail", "available"],
      ["optional", "unavailable"],
    ],
  );
  assert.equal(
    result.providers[1]?.issue?.category,
    "transient_service_failure",
  );
});

test("unknown requested provider returns structured unavailable status", async () => {
  const registry = new AutomationProviderRegistry();
  registry.register(provider("mail"));
  const result = await registry.discoverWithStatus({ provider: "missing" });
  assert.deepEqual(result.capabilities, []);
  assert.equal(result.providers[0]?.issue?.category, "provider_unavailable");
});

test("compiled rule snapshots fail closed when a capability schema drifts", async () => {
  const registry = new AutomationProviderRegistry();
  registry.register(provider("processor"));
  await assert.rejects(
    () =>
      registry.compile({
        id: "fixed-step",
        provider: "processor",
        capability: "capability",
        capabilityFingerprint: "previous-schema-fingerprint",
        input: {},
      }),
    /automation-capability-drift:processor\/capability:breaking/,
  );
});
