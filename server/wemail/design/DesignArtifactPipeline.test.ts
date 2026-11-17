import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AutomationDataset } from "../../../shared/wemail/automation.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { ApplicationMessageRepository } from "../applicationMessages/ApplicationMessageRepository.js";
import { DesignRecipeCompiler } from "./DesignRecipeCompiler.js";
import { DesignRenderer } from "./DesignRenderer.js";
import { AgentArtifactDeliveryService } from "./AgentArtifactDeliveryService.js";
import { validateArtifactHtml } from "./monoValidator.js";
import { INSIGHT_REPORT_TEMPLATES } from "./InsightReportTemplates.js";
import { MessageArtifactRepository } from "./MessageArtifactRepository.js";
import { InsightReportRepository } from "./InsightReportRepository.js";

const dataset: AutomationDataset = {
  type: "dataset",
  schema: { fields: [{ name: "day", type: "date", label: "日期" }, { name: "amount", type: "number", label: "金额" }] },
  rows: [{ day: "2026-07-01", amount: 120 }, { day: "2026-07-02", amount: 180 }],
  summary: { totalAmount: 300, totalInvoices: 2 },
  provenance: [{ outputPath: "rows.0", sourceType: "mail", emailIds: ["mail-1"] }],
};

test("trusted design pipeline persists immutable HTML and exposes it only through an owned message", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-design-artifact-"));
  const db = openOrCreateMailDatabase(path.join(dir, "db.sqlite"));
  try {
    const recipe = new DesignRecipeCompiler().compile({ dataset, mode: "auto", objective: "生成发票趋势报告", title: "发票报告" });
    assert.equal(recipe.kind, "report");
    const rendered = new DesignRenderer().render(recipe, dataset);
    assert.match(rendered.html, /<script id="wemail-viewer-runtime"/);
    assert.doesNotMatch(rendered.html, /<script[^>]*\ssrc="https?:\/\//i);
    assert.doesNotMatch(rendered.html, /<script[^>]*\ssrc="https?:\/\//i);
    assert.match(rendered.html, /300/);
    const artifacts = new MessageArtifactRepository(db, dir, () => "2026-07-27T10:00:00.000Z");
    const artifact = artifacts.create({ accountId: "acct-1", recipe, html: rendered.html, preview: rendered.preview, sourceRuleId: "rule-1", sourceRuleVersion: 1, sourceRunId: "run-1" });
    assert.equal(artifacts.getManifest(artifact.artifactId, 1, "acct-2"), null);
    assert.equal(artifacts.readResource(artifact.artifactId, 1, "../secret", "acct-1"), null);
    const messages = new ApplicationMessageRepository(db, () => "2026-07-27T10:00:00.000Z");
    const message = messages.create({ accountId: "acct-1", sourceType: "automation", sourceRuleId: "rule-1", sourceRunId: "run-1", type: "analysis", severity: "success", title: recipe.title, preview: rendered.preview, content: [{ type: "paragraph", text: rendered.preview }], references: [], interactions: [{ type: "openArtifact", artifactId: artifact.artifactId, version: 1, label: "查看完整内容" }], artifact: { id: artifact.artifactId, version: 1, kind: artifact.kind, contentHash: artifact.contentHash }, keyMetrics: rendered.keyMetrics, delayed: true });
    assert.equal(message.artifact?.id, artifact.artifactId);
    assert.equal(message.delayed, true);
    const resource = artifacts.readResource(artifact.artifactId, 1, "index.html", "acct-1");
    assert.equal(resource?.body.toString("utf8"), rendered.html);
    const profileArtifact = artifacts.create({
      accountId: "acct-1",
      owner: { type: "localProfile", profileId: "default" },
      recipe,
      html: rendered.html,
      preview: rendered.preview,
    });
    assert.ok(
      artifacts.getManifest(profileArtifact.artifactId, 1, "acct-2", "default"),
      "local-profile artifacts are visible from another connected account",
    );
    assert.equal(
      artifacts.getManifest(profileArtifact.artifactId, 1, "acct-2", "other"),
      null,
    );
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("design compiler uses deck only for explicit presentation intent and rejects fabricated bindings", () => {
  const compiler = new DesignRecipeCompiler();
  assert.equal(compiler.compile({ dataset, mode: "auto", objective: "做成汇报 slide" }).kind, "deck");
  assert.equal(compiler.compile({ dataset, mode: "auto", objective: "分析本月发票" }).kind, "report");
});

test("insight templates turn nested summaries and ISO dates into a readable report", () => {
  const conversationDataset: AutomationDataset = {
    type: "dataset",
    schema: {
      fields: [
        { name: "day", type: "datetime", label: "日期" },
        { name: "calls", type: "number", label: "调用量" },
        { name: "failures", type: "number", label: "失败数" },
      ],
    },
    rows: [
      { day: "2026-07-23T00:00:00.000+08:00", calls: 0, failures: 0 },
      { day: "2026-07-24T00:00:00.000+08:00", calls: 1_200, failures: 3 },
      { day: "2026-07-29T00:00:00.000+08:00", calls: 82_482, failures: 108 },
    ],
    summary: {
      metrics: [
        { label: "总调用数", value: 82_482 },
        { label: "总失败数", value: 108 },
      ],
      insights: [
        { title: "集中时段", conclusion: "调用量主要集中在 7 月 29 日。" },
      ],
      notes: "数据来源为会话分析相关邮件。",
    },
  };
  const compiler = new DesignRecipeCompiler();
  const recipe = compiler.compile({
    dataset: conversationDataset,
    mode: "report",
    title: "最近七天会话分析指标趋势",
    objective: "分析调用量、失败数和告警变化",
  });
  const rendered = new DesignRenderer().render(recipe, conversationDataset);

  assert.equal(recipe.templateId, "operational-health");
  assert.equal(INSIGHT_REPORT_TEMPLATES.length, 4);
  assert.ok(recipe.sections[0].components.some((component) => component.type === "insight-list"));
  assert.ok(recipe.sections[0].components.every((component) =>
    component.type !== "metric" || component.valuePath !== "summary.metrics"));
  assert.doesNotMatch(rendered.html, /\[object Object\]/);
  assert.doesNotMatch(rendered.html, /总调用数/);
  assert.doesNotMatch(rendered.html, /2026-07-23T00:00:00/);
  assert.match(rendered.html, /07\/23/);
  assert.match(rendered.html, /关键发现/);
  assert.match(rendered.html, /grid-line/);
  assert.match(rendered.html, /调用量主要集中在 7 月 29 日/);
});

test("reports without numeric fields degrade to conclusions and detail instead of a fake chart", () => {
  const textDataset: AutomationDataset = {
    type: "dataset",
    schema: {
      fields: [
        { name: "topic", type: "string", label: "主题" },
        { name: "owner", type: "string", label: "负责人" },
      ],
    },
    rows: [{ topic: "续费跟进", owner: "销售团队" }],
    summary: { conclusion: "当前最重要的事项是完成续费跟进。" },
  };
  const recipe = new DesignRecipeCompiler().compile({
    dataset: textDataset,
    mode: "report",
    title: "事项洞察",
  });
  const rendered = new DesignRenderer().render(recipe, textDataset);

  assert.equal(recipe.templateId, "executive-insight");
  assert.ok(recipe.sections[0].components.every((component) => component.type !== "chart"));
  assert.match(rendered.html, /当前最重要的事项是完成续费跟进/);
  assert.match(rendered.html, /数据明细/);
});

test("a single email can be faithfully converted into a compact field-comparison chart", () => {
  const mailDataset: AutomationDataset = {
    type: "dataset",
    schema: {
      fields: [
        { name: "opens", type: "number", label: "打开数" },
        { name: "clicks", type: "number", label: "点击数" },
        { name: "replies", type: "number", label: "回复数" },
        { name: "unsubscribes", type: "number", label: "退订数" },
      ],
    },
    rows: [{ opens: 1_280, clicks: 326, replies: 48, unsubscribes: 7 }],
    summary: { note: "以下数值来自邮件正文中的活动复盘表。" },
    provenance: [{ outputPath: "rows.0", sourceType: "mail", emailIds: ["mail-campaign-review"] }],
  };
  const recipe = new DesignRecipeCompiler().compile({
    dataset: mailDataset,
    mode: "report",
    title: "活动邮件数据图表",
    objective: "把这封邮件里的数据转换成图表",
  });
  const rendered = new DesignRenderer().render(recipe, mailDataset);
  const chart = recipe.sections[0].components.find((component) => component.type === "chart");

  assert.equal(recipe.purpose, "visualize");
  assert.equal(recipe.templateId, "email-visual-summary");
  assert.ok(chart?.type === "chart" && chart.chart.data.measures?.length === 4);
  assert.ok(recipe.sections[0].components.every((component) => component.type !== "insight-list"));
  assert.doesNotMatch(rendered.html, /核心结论|峰值观察|趋势变化/);
  assert.match(rendered.html, /WEMAIL VISUAL/);
  assert.match(rendered.html, /来源：1 封邮件/);
  assert.match(rendered.html, /打开数/);
  assert.match(rendered.html, /邮件中的数值对比/);
});

test("dated text from one email becomes a timeline instead of a fabricated numeric chart", () => {
  const scheduleDataset: AutomationDataset = {
    type: "dataset",
    schema: {
      fields: [
        { name: "date", type: "date", label: "日期" },
        { name: "event", type: "string", label: "事项" },
        { name: "owner", type: "string", label: "负责人" },
      ],
    },
    rows: [
      { date: "2026-08-03", event: "提交初稿", owner: "产品组" },
      { date: "2026-08-06", event: "客户评审", owner: "项目组" },
    ],
    provenance: [
      { outputPath: "rows", sourceType: "mail", emailIds: ["mail-project-plan"] },
    ],
  };
  const recipe = new DesignRecipeCompiler().compile({
    dataset: scheduleDataset,
    mode: "report",
    title: "项目排期",
    objective: "把这封邮件整理成时间线",
  });
  const rendered = new DesignRenderer().render(recipe, scheduleDataset);

  assert.equal(recipe.purpose, "visualize");
  assert.equal(recipe.templateId, "timeline-view");
  assert.ok(recipe.sections[0].components.some((component) => component.type === "timeline"));
  assert.ok(recipe.sections[0].components.every((component) => component.type !== "chart"));
  assert.match(rendered.html, /邮件时间线/);
  assert.match(rendered.html, /提交初稿/);
  assert.match(rendered.html, /客户评审/);
});

test("snapshot dataset with '趋势' in the prompt never yields a trend chart (original-bug regression)", () => {
  // The original bug: a single-time-point snapshot produced a "值趋势" line because "趋势"
  // in the prompt force-triggered forceLine. The compiler must now refuse a line/area here.
  const snapshot: AutomationDataset = {
    type: "dataset",
    schema: {
      fields: [
        { name: "channel", type: "string", label: "渠道" },
        { name: "metric", type: "string", label: "指标" },
        { name: "value", type: "number", label: "值" },
        { name: "unit", type: "string", label: "单位" },
      ],
    },
    rows: [
      { channel: "telephony", metric: "通话总量", value: 37573, unit: "次" },
      { channel: "wechat", metric: "通话总量", value: 6210, unit: "次" },
    ],
    provenance: [{ outputPath: "rows", sourceType: "mail", emailIds: ["m1"] }],
  };
  const recipe = new DesignRecipeCompiler().compile({
    dataset: snapshot, mode: "report", title: "监控日报",
    objective: "分析监控数据，提炼异常点和趋势，生成趋势图",
  });
  const charts = recipe.sections.flatMap((s) => s.components).filter((c) => c.type === "chart");
  for (const c of charts) {
    if (c.type === "chart") {
      assert.ok(c.chart.type !== "line" && c.chart.type !== "area", `snapshot must not yield a trend chart, got ${c.chart.type}`);
    }
  }
});

test("an intra-day HH:MM time series is temporal even when string-typed (line allowed)", () => {
  const intraday: AutomationDataset = {
    type: "dataset",
    schema: { fields: [{ name: "hour", type: "string", label: "时段" }, { name: "calls", type: "number", label: "调用量" }] },
    rows: [{ hour: "09:00", calls: 8428 }, { hour: "12:00", calls: 10229 }, { hour: "15:00", calls: 9770 }],
    provenance: [],
  };
  const recipe = new DesignRecipeCompiler().compile({ dataset: intraday, mode: "report", objective: "趋势" });
  const charts = recipe.sections.flatMap((s) => s.components).filter((c) => c.type === "chart");
  assert.ok(charts.some((c) => c.type === "chart" && (c.chart.type === "line" || c.chart.type === "area")), "intra-day HH:MM series should permit a trend chart");
});

test("a real multi-point time series may use a trend chart", () => {
  const ts: AutomationDataset = {
    type: "dataset",
    schema: { fields: [{ name: "day", type: "date", label: "日期" }, { name: "value", type: "number", label: "值" }] },
    rows: [{ day: "2026-07-01", value: 10 }, { day: "2026-07-02", value: 20 }, { day: "2026-07-03", value: 15 }],
    provenance: [],
  };
  const recipe = new DesignRecipeCompiler().compile({ dataset: ts, mode: "report", objective: "趋势" });
  const charts = recipe.sections.flatMap((s) => s.components).filter((c) => c.type === "chart");
  assert.ok(charts.some((c) => c.type === "chart" && c.chart.type === "line"), "a multi-point time series should permit a line");
});

test("thin spec: 占比 maps to waffle and cross-unit aggregation is refused", () => {
  const mono: AutomationDataset = {
    type: "dataset",
    schema: {
      fields: [
        { name: "channel", type: "string", label: "渠道" },
        { name: "metric", type: "string", label: "指标" },
        { name: "value", type: "number", label: "值" },
        { name: "unit", type: "string", label: "单位" },
      ],
    },
    rows: [
      { channel: "telephony", metric: "通话总量", value: 37573, unit: "次" },
      { channel: "wechat", metric: "通话总量", value: 6210, unit: "次" },
    ],
    provenance: [{ outputPath: "rows", sourceType: "mail", emailIds: ["m1"] }],
  };
  const recipeW = new DesignRecipeCompiler().compile({
    dataset: mono, mode: "report", title: "占比",
    charts: [{ family: "waffle", x: "channel", y: "value", where: { metric: "通话总量" } }],
  });
  const chartsW = recipeW.sections.flatMap((s) => s.components).filter((c) => c.type === "chart");
  assert.ok(chartsW.some((c) => c.type === "chart" && c.chart.type === "waffle"), "占比 should expand to a waffle");

  const mixed: AutomationDataset = {
    ...mono,
    rows: [
      { channel: "telephony", metric: "通话总量", value: 37573, unit: "次" },
      { channel: "telephony", metric: "成功率", value: 91, unit: "%" },
    ],
  };
  const recipeM = new DesignRecipeCompiler().compile({
    dataset: mixed, mode: "report", title: "混合",
    charts: [{ family: "bar", x: "metric", y: "value" }],
  });
  const chartsM = recipeM.sections.flatMap((s) => s.components).filter((c) => c.type === "chart");
  assert.equal(chartsM.length, 0, "cross-unit aggregation must be refused with no chart");
});

test("one-shot delivery threads the model's thin chart spec into the rendered artifact (waffle yes, bogus line refused)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-design-artifact-"));
  const db = openOrCreateMailDatabase(path.join(dir, "db.sqlite"));
  try {
    const channelDataset: AutomationDataset = {
      type: "dataset",
      schema: { fields: [{ name: "channel", type: "string", label: "渠道" }, { name: "value", type: "number", label: "值" }] },
      rows: [{ channel: "telephony", value: 37573 }, { channel: "wechat", value: 6210 }],
      provenance: [{ outputPath: "rows", sourceType: "mail", emailIds: ["m1"] }],
    };
    const artifacts = new MessageArtifactRepository(db, dir, () => "2026-07-31T00:00:00.000Z");
    const messages = new ApplicationMessageRepository(db, () => "2026-07-31T00:00:00.000Z");
    const delivery = new AgentArtifactDeliveryService(messages, artifacts, new InsightReportRepository(db, () => "2026-07-31T00:00:00.000Z"));

    const waffle = delivery.publish({
      accountId: "acct-1", title: "渠道通话占比", mode: "report", objective: "占比",
      dataset: channelDataset,
      charts: [{ family: "waffle", x: "channel", y: "value" }],
    });
    const waffleHtml = artifacts.readResource(waffle.artifact.artifactId, 1, "index.html", "acct-1")?.body.toString("utf8") ?? "";
    assert.match(waffleHtml, /data-chart-type="waffle"/);

    // Guardrail via the real delivery path: a line on a non-temporal field is refused.
    const refused = delivery.publish({
      accountId: "acct-1", title: "不应出线", mode: "report", dataset: channelDataset,
      charts: [{ family: "line", x: "channel", y: "value" }],
    });
    const refusedHtml = artifacts.readResource(refused.artifact.artifactId, 1, "index.html", "acct-1")?.body.toString("utf8") ?? "";
    assert.doesNotMatch(refusedHtml, /data-chart-type="line"/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("rendered artifact carries the brand header, a source line, no script, and passes the mono validator", () => {
  const recipe = new DesignRecipeCompiler().compile({ dataset, mode: "auto", objective: "生成发票趋势报告", title: "发票报告" });
  const rendered = new DesignRenderer().render(recipe, dataset);
  assert.match(rendered.html, /WeMail/);
  assert.match(rendered.html, /数据说明 · 来源：/);
  assert.ok((rendered.html.match(/<script\b/gi) || []).length <= 2);
  assert.doesNotMatch(rendered.html, /<script[^>]+src="\.\/echarts\.min\.js"/);
  assert.match(rendered.html, /<script id="wemail-echarts-runtime">/);
  assert.match(rendered.html, /<script id="wemail-viewer-runtime"/);
  const mono = validateArtifactHtml(rendered.html);
  assert.ok(mono.ok, `mono violations: ${mono.failures.join("; ")}`);
});

test("new mono families render: scatter / stacked-bar / heatmap / dumbbell", () => {
  const matrix: AutomationDataset = {
    type: "dataset",
    schema: { fields: [
      { name: "hour", type: "string", label: "时段" },
      { name: "channel", type: "string", label: "渠道" },
      { name: "value", type: "number", label: "值" },
    ]},
    rows: [
      { hour: "09:00", channel: "telephony", value: 8428 },
      { hour: "09:00", channel: "wechat", value: 1200 },
      { hour: "12:00", channel: "telephony", value: 10229 },
      { hour: "12:00", channel: "wechat", value: 2100 },
    ],
    provenance: [],
  };
  const compiler = new DesignRecipeCompiler();
  const renderer = new DesignRenderer();
  const stacked = renderer.render(compiler.compile({ dataset: matrix, mode: "report", charts: [{ family: "stacked-bar", x: "hour", y: "value", splitBy: "channel" }] }), matrix);
  assert.match(stacked.html, /data-chart-type="stacked-bar"/);
  const heat = renderer.render(compiler.compile({ dataset: matrix, mode: "report", charts: [{ family: "heatmap", x: "hour", y: "value", splitBy: "channel" }] }), matrix);
  assert.match(heat.html, /data-chart-type="heatmap"/);
  const scat = renderer.render(compiler.compile({ dataset: matrix, mode: "report", charts: [{ family: "scatter", x: "hour", y: "value" }] }), matrix);
  assert.match(scat.html, /data-chart-type="scatter"/);

  const beforeAfter: AutomationDataset = {
    type: "dataset",
    schema: { fields: [
      { name: "team", type: "string", label: "团队" },
      { name: "before", type: "number", label: "上周" },
      { name: "after", type: "number", label: "本周" },
    ]},
    rows: [{ team: "A", before: 30, after: 45 }, { team: "B", before: 50, after: 40 }],
    provenance: [],
  };
  const dumb = renderer.render(compiler.compile({ dataset: beforeAfter, mode: "report", charts: [{ family: "dumbbell", x: "team", y: "before", y2: "after" }] }), beforeAfter);
  assert.match(dumb.html, /data-chart-type="dumbbell"/);

  // all of them must still pass the mono validator (no saturated color, no script).
  for (const html of [stacked.html, heat.html, scat.html, dumb.html]) {
    const m = validateArtifactHtml(html);
    assert.ok(m.ok, `mono violations: ${m.failures.join("; ")}`);
  }
});

test("distribution families render and numeric scatter uses two value axes", () => {
  const distribution: AutomationDataset = {
    type: "dataset",
    schema: { fields: [
      { name: "team", type: "string", label: "团队" },
      { name: "volume", type: "number", label: "邮件量" },
      { name: "latency", type: "number", label: "响应时长" },
    ] },
    rows: Array.from({ length: 16 }, (_, index) => ({
      team: index % 2 ? "A" : "B",
      volume: 20 + index * 4,
      latency: 80 + index * 7 + (index % 3) * 9,
    })),
    provenance: [],
  };
  const compiler = new DesignRecipeCompiler();
  const renderer = new DesignRenderer();
  const histogram = renderer.render(compiler.compile({
    dataset: distribution,
    mode: "report",
    charts: [{ family: "histogram", x: "latency", y: "latency" }],
  }), distribution).html;
  const boxplot = renderer.render(compiler.compile({
    dataset: distribution,
    mode: "report",
    charts: [{ family: "boxplot", x: "team", y: "latency" }],
  }), distribution).html;
  const scatter = renderer.render(compiler.compile({
    dataset: distribution,
    mode: "report",
    charts: [{ family: "scatter", x: "volume", y: "latency", splitBy: "team" }],
  }), distribution).html;
  assert.match(histogram, /data-chart-type="histogram"/);
  assert.match(boxplot, /data-chart-type="boxplot"/);
  assert.match(scatter, /data-chart-type="scatter"/);
  for (const html of [histogram, boxplot, scatter]) {
    const mono = validateArtifactHtml(html);
    assert.ok(mono.ok, `mono violations: ${mono.failures.join("; ")}`);
  }
});

test("bare chart-type titles are overridden with a conclusion-style title", () => {
  const ds: AutomationDataset = {
    type: "dataset",
    schema: { fields: [{ name: "channel", type: "string", label: "渠道" }, { name: "value", type: "number", label: "通话总量" }] },
    rows: [{ channel: "telephony", value: 37573 }, { channel: "wechat", value: 6210 }],
    provenance: [],
  };
  const recipe = new DesignRecipeCompiler().compile({
    dataset: ds, mode: "report",
    charts: [{ family: "bar", x: "channel", y: "value", title: "柱状图" }],
  });
  const chart = recipe.sections.flatMap((s) => s.components).find((c) => c.type === "chart");
  assert.ok(chart?.type === "chart");
  assert.notEqual(chart?.chart.title, "柱状图");
  assert.match(chart?.chart.title ?? "", /对比/);
});

test("line with splitBy renders a multi-series chart (ECharts or SVG fallback)", () => {
  const ds: AutomationDataset = {
    type: "dataset",
    schema: { fields: [
      { name: "date", type: "date", label: "日期" },
      { name: "hour", type: "string", label: "时段" },
      { name: "value", type: "number", label: "调用量" },
    ]},
    rows: [
      { date: "2026-08-01", hour: "09:00", value: 8000 },
      { date: "2026-08-01", hour: "12:00", value: 12000 },
      { date: "2026-08-02", hour: "09:00", value: 9000 },
      { date: "2026-08-02", hour: "12:00", value: 11000 },
    ],
    provenance: [],
  };
  const html = new DesignRenderer().render(new DesignRecipeCompiler().compile({
    dataset: ds, mode: "report", charts: [{ family: "line", x: "hour", y: "value", splitBy: "date" }],
  }), ds).html;
  // ECharts: data-chart-type="line" + echarts-container with multi-series option; SVG fallback: >=2 polylines.
  const hasEcharts = /data-chart-type="line"/.test(html) && /echarts-container/.test(html);
  const polylines = (html.match(/<polyline/g) || []).length;
  assert.ok(hasEcharts || polylines >= 2, `multi-series line should render as ECharts or >=2 polylines`);
});

test("explicit charts take precedence over autoPivot", () => {
  const ds: AutomationDataset = {
    type: "dataset",
    schema: { fields: [
      { name: "type", type: "string", label: "类型" },
      { name: "value", type: "number", label: "调用量" },
    ] },
    rows: [{ type: "实时", value: 100 }, { type: "离线", value: 20 }],
  };
  const recipe = new DesignRecipeCompiler().compile({
    dataset: ds,
    mode: "report",
    autoPivot: true,
    charts: [{ family: "bar", x: "type", y: "value", title: "实时与离线调用量对比" }],
  });
  const charts = recipe.sections.flatMap((section) => section.components)
    .filter((component) => component.type === "chart");
  assert.equal(charts.length, 1);
  assert.equal(charts[0]?.type === "chart" ? charts[0].chart.title : "", "实时与离线调用量对比");
});

test("analyze purpose uses the full deterministic view plan without requiring autoPivot", () => {
  const dataset: AutomationDataset = {
    type: "dataset",
    schema: { fields: [
      { name: "sent_at", type: "datetime", label: "发送时间", semanticRole: "time" },
      { name: "team", type: "string", label: "团队", semanticRole: "dimension" },
      { name: "status", type: "string", label: "状态", semanticRole: "status" },
      { name: "mail_count", type: "number", label: "邮件数", semanticRole: "measure" },
    ] },
    rows: Array.from({ length: 14 }, (_, index) => ({
      sent_at: `2026-08-${String(index + 1).padStart(2, "0")}T${String((index * 3) % 24).padStart(2, "0")}:00:00+08:00`,
      team: index % 2 ? "销售" : "交付",
      status: index % 4 ? "已处理" : "待处理",
      mail_count: 20 + index * 3,
    })),
    summary: { analysisTimezone: "Asia/Shanghai" },
  };

  const recipe = new DesignRecipeCompiler().compile({ dataset, mode: "report", purpose: "analyze" });
  const components = recipe.sections.flatMap((section) => section.components);
  const charts = components
    .filter((component) => component.type === "chart")
    .map((component) => component.type === "chart" ? component.chart.type : "");
  assert.ok(new Set(charts).size >= 4);
  assert.ok(recipe.analysis?.intents.some((intent) => intent.relation === "time-composition"));
  assert.ok(recipe.analysis?.views.every((view) => view.reason.length > 0));
  assert.ok(dataset.schema.fields.some((field) => field.semanticId === "derived:weekday:sent_at"));
  const insightIndex = components.findIndex((component) => component.type === "insight-list");
  const lastChartIndex = components.reduce((index, component, candidate) => component.type === "chart" ? candidate : index, -1);
  const detailIndex = components.findIndex((component) => component.type === "table" && component.title === "数据明细");
  assert.ok(lastChartIndex >= 0 && lastChartIndex < insightIndex, "key findings must follow every chart");
  assert.ok(detailIndex > insightIndex, "key findings must remain above source detail");
  const html = new DesignRenderer().render(recipe, dataset).html;
  assert.doesNotMatch(html, /核心结论/);
  assert.match(html, /\.charts-row\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /\.charts-row>\.chart:last-child:nth-child\(odd\)\{grid-column:1\/-1\}/);
  assert.match(html, /@media\(max-width:820px\)\{\.charts-row\{grid-template-columns:1fr\}/);
});

test("analysisPlan renders every requested dimension as a switchable chart and summary table", () => {
  const ds: AutomationDataset = {
    type: "dataset",
    schema: { fields: [
      { name: "type", type: "string", label: "类型", semanticRole: "dimension" },
      { name: "model", type: "string", label: "模型", semanticRole: "dimension" },
      { name: "window", type: "string", label: "时间窗口", semanticRole: "time_window" },
      { name: "value", type: "number", label: "调用量", semanticRole: "measure" },
    ] },
    rows: [
      { type: "实时", model: "A", window: "最近一小时", value: 100 },
      { type: "实时", model: "A", window: "当天", value: 1200 },
      { type: "离线", model: "B", window: "最近一小时", value: 20 },
      { type: "离线", model: "B", window: "当天", value: 300 },
    ],
  };
  const compiler = new DesignRecipeCompiler();
  const analysisPlan = {
    dimensions: [
      { field: "type", requiredValues: ["实时", "离线"] },
      { field: "model", requiredValues: ["A", "B"] },
      { field: "window", requiredValues: ["最近一小时", "当天"], overlapping: true },
    ],
    measures: [{ field: "value", agg: "sum" as const }],
  };
  const recipe = compiler.compile({ dataset: ds, mode: "report", analysisPlan });
  const charts = recipe.sections.flatMap((section) => section.components)
    .filter((component) => component.type === "chart");
  assert.ok(charts.some((component) =>
    component.type === "chart" &&
    component.chart.type === "heatmap" &&
    component.chart.data.category === "type" &&
    component.chart.data.series === "window"));
  assert.ok(charts.some((component) =>
    component.type === "chart" &&
    component.chart.data.category === "model" &&
    component.chart.switchLabel === "模型"));
  assert.ok(charts.every((component) => component.type !== "chart" || component.chart.type !== "stacked-bar"));
  const tables = recipe.sections.flatMap((section) => section.components)
    .filter((component) => component.type === "table");
  assert.deepEqual(new Set(tables.map((component) => component.type === "table" ? component.switchLabel : undefined)), new Set(["类型", "模型"]));
  const html = new DesignRenderer().render(recipe, ds).html;
  assert.match(html, /data-switch-view="0"[^>]*>类型</);
  assert.match(html, /data-switch-view="1"[^>]*>模型</);
  assert.match(html, /类型维度汇总/);
  assert.match(html, /模型维度汇总/);

  assert.throws(() => compiler.compile({
    dataset: ds,
    mode: "report",
    analysisPlan: {
      ...analysisPlan,
      dimensions: [
        analysisPlan.dimensions[0],
        analysisPlan.dimensions[1],
        { field: "window", requiredValues: ["最近一小时", "最近一天"], overlapping: true },
      ],
    },
  }), /analysis-plan-missing-value:window:最近一天/);
});

// ── treemap family (lieflat F13, ported) ─────────────────────────────

test("treemap: two-level hierarchy renders via ECharts with parent=sum(children)", () => {
  const ds: AutomationDataset = {
    type: "dataset",
    schema: {
      fields: [
        { name: "scenario", type: "string", label: "场景" },
        { name: "model", type: "string", label: "模型" },
        { name: "cnt", type: "number", label: "调用量" },
      ],
    },
    rows: [
      { scenario: "话务小结", model: "qwen-32b", cnt: 300 },
      { scenario: "话务小结", model: "qwen-30b", cnt: 200 },
      { scenario: "意图识别", model: "qwen-32b", cnt: 100 },
      { scenario: "意图识别", model: "qwen-8b", cnt: 50 },
    ],
    summary: { totalCalls: 650 },
    provenance: [{ outputPath: "rows", sourceType: "mail", emailIds: ["mail-1"] }],
  };
  const recipe = new DesignRecipeCompiler().compile({
    dataset: ds, mode: "report", purpose: "visualize",
    charts: [{ family: "treemap", x: "scenario", y: "cnt", splitBy: "model", title: "场景×模型调用量构成" }],
  });
  const chart = recipe.sections.flatMap((s) => s.components)
    .find((c) => c.type === "chart" && c.chart.type === "treemap") as { type: "chart"; chart: { type: string; title: string } } | undefined;
  assert.ok(chart, "treemap thin spec should expand to a treemap chart");
  assert.equal(chart.chart.type, "treemap");
  const html = new DesignRenderer().render(recipe, ds).html;
  assert.match(html, /data-chart-type="treemap"/);
  assert.match(html, /HIERARCHY/);
  const opt = JSON.parse(html.match(/data-option='(\{[\s\S]*?\})'/)?.[1] ?? "{}");
  assert.ok(opt.series?.some((s: { type: string }) => s.type === "treemap"));
});

test("treemap: refused without a leaf (splitBy) dimension", () => {
  const ds: AutomationDataset = {
    type: "dataset",
    schema: {
      fields: [
        { name: "scenario", type: "string", label: "场景" },
        { name: "cnt", type: "number", label: "调用量" },
      ],
    },
    rows: [{ scenario: "话务小结", cnt: 500 }],
    summary: {},
    provenance: [{ outputPath: "rows", sourceType: "mail", emailIds: ["mail-1"] }],
  };
  const recipe = new DesignRecipeCompiler().compile({
    dataset: ds, mode: "report", purpose: "visualize",
    charts: [{ family: "treemap", x: "scenario", y: "cnt" }],
  });
  const treemaps = recipe.sections.flatMap((s) => s.components)
    .filter((c) => c.type === "chart" && c.chart.type === "treemap");
  assert.equal(treemaps.length, 0, "treemap without a leaf dimension must be refused");
});

test("treemap: refused when the measure is not a numeric field", () => {
  const ds: AutomationDataset = {
    type: "dataset",
    schema: {
      fields: [
        { name: "scenario", type: "string", label: "场景" },
        { name: "model", type: "string", label: "模型" },
        { name: "status", type: "string", label: "状态" },
      ],
    },
    rows: [{ scenario: "话务小结", model: "qwen-32b", status: "S" }],
    summary: {},
    provenance: [{ outputPath: "rows", sourceType: "mail", emailIds: ["mail-1"] }],
  };
  const recipe = new DesignRecipeCompiler().compile({
    dataset: ds, mode: "report", purpose: "visualize",
    charts: [{ family: "treemap", x: "scenario", y: "status", splitBy: "model" }],
  });
  const treemaps = recipe.sections.flatMap((s) => s.components)
    .filter((c) => c.type === "chart" && c.chart.type === "treemap");
  assert.equal(treemaps.length, 0, "treemap measure must be numeric");
});

// ── color systems (single-system lock; lieflat §6.5, adapted) ─────────

const colorDs: AutomationDataset = {
  type: "dataset",
  schema: {
    fields: [
      { name: "day", type: "date", label: "日期" },
      { name: "channel", type: "string", label: "渠道" },
      { name: "calls", type: "number", label: "调用量" },
    ],
  },
  rows: [
    { day: "2026-07-01", channel: "电销", calls: 120 },
    { day: "2026-07-02", channel: "电销", calls: 180 },
    { day: "2026-07-01", channel: "企微", calls: 60 },
    { day: "2026-07-02", channel: "企微", calls: 90 },
  ],
  summary: { totalCalls: 450 },
  provenance: [{ outputPath: "rows", sourceType: "mail", emailIds: ["mail-1"] }],
};

test("color system: explicit preset id lands on the recipe and the rendered skin", () => {
  const compiler = new DesignRecipeCompiler();
  assert.equal(compiler.compile({ dataset: colorDs, mode: "report", designSystem: "porcelain" }).designSystem, "wemail-porcelain");
  assert.equal(compiler.compile({ dataset: colorDs, mode: "report", designSystem: "palm" }).designSystem, "wemail-palm");
  assert.equal(compiler.compile({ dataset: colorDs, mode: "report", designSystem: "wire" }).designSystem, "wemail-wire");
  assert.equal(compiler.compile({ dataset: colorDs, mode: "report", designSystem: "mono" }).designSystem, "wemail-mono");
  const html = new DesignRenderer().render(compiler.compile({ dataset: colorDs, mode: "report", designSystem: "palm" }), colorDs).html;
  assert.match(html, /data-design-system="palm"/);
  assert.match(html, /--accent:#D4A017/);
});

test("color system: auto-selects porcelain for temporal data, mono otherwise", () => {
  const compiler = new DesignRecipeCompiler();
  const temporalRecipe = compiler.compile({ dataset: colorDs, mode: "report" });
  assert.equal(temporalRecipe.designSystem, "wemail-porcelain", "temporal data → porcelain (ordered blue ramp)");
  const staticDs: AutomationDataset = {
    type: "dataset",
    schema: { fields: [{ name: "channel", type: "string", label: "渠道" }, { name: "calls", type: "number", label: "调用量" }] },
    rows: [{ channel: "电销", calls: 120 }, { channel: "企微", calls: 60 }],
    summary: {},
    provenance: [{ outputPath: "rows", sourceType: "mail", emailIds: ["mail-1"] }],
  };
  assert.equal(compiler.compile({ dataset: staticDs, mode: "report" }).designSystem, "wemail-mono", "categorical-only → mono (safe fallback)");
  // Intent words still win over data shape.
  assert.equal(compiler.compile({ dataset: staticDs, mode: "report", objective: "做个暖色系的分析" }).designSystem, "wemail-palm");
});

test("color system: custom brand colorboard from user hexes, derived shades only", () => {
  const compiler = new DesignRecipeCompiler();
  const recipe = compiler.compile({ dataset: colorDs, mode: "report", designSystem: "custom:#165DFF,#0E42D2" });
  assert.equal(recipe.designSystem, "custom:#165dff,#0e42d2");
  const html = new DesignRenderer().render(recipe, colorDs).html;
  assert.match(html, /data-design-system="custom"/);
  assert.match(html, /--accent:#0e42d2/i);
  const opt = JSON.parse(html.match(/data-option='(\{[\s\S]*?\})'/)?.[1] ?? "{}");
  assert.equal(opt.color?.[0]?.toLowerCase(), "#165dff", "data color is the user's brand hex");
});

test("color system: ink boost thickens strokes and floors opacity under a non-mono system", () => {
  const compiler = new DesignRecipeCompiler();
  const porcelain = new DesignRenderer().render(compiler.compile({ dataset: colorDs, mode: "report", designSystem: "porcelain" }), colorDs).html;
  const mono = new DesignRenderer().render(compiler.compile({ dataset: colorDs, mode: "report", designSystem: "mono" }), colorDs).html;
  const porcelainLine = JSON.parse(porcelain.match(/data-option='(\{[\s\S]*?\})'/)?.[1] ?? "{}").series?.find((s: { type: string }) => s.type === "line");
  const monoLine = JSON.parse(mono.match(/data-option='(\{[\s\S]*?\})'/)?.[1] ?? "{}").series?.find((s: { type: string }) => s.type === "line");
  const porcelainWidth = porcelainLine.lineStyle.width;
  const monoWidth = monoLine.lineStyle.width;
  assert.ok(porcelainWidth >= monoWidth * 1.8 - 0.01, `colored stroke should be ×1.8 (got ${porcelainWidth} vs mono ${monoWidth})`);
});

// ── new families: diverging-bar / counter / donut→waffle retirement ──

const familyDs: AutomationDataset = {
  type: "dataset",
  schema: {
    fields: [
      { name: "date", type: "date", label: "日期" },
      { name: "model", type: "string", label: "模型" },
      { name: "cnt", type: "number", label: "调用量" },
      { name: "delta", type: "number", label: "日环比" },
    ],
  },
  rows: [
    { date: "2026-07-01", model: "m1", cnt: 100, delta: 30 },
    { date: "2026-07-02", model: "m1", cnt: 130, delta: 30 },
    { date: "2026-07-01", model: "m2", cnt: 60, delta: -20 },
    { date: "2026-07-02", model: "m2", cnt: 40, delta: -20 },
  ],
  summary: { totalCalls: 330 },
  provenance: [{ outputPath: "rows", sourceType: "mail", emailIds: ["mail-1"] }],
};

test("donut is retired: a legacy donut spec compiles to waffle", () => {
  const recipe = new DesignRecipeCompiler().compile({
    dataset: familyDs, mode: "report", purpose: "visualize",
    charts: [{ family: "donut", x: "model", y: "cnt" }],
  });
  const types = recipe.sections.flatMap((s) => s.components)
    .filter((c) => c.type === "chart").map((c) => (c.type === "chart" ? c.chart.type : ""));
  assert.ok(types.includes("waffle"), "donut request must map to waffle");
  assert.ok(!types.includes("donut"));
});

test("diverging-bar renders signed values and downgrades to bar when nothing is negative", () => {
  const compiler = new DesignRecipeCompiler();
  const signed = compiler.compile({
    dataset: familyDs, mode: "report", purpose: "visualize",
    charts: [{ family: "diverging-bar", x: "model", y: "delta", title: "模型日环比" }],
  });
  const signedTypes = signed.sections.flatMap((s) => s.components)
    .filter((c) => c.type === "chart").map((c) => (c.type === "chart" ? c.chart.type : ""));
  assert.ok(signedTypes.includes("diverging-bar"), "signed data should keep diverging-bar");
  const html = new DesignRenderer().render(signed, familyDs).html;
  assert.match(html, /data-chart-type="diverging-bar"/);

  const allPositive: AutomationDataset = {
    ...familyDs,
    rows: familyDs.rows.map((r) => ({ ...r, delta: Math.abs(Number(r.delta)) })),
  };
  const downgraded = compiler.compile({
    dataset: allPositive, mode: "report", purpose: "visualize",
    charts: [{ family: "diverging-bar", x: "model", y: "delta" }],
  });
  const downgradedTypes = downgraded.sections.flatMap((s) => s.components)
    .filter((c) => c.type === "chart").map((c) => (c.type === "chart" ? c.chart.type : ""));
  assert.ok(!downgradedTypes.includes("diverging-bar"), "no negative values → honest downgrade to bar");
  assert.ok(downgradedTypes.includes("bar"));
});

test("counter renders a KPI card with data-kpi for the count-up animation", () => {
  const recipe = new DesignRecipeCompiler().compile({
    dataset: familyDs, mode: "report", purpose: "visualize",
    charts: [{ family: "counter", x: "date", y: "cnt", title: "累计调用量" }],
  });
  const types = recipe.sections.flatMap((s) => s.components)
    .filter((c) => c.type === "chart").map((c) => (c.type === "chart" ? c.chart.type : ""));
  assert.ok(types.includes("counter"));
  const html = new DesignRenderer().render(recipe, familyDs).html;
  assert.match(html, /data-chart-type="counter"/);
  assert.match(html, /data-kpi="330"/, "counter carries the raw total for the viewer count-up");
  assert.match(html, /KPI/);
});
