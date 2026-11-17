import type { TemporalExpression } from "../../../shared/wemail/automation.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import {
  AutomationFieldRegistry,
  type TemporalResolution,
} from "./AutomationFieldRegistry.js";

export async function evaluateTemporalExpression(
  expression: TemporalExpression,
  context: { message: MailMessage; timezone: string },
  registry: AutomationFieldRegistry,
): Promise<TemporalResolution> {
  if (expression.type === "field") {
    return registry.resolve(expression.path, {
      message: context.message,
      scope: expression.scope,
    });
  }

  if (expression.type === "aggregate") {
    const resolution = await evaluateTemporalExpression(expression.values, context, registry);
    if (resolution.status !== "ready") return resolution;
    if (resolution.values.length === 0) {
      return { status: "unavailable", reasons: ["empty-temporal-values"] };
    }
    const values = [...resolution.values].sort();
    return {
      status: "ready",
      valueType: resolution.valueType,
      values: [expression.operator === "min" ? values[0]! : values.at(-1)!],
    };
  }

  if (expression.type === "coalesce") {
    for (const value of expression.values) {
      const resolution = await evaluateTemporalExpression(value, context, registry);
      if (resolution.status === "ready" || resolution.status === "pending") return resolution;
    }
    return { status: "unavailable", reasons: ["all-temporal-values-unavailable"] };
  }

  const base = await evaluateTemporalExpression(expression.base, context, registry);
  if (base.status !== "ready") return base;
  if (base.values.length !== 1) {
    return { status: "unavailable", reasons: ["expected-one-temporal-value"] };
  }
  const durationMs = expression.duration.amount * durationMilliseconds(expression.duration.unit);
  if (!Number.isFinite(durationMs)) throw new Error("invalid-temporal-duration");

  const date = parseTemporalValue(
    base.values[0]!,
    base.valueType,
    context.timezone,
  );
  return {
    status: "ready",
    valueType: "datetime",
    values: [new Date(date.getTime() + durationMs).toISOString()],
  };
}

function durationMilliseconds(unit: "minute" | "hour" | "day"): number {
  if (unit === "minute") return 60_000;
  if (unit === "hour") return 3_600_000;
  return 86_400_000;
}

export function canonicalizeTemporalValue(
  value: string,
  valueType: "date" | "datetime",
  timezone: string,
): string {
  return parseTemporalValue(value, valueType, timezone).toISOString();
}

function parseTemporalValue(
  value: string,
  valueType: "date" | "datetime",
  timezone: string,
): Date {
  return valueType === "date"
    ? zonedStartOfDay(value, timezone)
    : parseDateTime(value);
}

function parseDateTime(value: string): Date {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/
      .exec(value);
  if (!match) throw new Error("invalid-temporal-date");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const zone = match[8]!;
  const offsetSign = match[9];
  const offsetHour = Number(match[10] ?? "0");
  const offsetMinute = Number(match[11] ?? "0");
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    throw new Error("invalid-temporal-date");
  }

  const millisecond = Number(fraction.padEnd(3, "0").slice(0, 3));
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  const offset =
    zone === "Z"
      ? 0
      : (offsetSign === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  const date = new Date(local.getTime() - offset * 60_000);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid-temporal-date");
  return date;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function zonedStartOfDay(value: string, timezone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("invalid-temporal-date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year
    || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day
  ) {
    throw new Error("invalid-temporal-date");
  }

  let candidate = calendarDate;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedDateParts(candidate, timezone);
    const desiredUtc = Date.UTC(year, month - 1, day);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const delta = desiredUtc - actualUtc;
    if (delta === 0) break;
    candidate = new Date(candidate.getTime() + delta);
  }

  const actual = zonedDateParts(candidate, timezone);
  if (
    actual.year !== year
    || actual.month !== month
    || actual.day !== day
    || actual.hour !== 0
    || actual.minute !== 0
  ) {
    throw new Error("invalid-temporal-date");
  }
  return candidate;
}

function zonedDateParts(date: Date, timezone: string) {
  try {
    const values = new Map(
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(date).map((part) => [part.type, part.value]),
    );
    return {
      year: Number(values.get("year")),
      month: Number(values.get("month")),
      day: Number(values.get("day")),
      hour: Number(values.get("hour")),
      minute: Number(values.get("minute")),
    };
  } catch {
    throw new Error("invalid-temporal-date");
  }
}
