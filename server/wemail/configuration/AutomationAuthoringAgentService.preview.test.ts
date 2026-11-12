import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionPipelineDraft } from "../../../shared/wemail/skillCenter.js";
import { deriveArtifactPreviewSpec } from "./AutomationAuthoringAgentService.js";

test("artifact preview derives fields from the current recipe instead of a built-in scenario", () => {
  const artifact: ExecutionPipelineDraft["artifact"] = {
    version: 1,
    format: "html",
    title: "经营简报",
    components: [{
      id: "trend",
      type: "line_chart",
      binding: {
        xField: "date",
        valueFields: ["revenue", "cost"],
      },
    }],
    layout: { structure: "report", sections: ["trend"] },
    theme: { name: "wemail" },
    accessibility: { includeTextSummary: true, chartDescriptions: true },
    emptyState: "暂无数据",
    errorState: "生成失败",
    outputSchema: {},
  };
  const preview = deriveArtifactPreviewSpec(artifact, [{
    date: "2026-08-01",
    revenue: 120,
    cost: 80,
  }]);
  assert.equal(preview.xField, "date");
  assert.deepEqual(preview.series.map((series) => series.field), ["revenue", "cost"]);
  assert.match(preview.textSummary, /经营简报/);
  assert.doesNotMatch(preview.textSummary, /调用量|失败量|平均耗时/);
});
