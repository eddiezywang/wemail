import type {
  AutomationFieldDefinition,
  AutomationRule,
  TemporalExpression,
} from "../../../shared/wemail/automation.js";
import { AUTOMATION_FIELD_DEFINITIONS } from "./AutomationFieldCatalog.js";

export interface TemporalExpressionShape {
  valueType: "date" | "datetime";
  cardinality: "one" | "many";
}

export type AutomationRuleDraft = Omit<AutomationRule, "id" | "createdAt" | "updatedAt">;

export function analyzeTemporalExpression(
  expression: TemporalExpression,
  definitions: readonly AutomationFieldDefinition[] = AUTOMATION_FIELD_DEFINITIONS,
  depth = 0,
  counter = { nodes: 0 },
): TemporalExpressionShape {
  if (depth > 8 || ++counter.nodes > 32) {
    throw new Error("temporal-expression-too-complex");
  }
  if (!isRecord(expression)) throw new Error("temporal-expression-invalid-node");

  if (expression.type === "field") {
    if (
      typeof expression.path !== "string" ||
      (expression.scope !== undefined &&
        expression.scope !== "mail" &&
        expression.scope !== "matchingAttachments")
    ) {
      throw new Error("temporal-expression-invalid-node");
    }
    const definition = definitions.find((candidate) => candidate.path === expression.path);
    if (!definition) throw new Error("temporal-expression-unknown-field");

    const expectedScope = definition.scope === "mail" ? "mail" : "matchingAttachments";
    if (expression.scope !== undefined && expression.scope !== expectedScope) {
      throw new Error("temporal-expression-field-scope-mismatch");
    }
    return {
      valueType: definition.valueType,
      cardinality: definition.cardinality,
    };
  }

  if (expression.type === "aggregate") {
    if (expression.operator !== "max" && expression.operator !== "min") {
      throw new Error("temporal-expression-invalid-aggregate-operator");
    }
    if (!isRecord(expression.values)) throw new Error("temporal-expression-invalid-node");
    const values = analyzeTemporalExpression(expression.values, definitions, depth + 1, counter);
    if (values.cardinality !== "many") {
      throw new Error("temporal-expression-requires-collection");
    }
    return { valueType: values.valueType, cardinality: "one" };
  }

  if (expression.type === "coalesce") {
    if (!Array.isArray(expression.values) || !expression.values.every(isRecord)) {
      throw new Error("temporal-expression-invalid-node");
    }
    if (expression.values.length < 2 || expression.values.length > 8) {
      throw new Error("temporal-expression-invalid-coalesce-arity");
    }
    const values = expression.values.map((value) =>
      analyzeTemporalExpression(value, definitions, depth + 1, counter),
    );
    if (values.some((value) => value.cardinality !== "one")) {
      throw new Error("temporal-expression-requires-scalar");
    }
    return {
      valueType: values.some((value) => value.valueType === "datetime") ? "datetime" : "date",
      cardinality: "one",
    };
  }

  if (expression.type !== "addDuration") {
    throw new Error("temporal-expression-invalid-node");
  }
  if (!isRecord(expression.base) || !isRecord(expression.duration)) {
    throw new Error("temporal-expression-invalid-node");
  }
  const base = analyzeTemporalExpression(expression.base, definitions, depth + 1, counter);
  if (base.cardinality !== "one") {
    throw new Error("temporal-expression-requires-scalar");
  }
  if (
    !Number.isFinite(expression.duration.amount) ||
    !Number.isInteger(expression.duration.amount) ||
    expression.duration.amount <= 0 ||
    !["minute", "hour", "day"].includes(expression.duration.unit)
  ) {
    throw new Error("temporal-expression-invalid-duration");
  }
  return { valueType: "datetime", cardinality: "one" };
}

export function assertValidAutomationRuleDraft(
  rule: AutomationRuleDraft,
  definitions: readonly AutomationFieldDefinition[] = AUTOMATION_FIELD_DEFINITIONS,
): void {
  const candidate: unknown = rule;
  if (!isRecord(candidate)) throw new Error("invalid-automation-rule");
  if (typeof candidate.accountId !== "string" || !candidate.accountId.trim()) {
    throw new Error("automation-rule-account-required");
  }
  if (typeof candidate.name !== "string" || !candidate.name.trim()) {
    throw new Error("automation-rule-name-required");
  }
  if (typeof candidate.enabled !== "boolean") {
    throw new Error("invalid-automation-rule-enabled");
  }
  if (!isRecord(candidate.conditions)) {
    throw new Error("automation-rule-conditions-required");
  }
  assertValidConditions(candidate.conditions);
  if (
    candidate.naturalLanguageCondition !== undefined &&
    typeof candidate.naturalLanguageCondition !== "string"
  ) {
    throw new Error("invalid-automation-natural-language-condition");
  }
  if (
    candidate.conditionMode !== undefined &&
    candidate.conditionMode !== "all" &&
    candidate.conditionMode !== "any"
  ) {
    throw new Error("invalid-automation-condition-mode");
  }
  if (
    candidate.conditionRules !== undefined &&
    (
      !Array.isArray(candidate.conditionRules) ||
      !candidate.conditionRules.every(isValidConditionRule)
    )
  ) {
    throw new Error("invalid-automation-condition-rules");
  }
  if (!Array.isArray(candidate.actions) || candidate.actions.length === 0) {
    throw new Error("automation-rule-actions-required");
  }
  for (const action of candidate.actions) assertValidAction(action);

  if (!isRecord(candidate.trigger)) {
    throw new Error("automation-rule-trigger-required");
  }
  const trigger = candidate.trigger;
  if (
    trigger.type !== "manual" &&
    trigger.type !== "mailReceived" &&
    trigger.type !== "scheduled"
  ) {
    throw new Error("automation-rule-trigger-required");
  }

  if (trigger.type === "scheduled") {
    const schedule = isRecord(trigger.schedule) ? trigger.schedule : undefined;
    const interval = schedule?.type === "interval" ? schedule.intervalMinutes : trigger.intervalMinutes;
    if (schedule?.type === "daily") {
      if (typeof schedule.localTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime)) {
        throw new Error("invalid-scheduled-trigger");
      }
      assertValidTimezone(String(schedule.timezone ?? ""), "invalid-scheduled-timezone");
    } else if (schedule && schedule.type !== "interval") {
      throw new Error("invalid-scheduled-trigger");
    } else if (typeof interval !== "number" || !Number.isInteger(interval) || interval <= 0) {
      throw new Error("invalid-scheduled-trigger");
    }
    if (trigger.nextRunAt !== undefined && (typeof trigger.nextRunAt !== "string" || !Number.isFinite(Date.parse(trigger.nextRunAt)))) {
      throw new Error("invalid-scheduled-trigger");
    }
  }

  if (candidate.processing !== undefined) assertValidProcessing(candidate.processing, trigger.type);

  if (trigger.type !== "manual") {
    const hasConditions = Object.keys(candidate.conditions).length > 0;
    const hasConditionRules = Array.isArray(candidate.conditionRules) &&
      candidate.conditionRules.length > 0;
    const hasNaturalLanguageCondition =
      typeof candidate.naturalLanguageCondition === "string" &&
      !!candidate.naturalLanguageCondition.trim();
    if (!hasConditions && !hasConditionRules && !hasNaturalLanguageCondition && (!isRecord(candidate.processing) || candidate.processing.mode !== "collection")) {
      throw new Error("automatic-rule-condition-required");
    }
  }

  if (trigger.type !== "mailReceived" || trigger.execution === undefined) return;
  if (!isRecord(trigger.execution)) throw new Error("invalid-mail-received-execution");
  const execution = trigger.execution;
  if (
    execution.type !== "immediate" &&
    execution.type !== "delay" &&
    execution.type !== "nextDayAt" &&
    execution.type !== "atExpression"
  ) {
    throw new Error("invalid-mail-received-execution");
  }
  if (execution.type === "immediate") return;

  if (execution.type === "delay") {
    if (
      typeof execution.amount !== "number" ||
      !Number.isFinite(execution.amount) ||
      execution.amount <= 0 ||
      execution.amount > 365 ||
      (
        execution.unit !== "minute" &&
        execution.unit !== "hour" &&
        execution.unit !== "day"
      )
    ) {
      throw new Error("invalid-mail-received-delay");
    }
    return;
  }

  if (execution.type === "nextDayAt") {
    if (
      typeof execution.localTime !== "string" ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(execution.localTime)
    ) {
      throw new Error("invalid-next-day-local-time");
    }
    assertValidTimezone(
      typeof execution.timezone === "string" ? execution.timezone : "",
      "invalid-next-day-timezone",
    );
    return;
  }

  assertValidTimezone(
    typeof execution.timezone === "string" ? execution.timezone : "",
    "invalid-at-expression-timezone",
  );
  const shape = analyzeTemporalExpression(
    execution.expression as TemporalExpression,
    definitions,
  );
  if (shape.cardinality !== "one") {
    throw new Error("temporal-expression-requires-scalar");
  }
}

const CONDITION_STRING_FIELDS = new Set([
  "sender",
  "recipient",
  "cc",
  "subjectKeyword",
  "bodyKeyword",
  "aiTag",
]);
const CONDITION_NUMBER_FIELDS = new Set(["olderThanDays", "newerThanDays"]);
const CONDITION_RULE_FIELDS = new Set([
  "sender",
  "recipient",
  "cc",
  "subject",
  "body",
  "hasAttachment",
  "aiTag",
]);
const CONDITION_RULE_OPERATORS = new Set([
  "contains",
  "notContains",
  "equals",
  "notEquals",
  "exists",
  "notExists",
]);
const SIMPLE_ACTION_TYPES = new Set([
  "star",
  "archive",
  "trash",
  "spam",
  "notSpam",
  "markImportant",
  "markNotImportant",
  "markRead",
  "markUnread",
  "suppressTodoCreation",
]);

function assertValidConditions(conditions: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(conditions)) {
    if (CONDITION_STRING_FIELDS.has(key) && typeof value === "string") continue;
    if (
      CONDITION_NUMBER_FIELDS.has(key) &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      continue;
    }
    if (key === "hasAttachment" && typeof value === "boolean") continue;
    throw new Error("invalid-automation-rule-conditions");
  }
}

function isValidConditionRule(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    CONDITION_RULE_FIELDS.has(String(value.field)) &&
    CONDITION_RULE_OPERATORS.has(String(value.operator)) &&
    (
      value.value === undefined ||
      typeof value.value === "string" ||
      typeof value.value === "boolean"
    )
  );
}

function assertValidAction(action: unknown): void {
  if (!isRecord(action) || typeof action.type !== "string") {
    throw new Error("invalid-automation-action");
  }
  if (action.type === "applyLabel") {
    if (typeof action.label !== "string" || !action.label.trim()) {
      throw new Error("invalid-automation-action");
    }
    return;
  }
  if (SIMPLE_ACTION_TYPES.has(action.type)) return;
  if (action.type === "publishApplicationMessage") {
    if (typeof action.title !== "string" || !action.title.trim()) throw new Error("invalid-automation-action");
    if (action.desktopNotification !== undefined && typeof action.desktopNotification !== "boolean") throw new Error("invalid-automation-action");
    return;
  }
  if (action.type === "publishBotMessage") {
    const validDestination =
      isRecord(action.destination) &&
      ((action.destination.type === "owner" &&
        Number.isInteger(action.destination.ownerBindingVersion) &&
        Number(action.destination.ownerBindingVersion) >= 1) ||
        (action.destination.type === "conversation" &&
          typeof action.destination.destinationId === "string" &&
          action.destination.destinationId.length > 0));
    if (
      typeof action.botProfileId !== "string" ||
      !action.botProfileId ||
      !validDestination ||
      (action.title !== undefined &&
        (typeof action.title !== "string" || action.title.length > 120)) ||
      (action.bodyTemplate !== undefined &&
        (typeof action.bodyTemplate !== "string" ||
          action.bodyTemplate.length > 2_000 ||
          /\{\{(?!sender\}\}|subject\}\}|receivedAt\}\}|snippet\}\})/.test(
            action.bodyTemplate,
          )))
    ) {
      throw new Error("invalid-publish-bot-message-action");
    }
    return;
  }
  if (action.type !== "external") throw new Error("invalid-automation-action");
  if (
    action.adapter !== "wecli.allowance.upload" &&
    action.adapter !== "wecli.operation"
  ) {
    throw new Error("unsupported-external-action-adapter");
  }
  if (!isRecord(action.input)) throw new Error("invalid-automation-action");

  if (action.adapter === "wecli.allowance.upload") {
    const policy = action.input.attachmentPolicy;
    if (policy !== undefined && policy !== "pdf" && policy !== "invoice" && policy !== "all") {
      throw new Error("invalid-wecli-allowance-upload");
    }
    return;
  }

  const capability = action.input.capability;
  const operation = action.input.operation;
  const args = action.input.args;
  const isSafeIdentifier = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value);
  if (
    !isSafeIdentifier(capability) ||
    !isSafeIdentifier(operation) ||
    (args !== undefined && (!Array.isArray(args) || !args.every(isSafeIdentifier)))
  ) {
    throw new Error("invalid-wecli-operation");
  }
}

function assertValidProcessing(processing: unknown, triggerType: string): void {
  if (!isRecord(processing) || (processing.mode !== "perMessage" && processing.mode !== "collection")) {
    throw new Error("invalid-automation-processing");
  }
  if (processing.mode === "collection" && triggerType !== "scheduled" && triggerType !== "manual") throw new Error("collection-trigger-not-supported");
  if (!isRecord(processing.scope)) {
    if (processing.mode === "collection" || triggerType === "scheduled") throw new Error("collection-scope-required");
    return;
  }
  if (processing.scope.type === "rollingWindow") {
    if (!Number.isInteger(processing.scope.amount) || Number(processing.scope.amount) <= 0 || Number(processing.scope.amount) > 365 || !["hour", "day"].includes(String(processing.scope.unit))) {
      throw new Error("invalid-collection-scope");
    }
  } else if (processing.scope.type === "previousScheduleWindow") {
    const maxLookback = processing.scope.maxLookback;
    if (
      maxLookback !== undefined &&
      (!isRecord(maxLookback) ||
        !Number.isInteger(maxLookback.amount) ||
        Number(maxLookback.amount) <= 0 ||
        Number(maxLookback.amount) > 365 ||
        !["hour", "day"].includes(String(maxLookback.unit)))
    ) {
      throw new Error("invalid-collection-scope");
    }
  } else if (processing.scope.type === "calendarDay") {
    assertValidTimezone(String(processing.scope.timezone), "invalid-collection-scope");
  } else {
    throw new Error("invalid-collection-scope");
  }
  if (processing.scope.limit !== undefined && (!Number.isInteger(processing.scope.limit) || Number(processing.scope.limit) < 1 || Number(processing.scope.limit) > 1000)) {
    throw new Error("invalid-collection-limit");
  }
  if (processing.mode === "perMessage") return;
  if (!Array.isArray(processing.processors) || processing.processors.length === 0) throw new Error("collection-processor-required");
  for (const processor of processing.processors) {
    if (!isRecord(processor) || (processor.type !== "mailDigest" && processor.type !== "invoiceReadinessAnalysis")) throw new Error("unsupported-collection-processor");
  }
}

function assertValidTimezone(timezone: string, error: string): void {
  if (typeof timezone !== "string" || !timezone.trim()) throw new Error(error);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
