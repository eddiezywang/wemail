import type { LlmClient } from "./LlmClient.js";
import {
  buildLlmClient,
  configFromRuntimeSettings,
  type LlmProviderConfig,
} from "../bootstrap/composition/settings.js";
import type { LlmRuntimeSettings } from "../settings/LlmSettingsService.js";

export type LlmLane = "default" | "agent" | "summary" | "draft";

export type LlmAvailability = "unknown" | "available" | "unreachable";

export interface LlmRuntimeError {
  code: string;
  status?: number;
  message: string;
  occurredAt: string;
}

export interface LlmRuntimeHealth {
  availability: LlmAvailability;
  lastError: LlmRuntimeError | null;
  lastSuccessAt: string | null;
}

export interface LlmRuntimeSnapshot {
  readonly generation: number;
  readonly configured: boolean;
  readonly settings: LlmRuntimeSettings | null;
  readonly config?: LlmProviderConfig;
  readonly client?: LlmClient;
  readonly provider?: LlmProviderConfig["provider"];
  modelFor(lane: LlmLane): string | undefined;
}

export interface LlmRuntimeOptions {
  initialSettings: LlmRuntimeSettings | null;
  initialConfig?: LlmProviderConfig;
  initialClient?: LlmClient;
  /** Test-only client override retained across replacements. */
  overrideClient?: LlmClient;
  configFromSettings?: (
    settings: LlmRuntimeSettings | null,
  ) => LlmProviderConfig | undefined;
  buildClient?: (config: LlmProviderConfig) => LlmClient;
  logger?: { error: (event: string, ctx: Record<string, unknown>) => void };
}

export class LlmRuntime {
  private current: LlmRuntimeSnapshot;
  private readonly listeners = new Set<(snapshot: LlmRuntimeSnapshot) => void>();
  private readonly resolveConfig: (
    settings: LlmRuntimeSettings | null,
  ) => LlmProviderConfig | undefined;
  private readonly createClient: (config: LlmProviderConfig) => LlmClient;
  private readonly overrideClient?: LlmClient;
  private readonly logger?: LlmRuntimeOptions["logger"];
  private runtimeHealth: LlmRuntimeHealth = {
    availability: "unknown",
    lastError: null,
    lastSuccessAt: null,
  };

  constructor(options: LlmRuntimeOptions) {
    this.resolveConfig = options.configFromSettings ?? configFromRuntimeSettings;
    this.createClient = options.buildClient ?? buildLlmClient;
    this.overrideClient = options.overrideClient;
    this.logger = options.logger;
    this.current = this.createSnapshot(
      options.initialSettings,
      0,
      options.initialConfig,
      options.initialClient,
    );
  }

  snapshot(): LlmRuntimeSnapshot {
    return this.current;
  }

  onChanged(listener: (snapshot: LlmRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  health(): LlmRuntimeHealth {
    return {
      ...this.runtimeHealth,
      lastError: this.runtimeHealth.lastError
        ? { ...this.runtimeHealth.lastError }
        : null,
    };
  }

  recordFailure(error: unknown): LlmRuntimeHealth {
    const candidate = error as {
      code?: unknown;
      status?: unknown;
      message?: unknown;
      detail?: unknown;
    } | null;
    const status = typeof candidate?.status === "number" &&
      Number.isFinite(candidate.status) &&
      candidate.status > 0
      ? candidate.status
      : undefined;
    const code = typeof candidate?.code === "string" && candidate.code.trim()
      ? candidate.code.trim().slice(0, 80)
      : status !== undefined
        ? `HTTP_${status}`
        : "LLM_ERROR";
    const rawMessage = error instanceof Error
      ? error.message
      : typeof candidate?.message === "string"
        ? candidate.message
        : String(error);
    const detail = typeof candidate?.detail === "string" && candidate.detail.trim()
      ? candidate.detail.trim()
      : undefined;
    const message = [rawMessage, detail]
      .filter(Boolean)
      .join(" · ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500) || code;
    this.runtimeHealth = {
      ...this.runtimeHealth,
      availability: "unreachable",
      lastError: {
        code,
        ...(status === undefined ? {} : { status }),
        message,
        occurredAt: new Date().toISOString(),
      },
    };
    return this.health();
  }

  recordSuccess(): LlmRuntimeHealth {
    this.runtimeHealth = {
      ...this.runtimeHealth,
      availability: "available",
      lastSuccessAt: new Date().toISOString(),
    };
    return this.health();
  }

  replace(settings: LlmRuntimeSettings | null): LlmRuntimeSnapshot {
    // Rebuild the provider client for every settings generation. Adapter-local
    // capability fallbacks (for example Anthropic thinking/tool-choice) must
    // never leak across a user model or endpoint change.
    const next = this.createSnapshot(settings, this.current.generation + 1);
    this.current = next;
    for (const listener of this.listeners) listener(next);
    return next;
  }

  private createSnapshot(
    settings: LlmRuntimeSettings | null,
    generation: number,
    initialConfig?: LlmProviderConfig,
    initialClient?: LlmClient,
  ): LlmRuntimeSnapshot {
    this.runtimeHealth = {
      availability: "unknown",
      lastError: null,
      lastSuccessAt: null,
    };
    const config = initialConfig ?? this.resolveConfig(settings);
    let client: LlmClient | undefined = initialClient ?? this.overrideClient;

    if (config && !client) {
      try {
        client = this.createClient(config);
      } catch (err) {
        this.logger?.error("llm.runtime.build-failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const frozenSettings = settings ? Object.freeze({ ...settings }) : null;
    const modelFor = (lane: LlmLane): string | undefined => {
      if (!client || !config) return undefined;
      if (lane === "agent") return frozenSettings?.agentModel ?? config.defaultModel;
      if (lane === "summary") return frozenSettings?.summaryModel ?? config.defaultModel;
      if (lane === "draft") return frozenSettings?.draftModel ?? config.defaultModel;
      return config.defaultModel;
    };

    return Object.freeze({
      generation,
      configured: Boolean(client && config),
      settings: frozenSettings,
      config: client ? config : undefined,
      client,
      provider: client ? config?.provider : undefined,
      modelFor,
    });
  }
}
