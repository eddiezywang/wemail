/**
 * Maps a ChartSpec + dataset → an ECharts option object for client-side rendering.
 * Replaces the SVG renderers for bar/line/stacked-bar/scatter/heatmap/treemap.
 * Waffle + dumbbell stay SVG (no native ECharts equivalent in Phase 1).
 *
 * Color: every generator takes an optional ColorSystem (the delivery-level "single
 * system" resolved from the recipe). Semantic status colors always outrank the system.
 * When a non-mono system is active, INK_BOOST applies: strokes get ×1.8 weight and
 * translucent marks never drop below 0.85 opacity (colored thin marks vanish on paper).
 */
import type { ChartSpec } from "../../../shared/wemail/designArtifacts.js";
import type { AutomationDataset } from "../../../shared/wemail/automation.js";
import { MONO, DATA_COLORS, seriesPalette, hexMix } from "./monoTokens.js";
import type { ColorAssigner, ColorSystem } from "./monoTokens.js";
import { COLOR_SYSTEMS, INK_BOOST } from "./monoTokens.js";

type EchartsOption = Record<string, unknown>;

const AXIS = {
  axisLine: { lineStyle: { color: MONO.MUTED, width: 1.5 } },
  axisTick: { show: false },
  axisLabel: { color: MONO.MUTED, fontSize: 11, fontWeight: 600 },
};
const SPLIT_LINE = { show: true, lineStyle: { color: MONO.GRID } };
const GRID = { left: 50, right: 24, top: 30, bottom: 56, containLabel: true };

function tooltipOf(system: ColorSystem): EchartsOption {
  // Ink-on-paper tooltip (light card); dark card inverts — see monoTokens tipLight/tipDark.
  return {
    backgroundColor: system.ink,
    borderWidth: 0,
    padding: [10, 14],
    textStyle: { color: system.bg, fontFamily: "Inter", fontSize: 12 },
  };
}

function axisOf(system: ColorSystem, base = AXIS): EchartsOption {
  return {
    ...base,
    axisLine: { lineStyle: { color: system.muted, width: 1.5 } },
    axisLabel: { color: system.muted, fontSize: 11, fontWeight: 600 },
  };
}

function splitLineOf(system: ColorSystem): EchartsOption {
  return { show: true, lineStyle: { color: system.grid } };
}

/** Line weight under a color system: colored strokes get the ink-boost scale. */
function strokeWidth(system: ColorSystem, base: number): number {
  return system.id === "mono" ? base : base * INK_BOOST.strokeScale;
}

function aggregate(vals: number[], method?: string): number {
  if (method === "count") return vals.length;
  if (method === "average") return vals.reduce((s, v) => s + v, 0) / vals.length;
  if (method === "min") return Math.min(...vals);
  if (method === "max") return Math.max(...vals);
  return vals.reduce((s, v) => s + v, 0);
}

function compactFmt(v: number): string {
  return Math.abs(v) >= 10000
    ? new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(v)
    : new Intl.NumberFormat("zh-CN").format(v);
}

/** Extract single-series data: category → aggregated value. */
function extractSingle(chart: ChartSpec, dataset: AutomationDataset) {
  const cat = chart.data.category;
  const val = chart.data.value;
  const where = chart.data.where;
  if (!val) return null;
  const groups = new Map<string, { rawLabel: unknown; values: number[]; idx: number }>();
  dataset.rows.forEach((row, idx) => {
    if (where && !Object.entries(where).every(([k, v]) => row[k] === v)) return;
    const rawLabel = cat ? row[cat] : idx + 1;
    const label = fmtCat(rawLabel);
    const v = Number(row[val]);
    if (!Number.isFinite(v)) return;
    const g = groups.get(label) ?? { rawLabel, values: [], idx };
    g.values.push(v);
    groups.set(label, g);
  });
  let result = [...groups.entries()].map(([label, g]) => ({
    label,
    rawLabel: g.rawLabel,
    value: aggregate(g.values, chart.data.aggregate),
    idx: g.idx,
  }));
  if (chart.data.sort === "ascending") {
    result.sort((a, b) => String(a.rawLabel).localeCompare(String(b.rawLabel)) || a.value - b.value);
  } else if (chart.data.sort === "descending") {
    result.sort((a, b) => b.value - a.value);
  } else {
    result.sort((a, b) => a.idx - b.idx);
  }
  const limit = chart.data.limit ?? 20;
  return result.slice(0, limit);
}

/** Extract multi-series data: category × series → aggregated value per cell. */
function extractMulti(chart: ChartSpec, dataset: AutomationDataset) {
  const cat = chart.data.category;
  const ser = chart.data.series;
  const val = chart.data.value;
  const where = chart.data.where;
  if (!cat || !ser || !val) return null;
  const cats: string[] = [];
  const series: string[] = [];
  const cell = new Map<string, number[]>();
  for (const row of dataset.rows) {
    if (where && !Object.entries(where).every(([k, v]) => row[k] === v)) continue;
    const v = Number(row[val]);
    if (!Number.isFinite(v)) continue;
    const c = fmtCat(row[cat]);
    const s = String(row[ser]);
    if (!cats.includes(c)) cats.push(c);
    if (!series.includes(s)) series.push(s);
    const k = `${c}|${s}`;
    const arr = cell.get(k) ?? [];
    arr.push(v);
    cell.set(k, arr);
  }
  cats.sort((a, b) => a.localeCompare(b, "zh-CN"));
  series.sort((a, b) => a.localeCompare(b, "zh-CN"));
  return {
    cats,
    series,
    valueFor: (c: string, s: string) => {
      const arr = cell.get(`${c}|${s}`);
      return arr ? aggregate(arr, chart.data.aggregate) : 0;
    },
  };
}

function fmtCat(v: unknown): string {
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      // 空格分隔的 datetime（如 "2026-07-01 01:40"）也必须保留时分，否则小时点会塌缩成天
      const isDatetime = /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(v);
      return new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        ...(isDatetime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
      }).format(d);
    }
    return v.length > 18 ? `${v.slice(0, 17)}…` : v;
  }
  return String(v ?? "—");
}

// ── Family generators ──────────────────────────────────────────

function barOption(chart: ChartSpec, dataset: AutomationDataset, assigner: ColorAssigner | undefined, system: ColorSystem): EchartsOption | null {
  const data = extractSingle(chart, dataset);
  if (!data?.length) return null;
  // Each bar gets a color by entity name (shared assigner) or by system palette (fallback).
  const colors = data.map((d, i) => assigner ? assigner.assign(d.label) : system.cat[i % system.cat.length]);
  // Wire: the largest bar is the single focal point → hero color.
  if (system.id === "wire" && data.length > 1) {
    const maxIdx = data.reduce((best, d, i) => d.value > data[best].value ? i : best, 0);
    colors[maxIdx] = system.hero;
  }
  const horizontal = chart.presentation?.orientation === "horizontal" ||
    data.length > 7 ||
    data.some((item) => item.label.length > 9);
  if (horizontal) {
    return {
      grid: { left: 112, right: 52, top: 22, bottom: 34, containLabel: true },
      tooltip: { ...tooltipOf(system), trigger: "axis", axisPointer: { type: "shadow" } },
      xAxis: { type: "value", splitLine: splitLineOf(system), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: system.muted, fontSize: 11 } },
      yAxis: { type: "category", inverse: true, data: data.map((item) => item.label), ...axisOf(system) },
      series: [{
        type: "bar",
        data: data.map((item, index) => ({ value: item.value, itemStyle: { color: colors[index], borderRadius: [0, 4, 4, 0] } })),
        barMaxWidth: 28,
        label: { show: true, position: "right", color: system.ink, fontSize: 11, fontWeight: 800, formatter: (params: { value: number }) => compactFmt(params.value) },
      }],
    };
  }
  return {
    grid: GRID,
    tooltip: { ...tooltipOf(system), trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: { type: "category", data: data.map((d) => d.label), ...axisOf(system) },
    yAxis: { type: "value", splitLine: splitLineOf(system), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false } },
    series: [{
      type: "bar",
      data: data.map((d, i) => ({ value: d.value, itemStyle: { color: colors[i], borderRadius: [4, 4, 0, 0] } })),
      barMaxWidth: 48,
      label: { show: true, position: "top", color: system.ink, fontSize: 11, fontWeight: 800, formatter: (p: { value: number }) => compactFmt(p.value) },
    }],
  };
}

function lineOption(chart: ChartSpec, dataset: AutomationDataset, assigner: ColorAssigner | undefined, system: ColorSystem): EchartsOption | null {
  const ser = chart.data.series;
  if (ser) return multiLineOption(chart, dataset, assigner, system);
  const data = extractSingle(chart, dataset);
  if (!data?.length) return null;
  return {
    grid: GRID,
    tooltip: { ...tooltipOf(system), trigger: "axis", axisPointer: { type: "cross" } },
    color: [system.data],
    legend: { show: false },
    dataZoom: data.length > 12 ? [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }] : [],
    xAxis: { type: "category", boundaryGap: false, data: data.map((d) => d.label), ...axisOf(system) },
    yAxis: { type: "value", scale: true, splitLine: splitLineOf(system), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: system.muted, fontSize: 11 } },
    series: [{
      type: "line",
      data: data.map((d) => d.value),
      smooth: true,
      symbol: "circle",
      symbolSize: 6,
      lineStyle: { width: strokeWidth(system, 1.8) },
      areaStyle: chart.type === "area" ? { opacity: system.id === "mono" ? 0.08 : 0.16 } : undefined,
    }],
  };
}

function multiLineOption(chart: ChartSpec, dataset: AutomationDataset, assigner: ColorAssigner | undefined, system: ColorSystem): EchartsOption | null {
  const multi = extractMulti(chart, dataset);
  if (!multi) return null;
  const { cats, series: serNames, valueFor } = multi;
  const palette = assigner ? assigner.paletteFor(serNames) : seriesPalette(serNames.length);
  return {
    grid: GRID,
    tooltip: { ...tooltipOf(system), trigger: "axis", axisPointer: { type: "cross" } },
    color: palette,
    legend: { data: serNames, icon: "circle", textStyle: { color: system.muted, fontSize: 11, fontWeight: 600 }, top: 0 },
    dataZoom: cats.length > 12 ? [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }] : [],
    xAxis: { type: "category", boundaryGap: false, data: cats, ...axisOf(system) },
    yAxis: { type: "value", scale: true, splitLine: splitLineOf(system), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: system.muted, fontSize: 11 } },
    series: serNames.map((s) => ({
      name: s,
      type: "line",
      data: cats.map((c) => valueFor(c, s)),
      smooth: true,
      symbol: "circle",
      symbolSize: 5,
      lineStyle: { width: strokeWidth(system, 1.8) },
    })),
  };
}

function stackedBarOption(chart: ChartSpec, dataset: AutomationDataset, assigner: ColorAssigner | undefined, system: ColorSystem): EchartsOption | null {
  const multi = extractMulti(chart, dataset);
  if (!multi) return null;
  const { cats, series: serNames, valueFor } = multi;
  // Semantic status colors take priority; otherwise the active system palette.
  // Red for failure is a UNIVERSAL data-viz rule and stays even under a preset.
  const palette = assigner ? assigner.paletteFor(serNames) : seriesPalette(serNames.length);
  const colors = serNames.map((s) => DATA_COLORS.statusColorFor(s) ?? palette[serNames.indexOf(s) % palette.length]);
  return {
    grid: GRID,
    tooltip: { ...tooltipOf(system), trigger: "axis", axisPointer: { type: "shadow" } },
    color: colors,
    legend: { data: serNames, icon: "circle", textStyle: { color: system.muted, fontSize: 11 } },
    xAxis: { type: "category", data: cats, ...axisOf(system) },
    yAxis: { type: "value", splitLine: splitLineOf(system), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: system.muted, fontSize: 11 } },
    series: serNames.map((s) => ({
      name: s,
      type: "bar",
      stack: "total",
      data: cats.map((c) => valueFor(c, s)),
      barMaxWidth: 48,
      itemStyle: { borderRadius: [0, 0, 0, 0] },
      emphasis: { focus: "series" },
    })),
  };
}

function scatterOption(chart: ChartSpec, dataset: AutomationDataset, assigner: ColorAssigner | undefined, system: ColorSystem): EchartsOption | null {
  const cat = chart.data.category;
  const val = chart.data.value;
  const where = chart.data.where;
  if (!val) return null;
  const rows = dataset.rows.filter((r) => !where || Object.entries(where).every(([k, v]) => r[k] === v));
  const xField = cat ? dataset.schema.fields.find((field) => field.name === cat) : undefined;
  if (cat && xField?.type === "number") {
    const split = chart.data.series;
    const groups = new Map<string, Array<[number, number, string]>>();
    for (const row of rows) {
      const x = Number(row[cat]);
      const y = Number(row[val]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const name = split ? String(row[split] ?? "其他") : "全部";
      const points = groups.get(name) ?? [];
      points.push([x, y, name]);
      groups.set(name, points);
    }
    if (![...groups.values()].some((points) => points.length)) return null;
    const names = [...groups.keys()];
    const palette = assigner ? assigner.paletteFor(names) : seriesPalette(names.length);
    return {
      grid: { left: 58, right: 30, top: split ? 48 : 24, bottom: 54, containLabel: true },
      tooltip: {
        ...tooltipOf(system),
        trigger: "item",
        formatter: (params: { data: [number, number, string] }) => {
          const [x, y, name] = params.data;
          return `${split ? `${name}<br/>` : ""}${xField.label ?? cat}：<b>${compactFmt(x)}</b><br/>${dataset.schema.fields.find((field) => field.name === val)?.label ?? val}：<b>${compactFmt(y)}</b>`;
        },
      },
      legend: { show: Boolean(split), data: names, icon: "circle", textStyle: { color: system.muted, fontSize: 11 } },
      xAxis: {
        type: "value",
        name: xField.label ?? cat,
        nameLocation: "middle",
        nameGap: 34,
        scale: true,
        splitLine: splitLineOf(system),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: system.muted, fontSize: 11 },
      },
      yAxis: {
        type: "value",
        name: dataset.schema.fields.find((field) => field.name === val)?.label ?? val,
        scale: true,
        splitLine: splitLineOf(system),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: system.muted, fontSize: 11 },
      },
      series: names.map((name, index) => ({
        name,
        type: "scatter",
        data: groups.get(name),
        symbolSize: 9,
        itemStyle: { color: palette[index], opacity: system.id === "mono" ? 0.62 : INK_BOOST.opacityFloor },
        emphasis: { focus: "series", scale: 1.5 },
      })),
    };
  }
  const cats = [...new Set(rows.map((r) => (cat ? fmtCat(r[cat]) : "值")))];
  const vals = rows.map((r) => Number(r[val])).filter(Number.isFinite);
  if (!vals.length) return null;
  const max = Math.max(...vals), min = Math.min(...vals);
  const palette = seriesPalette(cats.length);
  return {
    grid: GRID,
    tooltip: { ...tooltipOf(system), trigger: "item" },
    color: palette,
    xAxis: { type: "category", data: cats, ...axisOf(system) },
    yAxis: { type: "value", scale: true, splitLine: splitLineOf(system), axisLine: { show: false }, axisLabel: { color: system.muted, fontSize: 11 } },
    series: [{
      type: "scatter",
      symbolSize: 6,
      data: rows.map((r) => {
        const c = cat ? fmtCat(r[cat]) : "值";
        const v = Number(r[val]);
        return [c, Number.isFinite(v) ? v : min];
      }).filter((d: unknown[]) => d[1] !== undefined),
      itemStyle: { opacity: system.id === "mono" ? 0.6 : INK_BOOST.opacityFloor, color: system.id === "mono" ? MONO.L[0] : system.data },
    }],
  };
}

function histogramOption(chart: ChartSpec, dataset: AutomationDataset, system: ColorSystem): EchartsOption | null {
  const field = chart.data.value;
  if (!field) return null;
  const where = chart.data.where;
  const values = dataset.rows
    .filter((row) => !where || Object.entries(where).every(([key, value]) => row[key] === value))
    .map((row) => Number(row[field]))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (values.length < 3) return null;
  const min = values[0];
  const max = values.at(-1)!;
  const binCount = min === max ? 1 : Math.max(5, Math.min(16, Math.ceil(Math.log2(values.length) + 1)));
  const width = min === max ? 1 : (max - min) / binCount;
  const counts = Array.from({ length: binCount }, () => 0);
  for (const value of values) {
    const index = min === max ? 0 : Math.min(binCount - 1, Math.floor((value - min) / width));
    counts[index] += 1;
  }
  const labels = counts.map((_, index) => {
    const start = min + index * width;
    const end = index === counts.length - 1 ? max : start + width;
    return min === max ? compactFmt(min) : `${compactFmt(start)}–${compactFmt(end)}`;
  });
  return {
    grid: { left: 44, right: 22, top: 24, bottom: 66, containLabel: true },
    tooltip: {
      ...tooltipOf(system),
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: Array<{ axisValue: string; value: number }>) => `${params[0]?.axisValue ?? ""}<br/><b>${params[0]?.value ?? 0}</b> 个观测`,
    },
    xAxis: {
      type: "category",
      data: labels,
      axisLine: { lineStyle: { color: system.muted } },
      axisTick: { show: false },
      axisLabel: { color: system.muted, fontSize: 10, interval: Math.max(0, Math.ceil(labels.length / 8) - 1), rotate: labels.length > 8 ? 24 : 0 },
    },
    yAxis: { type: "value", minInterval: 1, splitLine: splitLineOf(system), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: system.muted, fontSize: 11 } },
    series: [{
      type: "bar",
      data: counts,
      barCategoryGap: "4%",
      itemStyle: { color: system.data, borderRadius: [3, 3, 0, 0], opacity: system.id === "mono" ? 0.82 : 0.9 },
      emphasis: { itemStyle: { color: system.hero } },
    }],
  };
}

function boxplotOption(chart: ChartSpec, dataset: AutomationDataset, system: ColorSystem): EchartsOption | null {
  const category = chart.data.category;
  const field = chart.data.value;
  if (!field) return null;
  const where = chart.data.where;
  const groups = new Map<string, number[]>();
  for (const row of dataset.rows) {
    if (where && !Object.entries(where).every(([key, value]) => row[key] === value)) continue;
    const value = Number(row[field]);
    if (!Number.isFinite(value)) continue;
    const name = category ? fmtCat(row[category]) : "全部";
    const values = groups.get(name) ?? [];
    values.push(value);
    groups.set(name, values);
  }
  const prepared = [...groups.entries()]
    .filter(([, values]) => values.length >= 3)
    .slice(0, 12)
    .map(([name, raw]) => {
      const values = [...raw].sort((left, right) => left - right);
      const q1 = percentile(values, 0.25);
      const median = percentile(values, 0.5);
      const q3 = percentile(values, 0.75);
      const iqr = q3 - q1;
      const lowerFence = q1 - iqr * 1.5;
      const upperFence = q3 + iqr * 1.5;
      const lower = values.find((value) => value >= lowerFence) ?? values[0];
      const upper = [...values].reverse().find((value) => value <= upperFence) ?? values.at(-1)!;
      return { name, data: [lower, q1, median, q3, upper], outliers: values.filter((value) => value < lower || value > upper) };
    });
  if (!prepared.length) return null;
  const outliers = prepared.flatMap((group, index) => group.outliers.map((value) => [index, value]));
  return {
    grid: { left: 52, right: 24, top: 24, bottom: 58, containLabel: true },
    tooltip: { ...tooltipOf(system), trigger: "item" },
    xAxis: { type: "category", data: prepared.map((group) => group.name), ...axisOf(system), boundaryGap: true },
    yAxis: { type: "value", scale: true, splitLine: splitLineOf(system), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: system.muted, fontSize: 11 } },
    series: [
      {
        name: dataset.schema.fields.find((candidate) => candidate.name === field)?.label ?? field,
        type: "boxplot",
        data: prepared.map((group) => group.data),
        itemStyle: { color: hexMix(system.data, system.bg, 0.72), borderColor: system.ink, borderWidth: strokeWidth(system, 1.2) },
        emphasis: { itemStyle: { borderColor: system.hero, borderWidth: 2 } },
      },
      ...(outliers.length ? [{ type: "scatter", data: outliers, symbolSize: 6, itemStyle: { color: system.hero, opacity: 0.72 } }] : []),
    ],
  };
}

function percentile(sorted: number[], p: number): number {
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function heatmapOption(chart: ChartSpec, dataset: AutomationDataset, system: ColorSystem): EchartsOption | null {
  const multi = extractMulti(chart, dataset);
  if (!multi) return null;
  const { cats, series: serNames, valueFor } = multi;
  const allVals = cats.flatMap((c) => serNames.map((s) => valueFor(c, s)));
  const max = Math.max(...allVals, 1);
  const data: Array<[number, number, number]> = [];
  serNames.forEach((s, si) => cats.forEach((c, ci) => data.push([ci, si, valueFor(c, s)])));
  // Ordinal ramp: lightness = value. Mono keeps its paper→ink ladder; presets use their own ramp.
  const ramp = system.id === "mono" ? [MONO.PAPER, ...MONO.L.slice().reverse()] : [...system.ramp].reverse();
  return {
    grid: { left: 100, right: 24, top: 30, bottom: 50 },
    tooltip: { ...tooltipOf(system), trigger: "item" },
    xAxis: { type: "category", data: cats, ...axisOf(system), splitArea: { show: false } },
    yAxis: { type: "category", data: serNames, ...axisOf(system), splitArea: { show: false } },
    visualMap: {
      min: 0, max,
      calculable: false, show: false,
      inRange: { color: ramp },
    },
    series: [{ type: "heatmap", data, label: { show: false } }],
  };
}

/**
 * Treemap (lieflat F13 Nested Treemap, ported): two-level hierarchy — category is the
 * parent, series the leaf, measure the non-negative weight. Area = value; a parent's
 * value is the sum of its children. Color never re-encodes the value silently:
 * - mono   → gray ladder by parent rank; children shade lighter (hierarchy, not value)
 * - palm   → hue per top-level category (≤4); children shade lighter
 * - porcelain → single-hue ramp by parent share rank
 * - wire   → gray, one HERO for the top parent only
 * nodeClick:false keeps the static delivery stable; tooltip shows full path + share.
 */
function treemapOption(chart: ChartSpec, dataset: AutomationDataset, system: ColorSystem): EchartsOption | null {
  const cat = chart.data.category;
  const ser = chart.data.series;
  const val = chart.data.value;
  const where = chart.data.where;
  if (!cat || !ser || !val) return null;
  const children = new Map<string, Map<string, number>>();
  let grand = 0;
  for (const row of dataset.rows) {
    if (where && !Object.entries(where).every(([k, v]) => row[k] === v)) continue;
    const v = Number(row[val]);
    if (!Number.isFinite(v) || v < 0) continue;
    const p = String(row[cat] ?? "—");
    const c = String(row[ser] ?? "—");
    const m = children.get(p) ?? new Map<string, number>();
    m.set(c, (m.get(c) ?? 0) + v);
    children.set(p, m);
    grand += v;
  }
  if (!grand || !children.size) return null;
  const parents = [...children.entries()]
    .map(([name, kids]) => ({ name, value: [...kids.values()].reduce((s, v) => s + v, 0), kids }))
    .sort((a, b) => b.value - a.value);
  const top = Math.min(parents.length, 4);
  const colorForParent = (index: number, name: string): string => {
    if (system.id === "palm") return system.cat[index % system.cat.length];
    if (system.id === "porcelain") {
      const rank = index < 4 ? index : 4; // top-4 parents own the ramp; rest flatten
      return system.ramp[Math.min(4, 1 + rank)];
    }
    if (system.id === "wire") return index === 0 ? system.hero : system.data2;
    return MONO.L[Math.min(index, MONO.L.length - 1)];
  };
  const leafColor = (parent: string): string => hexMix(parent, system.bg, 0.45);
  const data = parents.map((parent, index) => {
    const parentColor = colorForParent(index, parent.name);
    return {
      name: parent.name,
      value: parent.value,
      itemStyle: { color: parentColor, borderColor: system.bg, borderWidth: 2, gapWidth: 1 },
      label: {
        show: true,
        fontSize: 11,
        fontWeight: 700,
        color: system.id === "porcelain" ? "#FFFFFF" : system.bg,
        formatter: () => truncate(parent.name, 10),
      },
      emphasis: { itemStyle: { borderColor: system.hero, borderWidth: 2 } },
      children: [...parent.kids.entries()]
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
        .map((leaf) => ({
          name: leaf.name,
          value: leaf.value,
          itemStyle: { color: leafColor(parentColor), borderColor: system.bg, borderWidth: 1 },
          label: {
            show: true,
            fontSize: 10,
            fontWeight: 600,
            color: system.ink,
            formatter: () => truncate(leaf.name, 9),
          },
        })),
    };
  });
  return {
    tooltip: {
      ...tooltipOf(system),
      trigger: "item",
      formatter: (info: { name: string; value: number; treePathInfo: Array<{ name: string }> }) => {
        const path = (info.treePathInfo ?? []).map((p) => p.name).filter(Boolean).join(" / ");
        const share = grand > 0 ? ((info.value / grand) * 100).toFixed(1) : "0";
        return `${path}<br/><b>${compactFmt(info.value)}</b> · 占总量 ${share}%`;
      },
    },
    series: [{
      type: "treemap",
      data,
      width: "100%",
      height: "100%",
      roam: false,
      nodeClick: false,          // static delivery: no drill-down surprises
      leafDepth: 2,              // exactly two levels: parent + leaf
      breadcrumb: { show: false },
      visibleMin: 1.2,           // tiny rects keep their heat area but skip label overflow
      upperLabel: { show: false },
      labelLayout: { hideOverlap: true },
      levels: [
        { itemStyle: { borderColor: system.bg, borderWidth: 3, gapWidth: 3 } },
        { itemStyle: { borderColor: system.bg, borderWidth: 1, gapWidth: 1 } },
      ],
    }],
  };
}

function truncate(name: string, max: number): string {
  return name.length > max ? `${name.slice(0, max)}…` : name;
}

/**
 * Diverging bar (lieflat G10, ported): signed values around a zero axis.
 * Positive → system ink/hero, negative → faintData; labels carry the sign.
 * Refuses data without any negative value (a plain bar then — rework to bar).
 */
function divergingBarOption(chart: ChartSpec, dataset: AutomationDataset, system: ColorSystem): EchartsOption | null {
  const data = extractSingle(chart, dataset);
  if (!data?.length) return null;
  if (!data.some((d) => d.value < 0)) return null; // not signed — a bar is the honest family
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const pos = system.id === "mono" ? MONO.L[0] : system.hero;
  const neg = system.id === "mono" ? MONO.L[3] : system.faintData;
  return {
    animationDuration: 900,
    animationEasing: "quarticOut",
    animationDelay: (i: number) => i * 80,
    tooltip: {
      ...tooltipOf(system),
      trigger: "item",
      formatter: (p: { name: string; value: number }) =>
        `${p.name} — ${p.value > 0 ? "+" : ""}${compactFmt(p.value)}`,
    },
    grid: { left: 96, right: 52, top: 8, bottom: 8 },
    xAxis: {
      type: "value",
      splitLine: { lineStyle: { color: system.grid } },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
    },
    yAxis: {
      type: "category",
      data: sorted.map((d) => d.label),
      inverse: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: system.muted, fontFamily: "Inter", fontSize: 9.5, fontWeight: 600 },
    },
    series: [{
      type: "bar",
      barWidth: 16,
      data: sorted.map((d) => ({
        name: d.label,
        value: d.value,
        itemStyle: {
          color: d.value > 0 ? pos : neg,
          borderRadius: d.value > 0 ? [0, 9, 9, 0] : [9, 0, 0, 9],
        },
      })),
      label: {
        show: true,
        fontFamily: "Inter",
        fontSize: 11,
        fontWeight: 700,
        position: "outside",
        formatter: (p: { value: number }) => (p.value > 0 ? "+" : "") + compactFmt(p.value),
        color: system.ink,
      },
      markLine: {
        symbol: "none",
        silent: true,
        label: { show: false },
        lineStyle: { color: system.muted, width: 1.5 },
        data: [{ xAxis: 0 }],
      },
    }],
  };
}

/**
 * Draw-in counter (lieflat G18, ported): a big KPI number that counts up plus a
 * sparkline of the series. The raw total rides on __kpi (ECharts ignores unknown
 * top-level keys); the viewer runtime reads it to animate the DOM number overlay.
 */
function counterOption(chart: ChartSpec, dataset: AutomationDataset, system: ColorSystem): EchartsOption | null {
  const data = extractSingle(chart, dataset);
  if (!data?.length) return null;
  const total = data.reduce((s, d) => s + d.value, 0);
  const label = dataset.schema.fields.find((f) => f.name === chart.data.value)?.label ?? chart.data.value ?? "";
  return {
    animationDuration: 1400,
    animationEasing: "cubicOut",
    tooltip: { show: false },
    grid: { left: 14, right: 14, top: 78, bottom: 8 },
    xAxis: {
      type: "category",
      data: data.map((d) => d.label),
      boundaryGap: false,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
    },
    yAxis: { show: false, max: (v: { max: number }) => v.max * 1.08 },
    graphic: [
      { id: "kpiLabel", type: "text", left: 6, top: 48, style: { text: label, font: "600 11px Inter", fill: system.muted } },
    ],
    series: [{
      type: "line",
      data: data.map((d) => d.value),
      smooth: 0.2,
      symbol: "none",
      lineStyle: { color: system.data, width: strokeWidth(system, 2.4) },
      areaStyle: {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: system.id === "mono" ? "rgba(28,28,26,.14)" : system.faintData },
            { offset: 1, color: system.id === "mono" ? "rgba(28,28,26,0)" : `${system.faintData}00` },
          ],
        },
      },
    }],
    __kpi: total,
  };
}

/** Main entry: returns ECharts option or null (fall back to SVG for unsupported families). */
export function buildEchartsOption(
  chart: ChartSpec,
  dataset: AutomationDataset,
  assigner?: ColorAssigner,
  system: ColorSystem = COLOR_SYSTEMS.mono,
): EchartsOption | null {
  switch (chart.type) {
    case "bar": return barOption(chart, dataset, assigner, system);
    case "line":
    case "area": return lineOption(chart, dataset, assigner, system);
    case "stacked-bar": return stackedBarOption(chart, dataset, assigner, system);
    case "scatter": return scatterOption(chart, dataset, assigner, system);
    case "heatmap": return heatmapOption(chart, dataset, system);
    case "treemap": return treemapOption(chart, dataset, system);
    case "diverging-bar": return divergingBarOption(chart, dataset, system);
    case "counter": return counterOption(chart, dataset, system);
    case "histogram": return histogramOption(chart, dataset, system);
    case "boxplot": return boxplotOption(chart, dataset, system);
    default: return null;
  }
}

export function supportsEcharts(chartType: string): boolean {
  return ["bar", "line", "area", "stacked-bar", "scatter", "heatmap", "treemap", "diverging-bar", "counter", "histogram", "boxplot"].includes(chartType);
}
