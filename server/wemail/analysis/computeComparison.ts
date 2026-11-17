import type { AutomationDataset } from "../../../shared/wemail/automation.js";

/**
 * Layer 1 (data-analysis skill): period-over-period (环比) and year-over-year (同比).
 * 环比 = latest period vs previous period (absolute + percent). 同比 = vs same period
 * last year; reported as "insufficient history" unless a year-ago period is present.
 */
export interface PeriodDelta {
  current: number;
  previous: number;
  delta: number;
  pct: number;
}
export interface ComparisonResult {
  periodOverPeriod?: PeriodDelta;
  yearOverYear?: PeriodDelta | { insufficient: true };
}

export function computeComparison(dataset: AutomationDataset, timeField: string, measure: string): ComparisonResult {
  const byPeriod = new Map<string, number>();
  for (const row of dataset.rows) {
    const t = row[timeField];
    const v = Number(row[measure]);
    if (t === undefined || t === null || t === "" || !Number.isFinite(v)) continue;
    const key = String(t);
    byPeriod.set(key, (byPeriod.get(key) ?? 0) + v);
  }
  const periods = [...byPeriod.keys()].sort();
  const result: ComparisonResult = {};
  if (periods.length >= 2) {
    const current = byPeriod.get(periods[periods.length - 1]) ?? 0;
    const previous = byPeriod.get(periods[periods.length - 2]) ?? 0;
    result.periodOverPeriod = { current, previous, delta: current - previous, pct: previous === 0 ? 0 : (current - previous) / Math.abs(previous) };
  }
  // 同比: look for a period ~1 year before the latest; otherwise honest "insufficient".
  if (periods.length) {
    const latest = periods[periods.length - 1];
    const yearAgo = shiftYear(latest);
    if (yearAgo && byPeriod.has(yearAgo)) {
      const current = byPeriod.get(latest) ?? 0;
      const previous = byPeriod.get(yearAgo) ?? 0;
      result.yearOverYear = { current, previous, delta: current - previous, pct: previous === 0 ? 0 : (current - previous) / Math.abs(previous) };
    } else {
      result.yearOverYear = { insufficient: true };
    }
  }
  return result;
}

function shiftYear(iso: string): string | undefined {
  const m = /^(\d{4})-(\d{2}-\d{2})/.exec(iso);
  if (!m) return undefined;
  return `${Number(m[1]) - 1}-${m[2]}`;
}
