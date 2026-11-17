import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentCapabilityDescriptor,
  ExecutionPipelineDraft,
} from "../../../shared/wemail/skillCenter.js";
import {
  validateWorkflowRecipeCoverage,
  validateWorkflowRecipes,
} from "./WorkflowRecipeValidator.js";

function base(): ExecutionPipelineDraft {
  return {
    id: "pipeline-1",
    accountId: "account-1",
    revision: 1,
    mode: "one_shot",
    dataSelection: {
      version: 1,
      source: "mail",
      scope: { type: "calendar_day", timezone: "Asia/Shanghai" },
      filters: [{ field: "subject", operator: "contains", value: "日报" }],
      limits: { maxMessages: 100 },
    },
    analysis: {
      version: 1,
      inputKinds: ["mail-collection"],
      dimensions: [],
      metrics: [{
        id: "requests",
        label: "请求量",
        aggregation: "sum",
        field: "requestCount",
      }],
      modelTasks: [],
      conclusions: [],
      outputSchema: {},
    },
    artifact: {
      version: 1,
      format: "html",
      title: "日报",
      components: [{ id: "summary", type: "paragraph" }],
      layout: { structure: "report", sections: ["summary"] },
      theme: { name: "wemail" },
      accessibility: { includeTextSummary: true, chartDescriptions: true },
      emptyState: "暂无数据",
      errorState: "生成失败",
      outputSchema: {},
    },
    delivery: {
      version: 1,
      destinations: [{ type: "message_center", enabled: true }],
      content: { includeSummary: true, includeImage: false, includeArtifactLink: true },
      fallbackPolicy: { type: "stop" },
    },
    steps: [],
    skillSnapshots: [],
    capabilitySnapshots: [],
    reviews: [],
    validation: { status: "not_validated", issues: [] },
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

test("recipe validator rejects unsafe or incomplete domain contracts", () => {
  const draft = base();
  draft.dataSelection!.limits.maxMessages = 0;
  draft.analysis!.metrics = [{
    id: "failure-rate",
    label: "失败率",
    aggregation: "ratio",
  }];
  draft.delivery!.destinations = [{ type: "message_center", enabled: false }];
  const issues = validateWorkflowRecipes(draft);
  assert.ok(issues.some((issue) => issue.code === "max-messages-invalid"));
  assert.ok(issues.some((issue) => issue.code === "ratio-fields-required"));
  assert.ok(issues.some((issue) => issue.code === "delivery-destination-required"));
});

test("recipe validator rejects filters that cannot be compiled at runtime", () => {
  const draft = base();
  draft.dataSelection!.filters = [{
    field: "inventedField",
    operator: "contains",
    value: "x",
  }];
  assert.ok(
    validateWorkflowRecipes(draft)
      .some((issue) => issue.code === "filter-unsupported"),
  );
});

test("recipe validator accepts a bounded, previewable contract", () => {
  const draft = base();
  draft.analysis!.metrics = [{
    id: "requests",
    label: "请求量",
    aggregation: "sum",
    field: "requestCount",
  }];
  assert.deepEqual(validateWorkflowRecipes(draft), []);
});

test("recipe validator rejects empty analysis and charts without bindings", () => {
  const draft = base();
  draft.analysis!.metrics = [];
  draft.artifact!.components = [{ id: "trend", type: "line_chart" }];
  const issues = validateWorkflowRecipes(draft);
  assert.ok(issues.some((issue) => issue.code === "analysis-operation-required"));
  assert.ok(issues.some((issue) => issue.code === "chart-binding-required"));
});

test("recipe coverage rejects reviewed recipes that have no executable steps", () => {
  const draft = base();
  const capabilities = new Map();
  const issues = validateWorkflowRecipeCoverage(draft, capabilities);
  assert.ok(issues.some((issue) => issue.code === "analysis-step-required"));
  assert.ok(issues.some((issue) => issue.code === "artifact-step-required"));
  assert.ok(issues.some((issue) => issue.code === "message-center-step-required"));
});

test("recipe coverage rejects model work without a model-capable analysis step", () => {
  const draft = base();
  draft.analysis!.modelTasks = [{
    id: "classify-error",
    instruction: "对错误原因分类",
    outputFields: ["errorCategory"],
    maxInputItems: 100,
  }];
  draft.steps = [{
    id: "analyze",
    capabilityId: "analysis.basic",
    input: {},
    outputKind: "dataset",
    onError: { policy: "stop", retries: 0 },
  }];
  const capability = {
    id: "analysis.basic",
    category: "analysis",
    outputSchema: {},
    metadata: { supportsModelTasks: false },
  } as unknown as AgentCapabilityDescriptor;

  const issues = validateWorkflowRecipeCoverage(
    draft,
    new Map([[capability.id, capability]]),
  );
  assert.ok(issues.some((issue) => issue.code === "model-task-step-required"));
});
