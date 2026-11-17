import type { AutomationDataset } from "../../../shared/wemail/automation.js";

export type InsightTimeGrain = "hour" | "day";

export interface InsightAggregationSummary {
  stage: "aggregated";
  timeGrain: InsightTimeGrain;
  timeField: string;
  groupBy: string[];
  measures: Array<{ field: string; agg: string }>;
  requestedEmailCount: number;
  parsedEmailCount: number;
  skippedEmailCount: number;
  sourceEmailCount: number;
  rowCount: number;
  timePointCount: number;
  scopePreset?: "24h" | "7d";
}

export function sourceEmailIds(dataset: AutomationDataset): string[] {
  return [...new Set([
    ...(dataset.sourceEmails ?? []).map((source) => source.id),
    ...(dataset.provenance ?? []).flatMap((item) => item.emailIds ?? []),
  ].filter(Boolean))];
}

export function aggregationSummary(dataset: AutomationDataset): InsightAggregationSummary | undefined {
  const value = dataset.summary?.aggregation;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as InsightAggregationSummary;
}

export function timePointCount(dataset: AutomationDataset, timeField?: string): number {
  const field = timeField ?? dataset.schema.fields.find((item) => item.semanticRole === "time")?.name;
  if (!field) return 0;
  return new Set(dataset.rows
    .map((row) => row[field])
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map(String)).size;
}

/**
 * Rolling insight reports must arrive here as a complete, aggregated dataset.
 * This is deliberately independent of the model prompt: the renderer and the
 * publish boundary enforce the same contract even when the model skips a step.
 */
export function assertAggregatedInsightDataset(dataset: AutomationDataset): InsightAggregationSummary {
  const aggregation = aggregationSummary(dataset);
  if (!aggregation || aggregation.stage !== "aggregated") {
    throw new Error("insight-data-contract-missing-aggregation");
  }
  const ids = sourceEmailIds(dataset);
  const metadataIds = new Set((dataset.sourceEmails ?? []).map((source) => source.id).filter(Boolean));
  const processorIds = new Set((dataset.provenance ?? [])
    .filter((item) => item.sourceType === "processor" && item.operation === "aggregate-email-datasets")
    .flatMap((item) => item.emailIds ?? [])
    .filter(Boolean));
  if (!ids.length || metadataIds.size !== ids.length || processorIds.size !== ids.length || [...processorIds].some((id) => !metadataIds.has(id))) {
    throw new Error("insight-data-contract-source-metadata-mismatch");
  }
  if (aggregation.requestedEmailCount !== ids.length || aggregation.sourceEmailCount !== ids.length) {
    throw new Error("insight-data-contract-source-count-mismatch");
  }
  if (aggregation.parsedEmailCount !== ids.length || aggregation.skippedEmailCount !== 0) {
    throw new Error("insight-data-contract-source-incomplete");
  }
  if (aggregation.rowCount !== dataset.rows.length) {
    throw new Error("insight-data-contract-row-count-mismatch");
  }
  if (aggregation.timeGrain !== "hour" && aggregation.timeGrain !== "day") {
    throw new Error("insight-data-contract-time-grain-missing");
  }
  const timeField = dataset.schema.fields.find((field) => field.name === aggregation.timeField);
  if (!timeField || (timeField.semanticRole !== "time" && timeField.type !== "date" && timeField.type !== "datetime")) {
    throw new Error("insight-data-contract-time-field-missing");
  }
  const actualTimePoints = timePointCount(dataset, aggregation.timeField);
  if (aggregation.timePointCount !== actualTimePoints) {
    throw new Error("insight-data-contract-time-point-count-mismatch");
  }
  if (!Array.isArray(aggregation.groupBy) || !Array.isArray(aggregation.measures)) {
    throw new Error("insight-data-contract-aggregation-plan-missing");
  }
  const fields = new Map(dataset.schema.fields.map((field) => [field.name, field]));
  if (aggregation.groupBy.some((field) => !fields.has(field))) {
    throw new Error("insight-data-contract-group-field-missing");
  }
  if (aggregation.measures.some((measure) => fields.get(measure.field)?.type !== "number")) {
    throw new Error("insight-data-contract-measure-field-missing");
  }
  return aggregation;
}
