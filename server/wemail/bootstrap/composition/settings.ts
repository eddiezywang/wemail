/**
 * Settings-domain composition: persisted LLM configuration, the AI
 * profile (custom instructions, languages), per-lane usage telemetry,
 * and the helpers that translate persisted settings into a concrete
 * `LlmProviderConfig` / `LlmClient` / per-lane model selection.
 *
 * Pure helpers (`buildLlmClient`, `configFromRuntimeSettings`,
 * `modelForLane`, `piConfigForLane`) are exported so the cross-domain
 * `buildForAccount()` and `reloadLlmSettings()` paths in the root can
 * call them without depending on this module's `composeSettings()`.
 */

import {
  createAnthropicMessagesClient,
  createOpenAiCompatibleClient,
  type LlmClient,
} from "../../ai/LlmClient.js";
import type { MailDatabase } from "../../database/Database.js";
import type { PiModelConfig } from "../../agent/PiAgentRuntime.js";
import type { SecretStore } from "../../security/SecretStore.js";
import { AiProfileSettingsService } from "../../settings/AiProfileSettingsService.js";
import { AiUsageRepository } from "../../settings/AiUsageRepository.js";
import {
  LlmSettingsService,
  type LlmRuntimeSettings,
} from "../../settings/LlmSettingsService.js";

/**
 * LLM configuration understood by the composition root.
 *
 * `openai` matches any OpenAI-compatible endpoint (e.g. OpenAI itself,
 * Together, Groq — adapter is protocol-level, not vendor-level).
 */
export type LlmProviderConfig =
  | {
      provider: "openai";
      apiKey: string;
      baseUrl: string;
      defaultModel: string;
      organization?: string;
      reasoningEffort?: LlmRuntimeSettings["reasoningEffort"];
    }
  | {
      provider: "anthropic";
      apiKey: string;
      defaultModel: string;
      baseUrl?: string;
    };

export interface SettingsComposition {
  llmSettingsService: LlmSettingsService;
  aiUsage: AiUsageRepository;
}

export function normalizeAnthropicBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalized = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!normalized) return undefined;
  const withoutMessages = normalized.replace(/\/(?:v1\/)?messages$/i, "");
  return withoutMessages.replace(/\/v1$/i, "") || undefined;
}

export function normalizeOpenAiBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalized = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!normalized) return undefined;
  if (!/\/anthropic(?:\/v1)?(?:\/messages)?$/i.test(normalized)) return normalized;
  try {
    return new URL(normalized).origin;
  } catch {
    return normalized.replace(/\/anthropic(?:\/v1)?(?:\/messages)?$/i, "") || undefined;
  }
}

export function composeSettings(opts: {
  db: MailDatabase;
  secrets: SecretStore;
}): SettingsComposition {
  const { db, secrets } = opts;
  const llmSettingsService = new LlmSettingsService({ db, secrets });
  const aiUsage = new AiUsageRepository(db);
  return { llmSettingsService, aiUsage };
}

export function buildLlmClient(config: LlmProviderConfig): LlmClient {
  if (config.provider === "openai") {
    return createOpenAiCompatibleClient({
      baseUrl: normalizeOpenAiBaseUrl(config.baseUrl) ?? "https://api.openai.com/v1",
      apiKey: config.apiKey,
      defaultModel: config.defaultModel,
      organization: config.organization,
      reasoningEffort: config.reasoningEffort,
    });
  }
  return createAnthropicMessagesClient({
    apiKey: config.apiKey,
    defaultModel: config.defaultModel,
    baseUrl: normalizeAnthropicBaseUrl(config.baseUrl),
  });
}

export function configFromRuntimeSettings(
  settings: LlmRuntimeSettings | null,
): LlmProviderConfig | undefined {
  if (!settings) return undefined;
  if (settings.provider === "openai") {
    return {
      provider: "openai",
      apiKey: settings.apiKey,
      baseUrl: normalizeOpenAiBaseUrl(settings.baseUrl) ?? "https://api.openai.com/v1",
      defaultModel: settings.defaultModel,
      reasoningEffort: settings.reasoningEffort,
    };
  }
  return {
    provider: "anthropic",
    apiKey: settings.apiKey,
    baseUrl: normalizeAnthropicBaseUrl(settings.baseUrl),
    defaultModel: settings.defaultModel,
  };
}

export function modelForLane(
  config: LlmProviderConfig | undefined,
  settings: LlmRuntimeSettings | null,
  lane: "agent" | "summary" | "draft",
): string {
  if (lane === "agent" && settings?.agentModel) return settings.agentModel;
  if (lane === "summary" && settings?.summaryModel) return settings.summaryModel;
  if (lane === "draft" && settings?.draftModel) return settings.draftModel;
  return defaultAgentModel(config);
}

export function piConfigForLane(
  config: LlmProviderConfig,
  settings: LlmRuntimeSettings | null,
): PiModelConfig {
  const model = modelForLane(config, settings, "agent");
  if (config.provider === "openai") {
    return {
      provider: "openai",
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model,
    };
  }
  return {
    provider: "anthropic",
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model,
  };
}

function defaultAgentModel(config: LlmProviderConfig | undefined): string {
  // Callers only invoke this when an `llmClient` is configured, which
  // requires `config` to be set. The previous "claude-3-5-sonnet"
  // fallback was unreachable — keep a loud assertion instead so a future
  // refactor that changes the call sites fails fast in tests.
  if (!config) {
    throw new Error(
      "defaultAgentModel: called without an LlmProviderConfig — this branch is unreachable when an LLM client is configured.",
    );
  }
  return config.defaultModel;
}

/**
 * AiProfileSettingsService is per-call-site cheap and (in the original
 * monolith) was constructed inside `buildForAccount` only when an LLM
 * client was present. Re-export the constructor here so the cross-
 * domain `buildForAccount` doesn't have to reach into `../../settings/...`
 * directly.
 */
export { AiProfileSettingsService };
