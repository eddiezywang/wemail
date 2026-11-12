import type { AutomationDataset } from "../../../shared/wemail/automation.js";
import type {
  InsightAnalysisResult,
  InsightLens,
  InsightViewIntent,
  ThinChartSpec,
} from "../../../shared/wemail/designArtifacts.js";

/**
 * Deterministically translates analysis intent into an executable chart spec.
 * The analyzer never needs to know which charting library renders the result.
 */
export function selectInsightCharts(
  dataset: AutomationDataset,
  intents: InsightViewIntent[],
  options: { maxCharts?: number } = {},
): InsightAnalysisResult["views"] {
  const maxCharts = Math.max(1, Math.min(options.maxCharts ?? 10, 12));
  const candidates = intents
    .filter((intent) => intentFieldsExist(dataset, intent))
    .flatMap((intent) => {
      const chart = chartForIntent(intent);
      return chart ? [{
        lens: intent.lens,
        relation: intent.relation,
        score: intent.score,
        reason: selectionReason(intent, chart),
        chart,
      }] : [];
    })
    .filter((candidate, index, all) => {
      const signature = chartSignature(candidate.chart);
      return all.findIndex((item) => chartSignature(item.chart) === signature) === index;
    })
    .sort((left, right) => right.score - left.score);

  const selected: InsightAnalysisResult["views"] = [];
  const covered = new Set<InsightLens>();
  for (const candidate of candidates) {
    if (selected.length >= maxCharts) break;
    if (covered.has(candidate.lens)) continue;
    selected.push(candidate);
    covered.add(candidate.lens);
  }
  const coveredFamilies = new Set(selected.map((candidate) => candidate.chart.family));
  for (const candidate of candidates) {
    if (selected.length >= maxCharts) break;
    if (selected.includes(candidate) || coveredFamilies.has(candidate.chart.family)) continue;
    selected.push(candidate);
    coveredFamilies.add(candidate.chart.family);
  }
  for (const candidate of candidates) {
    if (selected.length >= maxCharts) break;
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  return selected;
}

function chartForIntent(intent: InsightViewIntent): ThinChartSpec | undefined {
  const dimension = intent.dimensions[0];
  const splitBy = intent.dimensions[1];
  const measure = intent.measures[0];
  const common = {
    title: intent.title,
    span: intent.span,
    top: intent.top,
  } satisfies Pick<ThinChartSpec, "title" | "span" | "top">;

  switch (intent.relation) {
    case "kpi":
      if (!dimension || !measure) return undefined;
      return { family: "counter", x: dimension, y: measure, agg: intent.aggregation, ...common };
    case "trend":
      if (!dimension || !measure) return undefined;
      return {
        family: intent.aggregation === "sum" && (intent.measureSemantic === "count" || intent.measureSemantic === "currency")
          ? "area"
          : "line",
        x: dimension,
        y: measure,
        agg: intent.aggregation,
        ...common,
      };
    case "rank":
      if (!dimension || !measure) return undefined;
      return { family: "bar", x: dimension, y: measure, agg: intent.aggregation, ...common };
    case "share":
      if (!dimension || !measure) return undefined;
      return { family: "waffle", x: dimension, y: measure, agg: intent.aggregation, ...common };
    case "time-composition":
      if (!dimension || !splitBy || !measure) return undefined;
      return { family: "stacked-bar", x: dimension, y: measure, splitBy, agg: intent.aggregation, ...common };
    case "distribution":
      if (!measure) return undefined;
      return { family: "histogram", x: measure, y: measure, agg: "count", ...common };
    case "grouped-distribution":
      if (!dimension || !measure) return undefined;
      return { family: "boxplot", x: dimension, y: measure, ...common };
    case "correlation":
      if (!measure || !intent.measures[1]) return undefined;
      return { family: "scatter", x: measure, y: intent.measures[1], splitBy: dimension, ...common };
    case "matrix":
      if (!dimension || !splitBy || !measure) return undefined;
      return { family: "heatmap", x: dimension, y: measure, splitBy, agg: intent.aggregation, ...common };
    case "hierarchy":
      if (!dimension || !splitBy || !measure) return undefined;
      return { family: "treemap", x: dimension, y: measure, splitBy, agg: intent.aggregation, ...common };
    case "before-after":
      if (!dimension || !measure || !intent.measures[1]) return undefined;
      return { family: "dumbbell", x: dimension, y: measure, y2: intent.measures[1], ...common };
    case "signed-contribution":
      if (!dimension || !measure) return undefined;
      return { family: "diverging-bar", x: dimension, y: measure, agg: intent.aggregation, ...common };
  }
}

function intentFieldsExist(dataset: AutomationDataset, intent: InsightViewIntent): boolean {
  const fields = new Set(dataset.schema.fields.map((field) => field.name));
  return [...intent.dimensions, ...intent.measures].every((field) => fields.has(field));
}

function selectionReason(intent: InsightViewIntent, chart: ThinChartSpec): string {
  const rules: Record<InsightViewIntent["relation"], string> = {
    kpi: "单一核心指标需要总量与微趋势并读。",
    trend: chart.family === "area"
      ? "可加总的计数或金额按时间变化，面积编码可同时表达规模与走势。"
      : "平均值、比例或时长按时间变化，折线避免暗示面积可加总。",
    rank: "一个分类维度与一个指标需要排序比较。",
    share: "低基数分类与非负可加总指标适合部分—整体比较。",
    "time-composition": "时间、分类和可加总指标共同回答构成如何变化。",
    distribution: "连续数值需要查看集中区、长尾和异常区间。",
    "grouped-distribution": "分类组内有足够样本，可比较中位数、四分位与离群值。",
    correlation: "两个连续数值有足够成对观测，可检查共同变化。",
    matrix: "两个离散维度形成交叉单元，颜色比并列柱更紧凑。",
    hierarchy: "两层分类与非负指标构成父子层级。",
    "before-after": "同一对象有明确的前后两个指标。",
    "signed-contribution": "指标同时包含正值和负值，需要围绕零轴比较。",
  };
  return rules[intent.relation];
}

function chartSignature(chart: ThinChartSpec): string {
  return JSON.stringify([
    chart.family,
    chart.x,
    chart.y,
    chart.y2,
    chart.splitBy,
    chart.where,
  ]);
}
