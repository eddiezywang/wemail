import type { AutomationDataset } from "../../../shared/wemail/automation.js";

type DatasetField = AutomationDataset["schema"]["fields"][number];

export const NORMALIZED_TIME_WINDOW_FIELD = "_time_window";
export const NORMALIZED_VALUE_FIELD = "_value";

interface TimeWindow {
  id: "last_1h" | "calendar_day" | "last_24h";
  label: "最近一小时" | "当天" | "最近一天";
}

interface NormalizedDatasetShape {
  fields: DatasetField[];
  rows: Array<Record<string, unknown>>;
  normalized: boolean;
}

/**
 * Convert a common monitoring wide table such as
 *   类型 | 最近一小时 | 当天
 * into a long analytical shape with explicit time-window and value fields.
 * Raw source tables remain untouched on AutomationDataset.rawTables.
 */
export function normalizeTabularDataset(
  fields: DatasetField[],
  rows: Array<Record<string, unknown>>,
): NormalizedDatasetShape {
  const canonical = canonicalizeLongTimeWindows(fields, rows);
  const annotated = annotateSemanticFields(canonical.fields, canonical.rows);
  const windows = annotated
    .filter((field) => field.type === "number")
    .map((field) => ({ field, window: detectTimeWindow(field.label ?? field.name) }))
    .filter((item): item is { field: DatasetField; window: TimeWindow } => Boolean(item.window));
  if (new Set(windows.map((item) => item.window.id)).size < 2) {
    return { fields: annotated, rows: canonical.rows, normalized: canonical.normalized };
  }

  const windowFields = new Set(windows.map((item) => item.field.name));
  const baseFields = annotated.filter((field) => !windowFields.has(field.name));
  const valueLabel = deriveMeasureLabel(windows.map((item) => item.field.label ?? item.field.name));
  const normalizedRows = canonical.rows.flatMap((row) => windows.flatMap(({ field, window }) => {
    const value = Number(row[field.name]);
    if (!Number.isFinite(value)) return [];
    const normalizedRow: Record<string, unknown> = {};
    for (const base of baseFields) normalizedRow[base.name] = row[base.name];
    normalizedRow[NORMALIZED_TIME_WINDOW_FIELD] = window.label;
    normalizedRow[NORMALIZED_VALUE_FIELD] = value;
    return [normalizedRow];
  }));

  const normalizedFields: DatasetField[] = [
    ...annotateSemanticFields(baseFields, normalizedRows),
    {
      name: NORMALIZED_TIME_WINDOW_FIELD,
      type: "string",
      label: "时间窗口",
      semanticRole: "time_window",
      semanticId: "time_window",
    },
    {
      name: NORMALIZED_VALUE_FIELD,
      type: "number",
      label: valueLabel,
      semanticRole: "measure",
      semanticId: "value",
    },
  ];
  return { fields: normalizedFields, rows: normalizedRows, normalized: true };
}

function canonicalizeLongTimeWindows(
  fields: DatasetField[],
  rows: Array<Record<string, unknown>>,
): NormalizedDatasetShape {
  const detected = fields.flatMap((field) => {
    if (field.type !== "string") return [];
    const populated = rows
      .map((row) => String(row[field.name] ?? "").trim())
      .filter(Boolean);
    if (!populated.length) return [];
    const windows = populated.map(detectTimeWindow);
    if (windows.some((window) => !window) || new Set(windows.map((window) => window?.id)).size < 2) return [];
    return [{ field }];
  });
  if (!detected.length) return { fields, rows, normalized: false };
  const names = new Set(detected.map((item) => item.field.name));
  const normalizedFields = fields.map((field) => names.has(field.name)
    ? {
        ...field,
        semanticRole: "time_window" as const,
        semanticId: "time_window",
      }
    : field);
  const normalizedRows = rows.map((row) => {
    const next = { ...row };
    for (const { field } of detected) {
      const window = detectTimeWindow(String(row[field.name] ?? ""));
      if (window) next[field.name] = window.label;
    }
    return next;
  });
  return { fields: normalizedFields, rows: normalizedRows, normalized: true };
}

function annotateSemanticFields(
  fields: DatasetField[],
  rows: Array<Record<string, unknown>>,
): DatasetField[] {
  return fields.map((field) => {
    if (field.semanticRole) return field;
    const descriptor = `${field.name} ${field.label ?? ""}`;
    if (field.type === "date" || field.type === "datetime") {
      return { ...field, semanticRole: "time" as const, semanticId: "time" };
    }
    if (field.type === "number") {
      return { ...field, semanticRole: "measure" as const, semanticId: field.name };
    }
    if (/单位|unit/i.test(descriptor)) {
      return { ...field, semanticRole: "unit" as const, semanticId: "unit" };
    }
    if (/status|state|result|结果|状态|成败/i.test(descriptor)) {
      return { ...field, semanticRole: "status" as const, semanticId: "status" };
    }
    if (field.type === "string" || field.type === "boolean") {
      const values = rows
        .map((row) => String(row[field.name] ?? "").trim())
        .filter(Boolean);
      const hasRealtime = values.some((value) => /实时/.test(value));
      const hasOffline = values.some((value) => /离线/.test(value));
      return {
        ...field,
        semanticRole: "dimension" as const,
        semanticId: hasRealtime && hasOffline ? "execution_type" : field.name,
      };
    }
    return field;
  });
}

function detectTimeWindow(value: string): TimeWindow | undefined {
  const normalized = value.toLowerCase().replace(/[\s_\-—·（）()]/g, "");
  if (
    /(?:最近|近|过去|前)?(?:1|一)小时/.test(normalized) ||
    /(?:last|past)1h/.test(normalized)
  ) {
    return { id: "last_1h", label: "最近一小时" };
  }
  if (
    /最近(?:1|一)天|近(?:24|二十四)小时|过去(?:24|二十四)小时/.test(normalized) ||
    /(?:last|past)(?:24h|1day)/.test(normalized)
  ) {
    return { id: "last_24h", label: "最近一天" };
  }
  if (/当天|当日|今日|本日|today|calendarday/.test(normalized)) {
    return { id: "calendar_day", label: "当天" };
  }
  return undefined;
}

function deriveMeasureLabel(labels: string[]): string {
  const stripped = labels
    .map((label) => label
      .replace(/最近(?:1|一)小时|近(?:1|一)小时|过去(?:1|一)小时/g, "")
      .replace(/最近(?:1|一)天|近(?:24|二十四)小时|过去(?:24|二十四)小时/g, "")
      .replace(/当天|当日|今日|本日/g, "")
      .replace(/^[\s_\-—·:：]+|[\s_\-—·:：]+$/g, ""))
    .filter(Boolean);
  return stripped.length > 0 && stripped.every((label) => label === stripped[0])
    ? stripped[0]
    : "数值";
}
