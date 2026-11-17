import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AutomationDataset } from "../../../../shared/wemail/automation.js";
import type { ArtifactRecipe } from "../../../../shared/wemail/skillCenter.js";
import { openOrCreateMailDatabase } from "../../database/Database.js";
import { MessageArtifactRepository } from "../../design/MessageArtifactRepository.js";
import type { CompiledAutomationStep } from "./AutomationProvider.js";
import { DesignAutomationProvider } from "./DesignAutomationProvider.js";

test("reviewed ArtifactRecipe drives every configured chart in the runtime preview", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-design-provider-"));
  const db = openOrCreateMailDatabase(":memory:");
  try {
    const provider = new DesignAutomationProvider(
      new MessageArtifactRepository(db, root),
    );
    const preview = await provider.preview(step(), {
      dataset: dataset(),
      artifactRecipe: artifactRecipe(),
    });
    const summary = preview.resolvedInputSummary as {
      recipe: {
        sections: Array<{
          components: Array<{
            type: string;
            chart?: { data?: { value?: string } };
          }>;
        }>;
      };
    };
    const values = summary.recipe.sections
      .flatMap((section) => section.components)
      .filter((component) => component.type === "chart")
      .map((component) => component.chart?.data?.value);
    assert.deepEqual(values, ["requestCount", "errorRate", "p95LatencyMs"]);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function dataset(): AutomationDataset {
  return {
    type: "dataset",
    schema: { fields: [
      { name: "hour", type: "string" },
      { name: "requestCount", type: "number" },
      { name: "errorRate", type: "number" },
      { name: "p95LatencyMs", type: "number" },
    ] },
    rows: [
      { hour: "09:00", requestCount: 10, errorRate: 0.1, p95LatencyMs: 250 },
      { hour: "10:00", requestCount: 20, errorRate: 0.05, p95LatencyMs: 300 },
    ],
  };
}

function artifactRecipe(): ArtifactRecipe {
  return {
    version: 1,
    format: "html",
    title: "小时运行报告",
    components: [
      { id: "requests", type: "line_chart", binding: { xField: "hour", valueField: "requestCount" } },
      { id: "errors", type: "line_chart", binding: { xField: "hour", valueField: "errorRate" } },
      { id: "latency", type: "line_chart", binding: { xField: "hour", valueField: "p95LatencyMs" } },
    ],
    layout: { structure: "report", sections: ["trends"] },
    theme: { name: "wemail" },
    accessibility: { includeTextSummary: true, chartDescriptions: true },
    emptyState: "暂无数据",
    errorState: "生成失败",
    outputSchema: {},
  };
}

function step(): CompiledAutomationStep {
  return {
    id: "render",
    provider: "design",
    capability: "render",
    input: {},
    descriptor: {
      provider: "design",
      id: "render",
      version: "1",
      kind: "design",
      label: "设计",
      description: "设计",
      inputSchema: {},
      outputSchema: {},
      risk: "local-write",
      sideEffects: ["write-local-artifact"],
      previewSupport: "full",
      idempotency: "keyed",
      discoveryConfidence: "declared",
      fingerprint: "design-1",
    },
  };
}
