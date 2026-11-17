import { BusinessPreferencesPatchSchema } from "../../../shared/wemail/businessPreferences.js";
import type { MailDatabaseClient } from "../../wemail/database/MailDatabaseClient.js";
import { Hono } from "hono";
import {
  LlmSettingsService,
  type LlmProvider,
  type LlmRuntimeSettings,
} from "../../wemail/settings/LlmSettingsService.js";
import {
  AiProfileSettingsService,
  AiProfileValidationError,
} from "../../wemail/settings/AiProfileSettingsService.js";
import {
  AI_WORKER_CONCURRENCY_MAX,
  AI_WORKER_CONCURRENCY_MIN,
  CUSTOM_INSTRUCTIONS_MAX_LENGTH,
  LLM_REASONING_EFFORT_VALUES,
  TODO_PROMPT_MAX_LENGTH,
  type LlmReasoningEffort,
} from "../../../shared/wemail/settings.js";
import { AiUsageRepository } from "../../wemail/settings/AiUsageRepository.js";
import { LearningSummaryService } from "../../wemail/personalization/LearningSummaryService.js";
import { UsageStatsService } from "../../wemail/personalization/UsageStatsService.js";
import type { IntelligenceJobType } from "../../../shared/wemail/intelligence.js";
import type {
  UsagePeriod,
  UsageTimeseriesGranularity,
} from "../../../shared/wemail/usage.js";
import type { MailDatabase } from "../../wemail/database/Database.js";
import type { SecretStore } from "../../wemail/security/SecretStore.js";
import { BusinessPreferenceService } from "../../wemail/settings/BusinessPreferenceService.js";
import {
  detectLocalGateway,
  discoverLlmModels,
} from "../../wemail/settings/LlmModelDiscovery.js";

export interface CreateSettingsAppDeps {
  db: MailDatabase;
  mailDatabase?: Pick<MailDatabaseClient, "getBusinessPreferences" | "saveBusinessPreferences">;
  secrets: SecretStore;
  now?: () => string;
  llmProbe?: LlmProbe;
  llmModelFetch?: typeof fetch;
  /**
   * Fallback for configurations supplied by the composition root (for
   * example an environment-backed runtime without a persisted settings row).
   * The API key is only consumed server-side and is never serialized.
   */
  getLlmRuntimeSettings?: () => LlmRuntimeSettings | null;
  onLlmSettingsSaved?: (settings: {
    provider: LlmProvider;
    apiKey: string;
    baseUrl?: string;
    defaultModel: string;
    summaryModel?: string;
    draftModel?: string;
    agentModel?: string;
    reasoningEffort?: LlmReasoningEffort;
  }) => Promise<void> | void;
  /**
   * Notified after the AI worker concurrency setting is persisted. The
   * composition fans this out via `notifyAiWorkerConcurrencyChanged` to
   * live-resize the CanonicalAiWorkerPool. Mirrors `onLlmSettingsSaved`.
   */
  onAiWorkerConcurrencyChanged?: (concurrency: number) => Promise<void> | void;
}

const PROVIDERS = new Set<LlmProvider>(["openai", "anthropic"]);
const PROBE_TIMEOUT_MS = 10_000;
const ANTHROPIC_VERSION = "2023-06-01";

export interface LlmProbeCandidate {
  provider: LlmProvider;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export type LlmProbe = (candidate: LlmProbeCandidate) => Promise<void>;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function normalizedBaseUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function anthropicBaseUrl(value: string | undefined): string | undefined {
  const normalized = normalizedBaseUrl(value);
  if (!normalized) return undefined;
  const withoutMessages = normalized.replace(/\/(?:v1\/)?messages$/i, "");
  return withoutMessages.replace(/\/v1$/i, "") || undefined;
}

function openAiBaseUrl(value: string | undefined): string | undefined {
  const normalized = normalizedBaseUrl(value);
  if (!normalized) return undefined;
  if (!/\/anthropic(?:\/v1)?(?:\/messages)?$/i.test(normalized)) return normalized;
  try {
    return new URL(normalized).origin;
  } catch {
    return normalized.replace(/\/anthropic(?:\/v1)?(?:\/messages)?$/i, "") || undefined;
  }
}

function explicitProvider(body: unknown): LlmProvider | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>).provider;
  return typeof value === "string" && PROVIDERS.has(value as LlmProvider)
    ? value as LlmProvider
    : undefined;
}

function providerForUnverifiedSave(
  body: unknown,
  baseUrl: string | undefined,
  previous: { provider: LlmProvider } | null,
): LlmProvider {
  const explicit = explicitProvider(body);
  if (explicit) return explicit;
  if (/\/anthropic(?:\/v1)?(?:\/messages)?$/i.test(normalizedBaseUrl(baseUrl))) {
    return "anthropic";
  }
  return previous?.provider ?? "openai";
}

/**
 * A model-routing edit does not change the endpoint or credentials. Keep the
 * synchronous probe for first-time setup and connection changes; routing-only
 * updates can be committed immediately once the endpoint is already on the
 * preferred Anthropic transport. Existing OpenAI selections are re-probed so
 * a dual-protocol gateway can migrate without a client-side setting change.
 */
function needsLlmProbe(
  body: unknown,
  input: { apiKey?: string; baseUrl?: string },
  previous: { provider: LlmProvider; apiKey: string; baseUrl?: string } | null,
): boolean {
  if (!previous) return true;
  // Re-probe an existing OpenAI selection so a provider that also exposes
  // Anthropic tool-use can move to the preferred structured-output path.
  if (previous.provider !== "anthropic") return true;
  const provider = explicitProvider(body);
  if (provider && provider !== previous.provider) return true;
  if (input.apiKey !== undefined) return true;
  return normalizedBaseUrl(input.baseUrl) !== normalizedBaseUrl(previous.baseUrl);
}

function validateLlmBody(body: unknown):
  | {
      provider: LlmProvider;
      apiKey?: string;
      baseUrl?: string;
      defaultModel: string;
      summaryModel?: string;
      draftModel?: string;
      agentModel?: string;
      reasoningEffort?: LlmReasoningEffort;
    }
  | { field: string; error: string } {
  if (!body || typeof body !== "object") {
    return { field: "body", error: "request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (b.provider !== undefined && (typeof b.provider !== "string" || !PROVIDERS.has(b.provider as LlmProvider))) {
    return { field: "provider", error: "provider must be openai or anthropic" };
  }
  if (!isNonEmptyString(b.defaultModel)) {
    return { field: "defaultModel", error: "defaultModel is required" };
  }
  if (b.apiKey !== undefined && typeof b.apiKey !== "string") {
    return { field: "apiKey", error: "apiKey must be a string" };
  }
  if (!validLlmBaseUrl(b.baseUrl)) {
    return { field: "baseUrl", error: "baseUrl must be an HTTP(S) URL without credentials, query, or fragment" };
  }
  if (b.reasoningEffort !== undefined &&
      !LLM_REASONING_EFFORT_VALUES.includes(b.reasoningEffort as LlmReasoningEffort)) {
    return {
      field: "reasoningEffort",
      error: `reasoningEffort must be one of ${LLM_REASONING_EFFORT_VALUES.join(", ")}`,
    };
  }

  return {
    provider: (PROVIDERS.has(b.provider as LlmProvider) ? b.provider : "openai") as LlmProvider,
    apiKey: optionalString(b.apiKey),
    baseUrl: optionalString(b.baseUrl),
    defaultModel: b.defaultModel.trim(),
    summaryModel: optionalString(b.summaryModel),
    draftModel: optionalString(b.draftModel),
    agentModel: optionalString(b.agentModel),
    reasoningEffort: b.reasoningEffort as LlmReasoningEffort | undefined,
  };
}

function validLlmBaseUrl(value: unknown): boolean {
  if (value === undefined || value === "") return true;
  if (typeof value !== "string") return false;
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * URL of the provider-specific model-list endpoint. Only the model LIST is
 * probed — never an individual model's chat capability.
 */
function modelListProbeUrl(candidate: LlmProbeCandidate): string {
  const base = normalizedBaseUrl(
    candidate.provider === "openai"
      ? openAiBaseUrl(candidate.baseUrl) ?? "https://api.openai.com/v1"
      : anthropicBaseUrl(candidate.baseUrl) ?? "https://api.anthropic.com",
  );
  if (candidate.provider === "openai") {
    if (/\/models$/i.test(base)) return base;
    return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
  }
  return `${base}/v1/models`;
}

/**
 * Detect an OpenAI-style model list payload. Anthropic's /v1/models returns
 * `{ data: [{ type: "model", id, display_name, ... }] }`; OpenAI-compatible
 * gateways (including dual-protocol ones that also accept `x-api-key` on the
 * models route) return `{ object: "list", data: [{ id, object: "model",
 * created, owned_by }] }`. Used to keep an OpenAI-compatible endpoint from
 * being auto-detected as Anthropic, which would then send the Anthropic chat
 * protocol and get rejected by the gateway's OpenAI-style handler.
 */
function isOpenAiModelsList(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.data)) return false;
  if (record.object === "list") return true;
  if (record.data.length === 0) return false;
  const first = record.data[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return false;
  const entry = first as Record<string, unknown>;
  if (entry.type === "model") return false; // Anthropic shape
  return entry.object === "model" || typeof entry.owned_by === "string";
}

/**
 * Connection probe that ONLY verifies the endpoint's model list responds.
 * It deliberately never runs a chat completion or exercises a specific
 * model, so a quota-limited or temporarily failing model cannot block
 * saving a valid endpoint. The provider (openai vs anthropic) is still
 * detected by probing the provider-specific /models endpoint.
 */
async function probeModelsEndpoint(candidate: LlmProbeCandidate, fetchImpl: typeof fetch = fetch): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(modelListProbeUrl(candidate), {
      method: "GET",
      redirect: "error",
      headers:
        candidate.provider === "openai"
          ? { authorization: `Bearer ${candidate.apiKey}`, accept: "application/json" }
          : { "x-api-key": candidate.apiKey, "anthropic-version": ANTHROPIC_VERSION, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`model-list-request-failed (${response.status})`);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new Error("model-list-invalid-json");
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { data?: unknown }).data)) {
      throw new Error("model-list-invalid-shape");
    }
    if (candidate.provider === "anthropic" && isOpenAiModelsList(parsed)) {
      throw new Error("model-list-openai-shape");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("model-list-timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function detectLlmProvider(args: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  probe: LlmProbe;
}): Promise<
  | { provider: LlmProvider }
  | {
      error: string;
      attempts: Array<{
        provider: LlmProvider;
        error: string;
        code?: string;
        status?: number;
      }>;
    }
> {
  const ordered: LlmProvider[] = ["anthropic", "openai"];
  const attempts: Array<{
    provider: LlmProvider;
    error: string;
    code?: string;
    status?: number;
  }> = [];
  for (const provider of ordered) {
    try {
      await args.probe({
        provider,
        apiKey: args.apiKey,
        baseUrl: args.baseUrl,
        model: args.model,
      });
      return { provider };
    } catch (error) {
      const candidate = error as { status?: unknown } | null;
      attempts.push({
        provider,
        error: "Provider probe failed",
        ...(typeof candidate?.status === "number" && candidate.status > 0
          ? { status: candidate.status }
          : {}),
      });
    }
  }
  return {
    error: "LLM endpoint probe failed for all supported protocols",
    attempts,
  };
}

export function createSettingsApp(deps: CreateSettingsAppDeps): Hono {
  const service = new LlmSettingsService(deps);
  const aiProfile = new AiProfileSettingsService(deps.db);
  const usage = new AiUsageRepository(deps.db, deps.now);
  const learningSummary = new LearningSummaryService({ db: deps.db });
  const usageStats = new UsageStatsService({ db: deps.db, now: deps.now });
  const businessPreferences = new BusinessPreferenceService(deps.db, deps.now);
  const router = new Hono();
  let llmSaveQueue: Promise<void> = Promise.resolve();

  router.get("/business-preferences", async (c) => {
    try {
      const snapshot = deps.mailDatabase?.getBusinessPreferences
        ? await deps.mailDatabase.getBusinessPreferences()
        : { stored: businessPreferences.isStored(), preferences: businessPreferences.get() };
      return c.json({ ok: true, ...snapshot });
    } catch {
      return c.json({ ok: false, error: "preferences-unavailable" }, 503);
    }
  });

  router.put("/business-preferences", async (c) => {
    const parsed = BusinessPreferencesPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: "invalid-business-preferences" }, 400);
    try {
      const preferences = deps.mailDatabase?.saveBusinessPreferences
        ? (await deps.mailDatabase.saveBusinessPreferences(parsed.data)).value
        : businessPreferences.save(parsed.data);
      return c.json({ ok: true, preferences });
    } catch {
      return c.json({ ok: false, error: "preferences-unavailable" }, 503);
    }
  });

  router.get("/llm", (c) => c.json({ llm: service.get() }));

  // Key-less probe of the local sub2agent gateway (127.0.0.1:8989). The
  // onboarding guide uses it to prefill the LLM form when a gateway is up.
  router.post("/llm/detect-local", async (c) =>
    c.json({ ok: true, ...(await detectLocalGateway(deps.llmModelFetch)) }),
  );

  router.post("/llm/discover-models", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) {
      return c.json({ ok: false, error: "invalid json body", field: "body" }, 400);
    }
    if (body.provider !== undefined &&
        (typeof body.provider !== "string" || !PROVIDERS.has(body.provider as LlmProvider))) {
      return c.json({ ok: false, error: "provider must be openai or anthropic", field: "provider" }, 400);
    }
    if (body.apiKey !== undefined && typeof body.apiKey !== "string") {
      return c.json({ ok: false, error: "apiKey must be a string", field: "apiKey" }, 400);
    }
    if (!validLlmBaseUrl(body.baseUrl)) {
      return c.json({ ok: false, error: "baseUrl must be an HTTP(S) URL without credentials, query, or fragment", field: "baseUrl" }, 400);
    }

    const previous = service.getRuntimeSettings() ?? (service.get() ? null : deps.getLlmRuntimeSettings?.() ?? null);
    const apiKey = optionalString(body.apiKey) ?? previous?.apiKey;
    if (!apiKey) {
      return c.json(
        { ok: false, error: "apiKey is required to discover models", field: "apiKey" },
        400,
      );
    }
    if (service.isRetiredKey(apiKey)) {
      return c.json({ ok: false, error: "apiKey is retired; enter your own key", field: "apiKey" }, 400);
    }
    const inputProvider = (PROVIDERS.has(body.provider as LlmProvider)
      ? body.provider
      : previous?.provider ?? "openai") as LlmProvider;
    const discovered = await discoverLlmModels({
      inputProvider,
      apiKey,
      baseUrl: body.baseUrl !== undefined
        ? optionalString(body.baseUrl)
        : previous?.baseUrl,
      fetchImpl: deps.llmModelFetch,
    });
    if ("error" in discovered) {
      return c.json({ ok: false, ...discovered }, 400);
    }
    return c.json({ ok: true, ...discovered });
  });

  router.put("/llm", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid json body", field: "body" }, 400);
    }

    const parsed = validateLlmBody(body);
    if ("error" in parsed) {
      return c.json({ ok: false, error: parsed.error, field: parsed.field }, 400);
    }

    const previousSave = llmSaveQueue;
    let releaseSave!: () => void;
    llmSaveQueue = new Promise<void>((resolve) => { releaseSave = resolve; });
    await previousSave;
    try {
    const stored = service.get();
    const previous = service.getRuntimeSettings() ?? (stored ? null : deps.getLlmRuntimeSettings?.() ?? null);
    const apiKey = parsed.apiKey ?? previous?.apiKey;
    if (!apiKey) {
      return c.json(
        { ok: false, error: "apiKey is required to validate the LLM endpoint", field: "apiKey" },
        400,
      );
    }
    if (service.isRetiredKey(apiKey)) {
      return c.json({ ok: false, error: "apiKey is retired; enter your own key", field: "apiKey" }, 400);
    }
    const shouldProbe = needsLlmProbe(body, parsed, previous);
    const detected = shouldProbe
      ? await detectLlmProvider({
          apiKey,
          baseUrl: parsed.baseUrl,
          model: parsed.defaultModel,
          probe: deps.llmProbe ?? ((candidate) => probeModelsEndpoint(candidate, deps.llmModelFetch)),
        })
      : { provider: previous?.provider ?? parsed.provider };

    const provider = "error" in detected
      ? providerForUnverifiedSave(body, parsed.baseUrl, previous)
      : detected.provider;
    const saveInput = { ...parsed, provider, ...(!stored && !parsed.apiKey ? { apiKey } : {}) };
    const llm = service.save(saveInput);
    let runtimeReloaded = true;
    try {
    await deps.onLlmSettingsSaved?.({
      provider,
      apiKey,
      baseUrl: parsed.baseUrl,
      defaultModel: parsed.defaultModel,
      summaryModel: parsed.summaryModel,
      draftModel: parsed.draftModel,
      agentModel: parsed.agentModel,
      reasoningEffort: llm.reasoningEffort,
    });
    } catch {
      runtimeReloaded = false;
    }
    if ("error" in detected) {
      return c.json({
        ok: true,
        llm,
        runtimeReloaded,
        probe: {
          ok: false,
          error: detected.error,
          attempts: detected.attempts,
          manualSave: true,
        },
      });
    }
    return c.json({ ok: true, llm, runtimeReloaded, probe: { ok: true, provider, skipped: !shouldProbe } });
    } finally {
      releaseSave();
    }
  });

  router.get("/ai-profile", (c) => c.json({ profile: aiProfile.getProfile() }));

  router.get("/ai-worker-concurrency", (c) =>
    c.json({ ok: true, concurrency: aiProfile.getWorkerConcurrency() }),
  );

  router.put("/ai-worker-concurrency", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const raw = body.concurrency;
    if (
      typeof raw !== "number"
      || !Number.isFinite(raw)
      || !Number.isInteger(raw)
    ) {
      return c.json(
        { ok: false, error: "concurrency must be an integer", field: "concurrency" },
        400,
      );
    }
    const clamped = Math.max(
      AI_WORKER_CONCURRENCY_MIN,
      Math.min(AI_WORKER_CONCURRENCY_MAX, raw),
    );
    aiProfile.saveProfile({ workerConcurrency: clamped });
    await deps.onAiWorkerConcurrencyChanged?.(clamped);
    return c.json({ ok: true, concurrency: clamped });
  });

  router.get("/usage", (c) => {
    const accountId = c.req.query("accountId");
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    const period = c.req.query("period") ?? "30d";
    if (period !== "30d") {
      return c.json({ ok: false, error: "period must be 30d", field: "period" }, 400);
    }
    return c.json({
      ok: true,
      period,
      usage: usage.summarize({ accountId, period }),
    });
  });

  router.put("/ai-profile", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    // customInstructions is a free-form Markdown textbox. Empty string is
    // treated as "clear the instructions" (stored as null). Reject anything
    // longer than CUSTOM_INSTRUCTIONS_MAX_LENGTH with a clear field error.
    let customInstructions: string | undefined;
    if (body.customInstructions !== undefined) {
      if (typeof body.customInstructions !== "string") {
        return c.json(
          {
            ok: false,
            error: "customInstructions must be a string",
            field: "customInstructions",
          },
          400,
        );
      }
      if (body.customInstructions.length > CUSTOM_INSTRUCTIONS_MAX_LENGTH) {
        return c.json(
          {
            ok: false,
            error: `customInstructions exceeds maximum length of ${CUSTOM_INSTRUCTIONS_MAX_LENGTH} characters`,
            field: "customInstructions",
          },
          400,
        );
      }
      customInstructions = body.customInstructions.trim();
    }
    let todoPrompt: string | undefined;
    if (body.todoPrompt !== undefined) {
      if (typeof body.todoPrompt !== "string") {
        return c.json({ ok: false, error: "todoPrompt must be a string", field: "todoPrompt" }, 400);
      }
      if (body.todoPrompt.length > TODO_PROMPT_MAX_LENGTH) {
        return c.json({
          ok: false,
          error: `todoPrompt exceeds maximum length of ${TODO_PROMPT_MAX_LENGTH} characters`,
          field: "todoPrompt",
        }, 400);
      }
      todoPrompt = body.todoPrompt.trim();
    }

    try {
      const profile = aiProfile.saveProfile({
        userDisplayName: optionalString(body.userDisplayName),
        assistantPreference: optionalString(body.assistantPreference),
        summaryLanguage: optionalString(body.summaryLanguage),
        todoLanguage: optionalString(body.todoLanguage),
        composeLanguage: optionalString(body.composeLanguage),
        translationLanguage: optionalString(body.translationLanguage),
        importantContacts: Array.isArray(body.importantContacts)
          ? body.importantContacts.filter((v): v is string => typeof v === "string")
          : undefined,
        defaultSummaryLanguage: optionalString(body.defaultSummaryLanguage),
        defaultReplyTone: optionalString(body.defaultReplyTone),
        signaturePreference: optionalString(body.signaturePreference),
        customInstructions,
        todoPrompt,
      });
      return c.json({ ok: true, profile });
    } catch (err) {
      if (err instanceof AiProfileValidationError) {
        return c.json({ ok: false, error: err.message, field: err.field }, 400);
      }
      throw err;
    }
  });

  router.get("/writing-styles", (c) => c.json({ styles: aiProfile.listStyles() }));

  router.post("/writing-styles", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (!isNonEmptyString(body.name)) {
      return c.json({ ok: false, error: "name is required", field: "name" }, 400);
    }
    if (!isNonEmptyString(body.instructions)) {
      return c.json(
        { ok: false, error: "instructions is required", field: "instructions" },
        400,
      );
    }
    const style = aiProfile.createStyle({
      name: body.name.trim(),
      description: optionalString(body.description),
      instructions: body.instructions.trim(),
    });
    return c.json({ ok: true, style });
  });

  router.patch("/writing-styles/:id", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const style = aiProfile.updateStyle(c.req.param("id"), {
      name: optionalString(body.name),
      description: optionalString(body.description),
      instructions: optionalString(body.instructions),
    });
    if (!style) return c.json({ ok: false, error: "style-not-found" }, 404);
    return c.json({ ok: true, style });
  });

  router.delete("/writing-styles/:id", (c) => {
    const deleted = aiProfile.deleteStyle(c.req.param("id"));
    if (!deleted) return c.json({ ok: false, error: "style-not-found" }, 404);
    return c.json({ ok: true });
  });

  // --- Personalization endpoints ---

  /**
   * GET /learning-summaries?accountId=xxx
   * Returns all learning summaries for an account.
   */
  router.get("/learning-summaries", (c) => {
    const accountId = c.req.query("accountId");
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    return c.json({
      ok: true,
      summaries: learningSummary.listByAccount(accountId),
    });
  });

  /**
   * GET /usage-stats?accountId=xxx&period=30d|90d|180d|365d
   * Returns usage statistics grouped by stable UI buckets
   * with detailed processor-version rows.
   */
  router.get("/usage-stats", (c) => {
    const accountId = c.req.query("accountId");
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    const period = c.req.query("period") ?? "30d";
    if (!(["30d", "90d", "180d", "365d"] as const).includes(period as UsagePeriod)) {
      return c.json({ ok: false, error: "period must be 30d, 90d, 180d, or 365d", field: "period" }, 400);
    }
    return c.json({
      ok: true,
      period,
      stats: usageStats.getStats({ accountId, period: period as UsagePeriod }),
    });
  });

  /**
   * GET /usage-stats/email?emailId=xxx
   * Returns every recorded AI call for one email (newest first). Each row is
   * one request; retries and regenerations appear as separate entries.
   */
  router.get("/usage-stats/email", (c) => {
    const emailId = c.req.query("emailId");
    if (!emailId) {
      return c.json({ ok: false, error: "emailId is required" }, 400);
    }
    return c.json({
      ok: true,
      rows: usage.listByEmail(emailId),
    });
  });

  /**
   * GET /usage-stats/timeseries?accountId=xxx&granularity=minute|hour&window=N
   * Throughput monitoring: per-category token + call timeseries, zero-filled.
   * `window` units follow granularity (minutes for `minute`, hours for `hour`).
   */
  router.get("/usage-stats/timeseries", (c) => {
    const accountId = c.req.query("accountId");
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    const granularity = (c.req.query("granularity") ??
      "minute") as UsageTimeseriesGranularity;
    if (granularity !== "minute" && granularity !== "hour") {
      return c.json(
        { ok: false, error: "granularity must be minute or hour", field: "granularity" },
        400,
      );
    }
    const defaultWindow = granularity === "minute" ? 120 : 24;
    const parsedWindow = Number.parseInt(c.req.query("window") ?? "", 10);
    const window =
      Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : defaultWindow;
    const maxWindow = granularity === "minute" ? 720 : 168;
    return c.json({
      ok: true,
      granularity,
      result: usageStats.getTimeseries({
        accountId,
        granularity,
        window: Math.min(window, maxWindow),
      }),
    });
  });

  /**
   * POST /reset-learned
   * Reset learned preferences for an account. Clears learning summaries
   * so future prompt building uses no learned signals.
   * Body: { accountId: string, feature?: IntelligenceJobType }
   */
  router.post("/reset-learned", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    const feature = typeof body.feature === "string" ? body.feature as IntelligenceJobType : undefined;
    if (feature) {
      learningSummary.resetFeature(accountId, feature);
    } else {
      learningSummary.reset(accountId);
    }
    return c.json({ ok: true });
  });

  return router;
}
