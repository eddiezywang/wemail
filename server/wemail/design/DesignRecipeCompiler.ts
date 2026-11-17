import { randomUUID } from "node:crypto";
import { generatePivots, deriveReportTitle, datasetFieldLabel } from "../analysis/generatePivots.js";
import { computeComparison } from "../analysis/computeComparison.js";
import { deriveInsightDimensions } from "../analysis/deriveInsightDimensions.js";
import { planInsightViews } from "../analysis/planInsightViews.js";
import type { AutomationDataset } from "../../../shared/wemail/automation.js";
import type {
  ChartSpec,
  DesignAnalysisPlan,
  DesignArtifactKind,
  DesignComponentSpec,
  InsightAnalysisResult,
  DesignRecipe,
  DesignRequest,
  DesignTemplateId,
  ThinChartSpec,
} from "../../../shared/wemail/designArtifacts.js";
import { templateName } from "./InsightReportTemplates.js";
import { aggregationSummary } from "./InsightDatasetContract.js";
import { resolveColorSystem } from "./monoTokens.js";

type DatasetField = AutomationDataset["schema"]["fields"][number];

export class DesignRecipeCompiler {
  compile(request: DesignRequest): DesignRecipe {
    const kind = selectKind(request);
    // autoPivot: derive title + objective dynamically from the data (not hardcoded).
    const derived = request.autoPivot && !request.title
      ? deriveReportTitle(request.dataset)
      : null;
    const title = request.title?.trim() || derived?.title || defaultTitle(kind);
    if (derived && !request.objective) (request as { objective?: string }).objective = derived.objective;
    let profile = profileDataset(request.dataset);
    const purpose = selectPurpose(request, profile);
    if (purpose === "analyze") {
      deriveInsightDimensions(request.dataset);
      profile = profileDataset(request.dataset);
    }
    const templateId = selectTemplate(request, profile, purpose);
    const analysis = purpose === "analyze"
      ? planInsightViews(request.dataset, { maxCharts: request.constraints?.maxCharts ?? 10 })
      : undefined;
    validateAnalysisPlanDataset(request.dataset, request.analysisPlan);
    const requestedCharts = request.charts && request.charts.length
      ? expandThinCharts(request.charts, request.dataset)
      : request.analysisPlan
        ? expandThinCharts(buildAnalysisPlanCharts(request.analysisPlan, request.dataset), request.dataset)
        : analysis?.views.length
          ? expandThinCharts(analysis.views.map((view) => view.chart), request.dataset)
          : request.autoPivot
            ? expandThinCharts(generatePivots(request.dataset), request.dataset)
            : buildCharts(request, profile, templateId);
    const charts = ensureAggregatedTrendChart(requestedCharts, request.dataset);
    const metrics = buildMetrics(request.dataset, profile, purpose, analysis);
    const insights = purpose === "analyze" ? buildInsights(request.dataset, profile, templateId, analysis) : [];
    const sourceNarratives = purpose === "visualize" ? extractNarratives(request.dataset.summary) : [];
    const timeline = templateId === "timeline-view" ? buildTimeline(request.dataset, profile) : undefined;
    const components: DesignComponentSpec[] = [];

    if (purpose === "visualize" && sourceNarratives.length) {
      components.push({
        type: "callout",
        title: profile.singleEmail ? "邮件内容摘要" : "数据说明",
        text: sourceNarratives[0],
        tone: "info",
      });
    }
    components.push(...metrics);
    if (timeline?.items.length) components.push(timeline);
    const visualComponents = buildVisualComponents(charts, request.dataset, purpose);
    components.push(...visualComponents);
    if (insights.length) components.push({ type: "insight-list", items: insights });
    if (request.dataset.schema.fields.length && !visualComponents.some((component) => component.type === "table")) {
      components.push({
        type: "table",
        title: "数据明细",
        columns: request.dataset.schema.fields.slice(0, 8).map((field) => ({
          field: field.name,
          label: datasetFieldLabel(request.dataset, field.name),
        })),
        limit: 100,
      });
    }

    validateRecipeBindings(request.dataset, components);
    validateAnalysisPlanCoverage(request.analysisPlan, components);
    // autoPivot: prepend a 环比 callout so the report opens with the period-over-period delta.
    if (request.autoPivot && profile.temporal && profile.numeric.length) {
      const mf = preferredNumeric(profile.numeric, templateId);
      const cmp = computeComparison(request.dataset, profile.temporal.name, mf.name);
      if (cmp.periodOverPeriod) {
        const pp = cmp.periodOverPeriod;
        const ml = datasetFieldLabel(request.dataset, mf.name);
        components.unshift({
          type: "callout",
          title: "环比变化",
          text: `${ml}环比${pp.pct >= 0 ? "上升" : "下降"} ${Math.abs(pp.pct * 100).toFixed(1)}%（${pp.previous.toLocaleString("zh-CN")} → ${pp.current.toLocaleString("zh-CN")}）`,
          tone: pp.pct < 0 ? "warning" : "info",
        });
      }
    }
    const sourceEmailIds = [...profile.emailIds];
    const sourceCount = sourceEmailIds.length;
    const keyMetrics = metrics.slice(0, 4).map((metric) => ({
      label: metric.label,
      valuePath: metric.valuePath,
      value: metric.value,
      format: metric.format,
    }));
    return {
      schemaVersion: 1,
      id: `design-recipe-${randomUUID()}`,
      version: 1,
      kind,
      templateId,
      purpose,
      title,
      subtitle: request.objective,
      objective: request.objective,
      audience: request.audience,
      designSystem: resolveDesignSystem(request, request.dataset, profile),
      scope: sourceCount > 1 ? "multi" : "single",
      provenance: {
        sourceLabel: sourceCount > 0 ? `${sourceCount} 封来源邮件` : "未提供数据来源",
        emailIds: sourceEmailIds,
        sourceCount,
        unavailable: sourceCount === 0,
      },
      narrative: {
        structure: templateId === "operational-health"
          ? "status-exception-next-step"
          : purpose === "analyze"
            ? "conclusion-first"
            : templateId === "timeline-view" ? "chronological" : "overview-to-detail",
        primaryQuestion: request.objective,
        emptyState: {
          title: "当前范围暂无明细数据",
          description: purpose === "analyze"
            ? "报告已保留可用的摘要信息；调整筛选范围后可补充趋势与明细。"
            : "当前内容没有可绘制的数据，已保留可用的邮件摘要。",
          tone: "neutral",
        },
      },
      analysis,
      sections: [{
        id: "overview",
        title: templateName(templateId),
        description: describeDataset(request.dataset, profile, purpose),
        layout: "grid",
        components,
      }],
      notification: {
        title,
        previewTemplate: insights[0]?.text ?? sourceNarratives[0] ?? (request.dataset.rows.length
          ? purpose === "analyze"
            ? `已完成 ${request.dataset.rows.length} 条数据的洞察分析`
            : `已将 ${request.dataset.rows.length} 条数据转换为图表`
          : "当前范围暂无明细数据"),
        keyMetrics,
      },
      runtimeCapabilities: ["charts", "filter", "table-sort", "copy-value", ...(kind === "deck" ? ["deck-navigation" as const] : [])],
    };
  }
}

function buildAnalysisPlanCharts(plan: DesignAnalysisPlan, dataset: AutomationDataset): ThinChartSpec[] {
  const timeWindow = plan.dimensions.find((dimension) =>
    dimension.overlapping || dataset.schema.fields.find((field) => field.name === dimension.field)?.semanticRole === "time_window");
  const viewDimensions = plan.dimensions.filter((dimension) => dimension !== timeWindow);
  const charts: ThinChartSpec[] = [];
  if (!viewDimensions.length && timeWindow) {
    for (const measure of plan.measures) {
      charts.push({
        family: "bar",
        x: timeWindow.field,
        y: measure.field,
        agg: measure.agg,
        title: `按${fieldLabel(dataset, timeWindow.field)}查看${fieldLabel(dataset, measure.field)}`,
      });
    }
    return charts;
  }

  const switchable = viewDimensions.length > 1;
  for (const dimension of viewDimensions) {
    for (const measure of plan.measures) {
      charts.push({
        family: timeWindow ? "heatmap" : "bar",
        x: dimension.field,
        y: measure.field,
        ...(timeWindow ? { splitBy: timeWindow.field } : {}),
        agg: measure.agg,
        title: timeWindow
          ? `按${fieldLabel(dataset, dimension.field)}查看${fieldLabel(dataset, timeWindow.field)}${fieldLabel(dataset, measure.field)}`
          : `按${fieldLabel(dataset, dimension.field)}查看${fieldLabel(dataset, measure.field)}`,
        ...(switchable ? {
          switchGroup: "dimension-analysis",
          switchLabel: fieldLabel(dataset, dimension.field),
          span: "full" as const,
        } : {}),
      });
    }
  }
  return charts;
}

function fieldLabel(dataset: AutomationDataset, field: string): string {
  return datasetFieldLabel(dataset, field);
}

function buildVisualComponents(
  charts: ChartSpec[],
  dataset: AutomationDataset,
  purpose: "visualize" | "analyze",
): DesignComponentSpec[] {
  const regularCharts = charts.filter((chart) => chart.switchGroup !== "dimension-analysis" || !chart.switchLabel);
  const components: DesignComponentSpec[] = [];
  if (purpose === "analyze" && regularCharts.length >= 4) {
    const groups: Array<{ title: string; description: string; types: ChartSpec["type"][] }> = [
      { title: "变化与节奏", description: "先看总体走势、阶段变化和时间构成。", types: ["counter", "line", "area", "stacked-bar"] },
      { title: "构成与差异", description: "比较主要类别、占比、层级和前后变化。", types: ["waffle", "bar", "dumbbell", "diverging-bar", "treemap"] },
      { title: "分布与关系", description: "检查长尾、离群值、指标关系和交叉高值区。", types: ["histogram", "boxplot", "scatter", "heatmap"] },
    ];
    const consumed = new Set<ChartSpec>();
    for (const group of groups) {
      const grouped = regularCharts.filter((chart) => group.types.includes(chart.type));
      if (!grouped.length) continue;
      components.push({ type: "heading", text: group.title, level: 2 });
      components.push({ type: "paragraph", text: group.description });
      components.push(...grouped.map((chart) => ({ type: "chart" as const, chart })));
      grouped.forEach((chart) => consumed.add(chart));
    }
    components.push(...regularCharts.filter((chart) => !consumed.has(chart)).map((chart) => ({ type: "chart" as const, chart })));
  } else {
    components.push(...regularCharts.map((chart) => ({ type: "chart" as const, chart })));
  }
  const dimensionCharts = charts.filter((chart) =>
    chart.switchGroup === "dimension-analysis" && !!chart.switchLabel);
  const viewLabels = [...new Set(dimensionCharts.map((chart) => chart.switchLabel!))];
  for (const switchLabel of viewLabels) {
    const viewCharts = dimensionCharts.filter((chart) => chart.switchLabel === switchLabel);
    components.push(...viewCharts.map((chart) => ({ type: "chart" as const, chart })));
    const groupBy = [...new Set(viewCharts.flatMap((chart) => [
      chart.data.category,
      chart.data.series,
    ].filter(Boolean) as string[]))];
    const measures = [...new Map(viewCharts.flatMap((chart) => {
      const fields = [
        ...(chart.data.value ? [{ field: chart.data.value, label: fieldLabel(dataset, chart.data.value), aggregate: chart.data.aggregate }] : []),
        ...(chart.data.measures ?? []).map((measure) => ({
          field: measure.field,
          label: measure.label,
          aggregate: chart.data.aggregate,
        })),
      ];
      return fields.map((measure) => [measure.field, measure] as const);
    })).values()];
    if (groupBy.length && measures.length) {
      const where = viewCharts.length === 1 ? viewCharts[0].data.where : undefined;
      components.push({
        type: "table",
        title: `${switchLabel}维度汇总`,
        columns: [
          ...groupBy.map((field) => ({ field, label: fieldLabel(dataset, field) })),
          ...measures.map((measure) => ({ field: measure.field, label: measure.label })),
        ],
        groupBy,
        measures,
        where,
        limit: 100,
        switchGroup: "dimension-analysis",
        switchLabel,
      });
    }
  }
  return components;
}

function validateAnalysisPlanDataset(
  dataset: AutomationDataset,
  plan: DesignAnalysisPlan | undefined,
): void {
  if (!plan) return;
  if (!plan.dimensions.length || plan.dimensions.length > 6) {
    throw new Error("analysis-plan-requires-one-to-six-dimensions");
  }
  if (!plan.measures.length || plan.measures.length > 3) {
    throw new Error("analysis-plan-requires-one-to-three-measures");
  }
  const fields = new Map(dataset.schema.fields.map((field) => [field.name, field]));
  const dimensionNames = new Set<string>();
  for (const dimension of plan.dimensions) {
    if (!fields.has(dimension.field)) throw new Error(`analysis-plan-unknown-dimension:${dimension.field}`);
    if (dimensionNames.has(dimension.field)) throw new Error(`analysis-plan-duplicate-dimension:${dimension.field}`);
    dimensionNames.add(dimension.field);
    if (dimension.requiredValues?.length) {
      const available = new Set(dataset.rows.map((row) => normalizePlanValue(row[dimension.field])));
      for (const value of dimension.requiredValues) {
        if (!available.has(normalizePlanValue(value))) {
          throw new Error(`analysis-plan-missing-value:${dimension.field}:${String(value)}`);
        }
      }
    }
  }
  const measureNames = new Set<string>();
  for (const measure of plan.measures) {
    const field = fields.get(measure.field);
    if (!field) throw new Error(`analysis-plan-unknown-measure:${measure.field}`);
    if (field.type !== "number") throw new Error(`analysis-plan-measure-not-numeric:${measure.field}`);
    if (measureNames.has(measure.field)) throw new Error(`analysis-plan-duplicate-measure:${measure.field}`);
    measureNames.add(measure.field);
  }
}

function normalizePlanValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : String(value);
}

function validateAnalysisPlanCoverage(
  plan: DesignAnalysisPlan | undefined,
  components: DesignComponentSpec[],
): void {
  if (!plan) return;
  const charts = components.filter((component): component is Extract<DesignComponentSpec, { type: "chart" }> => component.type === "chart");
  if (!charts.length) throw new Error("analysis-plan-produced-no-charts");
  const dimensionBindings = new Set(charts.flatMap((component) => [
    component.chart.data.category,
    component.chart.data.series,
    ...Object.keys(component.chart.data.where ?? {}),
  ].filter(Boolean) as string[]));
  const measureBindings = new Set(charts.flatMap((component) => [
    component.chart.data.value,
    ...(component.chart.data.measures ?? []).map((measure) => measure.field),
  ].filter(Boolean) as string[]));
  for (const dimension of plan.dimensions) {
    if (!dimensionBindings.has(dimension.field)) {
      throw new Error(`analysis-plan-dimension-not-rendered:${dimension.field}`);
    }
    if (dimension.overlapping && charts.some((component) =>
      component.chart.type === "stacked-bar" &&
      (component.chart.data.category === dimension.field || component.chart.data.series === dimension.field))) {
      throw new Error(`analysis-plan-overlapping-dimension-stacked:${dimension.field}`);
    }
    const directlyRendered = charts.some((component) =>
      component.chart.data.category === dimension.field || component.chart.data.series === dimension.field);
    if (!directlyRendered && dimension.requiredValues?.length) {
      const renderedValues = new Set(charts
        .map((component) => component.chart.data.where?.[dimension.field])
        .filter((value) => value !== undefined)
        .map(normalizePlanValue));
      for (const value of dimension.requiredValues) {
        if (!renderedValues.has(normalizePlanValue(value))) {
          throw new Error(`analysis-plan-value-not-rendered:${dimension.field}:${String(value)}`);
        }
      }
    }
  }
  for (const measure of plan.measures) {
    if (!measureBindings.has(measure.field)) {
      throw new Error(`analysis-plan-measure-not-rendered:${measure.field}`);
    }
  }
}

function profileDataset(dataset: AutomationDataset) {
  // Temporal requires MORE THAN ONE distinct parseable date — a single-time-point snapshot
  // has no temporal dimension and must not yield a trend chart (the original "值趋势" bug).
  const temporal = dataset.schema.fields.find((field) => isTemporalAxis(dataset, field.name));
  const numeric = dataset.schema.fields.filter((field) => field.type === "number");
  const categorical = dataset.schema.fields.filter((field) =>
    (field.type === "string" || field.type === "boolean") &&
    field.semanticRole !== "time_window" &&
    field.semanticRole !== "status" &&
    field.semanticRole !== "unit");
  const emailIds = new Set((dataset.provenance ?? []).flatMap((item) => item.emailIds ?? []));
  return { temporal, numeric, categorical, emailIds, singleEmail: emailIds.size === 1 };
}
function countDistinctValues(dataset: AutomationDataset, field: string): number {
  const seen = new Set<string>();
  for (const row of dataset.rows) {
    const raw = row[field];
    if (raw === undefined || raw === null || raw === "") continue;
    seen.add(String(raw));
  }
  return seen.size;
}
// A field is a usable temporal axis when it has more than one distinct value AND it is
// date/datetime-typed, or a string field whose values look like dates or times.
// We deliberately do NOT use bare Date.parse: V8 parses pure numeric strings (e.g. "37573")
// as dates, which would mis-flag a numeric measure as a time axis.
const DATELIKE = /^\d{4}-\d{1,2}-\d{1,2}/;
const TIMELIKE = /^\d{1,2}:\d{2}/;
function isTemporalAxis(dataset: AutomationDataset, field: string): boolean {
  if (countDistinctValues(dataset, field) <= 1) return false;
  const f = dataset.schema.fields.find((x) => x.name === field);
  if (f && (f.type === "date" || f.type === "datetime")) return true;
  if (f && f.type === "string") {
    return dataset.rows.some((r) => {
      const v = String(r[field] ?? "");
      return v !== "" && (DATELIKE.test(v) || TIMELIKE.test(v));
    });
  }
  return false;
}

function selectPurpose(
  request: DesignRequest,
  profile: ReturnType<typeof profileDataset>,
): "visualize" | "analyze" {
  if (request.purpose && request.purpose !== "auto") return request.purpose;
  if (request.templateId && ["email-visual-summary", "quick-chart", "timeline-view"].includes(request.templateId)) return "visualize";
  const intent = `${request.title ?? ""} ${request.objective ?? ""} ${request.instructions ?? ""}`;
  if (/洞察|分析|结论|异常|原因|建议|insight|analy[sz]e|conclusion/i.test(intent)) return "analyze";
  if (/图表|画图|可视化|转换|趋势图|柱状图|饼图|时间线|chart|visuali[sz]e|plot|timeline/i.test(intent)) return "visualize";
  return profile.singleEmail ? "visualize" : "analyze";
}

function selectTemplate(
  request: DesignRequest,
  profile: ReturnType<typeof profileDataset>,
  purpose: "visualize" | "analyze",
): DesignTemplateId {
  if (request.templateId) return request.templateId;
  const intent = `${request.title ?? ""} ${request.objective ?? ""} ${request.instructions ?? ""} ${profile.numeric.map((field) => field.name).join(" ")}`;
  if (purpose === "visualize") {
    if (profile.temporal && !profile.numeric.length && profile.categorical.length && request.dataset.rows.length > 1) return "timeline-view";
    return profile.singleEmail ? "email-visual-summary" : "quick-chart";
  }
  if (/失败|告警|错误|成功率|健康|failure|error|alert|health/i.test(intent)) return "operational-health";
  if (profile.temporal && profile.numeric.length) return "trend-analysis";
  if (profile.categorical.length && profile.numeric.length) return "comparison-breakdown";
  return "executive-insight";
}

function buildCharts(
  request: DesignRequest,
  profile: ReturnType<typeof profileDataset>,
  templateId: DesignTemplateId,
): ChartSpec[] {
  if ((request.constraints?.maxCharts ?? 2) < 1 || !profile.numeric.length) return [];
  const value = preferredNumeric(profile.numeric, templateId);
  if (request.dataset.rows.length === 1 && profile.numeric.length > 1) {
    return [{
      id: "field-comparison",
      type: "bar",
      title: "邮件中的数值对比",
      description: "按邮件原始字段并列展示，不做额外推断。",
      data: {
        value: value.name,
        measures: profile.numeric.slice(0, 10).map((field) => ({
          field: field.name,
          label: datasetFieldLabel(request.dataset, field.name),
        })),
        sort: "source",
        limit: 10,
      },
      presentation: {
        showLegend: false,
        showValues: true,
        showGrid: false,
        numberFormat: { type: "compact" },
      },
      emptyState: "邮件中没有可比较的有效数值",
    }];
  }
  const category = profile.temporal ?? profile.categorical[0];
  if (!category) return [];
  const useLine = !!profile.temporal;
  return [{
    id: "primary-chart",
    type: useLine ? "line" : "bar",
    title: useLine
      ? `${datasetFieldLabel(request.dataset, value.name)}趋势`
      : `${datasetFieldLabel(request.dataset, value.name)}对比`,
    description: useLine ? "按时间观察变化，并标记峰值与低谷。" : "按类别汇总，识别主要贡献项。",
    data: {
      category: category.name,
      value: value.name,
      ...(useLine && profile.categorical[0] ? { series: profile.categorical[0].name } : {}),
      aggregate: "sum",
      sort: useLine ? "ascending" : "descending",
      limit: useLine ? 48 : 12,
    },
    presentation: {
      showLegend: useLine && Boolean(profile.categorical[0]),
      showValues: !useLine,
      showGrid: true,
      numberFormat: { type: "compact" },
    },
    emptyState: "当前数据不足以形成可靠图表",
  }];
}

/**
 * Expand the model's thin chart specs into visual ChartSpecs, enforcing guardrails:
 * line/area require a temporal axis (>1 distinct date on x); aggregations must not cross
 * mixed units; 占比 maps to waffle. Refused specs are dropped — the renderer never fabricates
 * a chart that contradicts the data shape.
 */
function expandThinCharts(specs: ThinChartSpec[], dataset: AutomationDataset): ChartSpec[] {
  const out: ChartSpec[] = [];
  for (const spec of specs) {
    if (spec.family === "table") continue; // tables are components, not charts
    if ((spec.family === "line" || spec.family === "area") && !isTemporalAxis(dataset, spec.x)) {
      continue; // refused: no temporal dimension
    }
    if ((spec.family === "treemap") && !spec.splitBy) {
      continue; // refused: treemap needs a leaf dimension (two-level hierarchy)
    }
    if ((spec.family === "treemap") && !dataset.schema.fields.some((field) => field.name === spec.y && field.type === "number")) {
      continue; // refused: measure must be a real numeric field
    }
    if ((spec.family === "histogram" || spec.family === "boxplot") && !dataset.schema.fields.some((field) => field.name === spec.y && field.type === "number")) {
      continue; // refused: distribution charts need a real numeric field
    }
    if (spec.family === "diverging-bar" && !dataset.rows.some((row) => Number(row[spec.y]) < 0)) {
      spec.family = "bar"; // honest downgrade: no signed values → plain bar
    }
    if (aggregatesValues(spec.family) && mixesUnits(dataset, spec)) {
      continue; // refused: cross-unit aggregation
    }
    out.push(thinToChartSpec(spec, dataset));
  }
  return out;
}

/**
 * A rolling multi-email report always gets one readable time-series overview.
 * Model-authored dimension views remain intact, but they must not be able to
 * omit the cross-email trend that explains how the aggregate changed over time.
 */
function ensureAggregatedTrendChart(charts: ChartSpec[], dataset: AutomationDataset): ChartSpec[] {
  const aggregation = aggregationSummary(dataset);
  if (!aggregation || aggregation.sourceEmailCount <= 1 || aggregation.timePointCount <= 1) return charts;
  const measure = aggregation.measures.find((candidate) =>
    dataset.schema.fields.some((field) => field.name === candidate.field && field.type === "number"),
  );
  if (!measure || charts.some((chart) =>
    (chart.type === "line" || chart.type === "area") && chart.data.category === aggregation.timeField,
  )) return charts;
  const aggregate = measure.agg === "latest" ? "average" : measure.agg;
  const trend = expandThinCharts([{
    family: "line",
    x: aggregation.timeField,
    y: measure.field,
    agg: aggregate as ThinChartSpec["agg"],
    span: "full",
    title: `${datasetFieldLabel(dataset, measure.field)}连续变化趋势`,
  }], dataset);
  return trend.length ? [...trend, ...charts] : charts;
}

function aggregatesValues(family: ThinChartSpec["family"]): boolean {
  return family === "bar" || family === "line" || family === "area" || family === "waffle" || family === "donut" || family === "heatmap" || family === "stacked-bar" || family === "treemap" || family === "diverging-bar" || family === "counter" || family === "histogram" || family === "boxplot";
}

function unitFieldOf(dataset: AutomationDataset): DatasetField | undefined {
  return dataset.schema.fields.find((f) => f.name === "unit" || /单位|unit/i.test(f.label ?? ""));
}

function mixesUnits(dataset: AutomationDataset, spec: ThinChartSpec): boolean {
  const unitField = unitFieldOf(dataset);
  if (!unitField) return false;
  const units = new Set<string>();
  for (const row of dataset.rows) {
    if (spec.where && !Object.entries(spec.where).every(([k, v]) => row[k] === v)) continue;
    const u = row[unitField.name];
    if (u !== undefined && u !== null && u !== "") units.add(String(u));
  }
  return units.size > 1;
}

// A bare chart-type name (柱状图 / bar chart / pie …) is not a conclusion. Override it
// with an inferred conclusion-style title so the chart always states a judgment.
function resolveChartTitle(raw: string | undefined, useLine: boolean, share: boolean, treemap: boolean, diverging: boolean, counter: boolean, distribution: boolean, relationship: boolean, valueLabel: string): string {
  const inferred = useLine ? `${valueLabel}趋势` : share ? `${valueLabel}占比` : treemap ? `${valueLabel}构成` : diverging ? `${valueLabel}正负对比` : counter ? `${valueLabel}总计` : distribution ? `${valueLabel}分布` : relationship ? `${valueLabel}关系` : `${valueLabel}对比`;
  return raw && !isBareChartTypeTitle(raw) ? raw : inferred;
}
function isBareChartTypeTitle(title: string): boolean {
  return /^(柱状图|条形图|柱图|折线图|线图|趋势图|面积图|饼图|环形图|占比图|对比图|散点图|热力图|堆叠图|堆叠柱图?|哑铃图|矩形树图|树图|发散图|发散柱|计数卡|直方图|箱线图|表格|图表?|bar\s*chart|line\s*chart|pie\s*chart|bar|line|area|pie|donut|waffle|scatter|heatmap|dumbbell|treemap|diverging|counter|histogram|boxplot|table|chart)$/i.test(title.trim());
}

function thinToChartSpec(spec: ThinChartSpec, dataset: AutomationDataset): ChartSpec {
  const valueLabel = datasetFieldLabel(dataset, spec.y);
  const useLine = spec.family === "line" || spec.family === "area";
  const share = spec.family === "waffle" || spec.family === "donut";
  const treemap = spec.family === "treemap";
  const diverging = spec.family === "diverging-bar";
  const counter = spec.family === "counter";
  const distribution = spec.family === "histogram" || spec.family === "boxplot";
  const relationship = spec.family === "scatter";
  const numberFormat: NonNullable<ChartSpec["presentation"]>["numberFormat"] = /rate|ratio|percent|pct|%|％|率|比例|占比/i.test(`${spec.y} ${valueLabel}`)
    ? { type: "percent", decimals: 1 }
    : { type: "compact" };
  const measures = spec.family === "dumbbell" && spec.y2
    ? [
        { field: spec.y, label: datasetFieldLabel(dataset, spec.y) },
        { field: spec.y2, label: datasetFieldLabel(dataset, spec.y2) },
      ]
    : undefined;
  const type: ChartSpec["type"] =
    spec.family === "line" ? "line"
    : spec.family === "area" ? "area"
    : spec.family === "waffle" || spec.family === "donut" ? "waffle" // donut 已弃用，映射到 waffle
    : spec.family === "scatter" ? "scatter"
    : spec.family === "heatmap" ? "heatmap"
    : spec.family === "stacked-bar" ? "stacked-bar"
    : spec.family === "dumbbell" ? "dumbbell"
    : spec.family === "treemap" ? "treemap"
    : spec.family === "diverging-bar" ? "diverging-bar"
    : spec.family === "counter" ? "counter"
    : spec.family === "histogram" ? "histogram"
    : spec.family === "boxplot" ? "boxplot"
    : "bar";
  return {
    id: `chart-${randomUUID().slice(0, 8)}`,
    type,
    title: resolveChartTitle(spec.title, useLine, share, treemap, diverging, counter, distribution, relationship, valueLabel),
    description: useLine ? "按时间观察变化。" : share ? "按类别占比。" : treemap ? "按两层层级看构成，面积=数值。" : diverging ? "按零轴两侧看正负对比。" : counter ? "KPI 总计 + 走势。" : distribution ? "查看中位区间、长尾和离群情况。" : relationship ? "观察两项指标是否同步变化；相关不代表因果。" : "按类别对比。",
    data: {
      category: spec.x,
      value: spec.y,
      series: spec.splitBy,
      aggregate: spec.agg ?? "sum",
      sort: useLine || counter ? "ascending" : "descending",
      limit: spec.top ?? (useLine || counter ? 48 : treemap ? 24 : 12),
      where: spec.where,
      measures,
    },
    source: dataset.provenance?.length ? deriveSourceLabel(dataset) : undefined,
    span: spec.span,
    switchGroup: spec.switchGroup,
    switchLabel: spec.switchLabel,
    presentation: { showLegend: !!spec.splitBy && !treemap, showValues: !useLine && !share, showGrid: true, numberFormat },
    emptyState: "当前数据不足以形成可靠图表",
  };
}

function deriveSourceLabel(dataset: AutomationDataset): string {
  const emailIds = new Set((dataset.provenance ?? []).flatMap((item) => item.emailIds ?? []));
  return emailIds.size > 0 ? `${emailIds.size} 封来源邮件` : "未提供数据来源";
}

/**
 * Resolve the delivery's color system (single-system lock). An explicit request wins;
 * otherwise we auto-select only when the fit is unambiguous (intent words, or a temporal
 * axis → porcelain); anything else stays mono, the safe fallback that preserves the
 * house AntV palette. Stored on the recipe so the renderer and every chart share ONE
 * system.
 */
function resolveDesignSystem(
  request: DesignRequest,
  dataset: AutomationDataset,
  profile: ReturnType<typeof profileDataset>,
): string {
  if (request.designSystem && request.designSystem !== "auto") {
    const normalized = request.designSystem.toLowerCase().trim();
    const bare = normalized.replace(/^wemail-/, "");
    if (bare === "insight" || bare === "visual" || bare === "editorial" || bare === "light" || bare === "dark") {
      return "wemail-mono"; // legacy theme names map to the mono system
    }
    return normalized.startsWith("custom:") ? normalized : `wemail-${bare}`;
  }
  const intent = `${request.title ?? ""} ${request.objective ?? ""} ${request.instructions ?? ""}`;
  const system = resolveColorSystem(undefined, intent, Boolean(profile.temporal));
  return system.id === "custom" ? "wemail-mono" : `wemail-${system.id}`;
}

function preferredNumeric(fields: DatasetField[], templateId: DesignTemplateId): DatasetField {
  if (templateId === "operational-health") {
    return fields.find((field) => /失败|告警|错误|failure|error|alert|调用|count|total/i.test(`${field.name} ${field.label ?? ""}`)) ?? fields[0];
  }
  return fields.find((field) => /总|数量|金额|调用|count|total|amount|value/i.test(`${field.name} ${field.label ?? ""}`)) ?? fields[0];
}

function buildMetrics(
  dataset: AutomationDataset,
  profile: ReturnType<typeof profileDataset>,
  purpose: "visualize" | "analyze",
  analysis?: InsightAnalysisResult,
): Array<Extract<DesignComponentSpec, { type: "metric" }>> {
  // 来源与粒度副注：KPI 表头第二行（如「19 封邮件 · 19 个小时点」）
  const aggregation = aggregationSummary(dataset);
  const sourceCount = profile.emailIds.size;
  const note = aggregation
    ? `${sourceCount} 封邮件 · ${aggregation.timePointCount} 个${aggregation.timeGrain === "hour" ? "小时" : "天"}点`
    : sourceCount > 1
      ? `${sourceCount} 封邮件`
      : undefined;
  const scalarSummary = Object.entries(dataset.summary ?? {})
    .filter(([, value]) => typeof value === "number" || typeof value === "boolean")
    .slice(0, 4)
    .map(([path, value], index) => ({
      type: "metric" as const,
      label: labelFor(path),
      valuePath: `summary.${path}`,
      format: inferMetricFormat(path, value as number | boolean),
      note: index === 0 ? note : undefined, // 只给主角 metric 副注，避免四卡重复
    }));
  if (scalarSummary.length) return scalarSummary;

  if (purpose === "visualize" && dataset.rows.length === 1) {
    return profile.numeric.slice(0, 4).map((field) => ({
      type: "metric" as const,
      label: datasetFieldLabel(dataset, field.name),
      value: Number(dataset.rows[0][field.name]),
      format: inferMetricFormat(field.name, Number(dataset.rows[0][field.name])),
    }));
  }
  const analyzedMeasures = new Map((analysis?.measures ?? []).map((measure) => [measure.field, measure]));
  const derived: Array<Extract<DesignComponentSpec, { type: "metric" }>> = profile.numeric.slice(0, 3).map((field) => {
    const values = finiteValues(dataset, field.name);
    const analyzed = analyzedMeasures.get(field.name);
    const average = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
    const useAverage = analyzed?.aggregation === "average";
    return {
      type: "metric" as const,
      label: `${datasetFieldLabel(dataset, field.name)}${useAverage ? "平均" : "合计"}`,
      value: useAverage ? average : values.reduce((sum, value) => sum + value, 0),
      format: analyzed?.semantic === "ratio"
        ? { type: "percent" as const, decimals: 1 }
        : { type: "compact" as const },
    };
  });
  return [
    { type: "metric" as const, label: "数据记录", value: dataset.rows.length },
    ...derived,
  ].slice(0, 4);
}

function buildTimeline(
  dataset: AutomationDataset,
  profile: ReturnType<typeof profileDataset>,
): Extract<DesignComponentSpec, { type: "timeline" }> | undefined {
  if (!profile.temporal) return undefined;
  const textFields = profile.categorical.filter((field) => field.name !== profile.temporal?.name);
  const titleField = textFields.find((field) => /标题|主题|事项|事件|title|subject|event|task/i.test(`${field.name} ${field.label ?? ""}`)) ?? textFields[0];
  const detailField = textFields.find((field) => field !== titleField);
  if (!titleField) return undefined;
  const items = dataset.rows
    .map((row) => ({
      label: compactLabel(row[profile.temporal!.name]),
      title: String(row[titleField.name] ?? "未命名事项"),
      text: detailField && row[detailField.name] !== undefined ? String(row[detailField.name]) : undefined,
      sort: new Date(String(row[profile.temporal!.name])).getTime(),
    }))
    .sort((a, b) => (Number.isFinite(a.sort) ? a.sort : 0) - (Number.isFinite(b.sort) ? b.sort : 0))
    .slice(0, 24)
    .map(({ label, title, text }) => ({ label, title, text }));
  return { type: "timeline", items };
}

function buildInsights(
  dataset: AutomationDataset,
  profile: ReturnType<typeof profileDataset>,
  templateId: DesignTemplateId,
  analysis?: InsightAnalysisResult,
): Array<{ title: string; text: string; tone?: "neutral" | "positive" | "warning" }> {
  const items: Array<{ title: string; text: string; tone?: "neutral" | "positive" | "warning" }> = [];
  const supplied = extractNarratives(dataset.summary);
  for (const text of supplied.slice(0, 2)) items.push({ title: "数据结论", text, tone: "neutral" });

  if (analysis?.findings.length) {
    for (const finding of analysis.findings) {
      items.push({ title: finding.title, text: finding.text, tone: finding.tone });
    }
    return items
      .filter((item, index, all) => all.findIndex((candidate) => candidate.title === item.title) === index)
      .slice(0, 12);
  }

  const aggregation = aggregationSummary(dataset);
  const plannedMeasure = aggregation?.measures.find((candidate) =>
    profile.numeric.some((field) => field.name === candidate.field),
  );
  const field = plannedMeasure
    ? profile.numeric.find((candidate) => candidate.name === plannedMeasure.field)
    : profile.numeric[0];
  if (field && profile.temporal) {
    const byTime = new Map<string, number[]>();
    for (const row of dataset.rows) {
      const time = row[profile.temporal.name];
      const value = Number(row[field.name]);
      if (time === undefined || time === null || time === "" || !Number.isFinite(value)) continue;
      const key = String(time);
      byTime.set(key, [...(byTime.get(key) ?? []), value]);
    }
    const points = [...byTime.entries()]
      .map(([time, values]) => ({
        time,
        value: aggregateTrendValues(values, plannedMeasure?.agg),
        sort: Date.parse(time),
      }))
      .sort((left, right) => (Number.isFinite(left.sort) ? left.sort : 0) - (Number.isFinite(right.sort) ? right.sort : 0));
    if (points.length > 1) {
      const first = points[0];
      const last = points[points.length - 1];
      const delta = last.value - first.value;
      const rate = first.value === 0 ? null : delta / Math.abs(first.value);
      items.push({
        title: "整体趋势",
        text: rate === null
          ? `${compactLabel(last.time)}合计为 ${formatNumber(last.value)}，最早时段为 0，净增加 ${formatNumber(delta)}。`
          : `${compactLabel(last.time)}较${compactLabel(first.time)}${delta >= 0 ? "上升" : "下降"} ${formatPercent(Math.abs(rate))}（${formatNumber(first.value)} → ${formatNumber(last.value)}）。`,
        tone: delta < 0 && templateId === "operational-health" ? "warning" : "neutral",
      });
      const max = points.reduce((best, point) => point.value > best.value ? point : best);
      const min = points.reduce((best, point) => point.value < best.value ? point : best);
      items.push({
        title: "时段峰值",
        text: `${datasetFieldLabel(dataset, field.name)}合计在${compactLabel(max.time)}达到 ${formatNumber(max.value)}；${compactLabel(min.time)}最低，为 ${formatNumber(min.value)}。`,
        tone: "positive",
      });
    }
  } else if (field) {
    const values = finiteValues(dataset, field.name);
    if (values.length) {
      items.push({
        title: "数值范围",
        text: `${datasetFieldLabel(dataset, field.name)}最高为 ${formatNumber(Math.max(...values))}，最低为 ${formatNumber(Math.min(...values))}。`,
        tone: "neutral",
      });
    }
  }
  for (const dimension of profile.categorical.slice(0, 2)) {
    const values = [...new Set(dataset.rows.map((row) => row[dimension.name])
      .filter((value) => value !== undefined && value !== null && value !== "")
      .map(String))];
    if (values.length) {
      items.push({
        title: `${datasetFieldLabel(dataset, dimension.name)}覆盖`,
        text: `共 ${values.length} 类：${values.slice(0, 6).join("、")}${values.length > 6 ? "等" : ""}。`,
        tone: "neutral",
      });
    }
  }
  if (!items.length) {
    items.push({
      title: "数据概览",
      text: dataset.rows.length
        ? `本报告覆盖 ${dataset.rows.length} 条记录、${dataset.schema.fields.length} 个字段；当前数据以明细浏览为主，未检测到适合量化绘图的连续数值。`
        : "当前范围没有明细记录，暂时无法判断趋势或差异。",
      tone: "neutral",
    });
  }
  return dedupe(items).slice(0, 4);
}

function extractNarratives(summary: AutomationDataset["summary"]): string[] {
  const result: string[] = [];
  const narrativeKey = /conclusion|insight|text|description|summary|note|narrative|洞察|结论|说明|备注/i;
  const visit = (value: unknown): void => {
    if (typeof value === "string" && value.trim().length >= 8) {
      result.push(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const preferred = ["conclusion", "insight", "text", "description", "summary", "note"]
        .map((key) => record[key])
        .find((candidate) => typeof candidate === "string" && candidate.trim());
      if (preferred) result.push(String(preferred).trim());
      else Object.entries(record)
        .filter(([key]) => narrativeKey.test(key))
        .forEach(([, child]) => visit(child));
    }
  };
  Object.entries(summary ?? {})
    .filter(([key]) => narrativeKey.test(key))
    .forEach(([, value]) => visit(value));
  return [...new Set(result)];
}

function validateRecipeBindings(dataset: AutomationDataset, components: DesignComponentSpec[]): void {
  const fields = new Set(dataset.schema.fields.map((field) => field.name));
  const summary = new Set(Object.keys(dataset.summary ?? {}));
  for (const component of components) {
    if (component.type === "metric" && component.valuePath && !summary.has(component.valuePath.replace(/^summary\./, ""))) {
      throw new Error(`unknown-summary-field:${component.valuePath}`);
    }
    if (component.type === "table") {
      for (const column of component.columns) if (!fields.has(column.field)) throw new Error(`unknown-table-field:${column.field}`);
      for (const field of component.groupBy ?? []) if (!fields.has(field)) throw new Error(`unknown-table-group-field:${field}`);
      for (const measure of component.measures ?? []) if (!fields.has(measure.field)) throw new Error(`unknown-table-measure-field:${measure.field}`);
      for (const field of Object.keys(component.where ?? {})) if (!fields.has(field)) throw new Error(`unknown-table-filter-field:${field}`);
    }
    if (component.type === "chart") {
      for (const field of [
        component.chart.data.category,
        component.chart.data.value,
        component.chart.data.series,
        ...(component.chart.data.measures ?? []).map((measure) => measure.field),
      ].filter(Boolean) as string[]) {
        if (!fields.has(field)) throw new Error(`unknown-chart-field:${field}`);
      }
    }
  }
}

function finiteValues(dataset: AutomationDataset, field: string): number[] {
  return dataset.rows.map((row) => Number(row[field])).filter(Number.isFinite);
}

function aggregateTrendValues(values: number[], aggregation?: string): number {
  if (!values.length) return 0;
  if (aggregation === "average") return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (aggregation === "min") return Math.min(...values);
  if (aggregation === "max") return Math.max(...values);
  if (aggregation === "latest") return values[values.length - 1] ?? values[0];
  return values.reduce((sum, value) => sum + value, 0);
}

function dedupe<T extends { text: string }>(items: T[]): T[] {
  return items.filter((item, index) =>
    items.findIndex((candidate) => candidate.text === item.text) === index,
  );
}
function compactLabel(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "该项");
  const date = new Date(value);
  // 空格分隔的 datetime 同样保留时分，否则小时点塌缩成天
  const isDatetime = /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    ...(isDatetime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).format(date);
}
function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}
function formatPercent(value: number): string {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
}
function describeDataset(
  dataset: AutomationDataset,
  profile: ReturnType<typeof profileDataset>,
  purpose: "visualize" | "analyze",
): string {
  // 只写 hero dataset-stamp 没有的增量信息：行数/字段数/来源邮件数已在页头 chips 展示，
  // 这里重复只会制造两处同一数据（401 行/5 字段/19 封出现两次）。
  const chartNote = profile.numeric.length
    ? `识别到 ${profile.numeric.length} 个数值字段，图表仅使用可验证的结构化数据。`
    : purpose === "analyze"
      ? "未识别到数值字段，因此保留文字洞察与明细，不强制生成图表。"
      : "未识别到数值字段，因此使用时间线或明细格式忠实呈现邮件内容。";
  const aggregation = aggregationSummary(dataset);
  const grainNote = aggregation
    ? `已按${aggregation.timeGrain === "hour" ? "小时" : "天"}粒度聚合`
    : "";
  return [grainNote, chartNote].filter(Boolean).join("；");
}
function selectKind(request: DesignRequest): DesignArtifactKind {
  if (request.mode !== "auto") return request.mode;
  if (/演示|汇报|presentation|slide|deck/i.test(`${request.objective ?? ""} ${request.instructions ?? ""}`)) return "deck";
  if (/看板|监控|dashboard/i.test(`${request.objective ?? ""} ${request.instructions ?? ""}`)) return "dashboard";
  if (/简报|摘要|brief/i.test(`${request.objective ?? ""} ${request.instructions ?? ""}`)) return "brief";
  return "report";
}
function labelFor(value: string): string {
  const labels: Record<string, string> = {
    totalCalls: "总调用量",
    calls: "调用量",
    totalFailures: "总失败数",
    failures: "失败数",
    failureRate: "失败率",
    successRate: "成功率",
    totalAlerts: "总告警数",
    alerts: "告警数",
    count: "数量",
    total: "合计",
  };
  if (labels[value]) return labels[value];
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").trim();
}
function inferMetricFormat(
  path: string,
  value: string | number | boolean,
): Extract<DesignComponentSpec, { type: "metric" }>["format"] {
  if (typeof value === "number" && /rate|ratio|percent|率|比例/i.test(path)) {
    return { type: "percent", decimals: 2 };
  }
  return typeof value === "number" ? { type: "number", decimals: 2 } : undefined;
}
function defaultTitle(kind: DesignArtifactKind): string {
  return `${kindLabel(kind)} · 邮件信息聚合`;
}
function kindLabel(kind: DesignArtifactKind): string {
  return ({ brief: "简报", report: "报告", dashboard: "数据看板", deck: "演示文稿" })[kind];
}
