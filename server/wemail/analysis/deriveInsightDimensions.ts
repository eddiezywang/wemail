import type { AutomationDataset } from "../../../shared/wemail/automation.js";

type DatasetField = AutomationDataset["schema"]["fields"][number];
type DerivedTransform = "weekday" | "time-band" | "month";

interface DerivedDimensionRecord {
  field: string;
  sourceField: string;
  transform: DerivedTransform;
  timezone: string;
}

/**
 * Adds low-cost, auditable calendar dimensions to a run-scoped dataset.
 * The mutation is intentional: compiler and renderer share this object, so a
 * selected derived field is available when the chart is rendered.
 */
export function deriveInsightDimensions(
  dataset: AutomationDataset,
  options: { timezone?: string } = {},
): AutomationDataset {
  if (!dataset.rows.length) return dataset;
  const timezone = validTimezone(options.timezone)
    ?? validTimezone(asString(dataset.summary?.analysisTimezone))
    ?? validTimezone(asString(dataset.summary?.timezone))
    ?? "UTC";
  const sourceFields = dataset.schema.fields.filter(isTemporalSource);
  const knownNames = new Set(dataset.schema.fields.map((field) => field.name));
  const seenValueSignatures = new Set<string>();
  const records = existingRecords(dataset.summary?.derivedDimensions);

  for (const [sourceIndex, source] of sourceFields.entries()) {
    const calendarValues = dataset.rows.map((row) => calendarValue(row[source.name], timezone));
    addDerived("weekday", source, sourceIndex, calendarValues.map((value) => value?.weekday), "星期");
    addDerived("time-band", source, sourceIndex, calendarValues.map((value) => value?.timeBand), "时段");
    addDerived("month", source, sourceIndex, calendarValues.map((value) => value?.month), "月份");
  }

  dataset.summary = {
    ...(dataset.summary ?? {}),
    analysisTimezone: timezone,
    ...(records.length ? { derivedDimensions: records } : {}),
  };
  return dataset;

  function addDerived(
    transform: DerivedTransform,
    source: DatasetField,
    sourceIndex: number,
    values: Array<string | undefined>,
    suffix: string,
  ): void {
    const usable = values.filter((value): value is string => Boolean(value));
    const distinct = new Set(usable);
    const maxCardinality = transform === "month" ? 60 : 12;
    if (usable.length < 2 || distinct.size < 2 || distinct.size > maxCardinality) return;
    const signature = `${transform}:${values.map((value) => value ?? "").join("\u001f")}`;
    if (seenValueSignatures.has(signature)) return;
    seenValueSignatures.add(signature);

    const fieldName = derivedFieldName(source.name, sourceIndex, transform);
    if (!knownNames.has(fieldName)) {
      dataset.schema.fields.push({
        name: fieldName,
        type: "string",
        label: `${source.label?.trim() || source.name}·${suffix}`,
        semanticRole: transform === "time-band" ? "time_window" : "dimension",
        semanticId: `derived:${transform}:${source.name}`,
      });
      dataset.rows.forEach((row, index) => {
        if (values[index] !== undefined) row[fieldName] = values[index];
      });
      knownNames.add(fieldName);
    }
    if (!records.some((record) => record.field === fieldName)) {
      records.push({ field: fieldName, sourceField: source.name, transform, timezone });
    }
  }
}

function isTemporalSource(field: DatasetField): boolean {
  if (field.semanticId?.startsWith("derived:")) return false;
  if (field.semanticRole === "time" || field.type === "date" || field.type === "datetime") return true;
  return field.type === "string" && /(^|[_\s-])(date|time|datetime|timestamp)([_\s-]|$)|日期|时间/i.test(`${field.name} ${field.label ?? ""}`);
}

function calendarValue(value: unknown, timezone: string): {
  weekday: string;
  month: string;
  timeBand?: string;
} | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = String(value).trim();
  const dateOnly = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (Number.isNaN(date.getTime())) return undefined;
    return {
      weekday: weekdayLabel(date.getUTCDay()),
      month: `${year}-${month.padStart(2, "0")}`,
    };
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find((item) => item.type === type)?.value;
    const hour = Number(part("hour"));
    const month = part("month");
    const year = part("year");
    const weekday = part("weekday");
    if (!month || !year || !weekday) return undefined;
    return {
      weekday,
      month: `${year}-${month}`,
      ...(Number.isFinite(hour) ? { timeBand: timeBand(hour) } : {}),
    };
  } catch {
    return undefined;
  }
}

function weekdayLabel(day: number): string {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][day] ?? "";
}

function timeBand(hour: number): string {
  if (hour < 6) return "凌晨 00–05";
  if (hour < 12) return "上午 06–11";
  if (hour < 18) return "下午 12–17";
  return "晚间 18–23";
}

function derivedFieldName(source: string, sourceIndex: number, transform: DerivedTransform): string {
  const safe = source.replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "") || `time_${sourceIndex + 1}`;
  return `__derived_${safe}_${transform.replace("-", "_")}`;
}

function validTimezone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function existingRecords(value: unknown): DerivedDimensionRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Partial<DerivedDimensionRecord>;
    if (!record.field || !record.sourceField || !record.transform || !record.timezone) return [];
    return [{
      field: record.field,
      sourceField: record.sourceField,
      transform: record.transform,
      timezone: record.timezone,
    }];
  });
}
