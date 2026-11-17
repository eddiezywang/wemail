import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationDataset } from "../../../../shared/wemail/automation.js";
import type { AnalysisRecipe } from "../../../../shared/wemail/skillCenter.js";
import type { LlmClient } from "../../ai/LlmClient.js";
import type { AiUsageRepository } from "../../settings/AiUsageRepository.js";
import { AgentCapabilityCatalogService } from "../../workflows/AgentCapabilityCatalogService.js";
import { AnalysisRecipeAutomationProvider } from "./AnalysisRecipeAutomationProvider.js";
import { AutomationProviderRegistry } from "./AutomationProviderRegistry.js";

const dataset: AutomationDataset = {
  type: "dataset",
  schema: {
    fields: [
      { name: "hour", type: "string" },
      { name: "requests", type: "number" },
      { name: "errors", type: "number" },
      { name: "latency", type: "number" },
      { name: "sourceEmailId", type: "reference" },
    ],
  },
  rows: [
    { hour: "09:00", requests: 100, errors: 5, latency: 100, sourceEmailId: "mail-1" },
    { hour: "09:00", requests: 50, errors: 5, latency: 300, sourceEmailId: "mail-2" },
    { hour: "10:00", requests: 200, errors: 10, latency: 200, sourceEmailId: "mail-3" },
  ],
};

const recipe: AnalysisRecipe = {
  version: 1,
  inputKinds: ["dataset"],
  dimensions: [{ id: "hour", field: "hour" }],
  metrics: [
    { id: "requests", label: "请求量", aggregation: "sum", field: "requests" },
    { id: "p95", label: "P95", aggregation: "p95", field: "latency" },
    {
      id: "errorRate",
      label: "错误率",
      aggregation: "ratio",
      numeratorField: "errors",
      denominatorField: "requests",
    },
  ],
  modelTasks: [],
  conclusions: [],
  outputSchema: {},
};

function context() {
  return {
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
  };
}

test("analysis recipe provider executes deterministic grouped metrics with provenance", async () => {
  const provider = new AnalysisRecipeAutomationProvider({
    getClient: () => undefined,
    getModel: () => undefined,
  });
  const descriptor = (await provider.discover())[0]!;
  const step = await provider.compile(descriptor, {
    id: "analyze-recipe",
    provider: provider.id,
    capability: "execute",
    input: {},
    onError: { policy: "stop", retries: 0 },
  });
  assert.deepEqual(await provider.validate(step, { dataset, recipe }, context()), []);
  const result = await provider.execute(step, { dataset, recipe }, context());
  assert.equal(result.status, "succeeded");
  const output = result.output as AutomationDataset;
  assert.deepEqual(output.rows, [
    { hour: "09:00", requests: 150, p95: 300, errorRate: 10 / 150 },
    { hour: "10:00", requests: 200, p95: 200, errorRate: 10 / 200 },
  ]);
  assert.deepEqual(output.provenance?.[0]?.emailIds, ["mail-1", "mail-2"]);
  assert.deepEqual(output.provenance?.[1]?.emailIds, ["mail-3"]);
});

test("analysis recipe execution is discoverable through a stable business capability ID", async () => {
  const registry = new AutomationProviderRegistry();
  registry.register(new AnalysisRecipeAutomationProvider({
    getClient: () => undefined,
    getModel: () => undefined,
  }));
  const capability = (await new AgentCapabilityCatalogService(registry, []).list())
    .find((item) => item.id === "analysis.recipeExecute");
  assert.equal(capability?.availability.state, "ready");
  assert.equal(capability?.metadata?.supportsModelTasks, true);
  assert.equal(capability?.executorKey, "analysis-recipe/execute");
});

test("analysis model tasks are bounded, schema-driven, and record provider token usage", async () => {
  const requests: Parameters<LlmClient["generate"]>[0][] = [];
  const client: LlmClient = {
    async generate(input) {
      requests.push(input);
      return {
        text: JSON.stringify({
          tasks: { classify: { label: "关注" } },
          conclusions: {},
        }),
        finishReason: "stop",
        usage: { inputTokens: 120, outputTokens: 20 },
      };
    },
  };
  const usageCalls: Array<Record<string, unknown>> = [];
  const usage = {
    record(input: Record<string, unknown>) {
      usageCalls.push(input);
    },
  } as unknown as AiUsageRepository;
  const provider = new AnalysisRecipeAutomationProvider({
    getClient: () => client,
    getModel: () => "analysis-model",
    usage,
  });
  const descriptor = (await provider.discover())[0]!;
  const step = await provider.compile(descriptor, {
    id: "analyze-recipe",
    provider: provider.id,
    capability: "execute",
    input: {},
    onError: { policy: "stop", retries: 0 },
  });
  const withModel: AnalysisRecipe = {
    ...recipe,
    modelTasks: [{
      id: "classify",
      instruction: "给出关注级别",
      outputFields: ["label"],
      maxInputItems: 2,
    }],
  };
  const result = await provider.execute(
    step,
    { dataset, recipe: withModel },
    context(),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(requests.length, 1);
  const sent = JSON.parse(requests[0]!.messages[0]!.content) as { rows: unknown[] };
  assert.equal(sent.rows.length, 2);
  assert.equal(usageCalls[0]?.inputTokens, 120);
  assert.equal(usageCalls[0]?.outputTokens, 20);
  assert.deepEqual((result.output as AutomationDataset).summary?.model, {
    tasks: { classify: { label: "关注" } },
    conclusions: {},
  });
});
