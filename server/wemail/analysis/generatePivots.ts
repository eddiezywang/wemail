import type { AutomationDataset } from "../../../shared/wemail/automation.js";
import type { ThinChartSpec } from "../../../shared/wemail/designArtifacts.js";
import { inferDimensions, type InferredDimensions } from "./inferDimensions.js";
import { insightFieldLabel, planInsightViews } from "./planInsightViews.js";

/**
 * Derive a dynamic report title from the dataset's content — NOT hardcoded.
 * Uses measure labels + all important dimensions + time range.
 */
export function deriveReportTitle(dataset: AutomationDataset, dims?: InferredDimensions): { title: string; objective: string } {
  const d = dims ?? inferDimensions(dataset);
  const measureLabel = d.measures[0]
    ? datasetFieldLabel(dataset, d.measures[0])
    : "数据";
  const dimensionLabels = [...d.categorical, ...(d.status ? [d.status] : [])]
    .slice(0, 3)
    .map((field) => label(dataset, field));
  const dimensionsLabel = dimensionLabels.join(" / ") || undefined;
  const timeField = d.temporal[0];
  let dateRange = "";
  if (timeField) {
    const dates = [...new Set(dataset.rows.map((r) => String(r[timeField] ?? "").slice(0, 10)))].filter(Boolean).sort();
    if (dates.length >= 2) {
      dateRange = ` · ${dates[0].slice(5)}→${dates[dates.length - 1].slice(5)}`;
    } else if (dates.length === 1) {
      dateRange = ` · ${dates[0].slice(5)}`;
    }
  }
  const title = dimensionsLabel
    ? `${dimensionsLabel} × ${measureLabel}洞察报告${dateRange}`
    : `${measureLabel}洞察报告${dateRange}`;
  const objective = dimensionsLabel
    ? `按${dimensionsLabel}等维度切换分析${measureLabel}的变化趋势与差异`
    : `分析${measureLabel}的变化趋势与异常`;
  return { title, objective };
}

/**
 * Generate a bounded set of views for every meaningful categorical dimension.
 * Multiple dimensions join one switch group, allowing 类型 / 模型 / 状态 to share
 * the same visual region. Overlapping time windows are separate heatmap series and
 * are never summed or stacked.
 */
export function generatePivots(dataset: AutomationDataset, dims?: InferredDimensions): ThinChartSpec[] {
  // Keep the public function for existing callers, but delegate the actual work to the
  // host-side analysis planner. `dims` remains accepted for API compatibility; the
  // planner intentionally re-profiles the complete dataset so new measures and lenses
  // are never hidden by a stale, partial inference result.
  void dims;
  return planInsightViews(dataset).views.map((view) => view.chart);
}

function label(dataset: AutomationDataset, name: string): string {
  return datasetFieldLabel(dataset, name);
}

export function datasetFieldLabel(dataset: AutomationDataset, name: string): string {
  return insightFieldLabel(dataset, name);
}
