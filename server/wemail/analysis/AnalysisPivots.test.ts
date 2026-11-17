import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationDataset } from "../../../shared/wemail/automation.js";
import { inferDimensions } from "./inferDimensions.js";
import { generatePivots } from "./generatePivots.js";
import { computeComparison } from "./computeComparison.js";
import { deriveInsightDimensions } from "./deriveInsightDimensions.js";
import { planInsightViews } from "./planInsightViews.js";

const ds: AutomationDataset = {
  type: "dataset",
  schema: { fields: [
    { name: "date", type: "date", label: "日期" },
    { name: "model", type: "string", label: "模型" },
    { name: "deal_status", type: "string", label: "状态" },
    { name: "cnt", type: "number", label: "调用量" },
  ]},
  rows: [
    { date: "2026-07-01", model: "qwen3-30b", deal_status: "S", cnt: 3019 },
    { date: "2026-07-01", model: "qwen3-32b", deal_status: "S", cnt: 2928 },
    { date: "2026-07-01", model: "qwen3-30b", deal_status: "F", cnt: 12 },
    { date: "2026-07-02", model: "qwen3-30b", deal_status: "S", cnt: 2880 },
  ],
  provenance: [],
};

test("inferDimensions: date→time, model→type, deal_status→status, cnt→measure", () => {
  const d = inferDimensions(ds);
  assert.deepEqual(d.temporal, ["date"]);
  assert.equal(d.status, "deal_status");
  assert.ok(d.categorical.includes("model"));
  assert.ok(d.measures.includes("cnt"));
});

test("generatePivots: emits diverse host-planned views across time and dimensions", () => {
  const pivots = generatePivots(ds);
  assert.ok(pivots.some((p) => (p.family === "line" || p.family === "area") && p.x === "date" && p.y === "cnt"));
  assert.ok(pivots.some((p) => p.family === "bar" && p.x === "model"));
  assert.ok(pivots.some((p) => p.family === "waffle" && p.x === "deal_status"));
  assert.ok(new Set(pivots.map((pivot) => pivot.family)).size >= 3);
});

test("generatePivots: skips pivots whose dimensions are absent", () => {
  const noTime: AutomationDataset = { ...ds, schema: { fields: ds.schema.fields.filter((f) => f.name !== "date") } };
  const pivots = generatePivots(noTime);
  // no time → no trend, but every dimension still gets a comparison view
  assert.ok(!pivots.some((p) => p.family === "line"));
  assert.ok(pivots.some((p) => p.family === "bar" && p.x === "model"));
  assert.ok(pivots.some((p) => p.family === "bar" && p.x === "deal_status"));
});

test("generatePivots: overlapping time windows are separated instead of stacked", () => {
  const windows: AutomationDataset = {
    type: "dataset",
    schema: { fields: [
      { name: "task_name", type: "string", label: "任务名", semanticRole: "dimension", semanticId: "task_name" },
      { name: "type", type: "string", label: "类型", semanticRole: "dimension", semanticId: "execution_type" },
      { name: "window", type: "string", label: "时间窗口", semanticRole: "time_window", semanticId: "time_window" },
      { name: "value", type: "number", label: "调用量", semanticRole: "measure", semanticId: "value" },
    ] },
    rows: [
      { task_name: "A", type: "实时", window: "最近一小时", value: 100 },
      { task_name: "A", type: "实时", window: "当天", value: 1200 },
      { task_name: "B", type: "离线", window: "最近一小时", value: 20 },
      { task_name: "B", type: "离线", window: "当天", value: 300 },
    ],
  };

  const inferred = inferDimensions(windows);
  assert.deepEqual(inferred.timeWindows, ["window"]);
  const pivots = generatePivots(windows);
  assert.ok(pivots.some((pivot) => pivot.family === "heatmap" && pivot.x === "type" && pivot.splitBy === "window"));
  assert.ok(pivots.some((pivot) => pivot.family === "heatmap" && pivot.x === "task_name" && pivot.splitBy === "window"));
  assert.ok(!pivots.some((pivot) => pivot.family === "stacked-bar"));
});

test("generatePivots: retains type, model, and status as visible analytical views", () => {
  const multi: AutomationDataset = {
    type: "dataset",
    schema: { fields: [
      { name: "biz_type", type: "string", label: "业务类型", semanticRole: "dimension" },
      { name: "model", type: "string", label: "模型", semanticRole: "dimension" },
      { name: "deal_status", type: "string", label: "状态", semanticRole: "status" },
      { name: "cnt", type: "number", label: "调用量", semanticRole: "measure" },
    ] },
    rows: [
      { biz_type: "实时", model: "A", deal_status: "S", cnt: 10 },
      { biz_type: "离线", model: "B", deal_status: "F", cnt: 2 },
    ],
  };
  const pivots = generatePivots(multi);
  const boundDimensions = new Set(pivots.flatMap((pivot) => [pivot.x, pivot.splitBy].filter(Boolean)));
  assert.ok(boundDimensions.has("biz_type"));
  assert.ok(boundDimensions.has("model"));
  assert.ok(boundDimensions.has("deal_status"));
  assert.ok(pivots.some((pivot) => pivot.family === "heatmap" || pivot.family === "treemap"));
});

test("generatePivots: adds distribution and true numeric relationship views without model output", () => {
  const rich: AutomationDataset = {
    type: "dataset",
    schema: { fields: [
      { name: "team", type: "string", label: "团队", semanticRole: "dimension" },
      { name: "volume", type: "number", label: "邮件数量", semanticRole: "measure" },
      { name: "latency", type: "number", label: "响应时长(ms)", semanticRole: "measure" },
    ] },
    rows: Array.from({ length: 16 }, (_, index) => ({
      team: index % 2 ? "A" : "B",
      volume: 10 + index * 3,
      latency: 40 + index * 8 + (index % 3) * 5,
    })),
  };
  const pivots = generatePivots(rich);
  assert.ok(pivots.some((pivot) => pivot.family === "histogram"));
  assert.ok(pivots.some((pivot) => pivot.family === "boxplot"));
  assert.ok(pivots.some((pivot) => pivot.family === "scatter" && pivot.x === "volume" && pivot.y === "latency"));
  const analysis = planInsightViews(rich);
  assert.equal(analysis.generatedBy, "deterministic-host");
  assert.ok(analysis.intents.some((intent) => intent.relation === "distribution" && intent.measures[0] === "latency"));
  assert.ok(analysis.intents.some((intent) => intent.relation === "correlation"));
  assert.ok(analysis.views.every((view) => view.reason.length > 0));
  const diversityBudget = planInsightViews(rich, { maxCharts: 5 }).views;
  assert.equal(new Set(diversityBudget.map((view) => view.chart.family)).size, diversityBudget.length);
  assert.equal(analysis.coverage.find((item) => item.lens === "distribution")?.status, "covered");
  assert.equal(analysis.coverage.find((item) => item.lens === "relationship")?.status, "covered");
  assert.equal(analysis.coverage.find((item) => item.lens === "quality")?.status, "covered");
});

test("deriveInsightDimensions: adds auditable weekday, time-band, and month angles", () => {
  const temporal: AutomationDataset = {
    type: "dataset",
    schema: { fields: [
      { name: "sent_at", type: "datetime", label: "发送时间", semanticRole: "time" },
      { name: "count", type: "number", label: "邮件数", semanticRole: "measure" },
    ] },
    rows: [
      { sent_at: "2026-07-31T01:00:00Z", count: 5 },
      { sent_at: "2026-08-01T07:00:00Z", count: 8 },
      { sent_at: "2026-08-03T13:00:00Z", count: 13 },
      { sent_at: "2026-08-04T20:00:00Z", count: 3 },
    ],
  };

  deriveInsightDimensions(temporal, { timezone: "Asia/Shanghai" });
  const derived = temporal.schema.fields.filter((field) => field.semanticId?.startsWith("derived:"));
  assert.deepEqual(derived.map((field) => field.semanticId).sort(), [
    "derived:month:sent_at",
    "derived:time-band:sent_at",
    "derived:weekday:sent_at",
  ]);
  assert.equal(temporal.summary?.analysisTimezone, "Asia/Shanghai");
  assert.equal((temporal.summary?.derivedDimensions as unknown[]).length, 3);
  assert.equal(temporal.rows[0].__derived_sent_at_time_band, "上午 06–11");

  const analysis = planInsightViews(temporal);
  assert.ok(analysis.dimensions.some((dimension) => dimension.field === "__derived_sent_at_weekday"));
  assert.ok(analysis.dimensions.some((dimension) => dimension.field === "__derived_sent_at_time_band" && dimension.kind === "time-window"));
});

test("computeComparison: 环比 on two periods; 同比 insufficient without year-ago", () => {
  const cmp = computeComparison(ds, "date", "cnt");
  assert.ok(cmp.periodOverPeriod);
  // 07-01 = 3019+2928+12 = 5959; 07-02 = 2880
  assert.equal(cmp.periodOverPeriod!.previous, 5959);
  assert.equal(cmp.periodOverPeriod!.current, 2880);
  assert.ok(cmp.periodOverPeriod!.delta < 0);
  assert.deepEqual(cmp.yearOverYear, { insufficient: true });
});
