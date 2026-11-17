import type {
  AutomationConditionField,
  AutomationConditionMode,
  AutomationConditionRule,
  AutomationConditions,
} from "../../../shared/wemail/automation.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";

export function includes(
  haystack: string | undefined,
  needle: string | undefined,
): boolean {
  if (!needle) return true;
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

export function matchesStructuredConditions(
  conditions: AutomationConditions,
  message: MailMessage,
  messageHasTag?: (emailId: string, tagName: string) => boolean,
): boolean {
  if (conditions.sender !== undefined) {
    if (
      !includes(message.from.email, conditions.sender) &&
      !includes(message.from.name, conditions.sender)
    ) {
      return false;
    }
  }
  if (conditions.recipient !== undefined) {
    if (
      !message.to.some(
        (addr) =>
          includes(addr.email, conditions.recipient) ||
          includes(addr.name, conditions.recipient),
      )
    ) {
      return false;
    }
  }
  if (conditions.cc !== undefined) {
    if (
      !message.cc.some(
        (addr) =>
          includes(addr.email, conditions.cc) ||
          includes(addr.name, conditions.cc),
      )
    ) {
      return false;
    }
  }
  if (
    conditions.subjectKeyword !== undefined &&
    !includes(message.subject, conditions.subjectKeyword)
  ) {
    return false;
  }
  if (
    conditions.bodyKeyword !== undefined &&
    !includes(`${message.snippet}\n${message.bodyText ?? ""}`, conditions.bodyKeyword)
  ) {
    return false;
  }
  if (
    conditions.hasAttachment !== undefined &&
    message.hasAttachments !== conditions.hasAttachment
  ) {
    return false;
  }
  if (
    conditions.aiTag !== undefined &&
    (!messageHasTag || !messageHasTag(message.id, conditions.aiTag))
  ) {
    return false;
  }
  return true;
}

export function matchesConditionRules(
  mode: AutomationConditionMode,
  rules: AutomationConditionRule[],
  message: MailMessage,
  messageHasTag?: (emailId: string, tagName: string) => boolean,
): boolean {
  if (rules.length === 0) return true;
  const results = rules.map((rule) => matchesConditionRule(rule, message, messageHasTag));
  return mode === "any" ? results.some(Boolean) : results.every(Boolean);
}

function matchesConditionRule(
  rule: AutomationConditionRule,
  message: MailMessage,
  messageHasTag?: (emailId: string, tagName: string) => boolean,
): boolean {
  if (rule.field === "aiTag") {
    return matchesAiTagRule(rule, message.id, messageHasTag);
  }

  const values = fieldValues(rule.field, message);
  switch (rule.operator) {
    case "contains":
      return textValues(values).some((value) => includes(value, stringValue(rule.value)));
    case "notContains":
      return !textValues(values).some((value) => includes(value, stringValue(rule.value)));
    case "equals":
      return values.some((value) => valueEquals(value, rule.value));
    case "notEquals":
      return !values.some((value) => valueEquals(value, rule.value));
    case "exists":
      return values.some(valueExists);
    case "notExists":
      return !values.some(valueExists);
  }
}

function matchesAiTagRule(
  rule: AutomationConditionRule,
  emailId: string,
  messageHasTag?: (emailId: string, tagName: string) => boolean,
): boolean {
  const tagName = stringValue(rule.value);
  const hasTag = !!tagName && !!messageHasTag?.(emailId, tagName);
  switch (rule.operator) {
    case "contains":
    case "equals":
    case "exists":
      return hasTag;
    case "notContains":
    case "notEquals":
    case "notExists":
      return !hasTag;
  }
}

function fieldValues(
  field: Exclude<AutomationConditionField, "aiTag">,
  message: MailMessage,
): Array<string | boolean> {
  switch (field) {
    case "sender":
      return [message.from.email, message.from.name].filter(isPresentString);
    case "recipient":
      return message.to.flatMap((addr) =>
        [addr.email, addr.name].filter(isPresentString),
      );
    case "cc":
      return message.cc.flatMap((addr) =>
        [addr.email, addr.name].filter(isPresentString),
      );
    case "subject":
      return [message.subject].filter(isPresentString);
    case "body":
      return [`${message.snippet}\n${message.bodyText ?? ""}`];
    case "hasAttachment":
      return [message.hasAttachments];
  }
}

function textValues(values: Array<string | boolean>): string[] {
  return values.filter((value): value is string => typeof value === "string");
}

function stringValue(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function valueEquals(value: string | boolean, expected: string | boolean | undefined): boolean {
  if (typeof value === "boolean") return expected === value;
  if (typeof expected !== "string") return false;
  return value.toLowerCase() === expected.toLowerCase();
}

function valueExists(value: string | boolean): boolean {
  if (typeof value === "boolean") return value;
  return value.trim().length > 0;
}

function isPresentString(value: string | undefined): value is string {
  return !!value && value.trim().length > 0;
}
