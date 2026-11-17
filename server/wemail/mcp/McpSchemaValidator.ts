import type { McpJsonSchema } from "./McpToolCatalog.js";

export interface McpSchemaIssue {
  path: string;
  message: string;
}

const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(value: unknown, type: NonNullable<McpJsonSchema["type"]>): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

export function validateMcpSchema(
  schema: McpJsonSchema,
  value: unknown,
  path = "$",
): McpSchemaIssue[] {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validateMcpSchema(candidate, value, path).length === 0);
    return matches.length === 1 ? [] : [{ path, message: "must match exactly one allowed shape" }];
  }

  if (schema.type && !matchesType(value, schema.type)) {
    return [{ path, message: `must be ${schema.type}` }];
  }
  if (schema.const !== undefined && value !== schema.const) {
    return [{ path, message: "must equal the required constant" }];
  }
  if (schema.enum && !schema.enum.includes(value as never)) {
    return [{ path, message: "must be one of the allowed values" }];
  }

  const issues: McpSchemaIssue[] = [];
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push({ path, message: `must have at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path, message: `must have at most ${schema.maxLength} characters` });
    if (schema.format === "email" && !EMAIL_PATTERN.test(value)) issues.push({ path, message: "must be an email address" });
    if (schema.format === "date-time" && (!DATE_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value)))) issues.push({ path, message: "must be an RFC 3339 date-time" });
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `must be at least ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `must be at most ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, message: `must contain at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path, message: `must contain at most ${schema.maxItems} items` });
    if (schema.items) value.forEach((item, index) => issues.push(...validateMcpSchema(schema.items!, item, `${path}[${index}]`)));
  }
  if (isRecord(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) issues.push({ path: `${path}.${required}`, message: "is required" });
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) issues.push({ path: `${path}.${key}`, message: "is not allowed" });
      }
    }
    for (const [key, propertyValue] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema) issues.push(...validateMcpSchema(propertySchema, propertyValue, `${path}.${key}`));
    }
  }
  return issues;
}
