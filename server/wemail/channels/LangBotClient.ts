import type { ChannelChatKind } from "../../../shared/wemail/channels.js";
import {
  LANGBOT_COMPATIBILITY_PROFILE,
  normalizeLangBotPlatform,
} from "./LangBotProtocol.js";

export interface LangBotBot {
  uuid: string;
  name: string;
  adapter: string;
  platform?: "feishu" | "wecom";
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface LangBotCompatibilityResult {
  compatible: boolean;
  profile: typeof LANGBOT_COMPATIBILITY_PROFILE;
  botCount: number;
  checkedAt: string;
}

export interface LangBotSendResult {
  sent: true;
  responseId?: string;
}

export class LangBotClientError extends Error {
  constructor(
    public readonly code:
      | "langbot-timeout"
      | "langbot-unreachable"
      | "langbot-unauthorized"
      | "langbot-not-found"
      | "langbot-invalid-request"
      | "langbot-server-error"
      | "langbot-incompatible",
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(code);
    this.name = "LangBotClientError";
  }
}

export interface LangBotClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

function botFrom(value: unknown): LangBotBot {
  const row = object(value);
  if (
    !row ||
    typeof row.uuid !== "string" ||
    typeof row.name !== "string" ||
    typeof row.adapter !== "string"
  ) {
    throw new LangBotClientError("langbot-incompatible", false);
  }
  const platform = normalizeLangBotPlatform(row.adapter);
  return {
    uuid: row.uuid,
    name: row.name,
    adapter: row.adapter,
    ...(platform ? { platform } : {}),
    enabled: row.enable !== false,
    ...(typeof row.created_at === "string" ? { createdAt: row.created_at } : {}),
    ...(typeof row.updated_at === "string" ? { updatedAt: row.updated_at } : {}),
  };
}

function redactLog(value: unknown): string {
  const source =
    typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return source
    .replace(/\b(lbk_[A-Za-z0-9._-]+)\b/g, "[REDACTED]")
    .replace(
      /\b(api[_-]?key|token|secret|authorization)\b\s*[:=]\s*["']?[^"',\s}]+/gi,
      "$1=[REDACTED]",
    )
    .slice(0, 500);
}

export class LangBotClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: LangBotClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("invalid-langbot-base-url");
    }
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
  }

  async checkCompatibility(): Promise<LangBotCompatibilityResult> {
    const bots = await this.listBots();
    return {
      compatible: true,
      profile: LANGBOT_COMPATIBILITY_PROFILE,
      botCount: bots.length,
      checkedAt: this.now().toISOString(),
    };
  }

  async listBots(): Promise<LangBotBot[]> {
    const body = await this.request("/api/v1/platform/bots");
    const data = object(body.data);
    if (body.code !== 0 || !data || !Array.isArray(data.bots)) {
      throw new LangBotClientError("langbot-incompatible", false);
    }
    return data.bots.map(botFrom);
  }

  async getBot(botUuid: string): Promise<LangBotBot> {
    const body = await this.request(
      `/api/v1/platform/bots/${encodeURIComponent(botUuid)}`,
    );
    const data = object(body.data);
    if (body.code !== 0 || !data) {
      throw new LangBotClientError("langbot-incompatible", false);
    }
    return botFrom(data.bot);
  }

  async getBotLogs(botUuid: string, maxCount = 10): Promise<string[]> {
    const body = await this.request(
      `/api/v1/platform/bots/${encodeURIComponent(botUuid)}/logs`,
      {
        method: "POST",
        body: JSON.stringify({
          from_index: -1,
          max_count: Math.max(1, Math.min(50, Math.floor(maxCount))),
        }),
      },
    );
    const data = object(body.data);
    if (body.code !== 0 || !data || !Array.isArray(data.logs)) {
      throw new LangBotClientError("langbot-incompatible", false);
    }
    return data.logs.map(redactLog);
  }

  async sendMessage(input: {
    botUuid: string;
    targetType: ChannelChatKind;
    targetId: string;
    text: string;
  }): Promise<LangBotSendResult> {
    if (!input.text.trim() || input.text.length > 32_000) {
      throw new LangBotClientError("langbot-invalid-request", false, 400);
    }
    const body = await this.request(
      `/api/v1/platform/bots/${encodeURIComponent(input.botUuid)}/send_message`,
      {
        method: "POST",
        body: JSON.stringify({
          target_type: input.targetType,
          target_id: input.targetId,
          message_chain: [{ type: "Plain", text: input.text }],
        }),
      },
    );
    const data = object(body.data);
    if (body.code !== 0 || data?.sent !== true) {
      throw new LangBotClientError("langbot-incompatible", false);
    }
    const responseId =
      typeof data.message_id === "string"
        ? data.message_id
        : typeof data.id === "string"
          ? data.id
          : undefined;
    return { sent: true, ...(responseId ? { responseId } : {}) };
  }

  private async request(
    pathname: string,
    init: RequestInit = {},
  ): Promise<JsonObject> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${pathname}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-API-Key": this.options.apiKey,
          ...init.headers,
        },
        signal: controller.signal,
      });
      if (!response.ok) throw this.classifyStatus(response.status);
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new LangBotClientError("langbot-incompatible", false);
      }
      const body = object(json);
      if (!body) throw new LangBotClientError("langbot-incompatible", false);
      return body;
    } catch (error) {
      if (error instanceof LangBotClientError) throw error;
      if (
        error instanceof Error &&
        (error.name === "AbortError" || controller.signal.aborted)
      ) {
        throw new LangBotClientError("langbot-timeout", true);
      }
      throw new LangBotClientError("langbot-unreachable", true);
    } finally {
      clearTimeout(timer);
    }
  }

  private classifyStatus(status: number): LangBotClientError {
    if (status === 401 || status === 403) {
      return new LangBotClientError("langbot-unauthorized", false, status);
    }
    if (status === 404) {
      return new LangBotClientError("langbot-not-found", false, status);
    }
    if (status === 408 || status === 429 || status >= 500) {
      return new LangBotClientError("langbot-server-error", true, status);
    }
    return new LangBotClientError("langbot-invalid-request", false, status);
  }
}
