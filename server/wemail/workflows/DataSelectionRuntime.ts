import type {
  AutomationConditionRule,
  AutomationConditions,
} from "../../../shared/wemail/automation.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import type { DataSelectionSpec } from "../../../shared/wemail/skillCenter.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import { matchesConditionRules } from "../automation/AutomationRuleMatcher.js";

const FIELD_ALIASES = {
  sender: "sender",
  from: "sender",
  recipient: "recipient",
  to: "recipient",
  cc: "cc",
  subject: "subject",
  body: "body",
  snippet: "body",
  hasAttachment: "hasAttachment",
  hasAttachments: "hasAttachment",
} as const;

const OPERATOR_ALIASES = {
  contains: "contains",
  notContains: "notContains",
  not_contains: "notContains",
  equals: "equals",
  notEquals: "notEquals",
  not_equals: "notEquals",
  exists: "exists",
  notExists: "notExists",
  not_exists: "notExists",
} as const;

export function compileDataSelectionFilters(spec: DataSelectionSpec): {
  conditions: AutomationConditions;
  conditionRules: AutomationConditionRule[];
  conditionMode?: "all";
} {
  const conditionRules = spec.filters.map((filter, index) => {
    const field = FIELD_ALIASES[filter.field as keyof typeof FIELD_ALIASES];
    const operator = OPERATOR_ALIASES[
      filter.operator as keyof typeof OPERATOR_ALIASES
    ];
    if (!field || !operator) {
      throw new Error(`data-selection-filter-unsupported:${filter.field}:${filter.operator}`);
    }
    const value =
      typeof filter.value === "string" || typeof filter.value === "boolean"
        ? filter.value
        : undefined;
    if (operator !== "exists" && operator !== "notExists" && value === undefined) {
      throw new Error(`data-selection-filter-value-required:${filter.field}`);
    }
    return {
      id: `data-selection-${index + 1}`,
      field,
      operator,
      ...(value !== undefined ? { value } : {}),
    };
  });
  return {
    conditions: {},
    conditionRules,
    ...(conditionRules.length > 0 ? { conditionMode: "all" as const } : {}),
  };
}

export function materializeDataSelection(input: {
  spec: DataSelectionSpec;
  accountId: string;
  mail: CanonicalMailRepository;
  now?: () => string;
}): Record<string, unknown> {
  const now = input.now?.() ?? new Date().toISOString();
  const compiled = compileDataSelectionFilters(input.spec);
  const scope = input.spec.scope;
  let messages: MailMessage[];
  let window: { from?: string; to: string; timezone?: string } = { to: now };

  if (scope.type === "current_mail") {
    const message = input.mail.getMessageById(scope.emailId, input.accountId);
    messages = message ? [message] : [];
  } else if (scope.type === "current_thread") {
    messages = input.mail.getMessagesByThreadId(scope.threadId, input.accountId);
  } else {
    const bounds = selectionBounds(input.spec, now);
    const upperBound = bounds.to;
    const lowerBound = bounds.from;
    window = {
      ...(lowerBound ? { from: lowerBound } : {}),
      to: upperBound,
      ...(scope.type === "calendar_day" ? { timezone: scope.timezone } : {}),
    };
    const scanLimit = Math.min(5_000, Math.max(input.spec.limits.maxMessages * 5, 100));
    messages = input.mail
      .listMessages({
        accountId: input.accountId,
        receivedBefore: new Date(Date.parse(upperBound) + 1).toISOString(),
        limit: scanLimit,
      })
      .filter((message) => !lowerBound || message.receivedAt >= lowerBound);
  }

  const currentEmailId = input.spec.relation?.currentEmailId ??
    (scope.type === "current_mail" ? scope.emailId : undefined);
  const current = currentEmailId
    ? input.mail.getMessageById(currentEmailId, input.accountId)
    : undefined;
  const selected = messages
    .filter((message) => input.spec.source !== "attachment" || message.hasAttachments)
    .filter((message) =>
      matchesConditionRules(
        compiled.conditionMode ?? "all",
        compiled.conditionRules,
        message,
      ),
    )
    .filter((message) => !input.spec.relation?.sameSender || !current ||
      message.from.email.toLowerCase() === current.from.email.toLowerCase())
    .filter((message) => !input.spec.relation?.sameThread || !current ||
      (message.threadId ?? message.id) === (current.threadId ?? current.id))
    .filter((message) => !input.spec.relation?.sameSystem || !current ||
      senderDomain(message) === senderDomain(current))
    .slice(0, input.spec.limits.maxMessages);

  return {
    type: "mail-collection",
    messages: selected.map((message) => ({
      type: "mail-reference",
      accountId: message.accountId,
      emailId: message.id,
      subject: message.subject,
    })),
    window,
  };
}

function selectionBounds(
  spec: DataSelectionSpec,
  upperBound: string,
): { from?: string; to: string } {
  const scope = spec.scope;
  if (scope.type === "rolling_window") {
    const unitMs = scope.unit === "hour" ? 3_600_000 : 86_400_000;
    return {
      from: new Date(Date.parse(upperBound) - scope.amount * unitMs).toISOString(),
      to: upperBound,
    };
  }
  if (scope.type === "previous_schedule_window") {
    const maxLookbackMs = scope.maxLookback
      ? scope.maxLookback.amount *
        (scope.maxLookback.unit === "hour" ? 3_600_000 : 86_400_000)
      : 86_400_000;
    return {
      from: new Date(Date.parse(upperBound) - maxLookbackMs).toISOString(),
      to: upperBound,
    };
  }
  if (scope.type === "calendar_day") {
    const date = scope.date ?? zonedDate(upperBound, scope.timezone);
    const start = zonedStartOfDay(date, scope.timezone);
    const nextDate = new Date(`${date}T00:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const end = zonedStartOfDay(nextDate.toISOString().slice(0, 10), scope.timezone);
    return {
      from: start,
      to: Date.parse(end) < Date.parse(upperBound) ? end : upperBound,
    };
  }
  return { to: upperBound };
}

function zonedDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function senderDomain(message: MailMessage): string {
  return message.from.email.split("@").at(-1)?.toLowerCase() ?? "";
}

function zonedStartOfDay(date: string, timezone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offsetAt = (instant: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((item) => item.type === type)?.value);
    return Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    ) - instant.getTime();
  };
  const first = new Date(guess - offsetAt(new Date(guess)));
  return new Date(guess - offsetAt(first)).toISOString();
}
