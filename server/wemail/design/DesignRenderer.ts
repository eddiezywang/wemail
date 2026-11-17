import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { AutomationDataset } from "../../../shared/wemail/automation.js";
import type { ChartSpec, DesignComponentSpec, DesignRecipe } from "../../../shared/wemail/designArtifacts.js";
import { templateName } from "./InsightReportTemplates.js";
import { MONO, rnd, DATA_COLORS, ColorAssigner, COLOR_SYSTEMS, buildCustomColorSystem } from "./monoTokens.js";
import type { ColorSystem } from "./monoTokens.js";
import { buildEchartsOption, supportsEcharts } from "./echartsOptions.js";
import { aggregationSummary, sourceEmailIds, timePointCount } from "./InsightDatasetContract.js";
import { readFileSync } from "node:fs";

// Load the trusted ECharts runtime once. Artifacts are standalone HTML files, so
// the runtime must be embedded rather than referenced as a sibling resource.
let echartsContent = "";
try {
  const echartsPath = createRequire(import.meta.url).resolve("echarts/dist/echarts.min");
  echartsContent = readFileSync(echartsPath, "utf8");
} catch { /* echarts not installed — SVG fallback */ }

export interface RenderedDesignArtifact {
  html: string;
  contentHash: string;
  preview: string;
  keyMetrics: Array<{ label: string; value: string }>;
}

export class DesignRenderer {
  render(recipe: DesignRecipe, dataset: AutomationDataset): RenderedDesignArtifact {
    const system = resolveSystem(recipe.designSystem);
    // Mono reports keep the AntV categorical palette (multi-series comparison is the norm);
    // preset/custom reports use the system palette for every chart in the delivery.
    const colorAssigner = new ColorAssigner(system.id === "mono" ? DATA_COLORS.categorical : system.cat);
    const body = recipe.sections.map((section) => `
      <section class="report-section">
        <header class="section-heading">
          <p class="section-index">${escapeHtml(section.title ?? "数据洞察")}</p>
          ${section.description ? `<p>${escapeHtml(section.description)}</p>` : ""}
        </header>
        <div class="report-grid ${escapeAttr(section.layout)}">
          ${renderComponents(section.components, dataset, colorAssigner, system)}
        </div>
      </section>`).join("");
    const reportPeriod = datasetPeriod(dataset);
    const viewerSource = viewerRuntimeScript();
    const viewerHash = createHash("sha256").update(viewerSource).digest("base64");
    const sourceEmails = dataset.sourceEmails ?? [];
    const sourceCount = sourceEmailIds(dataset).length;
    const aggregation = aggregationSummary(dataset);
    const dataTimePointCount = aggregation?.timePointCount ?? timePointCount(dataset);
    const rowLabel = aggregation ? "行聚合数据" : "条记录";
    const sourceBlock = sourceCount
      ? `<button type="button" class="src-trigger" aria-expanded="false" data-src-toggle>数据说明 · 来源：${sourceCount} 封邮件 <span class="caret">▾</span></button><div class="source-popup" hidden>${sourceEmails.length ? sourcePopupList(sourceEmails) : `<h3>来源邮件（${sourceCount}）</h3><p>详见原始数据。</p>`}</div>`
      : `<span class="src-trigger static">数据说明 · 来源：未提供</span>`;
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(recipe.title)}</title>
  <style>${styles(recipe.kind)}${designSystemCss(system)}main{max-width:${recipe.kind === "dashboard" ? "1540px" : "1600px"};padding:clamp(28px,3.5vw,64px)}.report-grid>*{min-width:0}.chart{width:100%;min-width:0}.charts-row{grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch}.charts-row .chart{height:100%}.charts-row>.chart:last-child:nth-child(odd){grid-column:1/-1}.chart.chart-wide{padding-left:30px;padding-right:30px}.echarts-container{display:block;width:100%;min-width:0;height:320px}.echarts-container.kpi{height:240px}.chart-wide .echarts-container{height:420px}.chart-wide .echarts-container.kpi{height:300px}.switch-pane{display:grid;gap:18px}.switch-pane[hidden]{display:none}@media(max-width:820px){.charts-row{grid-template-columns:1fr}.echarts-container{height:340px}}</style>
</head>
<body data-kind="${recipe.kind}" data-template="${recipe.templateId}" data-purpose="${recipe.purpose}" data-design-system="${system.id}">
  <main>
    <header class="hero">
      <div class="brand"><svg class="brand-mark" viewBox="0 0 30 30" aria-hidden="true"><rect x="2.5" y="7" width="25" height="16" rx="4.5" fill="none" stroke="var(--accent)" stroke-width="2.2"/><path d="M3.5 9 L15 17 L26.5 9" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/></svg><span class="brand-wm">WeMail</span></div>
      <div class="hero-meta">
        <span>${recipe.purpose === "analyze" ? "WEMAIL INSIGHT" : "WEMAIL VISUAL"}</span>
        <span>${escapeHtml(templateName(recipe.templateId))}${reportPeriod ? ` · 数据更新至 ${escapeHtml(reportPeriod)}` : ""}</span>
      </div>
      <h1>${escapeHtml(recipe.title)}</h1>
      ${recipe.subtitle ? `<p>${escapeHtml(recipe.subtitle)}</p>` : ""}
      <div class="dataset-stamp">
        <span><b>${dataset.rows.length}</b> ${rowLabel}</span>
        <span><b>${dataset.schema.fields.length}</b> 个字段</span>
        ${sourceCount ? `<span><b>${sourceCount}</b> 封来源邮件</span>` : ""}
        ${dataTimePointCount > 1 ? `<span><b>${dataTimePointCount}</b> 个时间点</span>` : ""}
        <span>基于本次结构化数据生成</span>
      </div>
      <div class="report-source">${sourceBlock}</div>
    </header>
    ${body || `<section class="empty"><h2>${escapeHtml(recipe.narrative.emptyState.title)}</h2><p>${escapeHtml(recipe.narrative.emptyState.description)}</p></section>`}
    ${dataset.rawTables && dataset.rawTables.length ? renderRawTables(dataset.rawTables) : ""}
    <footer><span>${recipe.purpose === "analyze" ? "WeMail 洞察报告" : "WeMail 邮件数据图表"}</span><span>结论与图表均绑定本次数据输入</span></footer>
  </main>
  ${echartsContent ? `<script id="wemail-echarts-runtime">${inlineScript(echartsContent)}</script>` : ""}
  <script id="wemail-viewer-runtime">${viewerSource}</script>
</body>
</html>`;
    const keyMetrics = (recipe.notification.keyMetrics ?? []).map((metric) => ({
      label: metric.label,
      value: formatValue(metric.valuePath ? readPath(dataset, metric.valuePath) : metric.value, metric.format),
    }));
    return {
      html,
      contentHash: createHash("sha256").update(html).digest("hex"),
      preview: renderTemplate(recipe.notification.previewTemplate, dataset),
      keyMetrics,
    };
  }
}

// Render components in order. A switch group may contain both charts and grouped tables;
// components with the same switchLabel become one pane so changing 类型 / 模型 / 状态
// updates the whole analytical view together.
function renderComponents(components: DesignComponentSpec[], dataset: AutomationDataset, assigner: ColorAssigner, system: ColorSystem): string {
  let html = "";
  let chartBuf: ChartComponent[] = [];
  const flush = (): void => {
    if (!chartBuf.length) return;
    html += `<div class="charts-row">${chartBuf.map((c) => renderComponent(c, dataset, assigner, system)).join("")}</div>`;
    chartBuf = [];
  };
  let i = 0;
  while (i < components.length) {
    const component = components[i];
    const switchGroup = componentSwitchGroup(component);
    if (switchGroup) {
      flush();
      const grp: SwitchableComponent[] = [];
      while (i < components.length) {
        const next = components[i];
        if (!next || (next.type !== "chart" && next.type !== "table") || componentSwitchGroup(next) !== switchGroup) break;
        grp.push(next); i++;
      }
      html += renderSwitchCard(grp, dataset, assigner, system);
    } else if (component.type === "chart") {
      // A temporal trend is the report's primary reading surface. Keep it out
      // of the comparison-card row so it gets the full report width instead of
      // competing with bars/donuts for a half-width grid track.
      if (isFullWidthChart(component)) {
        flush();
        html += renderComponent(component, dataset, assigner, system);
      } else {
        chartBuf.push(component);
      }
      i++;
    } else {
      flush(); html += renderComponent(component, dataset, assigner, system); i++;
    }
  }
  flush();
  return html;
}

function fieldLabel(dataset: AutomationDataset, name: string): string {
  return dataset.schema.fields.find((f) => f.name === name)?.label ?? name;
}

type ChartComponent = Extract<DesignComponentSpec, { type: "chart" }>;
type SwitchableComponent = Extract<DesignComponentSpec, { type: "chart" | "table" }>;

function componentSwitchGroup(component: DesignComponentSpec): string | undefined {
  if (component.type === "chart") return component.chart.switchGroup;
  if (component.type === "table") return component.switchGroup;
  return undefined;
}

function isFullWidthChart(component: ChartComponent): boolean {
  return component.chart.span === "full" || component.chart.type === "line" || component.chart.type === "area";
}

function componentSwitchLabel(component: SwitchableComponent, dataset: AutomationDataset): string {
  if (component.type === "table") return component.switchLabel ?? component.title ?? "明细";
  if (component.chart.switchLabel) return component.chart.switchLabel;
  return component.chart.data.series ? `分${fieldLabel(dataset, component.chart.data.series)}` : "全部";
}

// A switchable card: one toggle bar + one pane per semantic view. A pane can contain
// multiple charts and its matching summary table.
function renderSwitchCard(grp: SwitchableComponent[], dataset: AutomationDataset, assigner: ColorAssigner, system: ColorSystem): string {
  const views = new Map<string, SwitchableComponent[]>();
  for (const component of grp) {
    const label = componentSwitchLabel(component, dataset);
    const items = views.get(label) ?? [];
    items.push(component);
    views.set(label, items);
  }
  const entries = [...views.entries()];
  const buttons = entries.map(([label], idx) => {
    return `<button type="button" class="switch-btn ${idx === 0 ? "active" : ""}" data-switch-view="${idx}">${escapeHtml(label)}</button>`;
  }).join("");
  const panes = entries.map(([, items], idx) =>
    `<div class="switch-pane" data-switch-pane="${idx}"${idx === 0 ? "" : ' hidden="true"'}>${items.map((item) => renderComponent(item, dataset, assigner, system)).join("")}</div>`
  ).join("");
  return `<div class="chart-switch chart-wide"><div class="switch-bar">${buttons}</div>${panes}</div>`;
}

function renderComponent(
  component: DesignRecipe["sections"][number]["components"][number],
  dataset: AutomationDataset,
  assigner?: ColorAssigner,
  system: ColorSystem = COLOR_SYSTEMS.mono,
): string {
  if (component.type === "heading") return `<h${component.level ?? 2} class="standalone-heading">${escapeHtml(component.text)}</h${component.level ?? 2}>`;
  if (component.type === "paragraph") return `<p class="standalone-copy">${escapeHtml(component.text)}</p>`;
  if (component.type === "callout") {
    const marker = component.title === "核心结论" ? "结论" : "原文";
    return `<aside class="callout ${component.tone ?? "info"}"><span class="callout-mark">${marker}</span><div>${component.title ? `<strong>${escapeHtml(component.title)}</strong>` : ""}<p>${escapeHtml(component.text)}</p></div></aside>`;
  }
  if (component.type === "metric") {
    const value = component.valuePath ? readPath(dataset, component.valuePath) : component.value;
    return `<article class="metric"><span>${escapeHtml(component.label)}</span><strong>${escapeHtml(formatValue(value, component.format))}</strong>${component.note ? `<small>${escapeHtml(component.note)}</small>` : ""}</article>`;
  }
  if (component.type === "insight-list") {
    return `<article class="insights"><div class="component-heading"><span>INSIGHTS</span><h2>关键发现</h2></div><ol>${component.items.map((item, index) => `<li data-tone="${item.tone ?? "neutral"}"><b>${String(index + 1).padStart(2, "0")}</b><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p></div></li>`).join("")}</ol></article>`;
  }
  if (component.type === "timeline") {
    return `<article class="timeline"><div class="component-heading"><span>TIMELINE</span><h2>邮件时间线</h2></div><ol>${component.items.map((item) => `<li><time>${escapeHtml(item.label)}</time><div><strong>${escapeHtml(item.title)}</strong>${item.text ? `<p>${escapeHtml(item.text)}</p>` : ""}</div></li>`).join("")}</ol></article>`;
  }
  if (component.type === "chart") {
    const inner = renderChart(component.chart, dataset, assigner, system);
    return isFullWidthChart(component) ? inner.replace('class="chart"', 'class="chart chart-wide"') : inner;
  }
  if (component.type === "table") {
    const rows = tableRows(component, dataset).slice(0, Math.min(component.limit ?? 50, 100));
    return `<div class="table-wrap"><div class="component-heading"><span>DETAIL</span><h2>${escapeHtml(component.title ?? "数据明细")}</h2></div>${rows.length
      ? `<table><thead><tr>${component.columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${component.columns.map((column) => `<td>${escapeHtml(formatCellValue(row[column.field]))}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      : `<div class="empty compact"><p>当前范围没有可展示的明细记录。</p></div>`}</div>`;
  }
  return "";
}

function tableRows(
  component: Extract<DesignComponentSpec, { type: "table" }>,
  dataset: AutomationDataset,
): Array<Record<string, unknown>> {
  const rows = dataset.rows.filter((row) => rowMatchesWhere(row, component.where));
  if (!component.groupBy?.length || !component.measures?.length) return rows;
  const groups = new Map<string, { dimensions: Record<string, unknown>; values: Map<string, number[]> }>();
  for (const row of rows) {
    const dimensions = Object.fromEntries(component.groupBy.map((field) => [field, row[field]]));
    const key = JSON.stringify(component.groupBy.map((field) => row[field]));
    const group = groups.get(key) ?? { dimensions, values: new Map<string, number[]>() };
    for (const measure of component.measures) {
      const value = Number(row[measure.field]);
      if (!Number.isFinite(value)) continue;
      const values = group.values.get(measure.field) ?? [];
      values.push(value);
      group.values.set(measure.field, values);
    }
    groups.set(key, group);
  }
  const firstMeasure = component.measures[0]?.field;
  return [...groups.values()].map((group) => ({
    ...group.dimensions,
    ...Object.fromEntries(component.measures!.map((measure) => [
      measure.field,
      aggregate(group.values.get(measure.field) ?? [], measure.aggregate),
    ])),
  })).sort((a, b) => firstMeasure ? Number(b[firstMeasure]) - Number(a[firstMeasure]) : 0);
}

function renderChart(chart: ChartSpec, dataset: AutomationDataset, assigner?: ColorAssigner, system: ColorSystem = COLOR_SYSTEMS.mono): string {
  // ECharts families: render as interactive ECharts containers (zoom/pan/tooltip/legend).
  if (echartsContent && supportsEcharts(chart.type)) {
    const opt = buildEchartsOption(chart, dataset, assigner, system);
    if (opt) return echartsContainer(chart, opt);
  }
  // SVG fallback (waffle/dumbbell, or when ECharts is not installed).
  const values = chartValues(chart, dataset);
  if (!values.length) {
    return `<article class="chart"><div class="component-heading"><span>CHART</span><h2>${escapeHtml(chart.title ?? "图表")}</h2></div><div class="empty compact"><p>${escapeHtml(chart.emptyState ?? "暂无数据")}</p></div></article>`;
  }
  if (chart.type === "line" || chart.type === "area") {
    return chart.data.series ? renderLineChartMulti(chart, dataset) : renderLineChart(chart, values);
  }
  if (chart.type === "waffle") return renderWaffle(chart, values, assigner);
  if (chart.type === "scatter") return renderScatter(chart, dataset);
  if (chart.type === "heatmap") return renderHeatmap(chart, dataset);
  if (chart.type === "dumbbell") return renderDumbbell(chart, dataset, assigner);
  if (chart.type === "stacked-bar") return renderStackedBar(chart, dataset);
  if (chart.type === "treemap") {
    return `<article class="chart" data-chart-type="treemap"><div class="component-heading"><span>HIERARCHY</span><h2>${escapeHtml(chart.title ?? "层级构成")}</h2>${chart.description ? `<p>${escapeHtml(chart.description)}</p>` : ""}</div><div class="empty compact"><p>ECharts 未就绪，无法渲染层级构成图。</p></div></article>`;
  }
  return renderBarChart(chart, values, assigner);
}

function echartsEyebrow(type: string): string {
  if (type === "line" || type === "area") return "TREND";
  if (type === "stacked-bar") return "COMPOSITION";
  if (type === "scatter") return "RELATIONSHIP";
  if (type === "histogram" || type === "boxplot") return "DISTRIBUTION";
  if (type === "heatmap") return "MATRIX";
  if (type === "treemap") return "HIERARCHY";
  if (type === "diverging-bar") return "SIGNED";
  if (type === "counter") return "KPI";
  return "COMPARISON";
}

function echartsContainer(chart: ChartSpec, option: Record<string, unknown>): string {
  const json = JSON.stringify(option).replace(/'/g, "&#39;");
  const kpi = typeof (option as { __kpi?: unknown }).__kpi === "number" ? ` data-kpi="${String((option as { __kpi: number }).__kpi)}"` : "";
  const cls = kpi ? " echarts-container kpi" : " echarts-container";
  return `<article class="chart" data-chart-type="${chart.type}">
    <div class="component-heading"><span>${echartsEyebrow(chart.type)}</span><h2>${escapeHtml(chart.title ?? "图表")}</h2>${chart.description ? `<p>${escapeHtml(chart.description)}</p>` : ""}</div>
    <div class="${cls}" data-option='${json}'${kpi}></div>
  </article>`;
}

function renderLineChart(chart: ChartSpec, values: Array<{ label: string; rawLabel: unknown; value: number }>): string {
  const width = 920;
  const height = 340;
  const left = 40;
  const right = 24;
  const top = 30;
  const bottom = 56;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const scale = niceScale(values.map((item) => item.value));
  const points = values.map((item, index) => ({
    ...item,
    x: left + (values.length === 1 ? chartWidth / 2 : index * chartWidth / (values.length - 1)),
    y: top + (scale.max - item.value) / (scale.max - scale.min) * chartHeight,
  }));
  const pointList = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const baselineY = top + chartHeight;
  const areaBaseline = top + (scale.max - Math.max(scale.min, Math.min(scale.max, 0))) / (scale.max - scale.min) * chartHeight;
  const area = chart.type === "area"
    ? `<polygon class="line-area" points="${points[0].x.toFixed(1)},${areaBaseline.toFixed(1)} ${pointList} ${points.at(-1)!.x.toFixed(1)},${areaBaseline.toFixed(1)}"></polygon>`
    : "";
  const grid = scale.ticks.filter((_, i) => i % 2 === 0).map((tick) => {
    const y = top + (scale.max - tick) / (scale.max - scale.min) * chartHeight;
    return `<g class="grid-line"><line x1="${left}" y1="${y.toFixed(1)}" x2="${left + chartWidth}" y2="${y.toFixed(1)}"></line></g>`;
  }).join("");
  const floor = points.map((point) =>
    `<line class="cal-tick" x1="${point.x.toFixed(1)}" y1="${baselineY.toFixed(1)}" x2="${point.x.toFixed(1)}" y2="${(baselineY + 7).toFixed(1)}"></line>`,
  ).join("");
  let peakIdx = 0;
  points.forEach((point, i) => { if (point.value > points[peakIdx].value) peakIdx = i; });
  const dots = points.map((point, i) => {
    const isPeak = i === peakIdx && points.length > 1;
    const r = isPeak ? 4 : 2.4;
    const peakLabel = isPeak
      ? `<text class="peak-val" x="${point.x.toFixed(1)}" y="${(point.y - 12).toFixed(1)}" text-anchor="middle">${escapeHtml(formatValue(point.value, chart.presentation?.numberFormat))}</text>`
      : "";
    return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${r}"><title>${escapeHtml(`${point.label}：${formatValue(point.value, chart.presentation?.numberFormat)}`)}</title></circle>${peakLabel}`;
  }).join("");
  const step = Math.max(1, Math.ceil(points.length / 6));
  const labels = points.map((point, index) => {
    if (index % step !== 0 && index !== points.length - 1) return "";
    return `<text class="x-label" x="${point.x.toFixed(1)}" y="${height - 16}" text-anchor="middle">${escapeHtml(formatCategory(point.rawLabel))}</text>`;
  }).join("");
  return `<article class="chart" data-chart-type="${chart.type}">
    <div class="component-heading"><span>TREND</span><h2>${escapeHtml(chart.title ?? "趋势图")}</h2>${chart.description ? `<p>${escapeHtml(chart.description)}</p>` : ""}</div>
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttr(chart.title ?? "趋势折线图")}">
      ${grid}<line class="axis" x1="${left}" y1="${baselineY}" x2="${left + chartWidth}" y2="${baselineY}"></line>${floor}
      ${area}<polyline points="${pointList}"></polyline>${dots}${labels}
    </svg>
  </article>`;
}

// Lieflat multi-series hairline — one polyline per series (e.g. one line per day across hours),
// gray-ladder colors in fixed order. Used for the 7-day × hourly "compare intra-day curves" view.
function renderLineChartMulti(chart: ChartSpec, dataset: AutomationDataset): string {
  const cat = chart.data.category, ser = chart.data.series, val = chart.data.value;
  if (!cat || !ser || !val) return renderLineChart(chart, chartValues(chart, dataset));
  const rows = dataset.rows.filter((r) => rowMatchesWhere(r, chart.data.where));
  const cats: string[] = [], series: string[] = [];
  const cell = new Map<string, number>();
  for (const r of rows) {
    const v = Number(r[val]); if (!Number.isFinite(v)) continue;
    const c = String(r[cat]), s = String(r[ser]);
    if (!cats.includes(c)) cats.push(c);
    if (!series.includes(s)) series.push(s);
    const k = `${c}|${s}`; cell.set(k, (cell.get(k) ?? 0) + v);
  }
  if (!cats.length || !series.length) return renderLineChart(chart, chartValues(chart, dataset));
  cats.sort((a, b) => a.localeCompare(b, "zh-CN"));
  series.sort((a, b) => a.localeCompare(b, "zh-CN"));
  const all = [...cell.values()]; const max = Math.max(...all), min = Math.min(...all);
  const W = 920, H = 340, left = 44, right = 24, top = 30, bottom = 56;
  const cw = W - left - right, ch = H - top - bottom, baseline = top + ch;
  const xFor = (i: number) => left + (cats.length === 1 ? cw / 2 : i * cw / (cats.length - 1));
  const yFor = (v: number) => baseline - (max === min ? ch / 2 : (v - min) / (max - min) * ch);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const y = top + t * ch;
    return `<g class="grid-line"><line x1="${left}" y1="${y.toFixed(1)}" x2="${left + cw}" y2="${y.toFixed(1)}"></line></g>`;
  }).join("");
  const step = Math.max(1, Math.ceil(cats.length / 8));
  const labels = cats.map((c, ci) => (ci % step === 0 || ci === cats.length - 1) ? `<text class="x-label" x="${xFor(ci).toFixed(1)}" y="${H - 16}" text-anchor="middle">${escapeHtml(c)}</text>` : "").join("");
  const palette = DATA_COLORS.categorical;
  const lines = series.map((s, si) => {
    const color = palette[si % palette.length];
    const pts: Array<{ x: number; y: number; c: string; v: number }> = [];
    cats.forEach((c, ci) => { const v = cell.get(`${c}|${s}`); if (v !== undefined) pts.push({ x: xFor(ci), y: yFor(v), c, v }); });
    if (!pts.length) return "";
    const path = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const dots = pts.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.4" style="fill:${color}"><title>${escapeHtml(`${s} ${p.c}：${p.v.toLocaleString("zh-CN")}`)}</title></circle>`).join("");
    return `<polyline points="${path}" style="stroke:${color}"></polyline>${dots}`;
  }).join("");
  const legend = series.map((s, si) => `<li><i style="background:${DATA_COLORS.categorical[si % DATA_COLORS.categorical.length]}"></i>${escapeHtml(s)}</li>`).join("");
  return `<article class="chart" data-chart-type="${chart.type}">
    <div class="component-heading"><span>TREND</span><h2>${escapeHtml(chart.title ?? "趋势图")}</h2>${chart.description ? `<p>${escapeHtml(chart.description)}</p>` : ""}</div>
    <svg class="line-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeAttr(chart.title ?? "趋势图")}">
      ${grid}<line class="axis" x1="${left}" y1="${baseline}" x2="${left + cw}" y2="${baseline}"></line>${lines}${labels}
    </svg>
    <ul class="waffle-legend">${legend}</ul>
  </article>`;
}

function renderBarChart(chart: ChartSpec, values: Array<{ label: string; value: number }>, assigner?: ColorAssigner): string {
  // Lieflat "chunky bars": vertical capsule columns, value on top, no y-axis.
  const max = Math.max(1, ...values.map((item) => Math.abs(item.value)));
  const W = 920, H = 340, padL = 24, padR = 24, padT = 30, padB = 58;
  const cw = W - padL - padR, ch = H - padT - padB;
  const slot = cw / Math.max(1, values.length);
  const barW = Math.min(72, Math.max(8, slot * 0.5));
  const baseline = padT + ch;
  const bars = values.map((item, index) => {
    const cx = padL + slot * (index + 0.5);
    const h = Math.abs(item.value) / max * ch;
    const y = baseline - h;
    return `<g>
      <rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${(barW / 2).toFixed(1)}" fill="${assigner ? assigner.assign(item.label) : DATA_COLORS.categorical[index % DATA_COLORS.categorical.length]}"><title>${escapeHtml(`${item.label}：${formatValue(item.value, chart.presentation?.numberFormat)}`)}</title></rect>
      <text class="bar-val" x="${cx.toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle">${escapeHtml(formatValue(item.value, chart.presentation?.numberFormat))}</text>
      <text class="x-label" x="${cx.toFixed(1)}" y="${(baseline + 20).toFixed(1)}" text-anchor="middle">${escapeHtml(item.label)}</text>
    </g>`;
  }).join("");
  return `<article class="chart" data-chart-type="bar">
    <div class="component-heading"><span>COMPARISON</span><h2>${escapeHtml(chart.title ?? "对比图")}</h2>${chart.description ? `<p>${escapeHtml(chart.description)}</p>` : ""}</div>
    <svg class="bar-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeAttr(chart.title ?? "对比图")}">
      <line class="axis" x1="${padL}" y1="${baseline}" x2="${padL + cw}" y2="${baseline}"></line>
      ${bars}
    </svg>
  </article>`;
}

function renderWaffle(chart: ChartSpec, values: Array<{ label: string; value: number }>, assigner?: ColorAssigner): string {
  const total = values.reduce((sum, v) => sum + Math.abs(v.value), 0) || 1;
  const cells = values.map((v, i) => ({
    label: v.label,
    share: Math.round((Math.abs(v.value) / total) * 100),
    color: assigner ? assigner.assign(v.label) : DATA_COLORS.categorical[i % DATA_COLORS.categorical.length],
  }));
  if (cells.length) cells[0].share += 100 - cells.reduce((s, c) => s + c.share, 0);
  const COLS = 10, CELL = 18, R = 6.5, X0 = 6, Y0 = 6;
  let idx = 0;
  const dots: string[] = [];
  const legend: string[] = [];
  for (const c of cells) {
    for (let k = 0; k < c.share; k++) {
      const r = Math.floor(idx / COLS), col = idx % COLS;
      dots.push(`<circle cx="${(X0 + col * CELL + R).toFixed(1)}" cy="${(Y0 + r * CELL + R).toFixed(1)}" r="${R}" fill="${c.color}"/>`);
      idx++;
    }
    legend.push(`<li><i style="background:${c.color}"></i>${escapeHtml(c.label)}<b>${c.share}%</b></li>`);
  }
  const rows = Math.ceil(idx / COLS);
  const w = X0 * 2 + COLS * CELL, h = Y0 * 2 + rows * CELL;
  return `<article class="chart" data-chart-type="waffle">
    <div class="component-heading"><span>SHARE</span><h2>${escapeHtml(chart.title ?? "占比图")}</h2>${chart.description ? `<p>${escapeHtml(chart.description)}</p>` : ""}</div>
    <div class="waffle-wrap"><svg class="waffle" viewBox="0 0 ${w} ${Math.max(h, 60)}" role="img" aria-label="${escapeAttr(chart.title ?? "占比")}">${dots.join("")}</svg><ul class="waffle-legend">${legend.join("")}</ul></div>
  </article>`;
}

function rowMatchesWhere(row: Record<string, unknown>, where: ChartSpec["data"]["where"]): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

// Lieflat "jitter strip" — one dot per record, jittered inside its category band.
function renderScatter(chart: ChartSpec, dataset: AutomationDataset): string {
  const cat = chart.data.category;
  const val = chart.data.value;
  if (!val) return renderBarChart(chart, chartValues(chart, dataset));
  const rows = dataset.rows.filter((r) => rowMatchesWhere(r, chart.data.where));
  const cats = [...new Set(rows.map((r) => (cat ? String(r[cat]) : "值")))];
  const vals = rows.map((r) => Number(r[val]));
  if (!rows.length || !vals.some((v) => Number.isFinite(v))) return renderBarChart(chart, chartValues(chart, dataset));
  const finite = vals.filter((v) => Number.isFinite(v));
  const max = Math.max(...finite), min = Math.min(...finite);
  const W = 920, H = 340, padL = 24, padR = 24, padT = 30, padB = 58;
  const cw = W - padL - padR, ch = H - padT - padB, baseline = padT + ch;
  const bandW = cw / Math.max(1, cats.length);
  const dots = rows.map((r, i) => {
    const c = cat ? String(r[cat]) : "值";
    const ci = cats.indexOf(c);
    const v = Number(r[val]);
    if (!Number.isFinite(v)) return "";
    const jitter = rnd(i, 3);
    const x = padL + bandW * ci + bandW * (0.25 + jitter * 0.5);
    const y = baseline - (max === min ? ch / 2 : (v - min) / (max - min) * ch);
    return `<circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"><title>${escapeHtml(`${c}：${v.toLocaleString("zh-CN")}`)}</title></circle>`;
  }).join("");
  const labels = cats.map((c, ci) => `<text class="x-label" x="${(padL + bandW * (ci + 0.5)).toFixed(1)}" y="${H - 16}" text-anchor="middle">${escapeHtml(formatCategory(c))}</text>`).join("");
  return `<article class="chart" data-chart-type="scatter">
    <div class="component-heading"><span>DISTRIBUTION</span><h2>${escapeHtml(chart.title ?? "分布图")}</h2>${chart.description ? `<p>${escapeHtml(chart.description)}</p>` : ""}</div>
    <svg class="scatter-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeAttr(chart.title ?? "分布图")}">
      <line class="axis" x1="${padL}" y1="${baseline}" x2="${padL + cw}" y2="${baseline}"></line>${dots}${labels}
    </svg>
  </article>`;
}

// Lieflat "stacked rungs" — category columns stacked by series, 2px surface gap, total on top.
function renderStackedBar(chart: ChartSpec, dataset: AutomationDataset): string {
  const cat = chart.data.category, ser = chart.data.series, val = chart.data.value;
  if (!cat || !ser || !val) return renderBarChart(chart, chartValues(chart, dataset));
  const rows = dataset.rows.filter((r) => rowMatchesWhere(r, chart.data.where));
  const cats: string[] = [], series: string[] = [];
  const cell = new Map<string, number>();
  for (const r of rows) {
    const v = Number(r[val]);
    if (!Number.isFinite(v)) continue;
    const c = String(r[cat]), s = String(r[ser]);
    if (!cats.includes(c)) cats.push(c);
    if (!series.includes(s)) series.push(s);
    const k = `${c}|${s}`;
    cell.set(k, (cell.get(k) ?? 0) + v);
  }
  if (!cats.length || !series.length) return renderBarChart(chart, chartValues(chart, dataset));
  const totals = cats.map((c) => series.reduce((sum, s) => sum + (cell.get(`${c}|${s}`) ?? 0), 0));
  const max = Math.max(1, ...totals);
  const W = 920, H = 340, padL = 24, padR = 24, padT = 30, padB = 58;
  const cw = W - padL - padR, ch = H - padT - padB, baseline = padT + ch;
  const slot = cw / cats.length, barW = Math.min(72, slot * 0.5);
  const cols = cats.map((c, ci) => {
    const cx = padL + slot * (ci + 0.5);
    let acc = 0;
    const segs = series.map((s, si) => {
      const v = cell.get(`${c}|${s}`) ?? 0;
      const segH = v / max * ch;
      const y = baseline - acc - segH;
      acc += segH;
      const color = MONO.L[Math.min(si, MONO.L.length - 1)];
      return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, segH - 2).toFixed(1)}" fill="${color}"><title>${escapeHtml(`${c} · ${s}：${v.toLocaleString("zh-CN")}`)}</title></rect>`;
    }).join("");
    const totalY = baseline - totals[ci] / max * ch;
    return `${segs}<text class="bar-val" x="${cx.toFixed(1)}" y="${(totalY - 8).toFixed(1)}" text-anchor="middle">${escapeHtml(formatValue(totals[ci], chart.presentation?.numberFormat))}</text><text class="x-label" x="${cx.toFixed(1)}" y="${(baseline + 20).toFixed(1)}" text-anchor="middle">${escapeHtml(c)}</text>`;
  }).join("");
  const legend = series.map((s, si) => `<li><i style="background:${MONO.L[Math.min(si, MONO.L.length - 1)]}"></i>${escapeHtml(s)}</li>`).join("");
  return `<article class="chart" data-chart-type="stacked-bar">
    <div class="component-heading"><span>COMPOSITION</span><h2>${escapeHtml(chart.title ?? "构成图")}</h2>${chart.description ? `<p>${escapeHtml(chart.description)}</p>` : ""}</div>
    <svg class="bar-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeAttr(chart.title ?? "构成图")}"><line class="axis" x1="${padL}" y1="${baseline}" x2="${padL + cw}" y2="${baseline}"></line>${cols}</svg>
    <ul class="waffle-legend">${legend}</ul>
  </article>`;
}

// Lieflat "dot heat" — category × series matrix, intensity by value (darker = larger).
function renderHeatmap(chart: ChartSpec, dataset: AutomationDataset): string {
  const cat = chart.data.category, ser = chart.data.series, val = chart.data.value;
  if (!cat || !ser || !val) return renderBarChart(chart, chartValues(chart, dataset));
  const rows = dataset.rows.filter((r) => rowMatchesWhere(r, chart.data.where));
  const cats: string[] = [], series: string[] = [];
  const cell = new Map<string, number>();
  for (const r of rows) {
    const v = Number(r[val]);
    if (!Number.isFinite(v)) continue;
    const c = String(r[cat]), s = String(r[ser]);
    if (!cats.includes(c)) cats.push(c);
    if (!series.includes(s)) series.push(s);
    cell.set(`${c}|${s}`, (cell.get(`${c}|${s}`) ?? 0) + v);
  }
  if (!cats.length || !series.length) return renderBarChart(chart, chartValues(chart, dataset));
  const all = [...cell.values()];
  const max = Math.max(...all), min = Math.min(...all);
  const ladder = MONO.L;
  const fillFor = (v: number): string => {
    if (v === 0) return MONO.PAPER;
    const t = max === min ? 0.5 : (v - min) / (max - min);
    return ladder[Math.min(ladder.length - 1, Math.max(0, Math.floor((1 - t) * ladder.length)))];
  };
  const cellW = 84, cellH = 32, padL = 90, padT = 36;
  const W = padL + cats.length * cellW + 16, H = padT + series.length * cellH + 24;
  const cells = series.map((s, ri) => cats.map((c, ci) => {
    const v = cell.get(`${c}|${s}`) ?? 0;
    return `<rect x="${padL + ci * cellW}" y="${padT + ri * cellH}" width="${cellW - 3}" height="${cellH - 3}" fill="${fillFor(v)}"><title>${escapeHtml(`${c} · ${s}：${v.toLocaleString("zh-CN")}`)}</title></rect>`;
  }).join("")).join("");
  const colLabels = cats.map((c, ci) => `<text class="x-label" x="${padL + ci * cellW + (cellW - 3) / 2}" y="${padT - 8}" text-anchor="middle">${escapeHtml(formatCategory(c))}</text>`).join("");
  const rowLabels = series.map((s, ri) => `<text class="x-label" x="${padL - 8}" y="${padT + ri * cellH + (cellH - 3) / 2 + 3}" text-anchor="end">${escapeHtml(s)}</text>`).join("");
  return `<article class="chart" data-chart-type="heatmap">
    <div class="component-heading"><span>MATRIX</span><h2>${escapeHtml(chart.title ?? "热力图")}</h2>${chart.description ? `<p>${escapeHtml(chart.description)}</p>` : ""}</div>
    <svg class="heatmap-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeAttr(chart.title ?? "热力图")}">${cells}${colLabels}${rowLabels}</svg>
  </article>`;
}

// Lieflat "dumbbell" — two measures (before → after) per category, dot + connector.
function renderDumbbell(chart: ChartSpec, dataset: AutomationDataset, assigner?: ColorAssigner): string {
  const measures = chart.data.measures;
  if (!measures || measures.length < 2) return renderBarChart(chart, chartValues(chart, dataset));
  const a = measures[0], b = measures[1];
  const rows = dataset.rows.filter((r) => rowMatchesWhere(r, chart.data.where));
  const cats = rows.map((r, i) => (chart.data.category ? String(r[chart.data.category]) : `#${i + 1}`));
  const all = rows.flatMap((r) => [Number(r[a.field]), Number(r[b.field])]).filter((v) => Number.isFinite(v));
  if (!all.length) return renderBarChart(chart, chartValues(chart, dataset));
  const max = Math.max(...all), min = Math.min(...all);
  const W = 920, H = 340, padL = 90, padR = 24, padT = 30, padB = 40;
  const cw = W - padL - padR, ch = H - padT - padB;
  const rowH = ch / Math.max(1, rows.length);
  const xFor = (v: number) => padL + (max === min ? cw / 2 : (v - min) / (max - min) * cw);
  const lanes = rows.map((r, i) => {
    const va = Number(r[a.field]), vb = Number(r[b.field]);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) return "";
    const y = padT + rowH * (i + 0.5);
    const xa = xFor(va), xb = xFor(vb);
    return `<line class="dumb-line" x1="${xa.toFixed(1)}" y1="${y.toFixed(1)}" x2="${xb.toFixed(1)}" y2="${y.toFixed(1)}"></line>
      <circle class="dumb-before" cx="${xa.toFixed(1)}" cy="${y.toFixed(1)}" r="4"><title>${escapeHtml(`${cats[i]} · ${a.label}：${va.toLocaleString("zh-CN")}`)}</title></circle>
      <circle class="dumb-after" cx="${xb.toFixed(1)}" cy="${y.toFixed(1)}" r="4"><title>${escapeHtml(`${cats[i]} · ${b.label}：${vb.toLocaleString("zh-CN")}`)}</title></circle>
      <text class="x-label" x="${(padL - 8).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end">${escapeHtml(cats[i])}</text>`;
  }).join("");
  return `<article class="chart" data-chart-type="dumbbell">
    <div class="component-heading"><span>BEFORE / AFTER</span><h2>${escapeHtml(chart.title ?? "前后对比")}</h2>${chart.description ? `<p>${escapeHtml(chart.description)}</p>` : ""}</div>
    <svg class="dumbbell-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeAttr(chart.title ?? "前后对比")}">${lanes}</svg>
    <ul class="waffle-legend"><li><i style="background:${assigner ? assigner.assign(a.label) : DATA_COLORS.categorical[0]}"></i>${escapeHtml(a.label)}</li><li><i style="background:${assigner ? assigner.assign(b.label) : DATA_COLORS.categorical[1]}"></i>${escapeHtml(b.label)}</li></ul>
  </article>`;
}

function chartValues(chart: ChartSpec, dataset: AutomationDataset): Array<{ label: string; rawLabel: unknown; value: number }> {
  if (chart.data.measures?.length && dataset.rows[0]) {
    return chart.data.measures
      .map((measure) => ({
        label: measure.label,
        rawLabel: measure.label,
        value: Number(dataset.rows[0][measure.field]),
      }))
      .filter((item) => Number.isFinite(item.value))
      .slice(0, Math.min(chart.data.limit ?? 10, 12));
  }
  if (!chart.data.value) return [];
  const category = chart.data.category;
  const groups = new Map<string, { rawLabel: unknown; values: number[]; sourceIndex: number }>();
  dataset.rows.forEach((row, index) => {
    if (chart.data.where && !Object.entries(chart.data.where).every(([k, v]) => row[k] === v)) return;
    const rawLabel = category ? row[category] : index + 1;
    const label = formatCategory(rawLabel);
    const value = Number(row[chart.data.value!]);
    if (!Number.isFinite(value)) return;
    const group = groups.get(label) ?? { rawLabel, values: [], sourceIndex: index };
    group.values.push(value);
    groups.set(label, group);
  });
  let result = [...groups.entries()].map(([label, group]) => ({
    label,
    rawLabel: group.rawLabel,
    value: aggregate(group.values, chart.data.aggregate),
    sourceIndex: group.sourceIndex,
  }));
  if (chart.data.sort === "ascending") {
    result.sort((a, b) => sortableCategory(a.rawLabel) - sortableCategory(b.rawLabel) || a.value - b.value);
  } else if (chart.data.sort === "descending") {
    result.sort((a, b) => b.value - a.value);
  } else {
    result.sort((a, b) => a.sourceIndex - b.sourceIndex);
  }
  return result.slice(0, Math.min(chart.data.limit ?? 20, 48));
}

function aggregate(values: number[], method: ChartSpec["data"]["aggregate"]): number {
  if (!values.length) return 0;
  if (method === "count") return values.length;
  if (method === "average") return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (method === "min") return Math.min(...values);
  if (method === "max") return Math.max(...values);
  return values.reduce((sum, value) => sum + value, 0);
}

function niceScale(values: number[]): { min: number; max: number; ticks: number[] } {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const padding = Math.max(Math.abs(min) * 0.15, 1);
    min -= padding;
    max += padding;
  } else {
    const range = max - min;
    if (min >= 0 && min / max < 0.65) min = 0;
    else min -= range * 0.08;
    if (max <= 0 && max / min < 0.65) max = 0;
    else max += range * 0.08;
  }
  const roughStep = (max - min) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = niceNormalized * magnitude;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let tick = niceMin; tick <= niceMax + step / 2 && ticks.length < 8; tick += step) ticks.push(tick);
  return { min: niceMin, max: niceMax, ticks };
}

/**
 * Resolve the delivery's color system from the recipe's designSystem id. The recipe
 * stores "wemail-mono" / "wemail-porcelain" / "wemail-palm" / "wemail-wire" or a
 * "custom:#RRGGBB,…" board; unknown/legacy values fall back to mono (safe default).
 */
function resolveSystem(designSystem: string): ColorSystem {
  const spec = String(designSystem ?? "").toLowerCase().trim();
  if (spec.startsWith("custom:")) {
    const hexes = spec.slice("custom:".length).split(",").filter(Boolean);
    const custom = buildCustomColorSystem(hexes);
    if (custom) return custom;
  }
  const id = (spec.replace(/^wemail-/, "") || "mono") as ColorSystem["id"];
  return COLOR_SYSTEMS[id] ?? COLOR_SYSTEMS.mono;
}

/**
 * Preset skin: the base styles() string already drives everything through CSS variables
 * (--ink/--muted/--canvas/--surface/--soft/--line/--accent/--green/--warning). Re-scoping
 * those variables on body[data-design-system] re-skins the whole report shell; the ECharts
 * option objects carry their own system colors (see echartsOptions.ts).
 */
function designSystemCss(system: ColorSystem): string {
  if (system.id === "mono") return "";
  const mix = (a: string, b: string, t: number): string => {
    const pa = parseInt(a.replace("#", ""), 16);
    const pb = parseInt(b.replace("#", ""), 16);
    const ch = (s: number) => Math.round(((pa >> s) & 0xff) + (((pb >> s) & 0xff) - ((pa >> s) & 0xff)) * t);
    return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
  };
  const surface = system.id === "porcelain" ? "#FCFAF4" : system.bg;
  const accentSoft = system.id === "wire" ? "#FDECE6" : mix(system.bg, system.hero, 0.12);
  return `body[data-design-system="${system.id}"]{--ink:${system.ink};--muted:${system.muted};--canvas:${system.bg};--surface:${surface};--soft:${system.grid};--line:${system.grid};--accent:${system.hero};--accent-soft:${accentSoft};--green:${system.data};--warning:${system.hero}}body[data-design-system="${system.id}"] .line-chart .axis,body[data-design-system="${system.id}"] .bar-chart .axis{stroke:${system.muted}}body[data-design-system="${system.id}"] .bar-track{background:${system.grid}}`;
}

function styles(kind: string): string {
  return `:root{color-scheme:light;--ink:#1C1C1A;--muted:#8F8E88;--canvas:#F0EFEB;--surface:#FFFFFF;--soft:#F4F3EF;--line:#DEDDD6;--accent:#1C1C1A;--accent-soft:#F4F3EF;--green:#4A4944;--warning:#6A6963}*{box-sizing:border-box}body{margin:0;overflow-x:hidden;background:var(--canvas);color:var(--ink);font:14px/1.65 Inter,"Noto Sans SC","Segoe UI",sans-serif;font-variant-numeric:tabular-nums}body[data-purpose="visualize"]{--accent:#1C1C1A;--accent-soft:#F4F3EF;--green:#4A4944}main{width:100%;max-width:${kind === "dashboard" ? "1440px" : "1400px"};margin:auto;padding:clamp(24px,5vw,72px)}.hero{padding:0 0 38px;border-bottom:1px solid var(--line);margin-bottom:36px}.hero-meta{display:flex;justify-content:space-between;gap:20px;color:var(--muted);font-size:11px;letter-spacing:.1em}.hero-meta span:first-child{color:var(--accent);font-weight:800;letter-spacing:.18em}.hero h1{max-width:900px;margin:18px 0 12px;font-size:clamp(32px,5vw,56px);line-height:1.12;letter-spacing:-.035em;font-weight:750}.hero>p{max-width:72ch;margin:0;color:var(--muted);font-size:16px}.dataset-stamp{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:26px;color:var(--muted);font-size:12px}.dataset-stamp b{color:var(--ink);font-size:15px}.section-heading{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:18px}.section-heading .section-index{margin:0;color:var(--ink);font-size:17px;font-weight:700}.section-heading>p:last-child{max-width:620px;margin:0;overflow-wrap:anywhere;color:var(--muted);text-align:right}.report-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px}.report-grid>*{grid-column:span 12;min-width:0}.metric{grid-column:span 3;padding:20px 0;border-top:2px solid var(--ink)}.metric span{display:block;color:var(--muted);font-size:12px}.metric strong{display:block;margin-top:7px;font-size:clamp(24px,3vw,34px);line-height:1.2;letter-spacing:-.03em}.metric small{display:block;margin-top:5px;color:var(--muted);font-size:11px}.callout{display:grid;grid-template-columns:auto 1fr;gap:18px;padding:24px;border:1px solid color-mix(in srgb,var(--accent) 30%,white);background:var(--accent-soft);border-radius:12px}.callout-mark{align-self:start;border-radius:99px;background:var(--accent);color:white;padding:3px 9px;font-size:10px;font-weight:800;letter-spacing:.1em}.callout strong{font-size:16px}.callout p{max-width:80ch;margin:5px 0 0;overflow-wrap:anywhere;font-size:15px}.standalone-heading{grid-column:1/-1;margin:42px 0 0;padding-top:18px;border-top:2px solid var(--ink);font-size:clamp(22px,3vw,32px);line-height:1.15;letter-spacing:-.03em}.standalone-copy{grid-column:1/-1;max-width:72ch;margin:-8px 0 4px;color:var(--muted);font-size:13px}.component-heading{margin-bottom:14px}.component-heading>span{color:var(--accent);font-size:9px;font-weight:850;letter-spacing:.18em}.component-heading h2{margin:4px 0 0;font-size:19px;line-height:1.25;letter-spacing:-.02em}.component-heading p{margin:5px 0 0;color:var(--muted);font-size:12px}.insights,.timeline,.table-wrap{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:clamp(18px,3vw,28px);box-shadow:0 10px 30px rgba(24,34,29,.035)}.chart{background:color-mix(in srgb,var(--surface) 72%,var(--canvas));border:1px solid var(--line);border-top:2px solid var(--ink);border-radius:12px;padding:20px 22px 12px;box-shadow:none}.charts-row{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:18px;margin-bottom:8px}.insights ol,.timeline ol{list-style:none;margin:0;padding:0}.insights li{display:grid;grid-template-columns:34px 1fr;gap:14px;padding:17px 0;border-top:1px solid var(--line)}.insights li>b{color:var(--accent);font:700 11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.insights li strong{font-size:14px}.insights li p{margin:3px 0 0;color:var(--muted)}.timeline li{position:relative;display:grid;grid-template-columns:110px 1fr;gap:24px;padding:0 0 24px 24px;margin-left:6px;border-left:1px solid var(--line)}.timeline li:before{content:"";position:absolute;left:-5px;top:6px;width:9px;height:9px;border-radius:50%;background:var(--surface);border:2px solid var(--accent)}.timeline time{color:var(--accent);font:700 12px ui-monospace,SFMono-Regular,Consolas,monospace}.timeline p{margin:4px 0 0;color:var(--muted)}.line-chart{display:block;width:100%;min-height:260px;overflow:visible}.line-chart .axis{stroke:#8F8E88;stroke-width:1.5}.grid-line line{stroke:#e9edea;stroke-width:1}.line-chart polyline{fill:none;stroke:var(--accent);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.line-chart .line-area{fill:color-mix(in srgb,var(--accent) 8%,transparent)}.line-chart circle{fill:var(--accent);stroke:var(--canvas);stroke-width:2}.line-chart .cal-tick{stroke:#CFCEC7;stroke-width:.6}.line-chart .peak-val{fill:var(--ink);font-size:11px;font-weight:800;paint-order:stroke;stroke:var(--canvas);stroke-width:3px}.bar-chart{display:block;width:100%;height:auto;overflow:visible}.bar-chart .axis{stroke:#8F8E88;stroke-width:1.5}.bar-chart .bar-val{fill:var(--ink);font-size:11px;font-weight:800}.line-chart text,.bar-chart text{fill:var(--muted);font-size:11px;font-weight:600}.bars{display:grid;gap:14px}.bar-row{display:grid;grid-template-columns:28px minmax(100px,180px) 1fr auto;align-items:center;gap:12px}.rank{color:#9aa49d;font:11px ui-monospace,SFMono-Regular,Consolas,monospace}.bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar-track{height:10px;border-radius:3px;background:#edf0ed;overflow:hidden}.bar-track i{display:block;height:100%;border-radius:99px 3px 3px 99px;background:var(--ink)}.bar-row b{min-width:54px;text-align:right;font-size:12px}.table-wrap{overflow:auto}.table-wrap .component-heading{position:sticky;left:0}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid var(--line);padding:11px 12px;text-align:left;white-space:nowrap}th{background:var(--soft);color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.04em}tbody tr:hover{background:#f8faf8}.empty{text-align:center;padding:72px 20px;color:var(--muted)}.empty.compact{padding:38px 16px;background:var(--soft);border-radius:8px}.empty p{margin:0}footer{display:flex;justify-content:space-between;gap:20px;margin-top:34px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}@media(max-width:760px){main{padding:22px}.hero-meta,.section-heading,footer{align-items:start;flex-direction:column}.section-heading>p:last-child{text-align:left}.metric{grid-column:span 6}.bar-row{grid-template-columns:24px 100px 1fr auto}.line-chart{min-height:220px}.charts-row{grid-template-columns:1fr}}@media(max-width:600px){.bar-row{grid-template-columns:20px 80px 1fr}.bar-row b{grid-column:3;text-align:left}.callout{grid-template-columns:1fr}.callout-mark{justify-self:start}.timeline li{grid-template-columns:1fr;gap:4px}}@media(max-width:420px){.metric{grid-column:span 12}}@media print{body{background:white}main{max-width:none;padding:24px}.chart,.insights,.timeline,.table-wrap{box-shadow:none;break-inside:avoid}}.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}.brand-mark{width:26px;height:26px}.brand-wm{font-weight:800;font-size:17px;letter-spacing:-.02em}.chart-source{margin:10px 0 0;font-size:10.5px;color:${MONO.L[2]};font-weight:600;letter-spacing:.02em}.waffle-wrap{display:flex;gap:24px;align-items:center;flex-wrap:wrap}.waffle{width:220px;height:auto}.waffle-legend{list-style:none;margin:0;padding:0;display:grid;gap:8px;font-size:12px}.waffle-legend li{display:flex;align-items:center;gap:8px}.waffle-legend i{width:10px;height:10px;border-radius:50%;display:inline-block}.waffle-legend b{margin-left:auto;font-weight:800}.scatter-chart{display:block;width:100%;height:auto;overflow:visible}.scatter-chart .dot{fill:var(--accent);fill-opacity:.55;stroke:var(--canvas);stroke-width:.5}.heatmap-chart{display:block;width:100%;height:auto;overflow:visible}.heatmap-chart text{fill:var(--muted);font-size:10px;font-weight:600}.dumbbell-chart{display:block;width:100%;height:auto;overflow:visible}.dumbbell-chart text{fill:var(--muted);font-size:10px;font-weight:600}.dumb-line{stroke:var(--line);stroke-width:1.5}.dumb-before{fill:var(--muted)}.dumb-after{fill:var(--accent)}.src-trigger{display:inline-flex;align-items:center;gap:4px;background:transparent;border:1px solid var(--line);color:var(--ink);font:inherit;font-size:11px;font-weight:600;padding:4px 10px;border-radius:99px;cursor:pointer}.src-trigger.static{border:0;cursor:default;color:var(--muted)}.src-trigger .caret{font-size:9px;color:var(--muted)}.source-popup{position:fixed;left:50%;bottom:60px;transform:translateX(-50%);background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 18px;max-width:440px;max-height:50vh;overflow:auto;box-shadow:0 12px 32px rgba(24,34,29,.12);z-index:60}.source-popup h3{font-size:12px;color:var(--muted);margin:0 0 8px;letter-spacing:.04em}.source-popup ul{list-style:none;margin:0;padding:0;display:grid;gap:7px}.source-popup li b{display:block;font-size:12px;font-weight:700}.source-popup li span{font-size:11px;color:var(--muted)}.v-charttip{position:fixed;background:var(--ink);color:var(--canvas);padding:6px 10px;border-radius:8px;font-size:11px;font-weight:600;pointer-events:none;z-index:70;white-space:nowrap}.chart-wide{grid-column:1/-1}.chart-switch{grid-column:1/-1;margin-bottom:8px}.switch-bar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}.switch-btn{border:1px solid var(--line);background:transparent;color:var(--muted);font:600 14px/1 inherit;padding:9px 20px;border-radius:99px;cursor:pointer}.switch-btn.active{background:var(--ink);color:var(--canvas);border-color:var(--ink)}.switch-pane[hidden]{display:none}.echarts-container{height:300px;width:100%}.chart-wide .echarts-container{height:360px}`;
}

function inlineScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

function formatValue(value: unknown, format?: ChartSpec["presentation"] extends infer P ? P extends { numberFormat?: infer F } ? F : never : never): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") {
    if (format?.type === "currency") return new Intl.NumberFormat("zh-CN", { style: "currency", currency: format.currency, maximumFractionDigits: 2 }).format(value);
    if (format?.type === "percent") return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: format.decimals ?? 1 }).format(value);
    if (format?.type === "compact") return formatCompact(value);
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: format?.type === "number" ? format.decimals ?? 2 : 2 }).format(value);
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(formatCellValue).filter((item) => item !== "—").join("；") || "—";
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 4)
      .map(([key, item]) => `${key}：${formatCellValue(item)}`)
      .join("；") || "—";
  }
  return String(value);
}

function formatCellValue(value: unknown): string {
  if (typeof value === "string") {
    const date = new Date(value);
    if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) && !Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        ...(value.includes("T") ? { hour: "2-digit", minute: "2-digit" } : {}),
      }).format(date);
    }
  }
  return formatValue(value);
}

function formatCategory(value: unknown): string {
  if (typeof value === "string") {
    const date = new Date(value);
    if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) && !Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        ...(value.includes("T") ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
      }).format(date);
    }
    return value.length > 18 ? `${value.slice(0, 17)}…` : value;
  }
  return formatValue(value);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}
function sortableCategory(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return date;
    return value.codePointAt(0) ?? 0;
  }
  return 0;
}
function datasetPeriod(dataset: AutomationDataset): string | undefined {
  const temporal = dataset.schema.fields.find((field) => field.type === "date" || field.type === "datetime");
  if (!temporal) return undefined;
  const dates = dataset.rows
    .map((row) => new Date(String(row[temporal.name])))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());
  return dates[0]
    ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(dates[0])
    : undefined;
}
function singleEmailId(dataset: AutomationDataset): string | undefined {
  const ids = new Set((dataset.provenance ?? []).flatMap((item) => item.emailIds ?? []));
  return ids.size === 1 ? [...ids][0] : undefined;
}
function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) =>
    current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value);
}
function renderTemplate(template: string, dataset: AutomationDataset): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, path: string) => formatValue(readPath(dataset, path.trim()))).slice(0, 500);
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function sourcePopupList(emails: Array<{ id: string; subject?: string; from?: string; date?: string }>): string {
  return `<h3>来源邮件（${emails.length}）</h3><ul>${emails.map((s) => `<li><b>${escapeHtml(s.subject || s.id)}</b><span>${escapeHtml(s.from || "")}${s.date ? ` · ${escapeHtml(s.date)}` : ""}</span></li>`).join("")}</ul>`;
}

// Render original source tables (no re-aggregation) — each gets auto-enhanced by the
// viewer runtime (filter/sort/copy/export) since it's a real <table> element.
function renderRawTables(tables: Array<{ columns: string[]; rows: Array<Record<string, string>> }>): string {
  const sections = tables.map((t, i) =>
    `<div class="table-wrap"><div class="component-heading"><span>RAW ${i + 1}</span><h2>原始表 ${i + 1}（${t.rows.length} 行）</h2></div>` +
    `<table><thead><tr>${t.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>` +
    `<tbody>${t.rows.slice(0, 200).map((row) => `<tr>${t.columns.map((c) => `<td>${escapeHtml(row[c] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
  ).join("");
  return `<section class="report-section">
    <header class="section-heading">
      <p class="section-index">原始数据明细（${tables.length} 张表）</p>
      <p>忠实还原来源邮件中的原始表格 · 每张表独立筛选/排序/导出 · <button type="button" class="seg-btn export" data-export-all>全部导出 CSV</button></p>
    </header>
    <div class="report-grid grid">${sections}</div>
  </section>`;
}

/**
 * The application-owned trusted viewer runtime — the ONLY script an artifact may run. It is
 * bound to its SHA-256 hash in the artifact CSP and the iframe sandbox uses `allow-scripts`
 * WITHOUT `allow-same-origin`, so this exact script runs and nothing else can. It provides
 * table filter (auto-generated from low-cardinality columns), column sort, copy-value, and
 * CSV export — all renderer-side, costing the model zero tokens. Mono colors only.
 */
export function viewerRuntimeScript(): string {
  return `(function(){
  if(typeof echarts!=='undefined'){
    var chartEls=document.querySelectorAll('.echarts-container');
    function kpi(el){
      var target=Number(el.getAttribute('data-kpi'));if(!isFinite(target))return;
      var num=document.createElement('div');num.className='kpi-num';el.appendChild(num);
      var t0=null,DUR=1400;
      function step(ts){if(t0===null)t0=ts;var p=Math.min(1,(ts-t0)/DUR);var e=1-Math.pow(1-p,3);num.textContent=Math.round(target*e).toLocaleString('zh-CN');if(p<1)requestAnimationFrame(step);}
      requestAnimationFrame(step);
    }
    function mountChart(el){
      var raw=el.getAttribute('data-option');if(!raw)return;
      if(el.__echarts){el.__echarts.resize();return;}
      if(el.clientWidth<80||el.clientHeight<80)return;
      try{var opt=JSON.parse(raw);var inst=echarts.init(el);inst.setOption(opt);el.__echarts=inst;inst.resize();}catch(e){}
      if(el.getAttribute('data-kpi')&&!el.querySelector('.kpi-num'))kpi(el);
    }
    function resizeCharts(){chartEls.forEach(mountChart);}
    resizeCharts();
    if(typeof ResizeObserver!=='undefined'){
      var chartRO=new ResizeObserver(function(entries){entries.forEach(function(entry){mountChart(entry.target);});});
      chartEls.forEach(function(el){chartRO.observe(el);});
    }
    window.addEventListener('resize',resizeCharts);
    requestAnimationFrame(resizeCharts);
    setTimeout(resizeCharts,120);
  }
  var tables=document.querySelectorAll('table');
  var st=document.createElement('style');st.textContent='.v-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0 12px}.v-seg{display:inline-flex;background:#F4F3EF;border:1px solid #DEDDD6;border-radius:8px;padding:3px;gap:2px}.v-btn{border:0;background:transparent;color:#6A6963;font:600 12px/1 inherit;padding:5px 10px;border-radius:6px;cursor:pointer}.v-btn.active{background:#FFFFFF;color:#1C1C1A}.v-exp{background:#1C1C1A;color:#F0EFEB}.v-search{font:inherit;font-size:12px;border:1px solid #DEDDD6;border-radius:8px;padding:6px 9px;background:#FFFFFF;color:#1C1C1A}.v-count{margin-left:auto;color:#8F8E88;font-size:11px}th[data-sort]{cursor:pointer;user-select:none}th[data-sort]:hover{color:#1C1C1A}.echarts-container.kpi{position:relative}.kpi-num{position:absolute;top:12px;left:24px;font:800 34px/1 Inter;letter-spacing:-.02em;color:inherit;z-index:5;pointer-events:none}.v-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1C1C1A;color:#F0EFEB;padding:8px 14px;border-radius:8px;font-size:12px;font-weight:600;opacity:0;transition:opacity .15s;z-index:50}.v-toast.show{opacity:1}';
  document.head.appendChild(st);
  var toast=document.createElement('div');toast.className='v-toast';document.body.appendChild(toast);
  var timer;
  function show(msg){toast.textContent=msg;toast.classList.add('show');clearTimeout(timer);timer=setTimeout(function(){toast.classList.remove('show');},1200);}
  function fb(text){var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');show('已复制');}catch(e){show('复制：'+text);}document.body.removeChild(ta);}
  function copy(text){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){show('已复制');},function(){fb(text);});}else{fb(text);}}
  function card(rows,ci){var s={};for(var i=0;i<rows.length;i++){var v=rows[i].cells[ci]?rows[i].cells[ci].textContent.trim():'';s[v]=(s[v]||0)+1;}return Object.keys(s);}
  tables.forEach(function(table){
    var head=table.querySelector('thead tr'),tbody=table.tBodies[0];if(!head||!tbody)return;
    var headers=Array.prototype.slice.call(head.cells);
    var rows=Array.prototype.slice.call(tbody.rows);
    var state={col:null,dir:1,filter:{},q:''};
    var c=document.createElement('div');c.className='v-controls';
    headers.forEach(function(h,ci){
      var vals=card(rows,ci);
      if(vals.length>1&&vals.length<=6){
        var seg=document.createElement('div');seg.className='v-seg';
        var all=document.createElement('button');all.className='v-btn active';all.textContent='全部 '+h.textContent;all.dataset.v='';seg.appendChild(all);
        vals.forEach(function(v){var b=document.createElement('button');b.className='v-btn';b.textContent=v;b.dataset.v=v;seg.appendChild(b);});
        seg.addEventListener('click',function(e){var b=e.target.closest('.v-btn');if(!b)return;Array.prototype.forEach.call(seg.querySelectorAll('.v-btn'),function(x){x.classList.remove('active');});b.classList.add('active');state.filter[ci]=b.dataset.v;apply();});
        c.appendChild(seg);
      }
      h.dataset.sort='';h.addEventListener('click',function(){if(state.col===ci)state.dir*=-1;else{state.col=ci;state.dir=1;}apply();});
    });
    var search=document.createElement('input');search.className='v-search';search.type='search';search.placeholder='筛选…';
    search.addEventListener('input',function(){state.q=this.value.trim().toLowerCase();apply();});
    c.appendChild(search);
    var exp=document.createElement('button');exp.className='v-btn v-exp';exp.textContent='导出 CSV';exp.addEventListener('click',exportCsv);c.appendChild(exp);
    var count=document.createElement('span');count.className='v-count';c.appendChild(count);
    table.parentNode.insertBefore(c,table);
    table.addEventListener('click',function(e){var td=e.target.closest('td');if(td)copy(td.textContent.trim());});
    function apply(){
      var vis=rows.slice();
      if(state.q)vis=vis.filter(function(r){return r.textContent.toLowerCase().indexOf(state.q)>=0;});
      Object.keys(state.filter).forEach(function(ci){var v=state.filter[ci];if(v)vis=vis.filter(function(r){return r.cells[ci]&&r.cells[ci].textContent.trim()===v;});});
      if(state.col!==null){var ci=state.col;vis.sort(function(a,b){var av=a.cells[ci]?a.cells[ci].textContent.trim():'';var bv=b.cells[ci]?b.cells[ci].textContent.trim():'';var an=parseFloat(av.replace(/,/g,''));var bn=parseFloat(bv.replace(/,/g,''));var c2=!isNaN(an)&&!isNaN(bn)?an-bn:av.localeCompare(bv,'zh-CN');return c2*state.dir;});}
      var __cur=Array.prototype.slice.call(tbody.rows);
      for(var __i=0;__i<__cur.length;__i++){tbody.removeChild(__cur[__i]);}
      vis.forEach(function(r){tbody.appendChild(r);});
      count.textContent=vis.length+' / '+rows.length+' 条';
    }
    function exportCsv(){
      var lines=[headers.map(function(h){return '"'+h.textContent.replace(/"/g,'""')+'"';}).join(',')];
      Array.prototype.forEach.call(tbody.rows,function(r){lines.push(Array.prototype.map.call(r.cells,function(td){var v=td.textContent.trim();return /[",\\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;}).join(','));});
      var csv='\\ufeff'+lines.join('\\n');
      var blob=new Blob([csv],{type:'text/csv;charset=utf-8'});var url=URL.createObjectURL(blob);
      var a=document.createElement('a');a.href=url;a.download='wemail-detail.csv';document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(function(){URL.revokeObjectURL(url);},1000);
      show('已导出 '+tbody.rows.length+' 行');
    }
    apply();
  });
  function closeAllPopups(){document.querySelectorAll('.source-popup').forEach(function(p){p.setAttribute('hidden','')});document.querySelectorAll('[data-src-toggle]').forEach(function(b){b.setAttribute('aria-expanded','false')});}
  document.querySelectorAll('[data-src-toggle]').forEach(function(btn){
    var popup=btn.parentNode.querySelector('.source-popup');
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      var willOpen=popup&&popup.hasAttribute('hidden');
      closeAllPopups();
      if(popup&&willOpen){popup.removeAttribute('hidden');btn.setAttribute('aria-expanded','true');}
    });
  });
  document.addEventListener('click',function(e){if(!e.target.closest('.source-popup')&&!e.target.closest('[data-src-toggle]'))closeAllPopups();});
  document.querySelectorAll('svg.line-chart').forEach(function(svg){
    var dots=Array.prototype.slice.call(svg.querySelectorAll('circle'));
    if(!dots.length)return;
    var tip=document.createElement('div');tip.className='v-charttip';tip.style.display='none';document.body.appendChild(tip);
    svg.addEventListener('mousemove',function(e){
      var best=null,bd=1e9;
      dots.forEach(function(c){var r=c.getBoundingClientRect();var cx=r.left+r.width/2;var cy=r.top+r.height/2;var dx=e.clientX-cx;var dy=e.clientY-cy;var d=Math.sqrt(dx*dx+dy*dy);if(d<bd){bd=d;best=c;}});
      if(!best)return;
      var t=best.querySelector('title');
      tip.textContent=t?t.textContent:'';
      tip.style.display='block';tip.style.left=(e.clientX+14)+'px';tip.style.top=(e.clientY+14)+'px';
    });
    svg.addEventListener('mouseleave',function(){tip.style.display='none';});
  });
  document.querySelectorAll('.chart-switch').forEach(function(card){
    var btns=card.querySelectorAll('[data-switch-view]');
    var panes=card.querySelectorAll('[data-switch-pane]');
    btns.forEach(function(btn){btn.addEventListener('click',function(){
      var v=btn.getAttribute('data-switch-view');
      btns.forEach(function(b){b.classList.remove('active');});btn.classList.add('active');
      panes.forEach(function(p){
        p.hidden=p.getAttribute('data-switch-pane')!==v;
        if(!p.hidden){requestAnimationFrame(function(){p.querySelectorAll('.echarts-container').forEach(function(el){if(el.__echarts)el.__echarts.resize();});});}
      });
    });});
  });
  var __ea=document.querySelector('[data-export-all]');
  if(__ea){__ea.addEventListener('click',function(){
    var __lines=[];
    document.querySelectorAll('table').forEach(function(__t){
      var __ths=Array.prototype.slice.call(__t.querySelectorAll('thead th'));
      if(__ths.length)__lines.push(__ths.map(function(th){return '"'+th.textContent.replace(/"/g,'""')+'"';}).join(','));
      Array.prototype.forEach.call(__t.querySelectorAll('tbody tr'),function(tr){
        __lines.push(Array.prototype.slice.call(tr.querySelectorAll('td')).map(function(td){var v=td.textContent.trim();return /[",\\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;}).join(','));
      });
      __lines.push('');
    });
    var __csv='﻿'+__lines.join('\\n');
    var __blob=new Blob([__csv],{type:'text/csv;charset=utf-8'});var __url=URL.createObjectURL(__blob);
    var __a=document.createElement('a');__a.href=__url;__a.download='wemail-all-tables.csv';document.body.appendChild(__a);__a.click();document.body.removeChild(__a);
    setTimeout(function(){URL.revokeObjectURL(__url);},1000);
    show('已导出全部表');
  });}
})();`;
}
