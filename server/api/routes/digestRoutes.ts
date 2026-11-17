import { Hono } from "hono";
import type {
  GenerateMailDigestRequest,
  MailDigestKind,
  MailDigestRecord,
  MailDigestScope,
  MailDigestScopeKind,
  MailDigestSettings,
  MailDigestStatus,
} from "../../../shared/wemail/digests.js";

export interface DigestRoutesDeps {
  service: {
    getSettings(): MailDigestSettings;
    saveSettings(settings: MailDigestSettings): MailDigestSettings | Promise<MailDigestSettings>;
    getStatus(accountId: string, scope?: Partial<MailDigestScope>): MailDigestStatus | Promise<MailDigestStatus>;
    latest(
      accountId: string,
      scope?: Partial<MailDigestScope>,
      kind?: MailDigestKind,
    ): MailDigestRecord | null | Promise<MailDigestRecord | null>;
    list(
      accountId: string,
      scope?: Partial<MailDigestScope>,
      options?: { kind?: MailDigestKind; limit?: number },
    ): MailDigestRecord[] | Promise<MailDigestRecord[]>;
    generate(input: GenerateMailDigestRequest): MailDigestRecord | Promise<MailDigestRecord>;
  };
}

const DIGEST_KINDS = new Set<MailDigestKind>(["manual", "inactivity", "daily"]);
const SCOPE_KINDS = new Set<MailDigestScopeKind>(["folder", "view"]);

export function buildDigestRoutes({ service }: DigestRoutesDeps): Hono {
  const router = new Hono();

  router.get("/settings", (c) => {
    return c.json({ ok: true, settings: service.getSettings() });
  });

  router.put("/settings", async (c) => {
    const parsed = await readJsonObject(c.req);
    if ("error" in parsed) {
      return c.json({ ok: false, error: parsed.error, field: parsed.field }, 400);
    }

    const settingsInput = parseSettingsBody(parsed.body);
    if ("error" in settingsInput) {
      return c.json({ ok: false, error: settingsInput.error, field: settingsInput.field }, 400);
    }

    try {
      const settings = await service.saveSettings(settingsInput.value);
      return c.json({ ok: true, settings });
    } catch (error) {
      const mapped = mapDigestError(error);
      if (mapped?.status === 400) {
        return c.json({ ok: false, error: mapped.error, field: mapped.field }, 400);
      }
      throw error;
    }
  });

  router.get("/status", async (c) => {
    const accountId = parseAccountId(c.req.query("accountId"));
    if ("error" in accountId) {
      return c.json({ ok: false, error: accountId.error, field: accountId.field }, 400);
    }
    const scope = parseScope({
      scopeKind: c.req.query("scopeKind"),
      scopeKey: c.req.query("scopeKey"),
    });
    if ("error" in scope) {
      return c.json({ ok: false, error: scope.error, field: scope.field }, 400);
    }
    try {
      const status = await service.getStatus(accountId.value, scope.value);
      return c.json({ ok: true, status });
    } catch (error) {
      const mapped = mapDigestError(error);
      if (mapped?.status === 409) {
        return c.json({ ok: false, error: mapped.error }, 409);
      }
      if (mapped?.status === 400) {
        return c.json({ ok: false, error: mapped.error, field: mapped.field }, 400);
      }
      if (mapped?.status === 500) {
        return c.json({ ok: false, error: mapped.error }, 500);
      }
      throw error;
    }
  });

  router.get("/latest", async (c) => {
    const accountId = parseAccountId(c.req.query("accountId"));
    if ("error" in accountId) {
      return c.json({ ok: false, error: accountId.error, field: accountId.field }, 400);
    }
    const scope = parseScope({
      scopeKind: c.req.query("scopeKind"),
      scopeKey: c.req.query("scopeKey"),
    });
    if ("error" in scope) {
      return c.json({ ok: false, error: scope.error, field: scope.field }, 400);
    }
    const kind = parseOptionalDigestKind(c.req.query("kind"));
    if ("error" in kind) {
      return c.json({ ok: false, error: kind.error, field: kind.field }, 400);
    }
    const digest = await service.latest(accountId.value, scope.value, kind.value);
    return c.json({ ok: true, digest });
  });

  router.get("/list", async (c) => {
    const accountId = parseAccountId(c.req.query("accountId"));
    if ("error" in accountId) {
      return c.json({ ok: false, error: accountId.error, field: accountId.field }, 400);
    }
    const scope = parseScope({
      scopeKind: c.req.query("scopeKind"),
      scopeKey: c.req.query("scopeKey"),
    });
    if ("error" in scope) {
      return c.json({ ok: false, error: scope.error, field: scope.field }, 400);
    }
    const kind = parseOptionalDigestKind(c.req.query("kind"));
    if ("error" in kind) {
      return c.json({ ok: false, error: kind.error, field: kind.field }, 400);
    }
    const limit = parseLimit(c.req.query("limit"));
    if ("error" in limit) {
      return c.json({ ok: false, error: limit.error, field: limit.field }, 400);
    }
    const digests = await service.list(accountId.value, scope.value, {
      kind: kind.value,
      limit: limit.value,
    });
    return c.json({ ok: true, digests });
  });

  router.post("/generate", async (c) => {
    const parsed = await readJsonObject(c.req);
    if ("error" in parsed) {
      return c.json({ ok: false, error: parsed.error, field: parsed.field }, 400);
    }

    const input = parseGenerateBody(parsed.body);
    if ("error" in input) {
      return c.json({ ok: false, error: input.error, field: input.field }, 400);
    }

    try {
      const digest = await service.generate(input.value);
      return c.json({ ok: true, digest });
    } catch (error) {
      const mapped = mapDigestError(error);
      if (mapped?.status === 409) {
        return c.json({ ok: false, error: mapped.error }, 409);
      }
      if (mapped?.status === 400) {
        return c.json({ ok: false, error: mapped.error, field: mapped.field }, 400);
      }
      if (mapped?.status === 500) {
        return c.json({ ok: false, error: mapped.error }, 500);
      }
      throw error;
    }
  });

  return router;
}

function parseSettingsBody(body: Record<string, unknown>):
  | { value: MailDigestSettings }
  | { error: string; field: string } {
  const allowedFields = new Set([
    "manualEnabled",
    "manualWindowHours",
    "inactivityEnabled",
    "inactivityHours",
    "dailyEnabled",
    "dailyTime",
    "dailyWindowMode",
    "lastOpenedAt",
    "lastDailyDigestDate",
  ]);
  for (const field of Object.keys(body)) {
    if (!allowedFields.has(field)) {
      return { error: "unknown settings field", field };
    }
  }

  const manualEnabled = parseBooleanField(body, "manualEnabled");
  if ("error" in manualEnabled) return manualEnabled;
  const inactivityEnabled = parseBooleanField(body, "inactivityEnabled");
  if ("error" in inactivityEnabled) return inactivityEnabled;
  const dailyEnabled = parseBooleanField(body, "dailyEnabled");
  if ("error" in dailyEnabled) return dailyEnabled;
  const manualWindowHours = parseNumberField(body, "manualWindowHours");
  if ("error" in manualWindowHours) return manualWindowHours;
  const inactivityHours = parseNumberField(body, "inactivityHours");
  if ("error" in inactivityHours) return inactivityHours;
  const dailyTime = parseStringField(body, "dailyTime");
  if ("error" in dailyTime) return dailyTime;
  const dailyWindowMode = parseStringField(body, "dailyWindowMode");
  if ("error" in dailyWindowMode) return dailyWindowMode;
  if (
    dailyWindowMode.value !== "day-start-to-now" &&
    dailyWindowMode.value !== "previous-daily-time"
  ) {
    return { error: "dailyWindowMode must be a valid daily window mode", field: "dailyWindowMode" };
  }
  const lastOpenedAt = parseOptionalStringOrNullField(body, "lastOpenedAt");
  if ("error" in lastOpenedAt) return lastOpenedAt;
  const lastDailyDigestDate = parseOptionalStringOrNullField(body, "lastDailyDigestDate");
  if ("error" in lastDailyDigestDate) return lastDailyDigestDate;

  const settings: MailDigestSettings = {
    manualEnabled: manualEnabled.value,
    manualWindowHours: manualWindowHours.value,
    inactivityEnabled: inactivityEnabled.value,
    inactivityHours: inactivityHours.value,
    dailyEnabled: dailyEnabled.value,
    dailyTime: dailyTime.value,
    dailyWindowMode: dailyWindowMode.value,
  };
  if (lastOpenedAt.value !== undefined) settings.lastOpenedAt = lastOpenedAt.value;
  if (lastDailyDigestDate.value !== undefined) {
    settings.lastDailyDigestDate = lastDailyDigestDate.value;
  }
  return { value: settings };
}

function parseBooleanField(
  body: Record<string, unknown>,
  field: string,
): { value: boolean } | { error: string; field: string } {
  if (typeof body[field] !== "boolean") {
    return { error: `${field} must be a boolean`, field };
  }
  return { value: body[field] };
}

function parseNumberField(
  body: Record<string, unknown>,
  field: string,
): { value: number } | { error: string; field: string } {
  if (typeof body[field] !== "number") {
    return { error: `${field} must be a number`, field };
  }
  return { value: body[field] };
}

function parseStringField(
  body: Record<string, unknown>,
  field: string,
): { value: string } | { error: string; field: string } {
  if (typeof body[field] !== "string") {
    return { error: `${field} must be a string`, field };
  }
  return { value: body[field] };
}

function parseOptionalStringOrNullField(
  body: Record<string, unknown>,
  field: string,
): { value: string | null | undefined } | { error: string; field: string } {
  const value = body[field];
  if (value !== undefined && value !== null && typeof value !== "string") {
    return { error: `${field} must be a string or null`, field };
  }
  return { value: value as string | null | undefined };
}

function parseGenerateBody(body: Record<string, unknown>):
  | { value: GenerateMailDigestRequest }
  | { error: string; field: string } {
  const accountId = parseAccountId(body.accountId);
  if ("error" in accountId) return accountId;

  if (typeof body.kind !== "string" || !DIGEST_KINDS.has(body.kind as MailDigestKind)) {
    return {
      error: "kind must be manual, inactivity, or daily",
      field: "kind",
    };
  }

  const input: GenerateMailDigestRequest = {
    accountId: accountId.value,
    kind: body.kind as MailDigestKind,
  };
  if (body.windowStart !== undefined) {
    if (typeof body.windowStart !== "string") {
      return { error: "windowStart must be a string", field: "windowStart" };
    }
    input.windowStart = body.windowStart;
  }
  if (body.windowEnd !== undefined) {
    if (typeof body.windowEnd !== "string") {
      return { error: "windowEnd must be a string", field: "windowEnd" };
    }
    input.windowEnd = body.windowEnd;
  }
  const scope = parseScope({
    scopeKind: body.scopeKind,
    scopeKey: body.scopeKey,
  });
  if ("error" in scope) return scope;
  if (scope.value.scopeKind) input.scopeKind = scope.value.scopeKind;
  if (scope.value.scopeKey) input.scopeKey = scope.value.scopeKey;
  return { value: input };
}

function parseOptionalDigestKind(
  value: string | undefined,
): { value: MailDigestKind | undefined } | { error: string; field: string } {
  if (value === undefined) return { value: undefined };
  if (!DIGEST_KINDS.has(value as MailDigestKind)) {
    return {
      error: "kind must be manual, inactivity, or daily",
      field: "kind",
    };
  }
  return { value: value as MailDigestKind };
}

function parseLimit(
  value: string | undefined,
): { value: number } | { error: string; field: string } {
  if (value === undefined) return { value: 20 };
  if (!/^\d+$/.test(value)) {
    return { error: "limit must be an integer from 1 to 100", field: "limit" };
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { error: "limit must be an integer from 1 to 100", field: "limit" };
  }
  return { value: limit };
}

function parseScope(input: { scopeKind?: unknown; scopeKey?: unknown }):
  | { value: Partial<MailDigestScope> }
  | { error: string; field: string } {
  const hasKind = input.scopeKind !== undefined;
  const hasKey = input.scopeKey !== undefined;
  if (!hasKind && !hasKey) return { value: {} };
  if (typeof input.scopeKind !== "string" || !SCOPE_KINDS.has(input.scopeKind as MailDigestScopeKind)) {
    return { error: "scopeKind must be folder or view", field: "scopeKind" };
  }
  if (typeof input.scopeKey !== "string" || input.scopeKey.trim().length === 0) {
    return { error: "scopeKey is required when scopeKind is provided", field: "scopeKey" };
  }
  return {
    value: {
      scopeKind: input.scopeKind as MailDigestScopeKind,
      scopeKey: input.scopeKey.trim(),
    },
  };
}

function parseAccountId(value: unknown):
  | { value: string }
  | { error: string; field: "accountId" } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: "accountId is required", field: "accountId" };
  }
  return { value: value.trim() };
}

async function readJsonObject(req: {
  json: () => Promise<unknown>;
}): Promise<
  | { body: Record<string, unknown> }
  | { error: string; field: "body" }
> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { error: "invalid json body", field: "body" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "request body must be a JSON object", field: "body" };
  }
  return { body: body as Record<string, unknown> };
}

function mapDigestError(error: unknown):
  | { status: 400; error: string; field: string }
  | { status: 409; error: string }
  | { status: 500; error: string }
  | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "llm-not-configured") {
    return { status: 409, error: message };
  }
  if (message.startsWith("invalid-digest-window")) {
    return { status: 400, error: message, field: "window" };
  }
  if (message.startsWith("invalid-digest-settings")) {
    return { status: 400, error: message, field: "settings" };
  }
  if (
    message === "invalid-mail-digest-json" ||
    message === "invalid-mail-digest-result" ||
    message === "invalid-digest-stats"
  ) {
    return { status: 500, error: message };
  }
  return null;
}
