import { randomUUID } from "node:crypto";
import type {
  ChannelBotSetup,
  ChannelPlatform,
} from "../../../shared/wemail/channels.js";
import type { BotChannelConfigurationService } from "./BotChannelConfigurationService.js";

const FEISHU_ACCOUNTS_URL = "https://accounts.feishu.cn";
const FEISHU_REGISTRATION_PATH = "/oauth/v1/app/registration";
const WECOM_QR_GENERATE_URL = "https://work.weixin.qq.com/ai/qc/generate";
const WECOM_QR_QUERY_URL = "https://work.weixin.qq.com/ai/qc/query_result";
const WECOM_QR_PAGE_URL = "https://work.weixin.qq.com/ai/qc/gen";
const REQUEST_TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;

interface SetupSession {
  setup: ChannelBotSetup;
  deviceCode?: string;
  scode?: string;
  nextPollAt: number;
}

interface RegistrationResponse {
  supported_auth_methods?: unknown;
  device_code?: unknown;
  verification_uri_complete?: unknown;
  user_code?: unknown;
  interval?: unknown;
  expire_in?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
  error?: unknown;
}

export class ChannelBotOnboardingService {
  private readonly sessions = new Map<string, SetupSession>();

  constructor(
    private readonly configurations: BotChannelConfigurationService,
    private readonly fetcher: FetchLike = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(platform: ChannelPlatform): Promise<ChannelBotSetup> {
    this.cleanup();
    for (const [id, session] of this.sessions) {
      if (session.setup.platform === platform) this.sessions.delete(id);
    }
    return platform === "feishu" ? this.startFeishu() : this.startWeCom();
  }

  async get(setupId: string): Promise<ChannelBotSetup> {
    const session = this.sessions.get(setupId);
    if (!session) throw new Error("channel-bot-setup-not-found");
    if (session.setup.status !== "waiting") return session.setup;
    if (this.now().getTime() >= Date.parse(session.setup.expiresAt)) {
      session.setup = { ...session.setup, status: "expired" };
      return session.setup;
    }
    if (this.now().getTime() < session.nextPollAt) return session.setup;
    return session.setup.platform === "feishu"
      ? this.pollFeishu(session)
      : this.pollWeCom(session);
  }

  cancel(setupId: string): boolean {
    return this.sessions.delete(setupId);
  }

  private async startFeishu(): Promise<ChannelBotSetup> {
    const init = await this.postFeishu({ action: "init" });
    const methods = Array.isArray(init.supported_auth_methods)
      ? init.supported_auth_methods
      : [];
    if (!methods.includes("client_secret")) {
      throw new Error("feishu-registration-client-secret-unsupported");
    }
    const begin = await this.postFeishu({
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    });
    const deviceCode = stringValue(begin.device_code);
    const verificationUrl = stringValue(begin.verification_uri_complete);
    if (!deviceCode || !verificationUrl) {
      throw new Error("feishu-registration-invalid-response");
    }
    const intervalSeconds = positiveNumber(begin.interval, 5);
    const expiresInSeconds = positiveNumber(begin.expire_in, 600);
    const configurationUrl = appendQuery(verificationUrl, {
      from: "wemail",
      tp: "wemail",
    });
    const setup = this.createSetup({
      platform: "feishu",
      configurationUrl,
      qrPayload: configurationUrl,
      expiresInSeconds,
      retryAfterMs: intervalSeconds * 1_000,
    });
    this.sessions.set(setup.id, {
      setup,
      deviceCode,
      nextPollAt: 0,
    });
    return setup;
  }

  private async startWeCom(): Promise<ChannelBotSetup> {
    const response = await this.requestJson(
      appendQuery(WECOM_QR_GENERATE_URL, { source: "wemail" }),
      { headers: { "User-Agent": "WeMail/0.1" } },
    );
    const data = objectValue(response.data);
    const scode = stringValue(data.scode);
    const authUrl = stringValue(data.auth_url);
    if (!scode || !authUrl) throw new Error("wecom-registration-invalid-response");
    const configurationUrl = appendQuery(WECOM_QR_PAGE_URL, {
      source: "wemail",
      scode,
    });
    const setup = this.createSetup({
      platform: "wecom",
      configurationUrl,
      qrPayload: authUrl,
      expiresInSeconds: 300,
      retryAfterMs: 3_000,
    });
    this.sessions.set(setup.id, {
      setup,
      scode,
      nextPollAt: 0,
    });
    return setup;
  }

  private async pollFeishu(session: SetupSession): Promise<ChannelBotSetup> {
    session.nextPollAt = this.now().getTime() + session.setup.retryAfterMs;
    const result = await this.postFeishu({
      action: "poll",
      device_code: session.deviceCode ?? "",
      tp: "ob_app",
    });
    const appId = stringValue(result.client_id);
    const appSecret = stringValue(result.client_secret);
    if (appId && appSecret) {
      const configuration = this.configurations.save({
        platform: "feishu",
        externalBotId: appId,
        secret: appSecret,
      });
      session.setup = {
        ...session.setup,
        status: "connected",
        profileId: configuration.profileId,
      };
      return session.setup;
    }
    const error = stringValue(result.error);
    if (error === "access_denied" || error === "expired_token") {
      session.setup = {
        ...session.setup,
        status: error === "expired_token" ? "expired" : "failed",
        errorCode: `feishu-registration-${error.replaceAll("_", "-")}`,
      };
    }
    return session.setup;
  }

  private async pollWeCom(session: SetupSession): Promise<ChannelBotSetup> {
    session.nextPollAt = this.now().getTime() + session.setup.retryAfterMs;
    const response = await this.requestJson(
      appendQuery(WECOM_QR_QUERY_URL, { scode: session.scode ?? "" }),
      { headers: { "User-Agent": "WeMail/0.1" } },
    );
    const data = objectValue(response.data);
    if (stringValue(data.status).toLowerCase() !== "success") {
      return session.setup;
    }
    const botInfo = objectValue(data.bot_info);
    const botId = stringValue(botInfo.botid) || stringValue(botInfo.bot_id);
    const secret = stringValue(botInfo.secret);
    if (!botId || !secret) {
      session.setup = {
        ...session.setup,
        status: "failed",
        errorCode: "wecom-registration-credentials-missing",
      };
      return session.setup;
    }
    const configuration = this.configurations.save({
      platform: "wecom",
      externalBotId: botId,
      secret,
    });
    session.setup = {
      ...session.setup,
      status: "connected",
      profileId: configuration.profileId,
    };
    return session.setup;
  }

  private createSetup(input: {
    platform: ChannelPlatform;
    configurationUrl: string;
    qrPayload: string;
    expiresInSeconds: number;
    retryAfterMs: number;
  }): ChannelBotSetup {
    return {
      id: randomUUID(),
      platform: input.platform,
      mode: "create",
      status: "waiting",
      configurationUrl: input.configurationUrl,
      qrPayload: input.qrPayload,
      expiresAt: new Date(
        this.now().getTime() + input.expiresInSeconds * 1_000,
      ).toISOString(),
      retryAfterMs: input.retryAfterMs,
    };
  }

  private async postFeishu(
    body: Record<string, string>,
  ): Promise<RegistrationResponse> {
    const response = await this.requestJson(
      `${FEISHU_ACCOUNTS_URL}${FEISHU_REGISTRATION_PATH}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      },
      true,
    );
    return response as RegistrationResponse;
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    acceptErrorJson = false,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, {
        ...init,
        signal: controller.signal,
      });
      const payload = (await response.json()) as unknown;
      if (!acceptErrorJson && !response.ok) {
        throw new Error("channel-bot-setup-provider-unavailable");
      }
      return objectValue(payload);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("channel-bot-setup-")) {
        throw error;
      }
      throw new Error("channel-bot-setup-provider-unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }

  private cleanup() {
    const cutoff = this.now().getTime() - 60_000;
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.setup.expiresAt) < cutoff) this.sessions.delete(id);
    }
  }
}

function appendQuery(url: string, values: Record<string, string>): string {
  const result = new URL(url);
  for (const [key, value] of Object.entries(values)) {
    result.searchParams.set(key, value);
  }
  return result.toString();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}
