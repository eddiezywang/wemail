import type { AutomationSchedule, AutomationTrigger } from "../../../shared/wemail/automation.js";

export function normalizedSchedule(
  trigger: Extract<AutomationTrigger, { type: "scheduled" }>,
): AutomationSchedule {
  return trigger.schedule ?? {
    type: "interval",
    intervalMinutes: trigger.intervalMinutes ?? 60,
  };
}

export function nextScheduledOccurrence(
  trigger: Extract<AutomationTrigger, { type: "scheduled" }>,
  afterIso: string,
): string {
  const schedule = normalizedSchedule(trigger);
  const after = new Date(afterIso);
  if (!Number.isFinite(after.getTime())) throw new Error("invalid-schedule-anchor");
  if (schedule.type === "interval") {
    return new Date(after.getTime() + schedule.intervalMinutes * 60_000).toISOString();
  }
  const [hour, minute] = schedule.localTime.split(":").map(Number);
  const local = zonedParts(after, schedule.timezone);
  let dayOffset = local.hour > hour || (local.hour === hour && local.minute >= minute) ? 1 : 0;
  for (let retry = 0; retry < 3; retry += 1) {
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + dayOffset));
    const desired = {
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
      day: date.getUTCDate(), hour, minute,
    };
    let candidate = new Date(Date.UTC(desired.year, desired.month - 1, desired.day, hour, minute));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const actual = zonedParts(candidate, schedule.timezone);
      const delta = Date.UTC(desired.year, desired.month - 1, desired.day, hour, minute)
        - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
      if (delta === 0) return candidate.toISOString();
      candidate = new Date(candidate.getTime() + delta);
    }
    dayOffset += 1;
  }
  throw new Error("unresolvable-daily-schedule");
}

export function previousScheduledOccurrence(
  trigger: Extract<AutomationTrigger, { type: "scheduled" }>,
  beforeIso: string,
): string {
  const schedule = normalizedSchedule(trigger);
  const before = Date.parse(beforeIso);
  if (!Number.isFinite(before)) throw new Error("invalid-schedule-anchor");
  if (schedule.type === "interval") return new Date(before - schedule.intervalMinutes * 60_000).toISOString();
  let cursor = new Date(before - 48 * 3_600_000).toISOString();
  let previous = cursor;
  for (let i = 0; i < 4; i += 1) {
    const next = nextScheduledOccurrence(trigger, cursor);
    if (Date.parse(next) >= before) return previous;
    previous = next;
    cursor = next;
  }
  return previous;
}

function zonedParts(date: Date, timezone: string) {
  const values = new Map(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")), month: Number(values.get("month")),
    day: Number(values.get("day")), hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
  };
}
