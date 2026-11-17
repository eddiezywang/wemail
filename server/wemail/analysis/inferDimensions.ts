import type { AutomationDataset } from "../../../shared/wemail/automation.js";

/**
 * Layer 1 (data-analysis skill): infer the analytical dimensions of a dataset.
 * A monitoring dataset has at least TIME + TYPE; optionally STATUS + MEASURES.
 * Inference is schema + value based: date/hour → time; low-cardinality string → type;
 * status-named field → status; number → measure.
 */
export interface InferredDimensions {
  temporal: string[];
  timeWindows: string[];
  categorical: string[];
  status: string | null;
  measures: string[];
}

export function distinctCount(dataset: AutomationDataset, field: string): number {
  const seen = new Set<string>();
  for (const row of dataset.rows) {
    const v = row[field];
    if (v !== undefined && v !== null && v !== "") seen.add(String(v));
  }
  return seen.size;
}

export function inferDimensions(dataset: AutomationDataset): InferredDimensions {
  const temporal: string[] = [];
  const timeWindows: string[] = [];
  const categorical: string[] = [];
  let status: string | null = null;
  const measures: string[] = [];
  for (const f of dataset.schema.fields) {
    const descriptor = `${f.name} ${f.label ?? ""}`;
    if (f.semanticRole === "time_window" || /time.?window|时间窗口|统计范围/i.test(descriptor)) {
      timeWindows.push(f.name);
      continue;
    }
    if (
      f.semanticRole === "time" ||
      f.type === "date" ||
      f.type === "datetime" ||
      (f.type === "string" && /hour|time|date|时段|时间|日期/i.test(descriptor))
    ) {
      temporal.push(f.name);
      continue;
    }
    if (f.semanticRole === "measure" || f.type === "number") {
      measures.push(f.name);
      continue;
    }
    if (f.type === "string") {
      if (!status && (f.semanticRole === "status" || /status|state|deal_status|success|fail|result|结果|状态|成败/i.test(descriptor))) {
        status = f.name;
        continue;
      }
      const card = distinctCount(dataset, f.name);
      // Keep medium-cardinality dimensions for top-N and long-tail analysis, while
      // excluding near-unique identifiers that would only produce label noise.
      if (card >= 2 && card <= 60 && (f.semanticRole === "dimension" || card < dataset.rows.length * 0.9)) {
        categorical.push(f.name);
      }
    }
  }
  categorical.sort((a, b) => categoricalPriority(dataset, a) - categoricalPriority(dataset, b));
  return { temporal, timeWindows, categorical, status, measures };
}

function categoricalPriority(dataset: AutomationDataset, name: string): number {
  const field = dataset.schema.fields.find((item) => item.name === name);
  if (field?.semanticId === "execution_type") return 0;
  if (/type|model|channel|类型|模型|渠道/i.test(`${name} ${field?.label ?? ""}`)) return 1;
  return 2;
}
