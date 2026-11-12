import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { openOrCreateMailDatabase } from "../../wemail/database/Database.js";
import { FileSecretStore } from "../../wemail/security/SecretStore.js";
import { createSettingsApp } from "./settingsRoutes.js";
import { AiUsageRepository } from "../../wemail/settings/AiUsageRepository.js";
import type { LlmProvider } from "../../wemail/settings/LlmSettingsService.js";
import { LearningSummaryService } from "../../wemail/personalization/LearningSummaryService.js";
import { insertCanonicalTestAccount } from "../../wemail/database/MailDatabase.test-support.js";
import { DEFAULT_BUSINESS_PREFERENCES } from "../../../shared/wemail/businessPreferences.js";

function makeApp(
  now: () => string = () => "2026-04-26T12:00:00.000Z",
  options: Parameters<typeof createSettingsApp>[0] extends infer T
    ? Partial<Omit<T, "db" | "secrets" | "now">>
    : never = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-settings-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1" });
  const secrets = new FileSecretStore({ baseDir: path.join(dir, "secrets") });
  const app = new Hono();
  app.route("/api/settings", createSettingsApp({ db, secrets, now, ...options }));
  return { app, db, dir };
}

test("business preference routes use the database service and await committed writes", async () => {
  let complete!: () => void;
  const committed = new Promise<void>((resolve) => { complete = resolve; });
  const { app, db, dir } = makeApp(undefined, { mailDatabase: {
    getBusinessPreferences: async () => ({ stored: true, preferences: DEFAULT_BUSINESS_PREFERENCES }),
    saveBusinessPreferences: async (patch) => {
      await committed;
      return { value: { ...DEFAULT_BUSINESS_PREFERENCES, ...patch }, commitVersion: 42,
        changes: [{ entityType: "setting", entityPublicId: "business-preferences", operation: "update" }] };
    },
  } });
  try {
    db.pragma("query_only = ON");
    assert.deepEqual(await (await app.request("/api/settings/business-preferences")).json(),
      { ok: true, stored: true, preferences: DEFAULT_BUSINESS_PREFERENCES });
    let responded = false;
    const response = Promise.resolve(app.request("/api/settings/business-preferences", { method: "PUT",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ newMailNotifications: false }),
    })).then((result) => { responded = true; return result; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(responded, false);
    complete();
    const result = await response;
    assert.equal(result.status, 200);
    assert.equal((await result.json() as { preferences: { newMailNotifications: boolean } }).preferences.newMailNotifications, false);
    assert.equal(db.prepare("SELECT COUNT(*) FROM business_preferences").pluck().get(), 0);
  } finally {
    complete();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("business preference failures do not fall back to main-process SQL and invalid patches are rejected", async () => {
  let writes = 0;
  const { app, db, dir } = makeApp(undefined, { mailDatabase: {
    getBusinessPreferences: async () => { throw new Error("reader-offline"); },
    saveBusinessPreferences: async () => { writes += 1; throw new Error("writer-offline"); },
  } });
  try {
    assert.equal((await app.request("/api/settings/business-preferences")).status, 503);
    for (const [body, status] of [[{ notificationSound: false }, 503], [{ notificationSound: "yes" }, 400], [{ secret: "no" }, 400]] as const) {
      assert.equal((await app.request("/api/settings/business-preferences", { method: "PUT",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      })).status, status);
    }
    assert.equal(writes, 1);
    assert.equal(db.prepare("SELECT COUNT(*) FROM business_preferences").pluck().get(), 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AI profile settings can be saved and read", async () => {
  const { app } = makeApp();
  const put = await app.request("/api/settings/ai-profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userDisplayName: "Ada",
      assistantPreference: "concise",
      summaryLanguage: "zh-CN",
      todoLanguage: "zh-CN",
      composeLanguage: "en",
    }),
  });
  assert.equal(put.status, 200);
  const saved = (await put.json()) as { profile: { userDisplayName: string } };
  assert.equal(saved.profile.userDisplayName, "Ada");

  const get = await app.request("/api/settings/ai-profile");
  assert.equal(get.status, 200);
  const read = (await get.json()) as { profile: { assistantPreference: string } };
  assert.equal(read.profile.assistantPreference, "concise");
});

test("AI profile custom instructions can be cleared with an empty string", async () => {
  const { app } = makeApp();
  const saved = await app.request("/api/settings/ai-profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customInstructions: "Keep these rules",
    }),
  });
  assert.equal(saved.status, 200);

  const cleared = await app.request("/api/settings/ai-profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customInstructions: "",
    }),
  });
  assert.equal(cleared.status, 200);
  const clearedBody = (await cleared.json()) as {
    profile: { customInstructions?: string };
  };
  assert.equal(clearedBody.profile.customInstructions, "");

  const get = await app.request("/api/settings/ai-profile");
  assert.equal(get.status, 200);
  const read = (await get.json()) as {
    profile: { customInstructions?: string };
  };
  assert.equal(read.profile.customInstructions, "");
});

test("AI worker concurrency can be saved, clamped, and read back", async () => {
  const events: number[] = [];
  const { app } = makeApp(undefined, {
    onAiWorkerConcurrencyChanged: (n) => {
      events.push(n);
    },
  });

  const put = await app.request("/api/settings/ai-worker-concurrency", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ concurrency: 6 }),
  });
  assert.equal(put.status, 200);
  const saved = (await put.json()) as { ok: boolean; concurrency: number };
  assert.equal(saved.ok, true);
  assert.equal(saved.concurrency, 6);
  assert.deepEqual(events, [6], "change is emitted with the saved value");

  const get = await app.request("/api/settings/ai-worker-concurrency");
  assert.equal(get.status, 200);
  const read = (await get.json()) as { ok: boolean; concurrency: number };
  assert.equal(read.concurrency, 6, "persisted value is read back");
});

test("AI worker concurrency PUT clamps to [1, 16]", async () => {
  const events: number[] = [];
  const { app } = makeApp(undefined, {
    onAiWorkerConcurrencyChanged: (n) => {
      events.push(n);
    },
  });
  const low = await app.request("/api/settings/ai-worker-concurrency", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ concurrency: 0 }),
  });
  assert.equal(((await low.json()) as { concurrency: number }).concurrency, 1);

  const high = await app.request("/api/settings/ai-worker-concurrency", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ concurrency: 50 }),
  });
  assert.equal(((await high.json()) as { concurrency: number }).concurrency, 16);
  assert.deepEqual(events, [1, 16], "emitted values are clamped");
});

test("AI worker concurrency PUT rejects non-integers and missing field", async () => {
  const { app } = makeApp();
  const fractional = await app.request("/api/settings/ai-worker-concurrency", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ concurrency: 3.5 }),
  });
  assert.equal(fractional.status, 400);

  const missing = await app.request("/api/settings/ai-worker-concurrency", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(missing.status, 400);
});

test("writing styles support CRUD", async () => {
  const { app } = makeApp();
  const created = await app.request("/api/settings/writing-styles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Formal",
      description: "Polished business tone",
      instructions: "Use concise formal language.",
    }),
  });
  assert.equal(created.status, 200);
  const style = ((await created.json()) as { style: { id: string; name: string } }).style;
  assert.equal(style.name, "Formal");

  const updated = await app.request(`/api/settings/writing-styles/${style.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Executive" }),
  });
  assert.equal(updated.status, 200);
  assert.equal(((await updated.json()) as { style: { name: string } }).style.name, "Executive");

  const list = await app.request("/api/settings/writing-styles");
  assert.equal(((await list.json()) as { styles: unknown[] }).styles.length, 1);

  const deleted = await app.request(`/api/settings/writing-styles/${style.id}`, {
    method: "DELETE",
  });
  assert.equal(deleted.status, 200);
  assert.equal(((await (await app.request("/api/settings/writing-styles")).json()) as { styles: unknown[] }).styles.length, 0);
});

test("GET /api/settings/usage returns fixed 30d token buckets", async () => {
  const { app, db } = makeApp();
  const usage = new AiUsageRepository(db, () => "2026-04-24T12:00:00.000Z");
  usage.record({
    accountId: "acct-1",
    category: "summary",
    processor: "summary",
    inputTokens: 10,
    outputTokens: 5,
    model: "gpt-4o-mini",
  });
  usage.record({
    accountId: "acct-1",
    category: "agent_chat",
    processor: "agent",
    inputTokens: 20,
    outputTokens: 7,
    model: "gpt-4o-mini",
  });
  usage.record({
    accountId: "acct-2",
    category: "summary",
    processor: "summary",
    inputTokens: 99,
    outputTokens: 99,
  });

  const res = await app.request("/api/settings/usage?accountId=acct-1&period=30d");

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    period: string;
    usage: Array<{ category: string; label: string; tokens: number; calls: number }>;
  };
  assert.equal(body.ok, true);
  assert.equal(body.period, "30d");
  assert.equal(body.usage.length, 7);
  assert.deepEqual(body.usage.find((row) => row.category === "summary"), {
    category: "summary",
    label: "摘要",
    tokens: 15,
    calls: 1,
  });
  assert.deepEqual(body.usage.find((row) => row.category === "agent_chat"), {
    category: "agent_chat",
    label: "AI 聊天",
    tokens: 27,
    calls: 1,
  });
  assert.equal(body.usage.find((row) => row.category === "automation")!.tokens, 0);
});

test("PUT /api/settings/llm prefers Anthropic and saves the first structured-capable provider", async () => {
  const attempts: LlmProvider[] = [];
  const routed = new Hono();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-settings-probe-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  const secrets = new FileSecretStore({ baseDir: path.join(dir, "secrets") });
  routed.route(
    "/api/settings",
    createSettingsApp({
      db,
      secrets,
      llmProbe: async (candidate) => {
        attempts.push(candidate.provider);
        if (candidate.provider === "openai") {
          throw new Error("openai rejected this endpoint");
        }
      },
    }),
  );

  const res = await routed.request("/api/settings/llm", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: "http://127.0.0.1:9999",
      apiKey: "test-key",
      defaultModel: "claude-test",
    }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(attempts, ["anthropic"]);
  const body = (await res.json()) as { llm: { provider: LlmProvider; hasApiKey: boolean } };
  assert.equal(body.llm.provider, "anthropic");
  assert.equal(body.llm.hasApiKey, true);
});

test("PUT /api/settings/llm saves routing-only edits without probing the endpoint again", async () => {
  let probeCount = 0;
  const { app } = makeApp(undefined, {
    llmProbe: async () => {
      probeCount += 1;
    },
  });

  const initial = await app.request("/api/settings/llm", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: "https://models.example.com/v1",
      apiKey: "stored-secret",
      defaultModel: "default-model",
    }),
  });
  assert.equal(initial.status, 200);
  assert.equal(probeCount, 1);

  const updated = await app.request("/api/settings/llm", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: "https://models.example.com/v1",
      defaultModel: "next-model",
      agentModel: "agent-model",
      reasoningEffort: "low",
    }),
  });
  assert.equal(updated.status, 200);
  assert.equal(probeCount, 1);
  const saved = (await updated.json() as {
    llm: { defaultModel: string; agentModel?: string; reasoningEffort?: string };
  }).llm;
  assert.equal(saved.defaultModel, "next-model");
  assert.equal(saved.reasoningEffort, "low");
});

test("PUT /api/settings/llm rejects unsupported reasoning effort values", async () => {
  const { app } = makeApp();
  const response = await app.request("/api/settings/llm", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      apiKey: "stored-secret",
      defaultModel: "default-model",
      reasoningEffort: "invalid",
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { field: string }).field, "reasoningEffort");
});

test("PUT /api/settings/llm still saves a manual configuration when every probe fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-settings-probe-fail-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  const secrets = new FileSecretStore({ baseDir: path.join(dir, "secrets") });
  let settingsSavedArgs: unknown[] = [];
  const app = new Hono();
  app.route(
    "/api/settings",
    createSettingsApp({
      db,
      secrets,
      llmProbe: async (candidate) => {
        throw new Error(`${candidate.provider} failed`);
      },
      onLlmSettingsSaved: (...args: unknown[]) => {
        settingsSavedArgs = args;
      },
    }),
  );

  const res = await app.request("/api/settings/llm", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: "http://127.0.0.1:9999/anthropic",
      apiKey: "bad-key",
      defaultModel: "model",
    }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    llm: { provider: LlmProvider; baseUrl?: string; defaultModel: string };
    probe: { ok: boolean; manualSave: boolean; attempts: Array<{ provider: string }> };
  };
  assert.equal(body.ok, true);
  assert.equal(body.llm.provider, "anthropic");
  assert.equal(body.llm.baseUrl, "http://127.0.0.1:9999/anthropic");
  assert.equal(body.llm.defaultModel, "model");
  assert.equal(body.probe.ok, false);
  assert.equal(body.probe.manualSave, true);
  assert.deepEqual(
    body.probe.attempts.map((a) => a.provider),
    ["anthropic", "openai"],
  );
  assert.equal(settingsSavedArgs.length, 1);
  assert.equal(
    (settingsSavedArgs[0] as { defaultModel: string }).defaultModel,
    "model",
  );
  const saved = await app.request("/api/settings/llm");
  assert.equal((await saved.json() as { llm: { provider: LlmProvider } }).llm.provider, "anthropic");
});

test("POST /api/settings/llm/discover-models lists and deduplicates OpenAI-compatible models", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const { app } = makeApp(undefined, {
    llmModelFetch: async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({
        object: "list",
        data: [
          { id: "gpt-test", owned_by: "example" },
          { id: "gpt-test", owned_by: "example" },
          { id: "gpt-other", owned_by: "example" },
        ],
      });
    },
  });

  const res = await app.request("/api/settings/llm/discover-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: "https://models.example.com/v1/",
      apiKey: "secret-key",
    }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(requests, [{
    url: "https://models.example.com/v1/models",
    authorization: "Bearer secret-key",
  }]);
  assert.deepEqual(await res.json(), {
    ok: true,
    provider: "openai",
    models: [
      { id: "gpt-other", ownedBy: "example" },
      { id: "gpt-test", ownedBy: "example" },
    ],
  });
});

test("POST /api/settings/llm/discover-models probes the complete base URL and its origin", async () => {
  const requests: Array<{
    url: string;
    authorization: string | null;
    apiKey: string | null;
  }> = [];
  const { app } = makeApp(undefined, {
    llmModelFetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      requests.push({
        url,
        authorization: headers.get("authorization"),
        apiKey: headers.get("x-api-key"),
      });
      if (url === "https://api.deepseek.com/anthropic/v1/models") {
        return new Response(null, { status: 404 });
      }
      return Response.json({ data: [{ id: "deepseek-v4-flash" }] });
    },
  });

  const res = await app.request("/api/settings/llm/discover-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "anthropic",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "secret-key",
    }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(requests.map((request) => request.url).sort(), [
    "https://api.deepseek.com/anthropic/v1/models",
    "https://api.deepseek.com/v1/models",
  ]);
  const originRequest = requests.find((request) => request.url === "https://api.deepseek.com/v1/models");
  assert.equal(originRequest?.authorization, "Bearer secret-key");
  assert.equal(originRequest?.apiKey, null);
  assert.deepEqual(await res.json(), {
    ok: true,
    provider: "openai",
    models: [{ id: "deepseek-v4-flash" }],
  });
});

test("POST /api/settings/llm/discover-models falls back to Anthropic headers", async () => {
  const requests: Array<{ url: string; authorization: string | null; apiKey: string | null; version: string | null }> = [];
  const { app } = makeApp(undefined, {
    llmModelFetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
        apiKey: headers.get("x-api-key"),
        version: headers.get("anthropic-version"),
      });
      if (headers.has("authorization")) {
        return new Response(null, { status: 401 });
      }
      return Response.json({
        data: [{ id: "claude-test" }],
        has_more: false,
      });
    },
  });

  const res = await app.request("/api/settings/llm/discover-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "openai",
      baseUrl: "https://api.anthropic.com",
      apiKey: "anthropic-secret",
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(requests.length, 2);
  const anthropicRequest = requests.at(-1);
  assert.equal(anthropicRequest?.url, "https://api.anthropic.com/v1/models");
  assert.equal(anthropicRequest?.authorization, null);
  assert.equal(anthropicRequest?.apiKey, "anthropic-secret");
  assert.equal(anthropicRequest?.version, "2023-06-01");
  assert.deepEqual(await res.json(), {
    ok: true,
    provider: "anthropic",
    models: [{ id: "claude-test" }],
  });
});

test("POST /api/settings/llm/discover-models reuses a stored API key without changing settings", async () => {
  let observedApiKey = "";
  let settingsSavedCount = 0;
  const { app } = makeApp(undefined, {
    llmProbe: async () => undefined,
    onLlmSettingsSaved: () => {
      settingsSavedCount += 1;
    },
    llmModelFetch: async (_input, init) => {
      observedApiKey = new Headers(init?.headers).get("x-api-key") ?? "";
      return Response.json({ data: [{ id: "stored-model" }] });
    },
  });
  const saved = await app.request("/api/settings/llm", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "stored-secret", defaultModel: "saved-model" }),
  });
  assert.equal(saved.status, 200);
  assert.equal(settingsSavedCount, 1);

  const discovered = await app.request("/api/settings/llm/discover-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(discovered.status, 200);
  assert.equal(observedApiKey, "stored-secret");
  assert.equal(settingsSavedCount, 1);

  const after = await app.request("/api/settings/llm");
  const body = (await after.json()) as { llm: { defaultModel: string } };
  assert.equal(body.llm.defaultModel, "saved-model");
});

test("POST /api/settings/llm/discover-models reuses the active runtime key when settings are not persisted", async () => {
  let observedApiKey = "";
  const { app } = makeApp(undefined, {
    getLlmRuntimeSettings: () => ({
      provider: "anthropic",
      apiKey: "runtime-secret",
      baseUrl: "https://runtime.example.com",
      defaultModel: "runtime-model",
    }),
    llmModelFetch: async (_input, init) => {
      observedApiKey = new Headers(init?.headers).get("x-api-key") ?? "";
      return Response.json({ data: [{ id: "runtime-model" }] });
    },
  });

  const discovered = await app.request("/api/settings/llm/discover-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(discovered.status, 200);
  assert.equal(observedApiKey, "runtime-secret");
  assert.deepEqual(await discovered.json(), {
    ok: true,
    provider: "anthropic",
    models: [{ id: "runtime-model" }],
  });
});

test("POST /api/settings/llm/discover-models returns safe failures and never exposes upstream bodies", async () => {
  const { app } = makeApp(undefined, {
    llmModelFetch: async () => new Response("credential secret appeared here", { status: 403 }),
  });

  const res = await app.request("/api/settings/llm/discover-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "bad-secret" }),
  });

  assert.equal(res.status, 400);
  const text = await res.text();
  assert.doesNotMatch(text, /credential secret|bad-secret/);
  const body = JSON.parse(text) as { ok: boolean; attempts: Array<{ provider: string; status?: number }> };
  assert.equal(body.ok, false);
  assert.deepEqual(body.attempts.map((attempt) => attempt.provider), ["openai", "anthropic"]);
  assert.deepEqual(body.attempts.map((attempt) => attempt.status), [403, 403]);
});

test("POST /api/settings/llm/detect-local reports a reachable gateway with models", async () => {
  const requests: string[] = [];
  const { app } = makeApp(undefined, {
    llmModelFetch: async (input) => {
      requests.push(String(input));
      return Response.json({
        object: "list",
        data: [
          { id: "deepseek-v4-flash", owned_by: "sub2agent" },
          { id: "deepseek-v3.1", owned_by: "sub2agent" },
        ],
      });
    },
  });

  const res = await app.request("/api/settings/llm/detect-local", {
    method: "POST",
  });

  assert.equal(res.status, 200);
  assert.deepEqual(requests, ["http://127.0.0.1:8989/v1/models"]);
  assert.deepEqual(await res.json(), {
    ok: true,
    reachable: true,
    baseUrl: "http://127.0.0.1:8989/v1",
    provider: "openai",
    models: [
      { id: "deepseek-v3.1", ownedBy: "sub2agent" },
      { id: "deepseek-v4-flash", ownedBy: "sub2agent" },
    ],
  });
});

test("POST /api/settings/llm/detect-local marks an auth-challenged gateway as reachable", async () => {
  const { app } = makeApp(undefined, {
    llmModelFetch: async () => new Response("Unauthorized", { status: 401 }),
  });

  const res = await app.request("/api/settings/llm/detect-local", {
    method: "POST",
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    reachable: true,
    baseUrl: "http://127.0.0.1:8989/v1",
    requiresAuth: true,
    provider: "openai",
  });
});

test("POST /api/settings/llm/detect-local reports unreachable when the gateway is down", async () => {
  const { app } = makeApp(undefined, {
    llmModelFetch: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8989");
    },
  });

  const res = await app.request("/api/settings/llm/detect-local", {
    method: "POST",
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, reachable: false });
});

test("AI profile settings can save and read new personalization fields", async () => {
  const { app } = makeApp();
  const put = await app.request("/api/settings/ai-profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userDisplayName: "Ada",
      importantContacts: ["alice@example.com", "bob@example.com"],
      defaultSummaryLanguage: "zh-CN",
      defaultReplyTone: "formal",
      signaturePreference: "always",
    }),
  });
  assert.equal(put.status, 200);
  const saved = (await put.json()) as {
    profile: {
      importantContacts?: string[];
      defaultSummaryLanguage?: string;
      defaultReplyTone?: string;
      signaturePreference?: string;
    };
  };
  assert.deepEqual(saved.profile.importantContacts, ["alice@example.com", "bob@example.com"]);
  assert.equal(saved.profile.defaultSummaryLanguage, "zh-CN");
  assert.equal(saved.profile.defaultReplyTone, "formal");
  assert.equal(saved.profile.signaturePreference, "always");

  const get = await app.request("/api/settings/ai-profile");
  assert.equal(get.status, 200);
  const read = (await get.json()) as {
    profile: {
      importantContacts?: string[];
      defaultSummaryLanguage?: string;
      defaultReplyTone?: string;
      signaturePreference?: string;
    };
  };
  assert.deepEqual(read.profile.importantContacts, ["alice@example.com", "bob@example.com"]);
  assert.equal(read.profile.defaultSummaryLanguage, "zh-CN");
  assert.equal(read.profile.defaultReplyTone, "formal");
  assert.equal(read.profile.signaturePreference, "always");
});

test("POST /api/settings/reset-learned clears learning summaries", async () => {
  const { app, db } = makeApp();
  const learningSummary = new LearningSummaryService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  // Create a learning summary
  learningSummary.save({
    accountId: "acct-1",
    feature: "tags",
    signals: { suppressedTags: ["newsletter"] },
  });
  learningSummary.save({
    accountId: "acct-1",
    feature: "summary",
    signals: { averageRating: 4.2 },
  });

  // Verify summaries exist
  assert.equal(learningSummary.listByAccount("acct-1").length, 2);

  // Reset all learned preferences
  const res = await app.request("/api/settings/reset-learned", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct-1" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, true);

  // Verify summaries are cleared
  assert.equal(learningSummary.listByAccount("acct-1").length, 0);
});

test("POST /api/settings/reset-learned clears only specified feature", async () => {
  const { app, db } = makeApp();
  const learningSummary = new LearningSummaryService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  learningSummary.save({
    accountId: "acct-1",
    feature: "tags",
    signals: { suppressedTags: ["newsletter"] },
  });
  learningSummary.save({
    accountId: "acct-1",
    feature: "summary",
    signals: { averageRating: 4.2 },
  });

  const res = await app.request("/api/settings/reset-learned", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct-1", feature: "tags" }),
  });
  assert.equal(res.status, 200);

  // Tags should be cleared, summary should remain
  assert.equal(learningSummary.get("acct-1", "tags"), null);
  assert.ok(learningSummary.get("acct-1", "summary"));
});

test("POST /api/settings/reset-learned requires accountId", async () => {
  const { app } = makeApp();
  const res = await app.request("/api/settings/reset-learned", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.ok(body.error.includes("accountId"));
});

test("GET /api/settings/usage-stats returns stable buckets with processor version details", async () => {
  const { app, db } = makeApp();
  const usage = new AiUsageRepository(db, () => "2026-04-26T12:00:00.000Z");

  usage.record({
    accountId: "acct-1",
    category: "summary",
    processor: "summary",
    inputTokens: 100,
    outputTokens: 50,
    model: "gpt-4o-mini",
    processorVersion: 1,
    durationMs: 1200,
  });

  usage.record({
    accountId: "acct-1",
    category: "summary",
    processor: "summary",
    inputTokens: 200,
    outputTokens: 80,
    model: "gpt-4o-mini",
    processorVersion: 2,
    durationMs: 800,
  });

  const res = await app.request("/api/settings/usage-stats?accountId=acct-1&period=30d");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    period: string;
    stats: Array<{
      category: string;
      label: string;
      tokens: number;
      calls: number;
      details: Array<{
        processor: string;
        processorVersion: number;
        model: string;
        tokens: number;
        calls: number;
        avgDurationMs: number;
      }>;
    }>;
  };
  assert.equal(body.ok, true);
  assert.equal(body.period, "30d");
  assert.equal(body.stats.length, 7);

  const summaryBucket = body.stats.find((b) => b.category === "summary");
  assert.ok(summaryBucket);
  assert.equal(summaryBucket.tokens, 430);
  assert.equal(summaryBucket.calls, 2);
  assert.equal(summaryBucket.details.length, 2);

  const v1 = summaryBucket.details.find((d) => d.processorVersion === 1);
  assert.ok(v1);
  assert.equal(v1.tokens, 150);
  assert.equal(v1.calls, 1);
  assert.equal(v1.model, "gpt-4o-mini");

  const v2 = summaryBucket.details.find((d) => d.processorVersion === 2);
  assert.ok(v2);
  assert.equal(v2.tokens, 280);
  assert.equal(v2.calls, 1);
});

test("GET /api/settings/usage-stats requires accountId", async () => {
  const { app } = makeApp();
  const res = await app.request("/api/settings/usage-stats?period=30d");
  assert.equal(res.status, 400);
});

test("GET /api/settings/usage-stats accepts account chart periods", async () => {
  const { app } = makeApp();
  for (const period of ["30d", "90d", "180d", "365d"]) {
    const res = await app.request(`/api/settings/usage-stats?accountId=acct-1&period=${period}`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { period: string }).period, period);
  }

  const invalid = await app.request("/api/settings/usage-stats?accountId=acct-1&period=all");
  assert.equal(invalid.status, 400);
});

test("GET /api/settings/learning-summaries returns summaries for an account", async () => {
  const { app, db } = makeApp();
  const learningSummary = new LearningSummaryService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  learningSummary.save({
    accountId: "acct-1",
    feature: "tags",
    signals: { suppressedTags: ["newsletter"] },
  });

  const res = await app.request("/api/settings/learning-summaries?accountId=acct-1");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    summaries: Array<{ feature: string; accountId: string; signals: Record<string, unknown> }>;
  };
  assert.equal(body.ok, true);
  assert.equal(body.summaries.length, 1);
  assert.equal(body.summaries[0]!.feature, "tags");
});

test("GET /api/settings/learning-summaries requires accountId", async () => {
  const { app } = makeApp();
  const res = await app.request("/api/settings/learning-summaries");
  assert.equal(res.status, 400);
});
