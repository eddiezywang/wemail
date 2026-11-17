import type { AutomationDataset } from "../../../shared/wemail/automation.js";
import type {
  InsightAnalysisResult,
  InsightLens,
  InsightRelation,
  InsightViewIntent,
} from "../../../shared/wemail/designArtifacts.js";
import { inferDimensions } from "./inferDimensions.js";
import { selectInsightCharts } from "./selectInsightCharts.js";

type DatasetField = AutomationDataset["schema"]["fields"][number];
type MeasureSemantic = InsightAnalysisResult["measures"][number]["semantic"];

interface NumericProfile {
  field: DatasetField;
  semantic: MeasureSemantic;
  aggregation: "sum" | "average";
  values: number[];
  distinct: number;
  min?: number;
  max?: number;
  median?: number;
  p95?: number;
  mean?: number;
  deviation?: number;
}

const ALL_LENSES: InsightLens[] = [
  "overview",
  "trend",
  "comparison",
  "composition",
  "distribution",
  "relationship",
  "matrix",
  "hierarchy",
  "change",
  "anomaly",
  "quality",
];

export function planInsightViews(
  dataset: AutomationDataset,
  options: { maxCharts?: number } = {},
): InsightAnalysisResult {
  const inferred = inferDimensions(dataset);
  const temporal = inferred.temporal.find((field) => distinctCount(dataset, field) > 1);
  const timeWindow = inferred.timeWindows[0];
  const status = inferred.status;
  const categorical = [...new Set([
    ...inferred.categorical,
    ...(status ? [status] : []),
  ])]
    .filter((field) => {
      const count = distinctCount(dataset, field);
      return count >= 2 && count <= 60;
    })
    .sort((left, right) => dimensionPriority(dataset, left) - dimensionPriority(dataset, right));
  const measures = inferred.measures
    .map((field) => numericProfile(dataset, field))
    .filter((profile): profile is NumericProfile => Boolean(profile && profile.values.length))
    .sort((left, right) => measurePriority(left) - measurePriority(right));
  const primary = measures[0];
  const intents: InsightViewIntent[] = [];
  const findings: InsightAnalysisResult["findings"] = [];

  const addIntent = (
    lens: InsightLens,
    relation: InsightRelation,
    score: number,
    intent: Omit<InsightViewIntent, "lens" | "relation" | "score">,
  ): void => {
    const signature = JSON.stringify([
      relation,
      intent.dimensions,
      intent.measures,
    ]);
    if (intents.some((candidate) => JSON.stringify([
      candidate.relation,
      candidate.dimensions,
      candidate.measures,
    ]) === signature)) return;
    intents.push({ lens, relation, score, ...intent });
  };

  if (primary) {
    const summary = metricSummary(primary);
    findings.push({
      lens: "overview",
      title: `${fieldLabel(dataset, primary.field.name)}总体水平`,
      text: `${fieldLabel(dataset, primary.field.name)}${summary.label}为 ${formatMeasureValue(primary, summary.value)}；中位数 ${formatMeasureValue(primary, primary.median)}，p95 ${formatMeasureValue(primary, primary.p95)}。`,
      tone: "neutral",
      score: 100,
      fields: [primary.field.name],
    });
    if (temporal && primary.aggregation === "sum") {
      addIntent("overview", "kpi", 100, {
        dimensions: [temporal],
        measures: [primary.field.name],
        aggregation: primary.aggregation,
        measureSemantic: primary.semantic,
        span: "half",
        title: `${fieldLabel(dataset, primary.field.name)}总览与走势`,
      });
    }
  }

  if (primary && temporal) {
    const trend = trendFinding(dataset, temporal, primary);
    if (trend) findings.push(trend);
    addIntent("trend", "trend", 98, {
      dimensions: [temporal],
      measures: [primary.field.name],
      aggregation: primary.aggregation,
      measureSemantic: primary.semantic,
      span: "full",
      title: trend?.title ?? `${fieldLabel(dataset, primary.field.name)}随时间变化`,
    });
    const split = categorical.find((field) => distinctCount(dataset, field) <= 8);
    if (split && primary.aggregation === "sum") {
      addIntent("composition", "time-composition", 88, {
        dimensions: [temporal, split],
        measures: [primary.field.name],
        aggregation: primary.aggregation,
        measureSemantic: primary.semantic,
        span: "full",
        title: `${fieldLabel(dataset, split)}构成如何随时间变化`,
      });
    }
  }

  for (const [index, measure] of measures.slice(1, 4).entries()) {
    if (temporal) {
      const finding = trendFinding(dataset, temporal, measure);
      if (finding) findings.push({ ...finding, score: 86 - index });
      addIntent("trend", "trend", 86 - index, {
        dimensions: [temporal],
        measures: [measure.field.name],
        aggregation: measure.aggregation,
        measureSemantic: measure.semantic,
        span: "full",
        title: finding?.title ?? `${fieldLabel(dataset, measure.field.name)}随时间变化`,
      });
    } else if (categorical[0]) {
      addIntent("comparison", "rank", 80 - index, {
        dimensions: [categorical[0]],
        measures: [measure.field.name],
        aggregation: measure.aggregation,
        measureSemantic: measure.semantic,
        top: 12,
        title: `按${fieldLabel(dataset, categorical[0])}比较${fieldLabel(dataset, measure.field.name)}`,
      });
    }
  }

  if (primary && timeWindow) {
    const dimensions = categorical.filter((field) => field !== timeWindow).slice(0, 3);
    for (const dimension of dimensions) {
      addIntent("matrix", "matrix", 94, {
        dimensions: [dimension, timeWindow],
        measures: [primary.field.name],
        aggregation: primary.aggregation,
        measureSemantic: primary.semantic,
        span: "full",
        title: `${fieldLabel(dataset, dimension)}在不同${fieldLabel(dataset, timeWindow)}的强弱分布`,
      });
    }
  }

  if (primary) {
    for (const [index, dimension] of categorical.slice(0, 3).entries()) {
      const contribution = categoryFinding(dataset, dimension, primary);
      if (contribution) findings.push(contribution);
      addIntent("comparison", "rank", 90 - index * 4, {
        dimensions: [dimension],
        measures: [primary.field.name],
        aggregation: primary.aggregation,
        measureSemantic: primary.semantic,
        top: 12,
        title: contribution?.title ?? `按${fieldLabel(dataset, dimension)}比较${fieldLabel(dataset, primary.field.name)}`,
      });
    }
  }

  const compositionDimension = status ?? categorical.find((field) => distinctCount(dataset, field) <= 6);
  if (primary && compositionDimension && primary.aggregation === "sum" && (primary.min ?? 0) >= 0) {
    addIntent("composition", "share", 92, {
      dimensions: [compositionDimension],
      measures: [primary.field.name],
      aggregation: "sum",
      measureSemantic: primary.semantic,
      title: `${fieldLabel(dataset, compositionDimension)}占比揭示主要构成`,
    });
  }

  const distributionMeasure = measures
    .filter((profile) => profile.values.length >= 8 && profile.distinct >= 5)
    .sort((left, right) => distributionPriority(left) - distributionPriority(right))[0];
  if (distributionMeasure) {
    const distribution = distributionFinding(dataset, distributionMeasure);
    findings.push(distribution);
    addIntent("distribution", "distribution", 91, {
      dimensions: [],
      measures: [distributionMeasure.field.name],
      aggregation: "count",
      measureSemantic: distributionMeasure.semantic,
      title: distribution.title,
    });
    const boxDimension = categorical.find((dimension) => hasBoxplotGroups(dataset, dimension, distributionMeasure.field.name));
    if (boxDimension) {
      addIntent("distribution", "grouped-distribution", 87, {
        dimensions: [boxDimension],
        measures: [distributionMeasure.field.name],
        measureSemantic: distributionMeasure.semantic,
        title: `不同${fieldLabel(dataset, boxDimension)}的${fieldLabel(dataset, distributionMeasure.field.name)}分布差异`,
      });
    }
  }

  const relationship = bestRelationship(dataset, measures);
  if (relationship) {
    findings.push(relationship.finding);
    const relationshipSplit = categorical.find((field) => distinctCount(dataset, field) <= 6);
    addIntent("relationship", "correlation", 89, {
      dimensions: relationshipSplit ? [relationshipSplit] : [],
      measures: [relationship.x.field.name, relationship.y.field.name],
      measureSemantic: relationship.y.semantic,
      title: relationship.finding.title,
    });
  }

  if (primary && categorical.length >= 2) {
    const [parent, child] = categorical;
    const cells = distinctCount(dataset, parent) * distinctCount(dataset, child);
    addIntent("matrix", "matrix", 84, {
      dimensions: [parent, child],
      measures: [primary.field.name],
      aggregation: primary.aggregation,
      measureSemantic: primary.semantic,
      span: cells > 30 ? "full" : "half",
      title: `${fieldLabel(dataset, parent)}与${fieldLabel(dataset, child)}的交叉高值区`,
    });
    if ((primary.min ?? 0) >= 0 && cells <= 80) {
      addIntent("hierarchy", "hierarchy", 82, {
        dimensions: [parent, child],
        measures: [primary.field.name],
        aggregation: primary.aggregation,
        measureSemantic: primary.semantic,
        title: `${fieldLabel(dataset, parent)}下的${fieldLabel(dataset, child)}层级构成`,
      });
    }
  }

  const pair = beforeAfterPair(measures);
  const pairDimension = categorical[0];
  if (pair && pairDimension) {
    addIntent("change", "before-after", 93, {
      dimensions: [pairDimension],
      measures: [pair[0].field.name, pair[1].field.name],
      measureSemantic: pair[1].semantic,
      title: `${fieldLabel(dataset, pairDimension)}前后变化幅度`,
    });
  }

  const signed = measures.find((profile) => (profile.min ?? 0) < 0 && (profile.max ?? 0) > 0);
  if (signed && categorical[0]) {
    addIntent("change", "signed-contribution", 96, {
      dimensions: [categorical[0]],
      measures: [signed.field.name],
      aggregation: signed.aggregation,
      measureSemantic: signed.semantic,
      title: `${fieldLabel(dataset, signed.field.name)}的正负贡献分化`,
    });
  }

  const anomaly = anomalyFinding(dataset, measures);
  if (anomaly) findings.push(anomaly);
  const quality = qualityFinding(dataset);
  if (quality) findings.push(quality);

  const views = selectInsightCharts(dataset, intents, { maxCharts: options.maxCharts ?? 10 });
  const selectedFindings = selectDiverseFindings(findings, 10);
  const selectedLenses = new Set(views.map((view) => view.lens));
  const findingLenses = new Set(selectedFindings.map((finding) => finding.lens));
  const coverage = ALL_LENSES.map((lens) => {
    const relevant = intents.filter((intent) => intent.lens === lens);
    const covered = selectedLenses.has(lens) || findingLenses.has(lens);
    return {
      lens,
      status: covered ? "covered" as const : "not-applicable" as const,
      reason: covered
        ? selectedLenses.has(lens) ? "已生成可视证据。" : "已生成文字证据，当前数据不需要单独绘图。"
        : relevant.length ? "受图表预算限制，已由更高信息增益视角覆盖。" : notApplicableReason(lens),
      chartFamilies: views.filter((view) => view.lens === lens).map((view) => view.chart.family),
    };
  });

  return {
    schemaVersion: 1,
    generatedBy: "deterministic-host",
    dimensions: [
      ...inferred.temporal.map((field) => ({ field, kind: "temporal" as const, cardinality: distinctCount(dataset, field) })),
      ...inferred.timeWindows.map((field) => ({ field, kind: "time-window" as const, cardinality: distinctCount(dataset, field) })),
      ...inferred.categorical.map((field) => ({ field, kind: "categorical" as const, cardinality: distinctCount(dataset, field) })),
      ...(status ? [{ field: status, kind: "status" as const, cardinality: distinctCount(dataset, status) }] : []),
    ],
    measures: measures.map((profile) => ({
      field: profile.field.name,
      semantic: profile.semantic,
      aggregation: profile.aggregation,
      nonMissing: profile.values.length,
      distinct: profile.distinct,
      min: profile.min,
      max: profile.max,
      median: profile.median,
      p95: profile.p95,
    })),
    intents,
    views,
    findings: selectedFindings,
    coverage,
  };
}

export function insightFieldLabel(dataset: AutomationDataset, name: string): string {
  return fieldLabel(dataset, name);
}

function numericProfile(dataset: AutomationDataset, fieldName: string): NumericProfile | undefined {
  const field = dataset.schema.fields.find((candidate) => candidate.name === fieldName);
  if (!field) return undefined;
  const values = dataset.rows
    .flatMap((row) => {
      const value = finiteNumber(row[fieldName]);
      return value === undefined ? [] : [value];
    })
    .sort((left, right) => left - right);
  if (!values.length) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  const semantic = measureSemantic(field);
  return {
    field,
    semantic,
    aggregation: semantic === "count" || semantic === "currency" ? "sum" : "average",
    values,
    distinct: new Set(values).size,
    min: values[0],
    max: values.at(-1),
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    mean,
    deviation,
  };
}

function measureSemantic(field: DatasetField): MeasureSemantic {
  const descriptor = `${field.name} ${field.label ?? ""}`;
  if (/rate|ratio|percent|pct|share|conversion|%|％|率|比例|占比|转化/i.test(descriptor)) return "ratio";
  if (/duration|latency|elapsed|response.?time|耗时|时长|延迟|响应时间/i.test(descriptor)) return "duration";
  if (/amount|revenue|income|price|fee|cost|金额|收入|营收|价格|费用|成本|元/i.test(descriptor)) return "currency";
  if (/average|avg|mean|均值|平均/i.test(descriptor)) return "average";
  if (/(^|[_\s-])(cnt|count|total|sum|qty|number|calls?|volume)([_\s-]|$)|数量|次数|调用量|通话量|呼叫量|接通量|总量|人数|邮件数/i.test(descriptor)) return "count";
  return "value";
}

function measurePriority(profile: NumericProfile): number {
  const semantic = profile.semantic === "count" ? 0
    : profile.semantic === "currency" ? 1
      : profile.semantic === "ratio" ? 2
        : profile.semantic === "duration" ? 3
          : 4;
  const sparsityPenalty = profile.values.length < 3 ? 10 : 0;
  const constantPenalty = profile.distinct <= 1 ? 20 : 0;
  return semantic + sparsityPenalty + constantPenalty;
}

function distributionPriority(profile: NumericProfile): number {
  if (profile.semantic === "duration") return 0;
  if (profile.semantic === "average" || profile.semantic === "value") return 1;
  if (profile.semantic === "currency") return 2;
  if (profile.semantic === "ratio") return 3;
  return 4;
}

function dimensionPriority(dataset: AutomationDataset, field: string): number {
  const schema = dataset.schema.fields.find((candidate) => candidate.name === field);
  const descriptor = `${field} ${schema?.label ?? ""}`;
  if (schema?.semanticRole === "status" || /status|state|结果|状态|成败/i.test(descriptor)) return 0;
  if (/channel|source|渠道|来源/i.test(descriptor)) return 1;
  if (/type|category|业务|类型|类别/i.test(descriptor)) return 2;
  if (/team|owner|region|部门|团队|地区/i.test(descriptor)) return 3;
  return 5 + Math.min(distinctCount(dataset, field), 50) / 100;
}

function selectDiverseFindings(
  findings: InsightAnalysisResult["findings"],
  maxFindings: number,
): InsightAnalysisResult["findings"] {
  const sorted = [...findings]
    .sort((left, right) => right.score - left.score)
    .filter((finding, index, all) => all.findIndex((candidate) => candidate.title === finding.title) === index);
  const selected: InsightAnalysisResult["findings"] = [];
  const covered = new Set<InsightLens>();
  for (const finding of sorted) {
    if (selected.length >= maxFindings) break;
    if (covered.has(finding.lens)) continue;
    selected.push(finding);
    covered.add(finding.lens);
  }
  for (const finding of sorted) {
    if (selected.length >= maxFindings) break;
    if (!selected.includes(finding)) selected.push(finding);
  }
  return selected;
}

function trendFinding(
  dataset: AutomationDataset,
  temporal: string,
  measure: NumericProfile,
): InsightAnalysisResult["findings"][number] | undefined {
  const groups = aggregateBy(dataset, temporal, measure.field.name, measure.aggregation);
  if (groups.length < 2) return undefined;
  const first = groups[0];
  const last = groups.at(-1)!;
  const delta = last.value - first.value;
  const rate = first.value === 0 ? undefined : delta / Math.abs(first.value);
  const direction = delta >= 0 ? "上升" : "下降";
  return {
    lens: "trend",
    title: `${fieldLabel(dataset, measure.field.name)}较首期${direction}${rate === undefined ? "" : ` ${formatPercent(Math.abs(rate))}`}`,
    text: `${formatCategory(first.key)}为 ${formatMeasureValue(measure, first.value)}，${formatCategory(last.key)}为 ${formatMeasureValue(measure, last.value)}；净变化 ${formatMeasureDelta(measure, delta)}。`,
    tone: delta < 0 ? "warning" : "positive",
    score: 98,
    fields: [temporal, measure.field.name],
  };
}

function categoryFinding(
  dataset: AutomationDataset,
  dimension: string,
  measure: NumericProfile,
): InsightAnalysisResult["findings"][number] | undefined {
  const groups = aggregateBy(dataset, dimension, measure.field.name, measure.aggregation)
    .sort((left, right) => right.value - left.value);
  if (groups.length < 2) return undefined;
  const top = groups[0];
  const total = measure.aggregation === "sum"
    ? groups.reduce((sum, group) => sum + Math.max(0, group.value), 0)
    : 0;
  const share = total > 0 ? top.value / total : undefined;
  return {
    lens: "comparison",
    title: `${formatCategory(top.key)}在${fieldLabel(dataset, dimension)}中居首${share === undefined ? "" : `，占 ${formatPercent(share)}`}`,
    text: `${formatCategory(top.key)}为 ${formatMeasureValue(measure, top.value)}，比第二名${formatCategory(groups[1].key)}高 ${formatMeasureValue(measure, top.value - groups[1].value)}。`,
    tone: share !== undefined && share >= 0.5 ? "warning" : "neutral",
    score: 88,
    fields: [dimension, measure.field.name],
  };
}

function distributionFinding(
  dataset: AutomationDataset,
  measure: NumericProfile,
): InsightAnalysisResult["findings"][number] {
  const skew = measure.median === undefined || measure.p95 === undefined || measure.deviation === 0
    ? false
    : measure.p95 > measure.median + (measure.deviation ?? 0);
  return {
    lens: "distribution",
    title: `${fieldLabel(dataset, measure.field.name)}${skew ? "存在明显长尾" : "分布相对集中"}`,
    text: `中位数为 ${formatMeasureValue(measure, measure.median)}，p95 为 ${formatMeasureValue(measure, measure.p95)}，范围 ${formatMeasureValue(measure, measure.min)}–${formatMeasureValue(measure, measure.max)}。`,
    tone: skew ? "warning" : "neutral",
    score: 91,
    fields: [measure.field.name],
  };
}

function bestRelationship(dataset: AutomationDataset, measures: NumericProfile[]): {
  x: NumericProfile;
  y: NumericProfile;
  finding: InsightAnalysisResult["findings"][number];
} | undefined {
  let best: { x: NumericProfile; y: NumericProfile; correlation: number; pairs: number } | undefined;
  for (let left = 0; left < Math.min(measures.length, 5); left += 1) {
    for (let right = left + 1; right < Math.min(measures.length, 5); right += 1) {
      const x = measures[left];
      const y = measures[right];
      const pairs = dataset.rows.flatMap((row) => {
        const xv = finiteNumber(row[x.field.name]);
        const yv = finiteNumber(row[y.field.name]);
        return xv !== undefined && yv !== undefined ? [[xv, yv] as const] : [];
      });
      if (pairs.length < 4 || new Set(pairs.map((pair) => pair[0])).size < 3 || new Set(pairs.map((pair) => pair[1])).size < 3) continue;
      const correlation = pearson(pairs);
      if (!best || Math.abs(correlation) > Math.abs(best.correlation)) {
        best = { x, y, correlation, pairs: pairs.length };
      }
    }
  }
  if (!best) return undefined;
  const strength = Math.abs(best.correlation) >= 0.7 ? "强"
    : Math.abs(best.correlation) >= 0.4 ? "中等" : "弱";
  const direction = best.correlation >= 0 ? "正" : "负";
  return {
    x: best.x,
    y: best.y,
    finding: {
      lens: "relationship",
      title: `${fieldLabel(dataset, best.x.field.name)}与${fieldLabel(dataset, best.y.field.name)}呈${strength}${direction}相关`,
      text: `基于 ${best.pairs} 个成对观测，Pearson 相关系数为 ${best.correlation.toFixed(2)}；相关不等于因果。`,
      tone: "neutral",
      score: 89,
      fields: [best.x.field.name, best.y.field.name],
    },
  };
}

function anomalyFinding(
  dataset: AutomationDataset,
  measures: NumericProfile[],
): InsightAnalysisResult["findings"][number] | undefined {
  const profile = measures.find((candidate) => (candidate.deviation ?? 0) > 0 && candidate.values.length >= 6);
  if (!profile || profile.mean === undefined || profile.deviation === undefined) return undefined;
  const threshold = profile.mean + profile.deviation * 2;
  const outliers = dataset.rows.filter((row) => (finiteNumber(row[profile.field.name]) ?? Number.NEGATIVE_INFINITY) > threshold);
  if (!outliers.length) return undefined;
  return {
    lens: "anomaly",
    title: `${fieldLabel(dataset, profile.field.name)}发现 ${outliers.length} 个高位异常点`,
    text: `异常阈值为均值加 2 个标准差（${formatNumber(threshold)}）；建议结合时间和分类图定位主要贡献来源。`,
    tone: "warning",
    score: 86,
    fields: [profile.field.name],
  };
}

function qualityFinding(dataset: AutomationDataset): InsightAnalysisResult["findings"][number] | undefined {
  if (!dataset.rows.length || !dataset.schema.fields.length) return undefined;
  const totalCells = dataset.rows.length * dataset.schema.fields.length;
  const missingByField = dataset.schema.fields.map((field) => ({
    field,
    missing: dataset.rows.filter((row) => row[field.name] === undefined || row[field.name] === null || row[field.name] === "").length,
  })).filter((item) => item.missing > 0).sort((left, right) => right.missing - left.missing);
  const missing = missingByField.reduce((sum, item) => sum + item.missing, 0);
  const completeness = totalCells ? 1 - missing / totalCells : 0;
  return {
    lens: "quality",
    title: `数据完整率 ${formatPercent(completeness)}`,
    text: missingByField.length
      ? `缺失主要集中在${missingByField.slice(0, 3).map((item) => `${fieldLabel(dataset, item.field.name)}（${item.missing} 条）`).join("、")}。`
      : "当前分析字段未发现空值；仍需结合来源邮件确认业务口径是否一致。",
    tone: completeness < 0.9 ? "warning" : completeness === 1 ? "positive" : "neutral",
    score: completeness < 0.9 ? 95 : 78,
    fields: missingByField.slice(0, 5).map((item) => item.field.name),
  };
}

function beforeAfterPair(measures: NumericProfile[]): [NumericProfile, NumericProfile] | undefined {
  const before = measures.find((profile) => /before|previous|prior|last|上期|上周|去年|之前/i.test(`${profile.field.name} ${profile.field.label ?? ""}`));
  const after = measures.find((profile) => /after|current|this|本期|本周|今年|之后/i.test(`${profile.field.name} ${profile.field.label ?? ""}`));
  return before && after && before !== after ? [before, after] : undefined;
}

function hasBoxplotGroups(dataset: AutomationDataset, dimension: string, measure: string): boolean {
  const groups = new Map<string, number>();
  for (const row of dataset.rows) {
    const value = finiteNumber(row[measure]);
    if (value === undefined) continue;
    const key = String(row[dimension] ?? "—");
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return groups.size >= 2 && groups.size <= 10 && [...groups.values()].filter((count) => count >= 4).length >= 2;
}

function aggregateBy(
  dataset: AutomationDataset,
  dimension: string,
  measure: string,
  aggregation: "sum" | "average",
): Array<{ key: string; value: number; index: number }> {
  const groups = new Map<string, { values: number[]; index: number }>();
  dataset.rows.forEach((row, index) => {
    const value = finiteNumber(row[measure]);
    if (value === undefined) return;
    const key = String(row[dimension] ?? "—");
    const group = groups.get(key) ?? { values: [], index };
    group.values.push(value);
    groups.set(key, group);
  });
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      value: aggregation === "average"
        ? group.values.reduce((sum, value) => sum + value, 0) / group.values.length
        : group.values.reduce((sum, value) => sum + value, 0),
      index: group.index,
    }))
    .sort((left, right) => sortable(left.key) - sortable(right.key) || left.index - right.index);
}

function metricSummary(profile: NumericProfile): { label: string; value: number } {
  if (profile.aggregation === "average") {
    return { label: "平均值", value: profile.mean ?? 0 };
  }
  return { label: "合计", value: profile.values.reduce((sum, value) => sum + value, 0) };
}

function pearson(pairs: Array<readonly [number, number]>): number {
  const xMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const yMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let numerator = 0;
  let xSquare = 0;
  let ySquare = 0;
  for (const [x, y] of pairs) {
    numerator += (x - xMean) * (y - yMean);
    xSquare += (x - xMean) ** 2;
    ySquare += (y - yMean) ** 2;
  }
  const denominator = Math.sqrt(xSquare * ySquare);
  return denominator === 0 ? 0 : numerator / denominator;
}

function quantile(sorted: number[], percentile: number): number | undefined {
  if (!sorted.length) return undefined;
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function distinctCount(dataset: AutomationDataset, field: string): number {
  return new Set(dataset.rows
    .map((row) => row[field])
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map(String)).size;
}

function finiteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function fieldLabel(dataset: AutomationDataset, name: string): string {
  const field = dataset.schema.fields.find((candidate) => candidate.name === name);
  const raw = field?.label?.trim();
  if (raw && raw !== name) return raw;
  const labels: Record<string, string> = {
    biz_type: "业务类型",
    data_source: "数据源",
    model_name: "模型",
    task_name: "任务",
    deal_status: "处理状态",
    cnt: "调用量",
    count: "数量",
    total: "合计",
    _source_time: "统计时间",
    _source_date: "统计日期",
  };
  return labels[name] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").trim();
}

function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", {
    notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatMeasureValue(profile: NumericProfile, value: number | undefined): string {
  return profile.semantic === "ratio" && value !== undefined ? formatPercent(value) : formatNumber(value);
}

function formatMeasureDelta(profile: NumericProfile, value: number): string {
  if (profile.semantic === "ratio") {
    return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} 个百分点`;
  }
  return `${value >= 0 ? "+" : ""}${formatNumber(value)}`;
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function formatCategory(value: string): string {
  const date = new Date(value);
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(value) && !Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
  }
  return value;
}

function sortable(value: string): number {
  const date = Date.parse(value);
  return Number.isNaN(date) ? (value.codePointAt(0) ?? 0) : date;
}

function notApplicableReason(lens: InsightLens): string {
  const reasons: Record<InsightLens, string> = {
    overview: "缺少可量化指标。",
    trend: "缺少两个以上有效时间点。",
    comparison: "缺少可比较的分类维度。",
    composition: "缺少可加总的非负指标或低基数分类。",
    distribution: "有效数值点不足以估计分布。",
    relationship: "缺少两项具有足够变化的成对数值指标。",
    matrix: "缺少两个可交叉的维度。",
    hierarchy: "缺少两层分类结构或数据过于稀疏。",
    change: "缺少正负指标或明确的前后指标对。",
    anomaly: "当前样本量不足或未发现超过阈值的异常点。",
    quality: "当前数据为空，无法评估字段完整性。",
  };
  return reasons[lens];
}
