import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AutomationCapabilityDescriptor,
  AutomationProvider,
} from "../automation/providers/AutomationProvider.js";
import {
  descriptorFingerprint,
  AutomationProviderRegistry,
} from "../automation/providers/AutomationProviderRegistry.js";
import type { ExecutionPipelineDraft } from "../../../shared/wemail/skillCenter.js";
import { AgentCapabilityCatalogService } from "./AgentCapabilityCatalogService.js";
import {
  compileTrigger,
  ExecutionPipelineService,
} from "./ExecutionPipelineService.js";

function provider(
  id: string,
  descriptors: Array<Omit<AutomationCapabilityDescriptor, "provider" | "fingerprint">>,
): AutomationProvider {
  const capabilities = descriptors.map((descriptor) => {
    const base = { ...descriptor, provider: id };
    return { ...base, fingerprint: descriptorFingerprint(base) };
  });
  return {
    id,
    version: "1",
    async discover(query) {
      return capabilities.filter(
        (item) => !query?.capability || item.id === query.capability,
      );
    },
    async compile(capability, step) {
      return { ...step, descriptor: capability };
    },
    async validate() {
      return [];
    },
    async preview(_step, _input) {
      return {
        plannedOperation: "preview",
        resolvedInputSummary: {},
        warnings: [],
        sideEffects: [],
      };
    },
    async execute(step) {
      const now = "2026-07-29T00:00:00.000Z";
      return {
        status: "succeeded",
        warnings: [],
        sideEffects: [],
        audit: {
          provider: id,
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

function descriptor(
  id: string,
  kind: AutomationCapabilityDescriptor["kind"],
  output: string,
): Omit<AutomationCapabilityDescriptor, "provider" | "fingerprint"> {
  return {
    id,
    version: "1",
    kind,
    label: id,
    description: id,
    inputSchema: {},
    outputSchema: { automationValue: output },
    risk: kind === "sink" ? "external-mutation" : "read",
    sideEffects: kind === "sink" ? ["publish-message"] : [],
    previewSupport: "full",
    idempotency: "keyed",
    discoveryConfidence: "declared",
  };
}

function draft(mode: ExecutionPipelineDraft["mode"]): ExecutionPipelineDraft {
  return {
    id: `pipeline-${mode}`,
    accountId: "account-1",
    revision: 1,
    mode,
    ...(mode === "automation"
      ? {
          trigger: {
            event: "schedule" as const,
            timing: {
              localTime: "21:00",
              timezone: "Asia/Shanghai",
            },
          },
        }
      : {}),
    steps: [
      {
        id: "analyze",
        capabilityId: "analysis.monitoringReport",
        input: {},
        outputKind: "dataset",
        onError: { policy: "stop", retries: 0 },
      },
      {
        id: "render",
        capabilityId: "output.render",
        input: {},
        outputKind: "artifact-reference",
        onError: { policy: "stop", retries: 0 },
      },
      {
        id: "deliver",
        capabilityId: "delivery.bot.sendConnected",
        input: {},
        outputKind: "delivery-receipt",
        onError: { policy: "continue", retries: 2 },
      },
    ],
    skillSnapshots: [],
    capabilitySnapshots: [],
    reviews: [],
    validation: { status: "not_validated", issues: [] },
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

test("Agent capability catalog hides Provider IDs and localizes optional WeCLI absence", async () => {
  const registry = new AutomationProviderRegistry();
  registry.register(
    provider("processor", [descriptor("monitoring-report", "processor", "dataset")]),
  );
  const catalog = await new AgentCapabilityCatalogService(registry).list();
  assert.ok(catalog.some((item) => item.id === "analysis.monitoringReport"));
  assert.ok(!catalog.some((item) => item.id === "processor"));
  const wecli = catalog.find((item) => item.id === "optional.wecli");
  assert.equal(wecli?.availability.state, "not_installed");
  assert.deepEqual(
    wecli?.availability.recoveryActions?.map((action) => action.type),
    ["install", "adjust_pipeline", "cancel"],
  );
});

test("one-shot and automation use the same typed pipeline while only automation compiles a schedule", async () => {
  const registry = new AutomationProviderRegistry();
  registry.register(
    provider("processor", [descriptor("monitoring-report", "processor", "dataset")]),
  );
  registry.register(provider("design", [descriptor("render", "design", "artifact-reference")]));
  registry.register(
    provider("bot-message", [
      descriptor("publish-connected", "sink", "delivery-receipt"),
    ]),
  );
  const catalog = new AgentCapabilityCatalogService(registry, []);
  const service = new ExecutionPipelineService(catalog, registry);
  const automated = await service.compile(draft("automation"));
  const oneShot = await service.compile(draft("one_shot"));
  assert.deepEqual(oneShot.pipeline, automated.pipeline);
  assert.equal(oneShot.trigger, undefined);
  assert.deepEqual(automated.trigger, {
    type: "scheduled",
    schedule: {
      type: "daily",
      timezone: "Asia/Shanghai",
      localTime: "21:00",
    },
  });
});

test("compiled pipelines reject stale Skill snapshots before execution", async () => {
  const registry = new AutomationProviderRegistry();
  registry.register(provider("processor", [descriptor("monitoring-report", "processor", "dataset")]));
  const service = new ExecutionPipelineService(
    new AgentCapabilityCatalogService(registry, []),
    registry,
  );
  service.setSkillSnapshotValidator(() => {
    throw new Error("wemail-data-selection@1.0.0");
  });
  const candidate = draft("one_shot");
  candidate.skillSnapshots = [{
    skillId: "wemail-data-selection",
    version: "1.0.0",
    contentHash: "stale",
    scope: "builtin",
  }];
  await assert.rejects(
    () => service.compile(candidate),
    /skill-snapshot-stale:wemail-data-selection@1\.0\.0/,
  );
});

test("one-shot data selection refuses a silently empty runtime collection", async () => {
  const registry = new AutomationProviderRegistry();
  registry.register(
    provider("processor", [descriptor("monitoring-report", "processor", "dataset")]),
  );
  registry.register(provider("design", [descriptor("render", "design", "artifact-reference")]));
  registry.register(
    provider("bot-message", [descriptor("publish-connected", "sink", "delivery-receipt")]),
  );
  const service = new ExecutionPipelineService(
    new AgentCapabilityCatalogService(registry, []),
    registry,
  );
  const candidate = draft("one_shot");
  candidate.dataSelection = {
    version: 1,
    source: "mail",
    scope: { type: "rolling_window", amount: 24, unit: "hour" },
    filters: [],
    limits: { maxMessages: 100 },
  };
  await assert.rejects(
    () => service.executeOneShot(candidate),
    /data-selection-runtime-unavailable/,
  );
});

test("pipeline validation keeps analysis, artifact, and delivery recipes attached to executable steps", async () => {
  const registry = new AutomationProviderRegistry();
  registry.register(
    provider("processor", [descriptor("monitoring-report", "processor", "dataset")]),
  );
  registry.register(provider("design", [descriptor("render", "design", "artifact-reference")]));
  registry.register(
    provider("bot-message", [descriptor("publish-connected", "sink", "delivery-receipt")]),
  );
  const service = new ExecutionPipelineService(
    new AgentCapabilityCatalogService(registry, []),
    registry,
  );
  const candidate = draft("one_shot");
  candidate.analysis = {
    version: 1,
    inputKinds: ["mail-collection"],
    dimensions: [{ id: "hour", field: "hour" }],
    metrics: [{
      id: "requests",
      label: "请求量",
      aggregation: "sum",
      field: "requestCount",
    }],
    modelTasks: [],
    conclusions: [],
    outputSchema: {},
  };
  candidate.artifact = {
    version: 1,
    format: "html",
    title: "趋势",
    components: [{
      id: "trend",
      type: "line_chart",
      binding: { xField: "hour", valueField: "requestCount" },
    }],
    layout: { structure: "report", sections: ["trend"] },
    theme: { name: "wemail" },
    accessibility: { includeTextSummary: true, chartDescriptions: true },
    emptyState: "暂无数据",
    errorState: "生成失败",
    outputSchema: {},
  };
  candidate.delivery = {
    version: 1,
    destinations: [{ type: "connected_bot", enabled: true }],
    content: {
      includeSummary: true,
      includeImage: false,
      includeArtifactLink: true,
    },
    fallbackPolicy: {
      type: "first_available",
      priority: ["feishu_bot", "wecom_bot"],
    },
  };
  assert.equal((await service.validate(candidate)).status, "valid");
  const compiled = await service.compile(candidate);
  assert.deepEqual(
    compiled.pipeline.find((step) => step.id === "render")?.input.artifactRecipe,
    { type: "literal", value: candidate.artifact },
  );
  assert.deepEqual(
    compiled.pipeline.find((step) => step.id === "deliver")?.input,
    {
      policy: { type: "literal", value: "first_available" },
      priority: { type: "literal", value: ["feishu", "wecom"] },
    },
  );
  candidate.steps = candidate.steps.filter((step) => step.id !== "deliver");
  const invalid = await service.validate(candidate);
  assert.equal(invalid.status, "invalid");
  assert.ok(invalid.issues.some((issue) => issue.code === "bot-delivery-step-required"));
});

test("trigger compiler supports mail delay and next-day composition", () => {
  assert.deepEqual(
    compileTrigger({
      event: "mail.received",
      match: { subject: "发票" },
      timing: { delayMinutes: 30 },
    }),
    {
      type: "mailReceived",
      execution: { type: "delay", amount: 30, unit: "minute" },
    },
  );
  assert.deepEqual(
    compileTrigger({
      event: "mail.received",
      timing: {
        nextDayTime: "09:00",
        timezone: "Asia/Shanghai",
      },
    }),
    {
      type: "mailReceived",
      execution: {
        type: "nextDayAt",
        localTime: "09:00",
        timezone: "Asia/Shanghai",
      },
    },
  );
});
