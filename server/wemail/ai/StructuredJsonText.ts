/**
 * Remove one complete outer Markdown fence from JSON-text structured output.
 * Keep prose, partial fences, and other malformed payloads unchanged so the
 * caller's existing JSON/schema validation still rejects them.
 */
export function stripStructuredJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? text;
}

export type StructuredJsonTextErrorCode =
  | "EMPTY_STRUCTURED_OUTPUT"
  | "INVALID_STRUCTURED_JSON"
  | "STRUCTURED_OUTPUT_SCHEMA_MISMATCH";

export class StructuredJsonTextError extends Error {
  readonly code: StructuredJsonTextErrorCode;
  /**
   * Diagnostics for schema mismatches: a size-bounded shape summary of the
   * model output plus the first failing path. Value-free by construction —
   * only key names, types, and string lengths leak, never the payload itself.
   */
  readonly detail: string;
  /** Raw model text that failed normalization, so callers can salvage it leniently. */
  readonly rawText: string;

  constructor(code: StructuredJsonTextErrorCode, detail = "", rawText = "") {
    super(code.toLowerCase().replaceAll("_", "-"));
    this.name = "StructuredJsonTextError";
    this.code = code;
    this.detail = detail;
    this.rawText = rawText;
  }
}

export interface NormalizedStructuredJson {
  text: string;
  value: unknown;
}

/** Parse, validate, and canonicalize one structured model response. */
export function normalizeStructuredJsonText(
  rawText: string,
  schema: Record<string, unknown>,
): NormalizedStructuredJson {
  const text = stripStructuredJsonFence(rawText).trim();
  if (!text) {
    throw new StructuredJsonTextError("EMPTY_STRUCTURED_OUTPUT", "", rawText);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StructuredJsonTextError("INVALID_STRUCTURED_JSON", "", rawText);
  }
  const mismatch = schemaMismatch(schema, value, "$");
  if (mismatch) {
    throw new StructuredJsonTextError(
      "STRUCTURED_OUTPUT_SCHEMA_MISMATCH",
      `model output ${describeJsonShape(value)}; first mismatch: ${mismatch}`,
      rawText,
    );
  }
  return { text: JSON.stringify(value), value };
}

/**
 * Size-bounded structural summary of an arbitrary JSON value: key names and
 * shapes for objects/arrays, type plus string length for scalars. Values are
 * never included, so large or sensitive payloads stay out of logs.
 */
export function describeJsonShape(value: unknown, limit = 240): string {
  const shape = shapeOf(value, 0);
  return shape.length <= limit ? shape : `${shape.slice(0, limit - 1)}…`;
}

function shapeOf(value: unknown, depth: number): string {
  if (depth > 4) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const head = value.slice(0, 2).map((item) => shapeOf(item, depth + 1)).join(",");
    const rest = value.length > 2 ? `,+${value.length - 2}` : "";
    return `[${head}${rest}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const head = entries.slice(0, 6).map(([key, item]) => `${key}:${shapeOf(item, depth + 1)}`).join(",");
    const rest = entries.length > 6 ? `,+${entries.length - 6}` : "";
    return `{${head}${rest}}`;
  }
  if (typeof value === "string") return `str(${value.length})`;
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "num";
  if (typeof value === "boolean") return "bool";
  return typeof value;
}

/**
 * Validate `value` against `schema`, returning the first failing path with a
 * short reason (or null when it matches). Unknown properties are tolerated
 * even under `additionalProperties: false` — models routinely emit extra
 * fields and the extra keys are harmless to downstream readers.
 */
export function schemaMismatch(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  depth = 0,
): string | null {
  if (depth > 100) return `${path}: max depth exceeded`;

  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) {
      if (!isSchema(candidate)) continue;
      const reason = schemaMismatch(candidate, value, path, depth + 1);
      if (reason) return reason;
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const reasons: string[] = [];
    for (const candidate of schema.anyOf) {
      if (!isSchema(candidate)) continue;
      const reason = schemaMismatch(candidate, value, path, depth + 1);
      if (!reason) {
        reasons.length = 0;
        break;
      }
      reasons.push(reason);
    }
    if (reasons.length > 0) {
      return `${path}: anyOf, none matched (${reasons[0]})`;
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const reasons: Array<string | null> = [];
    for (const candidate of schema.oneOf) {
      if (!isSchema(candidate)) continue;
      reasons.push(schemaMismatch(candidate, value, path, depth + 1));
    }
    const matched = reasons.filter((reason) => reason === null).length;
    if (matched !== 1) {
      const detail = matched === 0
        ? `no branch matched (${reasons.find(Boolean) ?? "?"})`
        : `${matched} branches matched`;
      return `${path}: oneOf ${detail}`;
    }
  }
  if ("const" in schema && !sameJsonValue(schema.const, value)) {
    return `${path}: expected const ${shortJson(schema.const)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameJsonValue(candidate, value))) {
    return `${path}: expected one of ${shortJson(schema.enum)}`;
  }

  const types = typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter((type): type is string => typeof type === "string")
      : [];
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
    return `${path}: expected ${types.join("|")}, got ${typeOf(value)}`;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return `${path}: minLength ${schema.minLength}, got ${value.length}`;
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return `${path}: maxLength ${schema.maxLength}, got ${value.length}`;
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) {
          return `${path}: pattern ${schema.pattern} not matched`;
        }
      } catch {
        return `${path}: invalid pattern ${schema.pattern}`;
      }
    }
    if (typeof schema.format === "string" && !matchesFormat(schema.format, value)) {
      return `${path}: invalid ${schema.format} format`;
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path}: < minimum ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path}: > maximum ${schema.maximum}`;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      return `${path}: <= exclusiveMinimum ${schema.exclusiveMinimum}`;
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      return `${path}: >= exclusiveMaximum ${schema.exclusiveMaximum}`;
    }
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 10) {
        return `${path}: not a multiple of ${schema.multipleOf}`;
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `${path}: minItems ${schema.minItems}, got ${value.length}`;
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `${path}: maxItems ${schema.maxItems}, got ${value.length}`;
    }
    if (schema.uniqueItems === true) {
      const canonical = value.map((item) => JSON.stringify(item));
      if (new Set(canonical).size !== canonical.length) {
        return `${path}: duplicate items`;
      }
    }
    if (isSchema(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const reason = schemaMismatch(schema.items, value[index], `${path}[${index}]`, depth + 1);
        if (reason) return reason;
      }
    }
  }

  if (isRecord(value)) {
    const properties = isSchema(schema.properties)
      ? schema.properties as Record<string, Record<string, unknown>>
      : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          return `${path}: missing required '${key}'`;
        }
      }
    }
    const propertyCount = Object.keys(value).length;
    if (typeof schema.minProperties === "number" && propertyCount < schema.minProperties) {
      return `${path}: minProperties ${schema.minProperties}, got ${propertyCount}`;
    }
    if (typeof schema.maxProperties === "number" && propertyCount > schema.maxProperties) {
      return `${path}: maxProperties ${schema.maxProperties}, got ${propertyCount}`;
    }
    for (const [key, propertyValue] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isSchema(propertySchema)) {
        const reason = schemaMismatch(propertySchema, propertyValue, `${path}.${key}`, depth + 1);
        if (reason) return reason;
        continue;
      }
      // Unknown keys are tolerated even when additionalProperties is false.
      if (isSchema(schema.additionalProperties)) {
        const reason = schemaMismatch(schema.additionalProperties, propertyValue, `${path}.${key}`, depth + 1);
        if (reason) return reason;
      }
    }
  }

  return null;
}

function matchesType(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return `string(${value.length} chars)`;
  return typeof value;
}

function shortJson(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length <= 60 ? text : `${text.slice(0, 59)}…`;
}

function matchesFormat(format: string, value: string): boolean {
  if (format === "date-time") {
    return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  }
  if (format === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.toISOString().slice(0, 10) === value;
  }
  if (format === "time") {
    return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value);
  }
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === "uri" || format === "url") {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}
