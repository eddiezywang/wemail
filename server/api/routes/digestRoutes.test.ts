import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type {
  GenerateMailDigestRequest,
  MailDigestKind,
  MailDigestRecord,
  MailDigestSettings,
  MailDigestStatus,
} from "../../../shared/wemail/digests.js";
import { buildDigestRoutes } from "./digestRoutes.js";

const settings: MailDigestSettings = {
  manualEnabled: true,
  manualWindowHours: 8,
  inactivityEnabled: true,
  inactivityHours: 6,
  dailyEnabled: false,
  dailyTime: "18:00",
  dailyWindowMode: "day-start-to-now",
  lastOpenedAt: null,
  lastDailyDigestDate: null,
};

const digest: MailDigestRecord = {
  id: "digest-1",
  accountId: "acct-1",
  kind: "manual",
  scopeKind: "folder",
  scopeKey: "INBOX",
  windowStart: "2026-06-23T00:00:00.000Z",
  windowEnd: "2026-06-23T08:00:00.000Z",
  emailCount: 2,
  result: {
    type: "mailDigest",
    overview: ["Two important updates."],
    themes: [],
    actionItems: [],
    stats: {
      totalEmails: 2,
      includedEmails: 2,
      truncated: false,
    },
  },
  model: "summary-model",
  createdAt: "2026-06-23T08:01:00.000Z",
};

function makeApp(overrides: Partial<StubDigestService> = {}) {
  const calls: {
    savedSettings: MailDigestSettings[];
    statusInputs: Array<{ accountId: string; scopeKind?: string; scopeKey?: string }>;
    latestInputs: Array<{ accountId: string; scopeKind?: string; scopeKey?: string; kind?: string }>;
    listInputs: Array<{ accountId: string; scopeKind?: string; scopeKey?: string; kind?: string; limit: number }>;
    generateInputs: GenerateMailDigestRequest[];
  } = {
    savedSettings: [],
    statusInputs: [],
    latestInputs: [],
    listInputs: [],
    generateInputs: [],
  };
  const service: StubDigestService = {
    getSettings: () => settings,
    saveSettings: async (input) => {
      calls.savedSettings.push(input);
      return { ...input, manualWindowHours: 12 };
    },
    getStatus: async (accountId, scope) => {
      const input: { accountId: string; scopeKind?: string; scopeKey?: string } = { accountId };
      if (scope?.scopeKind) input.scopeKind = scope.scopeKind;
      if (scope?.scopeKey) input.scopeKey = scope.scopeKey;
      calls.statusInputs.push(input);
      return {
        state: "available",
        reason: "manual",
        scopeKind: scope?.scopeKind,
        scopeKey: scope?.scopeKey,
        windowStart: digest.windowStart,
        windowEnd: digest.windowEnd,
        emailCount: digest.emailCount,
        digest,
      };
    },
    latest: async (accountId, scope, kind) => {
      calls.latestInputs.push({
        accountId,
        scopeKind: scope?.scopeKind,
        scopeKey: scope?.scopeKey,
        kind,
      });
      return digest;
    },
    list: async (accountId, scope, options) => {
      calls.listInputs.push({
        accountId,
        scopeKind: scope?.scopeKind,
        scopeKey: scope?.scopeKey,
        kind: options?.kind,
        limit: options?.limit ?? 20,
      });
      return [digest];
    },
    generate: async (input) => {
      calls.generateInputs.push(input);
      return { ...digest, kind: input.kind };
    },
    ...overrides,
  };
  const app = new Hono();
  app.route("/api/digests", buildDigestRoutes({ service }));
  return { app, calls };
}

interface StubDigestService {
  getSettings(): MailDigestSettings;
  saveSettings(settings: MailDigestSettings): Promise<MailDigestSettings> | MailDigestSettings;
  getStatus(
    accountId: string,
    scope?: { scopeKind?: "folder" | "view"; scopeKey?: string },
  ): Promise<MailDigestStatus> | MailDigestStatus;
  latest(
    accountId: string,
    scope?: { scopeKind?: "folder" | "view"; scopeKey?: string },
    kind?: MailDigestKind,
  ): Promise<MailDigestRecord | null> | MailDigestRecord | null;
  list(
    accountId: string,
    scope?: { scopeKind?: "folder" | "view"; scopeKey?: string },
    options?: { kind?: MailDigestKind; limit?: number },
  ): Promise<MailDigestRecord[]> | MailDigestRecord[];
  generate(input: GenerateMailDigestRequest): Promise<MailDigestRecord> | MailDigestRecord;
}

test("GET /api/digests/settings returns current settings", async () => {
  const { app } = makeApp();

  const res = await app.request("/api/digests/settings");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, settings });
});

test("PUT /api/digests/settings saves valid settings and returns saved settings", async () => {
  const { app, calls } = makeApp();
  const nextSettings: MailDigestSettings = {
    ...settings,
    manualWindowHours: 10,
    dailyEnabled: true,
  };

  const res = await app.request("/api/digests/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(nextSettings),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(calls.savedSettings, [nextSettings]);
  assert.deepEqual(await res.json(), {
    ok: true,
    settings: { ...nextSettings, manualWindowHours: 12 },
  });
});

test("PUT /api/digests/settings returns 400 for invalid JSON bodies", async () => {
  const { app } = makeApp();

  const res = await app.request("/api/digests/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{",
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: "invalid json body",
    field: "body",
  });
});

test("PUT /api/digests/settings rejects missing or non-boolean toggle fields", async () => {
  for (const field of ["manualEnabled", "inactivityEnabled", "dailyEnabled"] as const) {
    const missing = makeApp();
    const missingBody = { ...settings };
    delete missingBody[field];

    const missingRes = await missing.app.request("/api/digests/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(missingBody),
    });

    assert.equal(missingRes.status, 400);
    assert.deepEqual(await missingRes.json(), {
      ok: false,
      error: `${field} must be a boolean`,
      field,
    });
    assert.deepEqual(missing.calls.savedSettings, []);

    const wrongType = makeApp();
    const wrongTypeRes = await wrongType.app.request("/api/digests/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...settings, [field]: "true" }),
    });

    assert.equal(wrongTypeRes.status, 400);
    assert.deepEqual(await wrongTypeRes.json(), {
      ok: false,
      error: `${field} must be a boolean`,
      field,
    });
    assert.deepEqual(wrongType.calls.savedSettings, []);
  }
});

test("PUT /api/digests/settings rejects wrong primitive types", async () => {
  const cases = [
    {
      field: "manualWindowHours",
      body: { ...settings, manualWindowHours: "8" },
      error: "manualWindowHours must be a number",
    },
    {
      field: "inactivityHours",
      body: { ...settings, inactivityHours: true },
      error: "inactivityHours must be a number",
    },
    {
      field: "dailyTime",
      body: { ...settings, dailyTime: 1800 },
      error: "dailyTime must be a string",
    },
    {
      field: "dailyWindowMode",
      body: { ...settings, dailyWindowMode: false },
      error: "dailyWindowMode must be a string",
    },
    {
      field: "lastOpenedAt",
      body: { ...settings, lastOpenedAt: 123 },
      error: "lastOpenedAt must be a string or null",
    },
    {
      field: "lastDailyDigestDate",
      body: { ...settings, lastDailyDigestDate: false },
      error: "lastDailyDigestDate must be a string or null",
    },
  ] as const;

  for (const testCase of cases) {
    const { app, calls } = makeApp();
    const res = await app.request("/api/digests/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(testCase.body),
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: testCase.error,
      field: testCase.field,
    });
    assert.deepEqual(calls.savedSettings, []);
  }
});

test("PUT /api/digests/settings rejects invalid daily window mode", async () => {
  const { app, calls } = makeApp();

  const res = await app.request("/api/digests/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...settings, dailyWindowMode: "custom" }),
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: "dailyWindowMode must be a valid daily window mode",
    field: "dailyWindowMode",
  });
  assert.deepEqual(calls.savedSettings, []);
});

test("PUT /api/digests/settings rejects unknown fields", async () => {
  const { app, calls } = makeApp();

  const res = await app.request("/api/digests/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...settings, nested: { enabled: true } }),
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: "unknown settings field",
    field: "nested",
  });
  assert.deepEqual(calls.savedSettings, []);
});

test("PUT /api/digests/settings returns 400 for service validation errors", async () => {
  const { app } = makeApp({
    saveSettings: () => {
      throw new Error("invalid-digest-settings:manualWindowHours");
    },
  });

  const res = await app.request("/api/digests/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...settings, manualWindowHours: 0 }),
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: "invalid-digest-settings:manualWindowHours",
    field: "settings",
  });
});

test("GET /api/digests/status validates accountId and returns status", async () => {
  const { app, calls } = makeApp();

  const missing = await app.request("/api/digests/status?accountId=%20%20");
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), {
    ok: false,
    error: "accountId is required",
    field: "accountId",
  });

  const res = await app.request("/api/digests/status?accountId=acct-1");
  assert.equal(res.status, 200);
  assert.deepEqual(calls.statusInputs, [{ accountId: "acct-1" }]);
  assert.deepEqual(await res.json(), {
    ok: true,
    status: {
      state: "available",
      reason: "manual",
      windowStart: digest.windowStart,
      windowEnd: digest.windowEnd,
      emailCount: digest.emailCount,
      digest,
    },
  });
});

test("GET /api/digests/status forwards optional scope", async () => {
  const { app, calls } = makeApp();

  const res = await app.request(
    "/api/digests/status?accountId=acct-1&scopeKind=folder&scopeKey=Archive",
  );

  assert.equal(res.status, 200);
  assert.deepEqual(calls.statusInputs, [{
    accountId: "acct-1",
    scopeKind: "folder",
    scopeKey: "Archive",
  }]);
});

test("GET /api/digests/status maps known daily backfill generation errors", async () => {
  const { app } = makeApp({
    getStatus: () => {
      throw new Error("invalid-mail-digest-json");
    },
  });

  const res = await app.request("/api/digests/status?accountId=acct-1");

  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: "invalid-mail-digest-json",
  });
});

test("GET /api/digests/latest validates accountId and returns digest or null", async () => {
  const missingDigest = makeApp({ latest: () => null });
  const missing = await missingDigest.app.request("/api/digests/latest?accountId= ");
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), {
    ok: false,
    error: "accountId is required",
    field: "accountId",
  });

  const noDigest = await missingDigest.app.request("/api/digests/latest?accountId=acct-1");
  assert.equal(noDigest.status, 200);
  assert.deepEqual(await noDigest.json(), { ok: true, digest: null });

  const { app, calls } = makeApp();
  const res = await app.request("/api/digests/latest?accountId=acct-1");
  assert.equal(res.status, 200);
  assert.deepEqual(calls.latestInputs, [{ accountId: "acct-1", scopeKind: undefined, scopeKey: undefined, kind: undefined }]);
  assert.deepEqual(await res.json(), { ok: true, digest });
});

test("GET /api/digests/latest forwards optional scope and kind", async () => {
  const { app, calls } = makeApp();

  const res = await app.request(
    "/api/digests/latest?accountId=acct-1&scopeKind=folder&scopeKey=Archive&kind=daily",
  );

  assert.equal(res.status, 200);
  assert.deepEqual(calls.latestInputs, [{
    accountId: "acct-1",
    scopeKind: "folder",
    scopeKey: "Archive",
    kind: "daily",
  }]);
});

test("GET /api/digests/list forwards optional scope, kind, and limit", async () => {
  const { app, calls } = makeApp();

  const res = await app.request(
    "/api/digests/list?accountId=acct-1&scopeKind=folder&scopeKey=Archive&kind=daily&limit=7",
  );

  assert.equal(res.status, 200);
  assert.deepEqual(calls.listInputs, [{
    accountId: "acct-1",
    scopeKind: "folder",
    scopeKey: "Archive",
    kind: "daily",
    limit: 7,
  }]);
  assert.deepEqual(await res.json(), { ok: true, digests: [digest] });
});

test("GET /api/digests/list validates limit bounds", async () => {
  const { app } = makeApp();

  const res = await app.request(
    "/api/digests/list?accountId=acct-1&scopeKind=folder&scopeKey=Archive&limit=101",
  );

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: "limit must be an integer from 1 to 100",
    field: "limit",
  });
});

test("POST /api/digests/generate validates accountId and kind", async () => {
  const { app } = makeApp();

  const missingAccount = await app.request("/api/digests/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "", kind: "manual" }),
  });
  assert.equal(missingAccount.status, 400);
  assert.deepEqual(await missingAccount.json(), {
    ok: false,
    error: "accountId is required",
    field: "accountId",
  });

  const invalidKind = await app.request("/api/digests/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct-1", kind: "weekly" }),
  });
  assert.equal(invalidKind.status, 400);
  assert.deepEqual(await invalidKind.json(), {
    ok: false,
    error: "kind must be manual, inactivity, or daily",
    field: "kind",
  });
});

test("POST /api/digests/generate supports optional windows and returns digest", async () => {
  const { app, calls } = makeApp();

  const res = await app.request("/api/digests/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountId: " acct-1 ",
      kind: "daily" satisfies MailDigestKind,
      windowStart: "2026-06-23T00:00:00.000Z",
      windowEnd: "2026-06-23T08:00:00.000Z",
    }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(calls.generateInputs, [
    {
      accountId: "acct-1",
      kind: "daily",
      windowStart: "2026-06-23T00:00:00.000Z",
      windowEnd: "2026-06-23T08:00:00.000Z",
    },
  ]);
  assert.deepEqual(await res.json(), {
    ok: true,
    digest: { ...digest, kind: "daily" },
  });
});

test("POST /api/digests/generate forwards optional manual scope", async () => {
  const { app, calls } = makeApp();

  const res = await app.request("/api/digests/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountId: "acct-1",
      kind: "manual",
      scopeKind: "folder",
      scopeKey: "Archive",
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(calls.generateInputs[0]?.scopeKind, "folder");
  assert.equal(calls.generateInputs[0]?.scopeKey, "Archive");
});

test("digest routes reject invalid scope fields", async () => {
  const { app } = makeApp();

  const status = await app.request(
    "/api/digests/status?accountId=acct-1&scopeKind=folder&scopeKey=%20%20",
  );

  assert.equal(status.status, 400);
  assert.deepEqual(await status.json(), {
    ok: false,
    error: "scopeKey is required when scopeKind is provided",
    field: "scopeKey",
  });
});

test("POST /api/digests/generate maps known service errors", async () => {
  const llm = makeApp({
    generate: () => {
      throw new Error("llm-not-configured");
    },
  });

  const llmRes = await llm.app.request("/api/digests/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct-1", kind: "manual" }),
  });
  assert.equal(llmRes.status, 409);
  assert.deepEqual(await llmRes.json(), {
    ok: false,
    error: "llm-not-configured",
  });

  const invalidWindow = makeApp({
    generate: () => {
      throw new Error("invalid-digest-window");
    },
  });
  const windowRes = await invalidWindow.app.request("/api/digests/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct-1", kind: "manual" }),
  });
  assert.equal(windowRes.status, 400);
  assert.deepEqual(await windowRes.json(), {
    ok: false,
    error: "invalid-digest-window",
    field: "window",
  });

  const invalidResult = makeApp({
    generate: () => {
      throw new Error("invalid-mail-digest-result");
    },
  });
  const invalidResultRes = await invalidResult.app.request("/api/digests/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct-1", kind: "manual" }),
  });
  assert.equal(invalidResultRes.status, 500);
  assert.deepEqual(await invalidResultRes.json(), {
    ok: false,
    error: "invalid-mail-digest-result",
  });
});
