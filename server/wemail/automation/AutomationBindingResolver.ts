import type { AutomationBindingExpression, AutomationValue } from "../../../shared/wemail/automation.js";
import type { AutomationProviderContext } from "./providers/AutomationProvider.js";

export function resolveStepInput(
  bindings: Record<string, AutomationBindingExpression>,
  context: AutomationProviderContext,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(bindings).map(([key, expression]) => [key, resolveBinding(expression, context)]));
}

export function resolveBinding(expression: AutomationBindingExpression, context: AutomationProviderContext): unknown {
  if (expression.type === "literal") return expression.value;
  if (expression.type === "coalesce") {
    for (const value of expression.values) {
      const resolved = resolveBinding(value, context);
      if (resolved !== undefined && resolved !== null && resolved !== "") return resolved;
    }
    return undefined;
  }
  const source = expression.from === "trigger"
    ? context.trigger
    : expression.from === "collection"
      ? context.collection
      : expression.from === "run"
        ? context.run
        : expression.stepId
          ? context.steps[expression.stepId]?.output
          : undefined;
  if (source === undefined) return undefined;
  return readPath(unwrapValue(source), expression.path);
}

function unwrapValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const typed = value as AutomationValue;
  if (typed.type === "scalar") return typed.value;
  return value;
}

function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").filter(Boolean).reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) return current[Number(segment)];
    if (typeof current !== "object") return undefined;
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}
