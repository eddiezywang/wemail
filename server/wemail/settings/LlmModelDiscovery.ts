import type { LlmProvider } from "./LlmSettingsService.js";

const DISCOVERY_TIMEOUT_MS = 10_000;
const ANTHROPIC_VERSION = "2023-06-01";

export interface DiscoveredLlmModel {
  id: string;
  ownedBy?: string;
}

export interface LlmModelDiscoveryAttempt {
  provider: LlmProvider;
  status?: number;
  error: string;
}

export type LlmModelDiscoveryResult =
  | { provider: LlmProvider; models: DiscoveredLlmModel[] }
  | { error: string; attempts: LlmModelDiscoveryAttempt[] };

type DiscoveryCandidateResult =
  | { provider: LlmProvider; models: DiscoveredLlmModel[] }
  | LlmModelDiscoveryAttempt;

class DiscoveryError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

function discoveryError(error: string, status?: number): DiscoveryError {
  return new DiscoveryError(error, status);
}

function safeAttempt(provider: LlmProvider, error: unknown): LlmModelDiscoveryAttempt {
  if (error instanceof DiscoveryError) {
    return { provider, error: error.message, ...(error.status !== undefined ? { status: error.status } : {}) };
  }
  return { provider, error: "model-list-request-failed" };
}

function normalizedBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

function modelListUrl(baseUrl: string): string {
  if (/\/models$/i.test(baseUrl)) return baseUrl;
  return /\/v1$/i.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
}

function originModelListUrl(baseUrl: string): string | undefined {
  try {
    return `${new URL(baseUrl).origin}/v1/models`;
  } catch {
    return undefined;
  }
}

function isAnthropicBaseUrl(baseUrl: string): boolean {
  return /\/anthropic(?:\/v1)?$/i.test(baseUrl);
}

function oppositeProvider(provider: LlmProvider): LlmProvider {
  return provider === "anthropic" ? "openai" : "anthropic";
}

function parseModels(body: unknown): DiscoveredLlmModel[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
    throw discoveryError("invalid-model-list");
  }
  const byId = new Map<string, DiscoveredLlmModel>();
  for (const item of (body as { data: unknown[] }).data) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim()) continue;
    const model: DiscoveredLlmModel = { id: record.id.trim() };
    if (typeof record.owned_by === "string" && record.owned_by.trim()) {
      model.ownedBy = record.owned_by.trim();
    }
    byId.set(model.id, model);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchJson(args: {
  url: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await args.fetchImpl(args.url, {
      method: "GET",
      redirect: "error",
      headers: args.headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw discoveryError("model-list-request-failed", response.status);
    }
    try {
      return await response.json();
    } catch {
      throw discoveryError("invalid-model-list");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw discoveryError("model-list-timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverOpenAi(args: {
  url: string;
  apiKey: string;
  fetchImpl: typeof fetch;
}): Promise<DiscoveredLlmModel[]> {
  const body = await fetchJson({
    url: args.url,
    fetchImpl: args.fetchImpl,
    headers: { authorization: `Bearer ${args.apiKey}` },
  });
  return parseModels(body);
}

async function discoverAnthropic(args: {
  url: string;
  apiKey: string;
  fetchImpl: typeof fetch;
}): Promise<DiscoveredLlmModel[]> {
  const body = await fetchJson({
    url: args.url,
    fetchImpl: args.fetchImpl,
    headers: {
      "anthropic-version": ANTHROPIC_VERSION,
      "x-api-key": args.apiKey,
    },
  });
  return parseModels(body);
}

/**
 * Local sub2agent gateway (127.0.0.1:8989) probe used by the onboarding
 * guide to prefill the LLM form. Unlike model discovery this runs WITHOUT an
 * API key and tolerates auth-challenged responses — any HTTP answer means the
 * gateway is up, so the guide can prefill the base URL even when the user
 * still has to enter a key. The probe only ever touches this loopback
 * constant, so there is no SSRF surface.
 */
export const LOCAL_GATEWAY_BASE_URL = "http://127.0.0.1:8989/v1";
export const LOCAL_GATEWAY_PROBE_TIMEOUT_MS = 4_000;

export interface LocalGatewayProbeResult {
  reachable: boolean;
  baseUrl?: string;
  requiresAuth?: boolean;
  models?: DiscoveredLlmModel[];
  provider?: LlmProvider;
}

export async function detectLocalGateway(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<LocalGatewayProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    LOCAL_GATEWAY_PROBE_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(`${LOCAL_GATEWAY_BASE_URL}/models`, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const baseUrl = LOCAL_GATEWAY_BASE_URL;
    if (response.status === 401 || response.status === 403) {
      return { reachable: true, baseUrl, requiresAuth: true, provider: "openai" };
    }
    if (!response.ok) {
      return { reachable: true, baseUrl, provider: "openai" };
    }
    try {
      const body = (await response.json()) as unknown;
      return { reachable: true, baseUrl, provider: "openai", models: parseModels(body) };
    } catch {
      if (controller.signal.aborted) return { reachable: false };
      return { reachable: true, baseUrl, provider: "openai" };
    }
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverLlmModels(args: {
  inputProvider: LlmProvider;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<LlmModelDiscoveryResult> {
  const configuredBaseUrl = normalizedBaseUrl(args.baseUrl) || (
    args.inputProvider === "anthropic"
      ? "https://api.anthropic.com"
      : "https://api.openai.com/v1"
  );
  const fullBaseUrlCandidate = {
    provider: isAnthropicBaseUrl(configuredBaseUrl) ? "anthropic" : args.inputProvider,
    url: modelListUrl(configuredBaseUrl),
  } satisfies { provider: LlmProvider; url: string };
  const originUrl = originModelListUrl(configuredBaseUrl);
  const candidates = [
    fullBaseUrlCandidate,
    ...(originUrl && originUrl !== fullBaseUrlCandidate.url
      ? [{ provider: "openai" as const, url: originUrl }]
      : []),
  ];

  if (!candidates.length) {
    candidates.push({
      provider: args.inputProvider,
      url: modelListUrl(configuredBaseUrl),
    });
  }

  const fetchImpl = args.fetchImpl ?? globalThis.fetch;

  const results: DiscoveryCandidateResult[] = await Promise.all(candidates.map(async (candidate) => {
    try {
      const models = candidate.provider === "openai"
        ? await discoverOpenAi({ url: candidate.url, apiKey: args.apiKey, fetchImpl })
        : await discoverAnthropic({ url: candidate.url, apiKey: args.apiKey, fetchImpl });
      return { provider: candidate.provider, models };
    } catch (error) {
      return safeAttempt(candidate.provider, error);
    }
  }));

  for (const provider of ["anthropic", "openai"] as const) {
    const result = results.find((candidate) => candidate?.provider === provider);
    if (result && "models" in result) {
      return { provider: result.provider, models: result.models };
    }
  }

  const attempts = results.filter(
    (candidate): candidate is LlmModelDiscoveryAttempt => "error" in candidate,
  );
  if (candidates.length === 1) {
    const primary = candidates[0];
    const alternateProvider = oppositeProvider(primary.provider);
    try {
      const models = alternateProvider === "openai"
        ? await discoverOpenAi({ url: primary.url, apiKey: args.apiKey, fetchImpl })
        : await discoverAnthropic({ url: primary.url, apiKey: args.apiKey, fetchImpl });
      return { provider: alternateProvider, models };
    } catch (error) {
      attempts.push(safeAttempt(alternateProvider, error));
    }
  }

  return { error: "LLM model discovery failed for all supported protocols", attempts };
}
