import type { AutomationDataset } from "./automation.js";

export type DesignArtifactKind = "brief" | "report" | "dashboard" | "deck";
export type DesignTemplateId =
  | "email-visual-summary"
  | "quick-chart"
  | "timeline-view"
  | "executive-insight"
  | "trend-analysis"
  | "comparison-breakdown"
  | "operational-health";

export interface DesignRequest {
  dataset: AutomationDataset;
  mode: "auto" | DesignArtifactKind;
  objective?: string;
  audience?: string;
  title?: string;
  locale?: "zh-CN" | "en";
  designSystem?: string;
  instructions?: string;
  templateId?: DesignTemplateId;
  purpose?: "auto" | "visualize" | "analyze";
  /** Source scope: single email (visualize) vs multiple same-type emails (analyze). */
  scope?: "single" | "multi";
  /** Optional thin chart specs from the model; when absent the compiler infers from data shape. */
  charts?: ThinChartSpec[];
  /** Required semantic bindings for a user-directed analysis. */
  analysisPlan?: DesignAnalysisPlan;
  /** Auto-run Layer-1 inference only when charts and analysisPlan are absent. */
  autoPivot?: boolean;
  constraints?: {
    maxSections?: number;
    maxCharts?: number;
    allowAnimations?: boolean;
    preferredDensity?: "compact" | "balanced" | "spacious";
  };
}

export type InsightLens =
  | "overview"
  | "trend"
  | "comparison"
  | "composition"
  | "distribution"
  | "relationship"
  | "matrix"
  | "hierarchy"
  | "change"
  | "anomaly"
  | "quality";

/**
 * A data relationship worth answering. This deliberately contains no visual
 * vocabulary: the chart selector translates an intent into a chart family.
 */
export type InsightRelation =
  | "kpi"
  | "trend"
  | "rank"
  | "share"
  | "time-composition"
  | "distribution"
  | "grouped-distribution"
  | "correlation"
  | "matrix"
  | "hierarchy"
  | "before-after"
  | "signed-contribution";

export interface InsightViewIntent {
  lens: InsightLens;
  relation: InsightRelation;
  score: number;
  dimensions: string[];
  measures: string[];
  title: string;
  aggregation?: "sum" | "count" | "average" | "min" | "max";
  measureSemantic?: "count" | "currency" | "ratio" | "duration" | "average" | "value";
  top?: number;
  span?: "full" | "half";
}

export interface InsightAnalysisResult {
  schemaVersion: 1;
  /** Host-side deterministic analysis does not consume model tokens. */
  generatedBy: "deterministic-host";
  dimensions: Array<{
    field: string;
    kind: "temporal" | "time-window" | "categorical" | "status";
    cardinality: number;
  }>;
  measures: Array<{
    field: string;
    semantic: "count" | "currency" | "ratio" | "duration" | "average" | "value";
    aggregation: "sum" | "average";
    nonMissing: number;
    distinct: number;
    min?: number;
    max?: number;
    median?: number;
    p95?: number;
  }>;
  /** Analysis questions discovered from the data before any chart is chosen. */
  intents: InsightViewIntent[];
  /** Executable chart bindings chosen deterministically from the intents. */
  views: Array<{
    lens: InsightLens;
    relation: InsightRelation;
    score: number;
    /** Human-readable deterministic rule that selected this chart family. */
    reason: string;
    chart: ThinChartSpec;
  }>;
  findings: Array<{
    lens: InsightLens;
    title: string;
    text: string;
    tone: "neutral" | "positive" | "warning";
    score: number;
    fields: string[];
  }>;
  coverage: Array<{
    lens: InsightLens;
    status: "covered" | "not-applicable";
    reason: string;
    chartFamilies: ChartFamily[];
  }>;
}

export interface DesignAnalysisPlanDimension {
  /** Real normalized dataset field. */
  field: string;
  /** Values explicitly requested by the user; publishing fails when any are absent. */
  requiredValues?: Array<string | number | boolean>;
  /** True when values are overlapping windows and therefore must not be stacked or summed. */
  overlapping?: boolean;
}

export interface DesignAnalysisPlanMeasure {
  /** Real numeric dataset field. */
  field: string;
  agg?: "sum" | "count" | "average" | "min" | "max";
}

/**
 * A compact, executable contract for explicit user requirements. Unlike objective text,
 * every dimension, required value, and measure is checked before the artifact is published.
 */
export interface DesignAnalysisPlan {
  dimensions: DesignAnalysisPlanDimension[];
  measures: DesignAnalysisPlanMeasure[];
}

export interface DesignFieldBinding {
  path: string;
  fallback?: string | number;
}

export interface ChartSpec {
  id: string;
  type: "line" | "area" | "bar" | "stacked-bar" | "donut" | "waffle" | "scatter" | "heatmap" | "dumbbell" | "treemap" | "diverging-bar" | "counter" | "histogram" | "boxplot";
  title?: string;
  source?: string;
  span?: "full" | "half";
  switchGroup?: string;
  /** User-facing label for this view inside a switch group, e.g. 类型 or 模型. */
  switchLabel?: string;
  description?: string;
  data: {
    category?: string;
    value?: string;
    measures?: Array<{ field: string; label: string }>;
    series?: string;
    aggregate?: "sum" | "count" | "average" | "min" | "max";
    sort?: "ascending" | "descending" | "source";
    limit?: number;
    /** Equality filter applied before aggregation (carried from the thin spec's `where`). */
    where?: Record<string, string | number | boolean>;
  };
  presentation?: {
    orientation?: "horizontal" | "vertical";
    showLegend?: boolean;
    showValues?: boolean;
    showGrid?: boolean;
    colorRole?: string;
    numberFormat?:
      | { type: "number"; decimals?: number }
      | { type: "currency"; currency: "CNY" | "USD" | "EUR" }
      | { type: "percent"; decimals?: number }
      | { type: "compact" };
  };
  emptyState?: string;
}

/**
 * The chart family the model may request. The compiler expands a {@link ThinChartSpec}
 * into a full visual {@link ChartSpec}; the model never writes visual config.
 */
/**
 * The chart family the model may request. The compiler expands a {@link ThinChartSpec}
 * into a full visual {@link ChartSpec}; the model never writes visual config.
 * "donut" is deprecated — the compiler maps it to waffle (its honest replacement);
 * it stays in the union only so legacy specs keep compiling.
 */
export type ChartFamily = "bar" | "line" | "area" | "waffle" | "donut" | "scatter" | "heatmap" | "dumbbell" | "stacked-bar" | "treemap" | "diverging-bar" | "counter" | "histogram" | "boxplot" | "table";

/**
 * The thin data-logic spec the model emits — only "what to plot", never "how it looks".
 * The compiler binds x/y/splitBy to real dataset fields, picks the family (from the spec
 * or inferred from data shape), and assigns all visuals from the mono design system.
 *
 * For treemap, `x` is the parent (top-level) dimension, `splitBy` the leaf (child)
 * dimension, and `y` a non-negative numeric measure: area encodes value, parents are
 * the sum of their children.
 */
export interface ThinChartSpec {
  family: ChartFamily;
  /** Dimension field (category or temporal axis). */
  x: string;
  /** Measure field (numeric value). */
  y: string;
  /** Second measure (before/after "to"), used by dumbbell. */
  y2?: string;
  /** Optional series-grouping field (e.g. channel). */
  splitBy?: string;
  agg?: "sum" | "count" | "average" | "min" | "max";
  /** Equality filter applied before aggregation, e.g. { unit: "次" } to keep one unit. */
  where?: Record<string, string | number | boolean>;
  /** Limit to the top-N categories by magnitude (avoids axis collapse on wide ranges). */
  top?: number;
  /** Which dataset this chart reads, when a report carries more than one. */
  dataset?: string;
  /** Optional conclusion-style title; if omitted the compiler infers one from the binding. */
  title?: string;
  /** Layout width: "full" (complex/dense chart, e.g. multi-series trend) or "half". */
  span?: "full" | "half";
  /** Charts sharing a switchGroup render into one card with a viewer toggle (e.g. total vs per-type). */
  switchGroup?: string;
  /** User-facing label for this alternate view. */
  switchLabel?: string;
}

export interface DesignTableMeasureSpec {
  field: string;
  label: string;
  aggregate?: "sum" | "count" | "average" | "min" | "max";
}

export interface DesignTableSpec {
  type: "table";
  title?: string;
  columns: Array<{ field: string; label: string }>;
  limit?: number;
  /** When supplied, the renderer produces a grouped summary table instead of raw rows. */
  groupBy?: string[];
  measures?: DesignTableMeasureSpec[];
  where?: Record<string, string | number | boolean>;
  /** Tables and charts can share a switch group so a dimension changes both together. */
  switchGroup?: string;
  switchLabel?: string;
}

export type DesignComponentSpec =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "paragraph"; text: string }
  | { type: "metric"; label: string; valuePath?: string; value?: string | number; format?: NonNullable<ChartSpec["presentation"]>["numberFormat"]; note?: string }
  | { type: "chart"; chart: ChartSpec }
  | DesignTableSpec
  | { type: "callout"; title?: string; text: string; tone?: "info" | "success" | "warning" | "error" }
  | { type: "insight-list"; items: Array<{ title: string; text: string; tone?: "neutral" | "positive" | "warning" }> }
  | { type: "timeline"; items: Array<{ label: string; title: string; text?: string }> }
  | { type: "mail-references"; title?: string; emailIdField?: string };

export interface DesignRecipe {
  schemaVersion: 1;
  id: string;
  version: number;
  kind: DesignArtifactKind;
  templateId: DesignTemplateId;
  purpose: "visualize" | "analyze";
  title: string;
  subtitle?: string;
  objective?: string;
  audience?: string;
  designSystem: string;
  /** Source scope this recipe was compiled for. */
  scope: "single" | "multi";
  /** Non-fabricated data-source provenance, rendered into the brand header and per-chart source lines. */
  provenance: {
    sourceLabel: string;
    emailIds?: string[];
    sourceCount: number;
    /** True when provenance could not be resolved — renderer shows a safe state, never a fake label. */
    unavailable?: boolean;
  };
  narrative: {
    structure: "conclusion-first" | "chronological" | "overview-to-detail" | "problem-evidence-action" | "status-exception-next-step";
    primaryQuestion?: string;
    emptyState: { title: string; description: string; tone: "neutral" | "success" | "warning" };
  };
  /** Auditable host-side analysis result used to select findings and visual views. */
  analysis?: InsightAnalysisResult;
  sections: Array<{
    id: string;
    title?: string;
    description?: string;
    layout: "single" | "two-column" | "three-column" | "grid" | "full-bleed";
    components: DesignComponentSpec[];
  }>;
  notification: {
    title: string;
    previewTemplate: string;
    keyMetrics?: Array<{
      label: string;
      valuePath?: string;
      value?: string | number;
      format?: NonNullable<ChartSpec["presentation"]>["numberFormat"];
    }>;
  };
  runtimeCapabilities: Array<"charts" | "collapse" | "filter" | "table-sort" | "deck-navigation" | "copy-value">;
}

export interface MessageArtifactManifest {
  schemaVersion: 1;
  id: string;
  version: number;
  kind: DesignArtifactKind;
  title: string;
  preview: string;
  recipeId: string;
  recipeVersion: number;
  designSystem: string;
  entry: "index.html";
  resources: Array<{
    name: string;
    contentType: string;
    size: number;
    sha256: string;
  }>;
  runtimeCapabilities: DesignRecipe["runtimeCapabilities"];
  sourceRuleId?: string;
  sourceRuleVersion?: number;
  sourceRunId?: string;
  createdAt: string;
  contentHash: string;
}

export interface InsightReportFormatPreferences {
  layout?: "dashboard" | "story";
  chartPreference?: "auto" | "donut" | "bar";
  density?: "compact" | "balanced" | "spacious";
  theme?: "editorial" | "light" | "dark";
}

export interface InsightReportSummary {
  id: string;
  accountId: string;
  currentVersion: number;
  scope: "single" | "multi";
  title: string;
  applicationMessageId: string;
  sourceEmailIds: string[];
  preferences: InsightReportFormatPreferences;
  createdAt: string;
  updatedAt: string;
}

export interface InsightReportVersionSummary {
  reportId: string;
  version: number;
  applicationMessageId: string;
  preferences: InsightReportFormatPreferences;
  createdAt: string;
}

export interface MessageArtifactSummary {
  artifactId: string;
  version: number;
  kind: DesignArtifactKind;
  title: string;
  preview: string;
  contentHash: string;
}
