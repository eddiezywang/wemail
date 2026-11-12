import { randomUUID } from "node:crypto";
import type { LangBotConnection } from "../../../shared/wemail/channels.js";
import type { SecretStore } from "../security/SecretStore.js";
import { ChannelAuditRepository } from "./ChannelAuditRepository.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import {
  generateWebhookSecret,
  validateLangBotEnablement,
} from "./ChannelSecurity.js";
import {
  langBotApiSecretKey,
  langBotWebhookSecretKey,
} from "./ChannelSecretKeys.js";
import {
  LangBotClient,
  LangBotClientError,
} from "./LangBotClient.js";
import {
  LANGBOT_COMPATIBILITY_PROFILE,
} from "./LangBotProtocol.js";

export interface PublicLangBotConnection {
  id: string;
  name: string;
  baseUrl: string;
  compatibilityProfile: string;
  enabled: boolean;
  trustMode: "loopback" | "remote";
  compatibilityState: LangBotConnection["compatibilityState"];
  hasApiCredential: boolean;
  hasWebhookCredential: boolean;
  lastCheckedAt?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export class LangBotConnectionService {
  constructor(
    private readonly repository: ChannelConnectionRepository,
    private readonly secrets: SecretStore,
    private readonly audit: ChannelAuditRepository,
    private readonly options: {
      developmentOverride?: boolean;
      clientFactory?: (input: {
        baseUrl: string;
        apiKey: string;
      }) => Pick<LangBotClient, "checkCompatibility">;
    } = {},
  ) {}

  create(input: {
    id?: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    webhookSecret?: string;
    trustMode: "loopback" | "remote";
    actor?: string;
  }): PublicLangBotConnection {
    if (!input.apiKey.trim()) throw new Error("langbot-api-key-required");
    const id = input.id ?? randomUUID();
    const apiSecretRef = langBotApiSecretKey(id);
    const webhookSecretRef = langBotWebhookSecretKey(id);
    const webhookSecret = input.webhookSecret?.trim() || generateWebhookSecret();
    this.secrets.saveSecret(apiSecretRef, input.apiKey);
    this.secrets.saveSecret(webhookSecretRef, webhookSecret);
    try {
      const connection = this.repository.createConnection({
        id,
        name: input.name,
        baseUrl: new URL(input.baseUrl).toString().replace(/\/+$/, ""),
        compatibilityProfile: LANGBOT_COMPATIBILITY_PROFILE,
        apiSecretRef,
        webhookSecretRef,
        trustMode: input.trustMode,
      });
      this.audit.record({
        eventType: "langbot.connection.created",
        actor: input.actor ?? "local-operator",
        connectionId: id,
        scope: { trustMode: input.trustMode },
        result: "created-disabled",
      });
      return this.publicView(connection);
    } catch (error) {
      this.secrets.deleteSecret(apiSecretRef);
      this.secrets.deleteSecret(webhookSecretRef);
      throw error;
    }
  }

  list(): PublicLangBotConnection[] {
    return this.repository
      .listConnections()
      .map((connection) => this.publicView(connection));
  }

  get(id: string): PublicLangBotConnection | undefined {
    const connection = this.repository.getConnection(id);
    return connection ? this.publicView(connection) : undefined;
  }

  async test(id: string): Promise<PublicLangBotConnection> {
    const connection = this.requireConnection(id);
    const apiKey = this.secrets.getSecret(connection.apiSecretRef);
    if (!apiKey) throw new Error("langbot-api-key-missing");
    try {
      const client =
        this.options.clientFactory?.({
          baseUrl: connection.baseUrl,
          apiKey,
        }) ?? new LangBotClient({ baseUrl: connection.baseUrl, apiKey });
      await client.checkCompatibility();
      const updated = this.repository.setConnectionCheck(id, {
        compatible: true,
      })!;
      this.audit.record({
        eventType: "langbot.connection.tested",
        actor: "local-operator",
        connectionId: id,
        scope: {},
        result: "compatible",
      });
      return this.publicView(updated);
    } catch (error) {
      const code =
        error instanceof LangBotClientError
          ? error.code
          : "langbot-unreachable";
      const updated = this.repository.setConnectionCheck(id, {
        compatible: false,
        enabled: false,
        errorCode: code,
      })!;
      this.audit.record({
        eventType: "langbot.connection.tested",
        actor: "local-operator",
        connectionId: id,
        scope: {},
        result: code,
      });
      return this.publicView(updated);
    }
  }

  enable(id: string): PublicLangBotConnection {
    const connection = this.requireConnection(id);
    if (connection.compatibilityState !== "compatible") {
      throw new Error("langbot-compatible-test-required");
    }
    validateLangBotEnablement({
      baseUrl: connection.baseUrl,
      trustMode: connection.trustMode,
      secrets: this.secrets,
      developmentOverride: this.options.developmentOverride,
    });
    const updated = this.repository.setConnectionCheck(id, {
      compatible: true,
      enabled: true,
    })!;
    this.audit.record({
      eventType: "langbot.connection.enabled",
      actor: "local-operator",
      connectionId: id,
      scope: { trustMode: connection.trustMode },
      result: "enabled",
    });
    return this.publicView(updated);
  }

  disable(id: string): PublicLangBotConnection {
    this.requireConnection(id);
    this.repository.disableConnection(id);
    return this.get(id)!;
  }

  rotateApiKey(id: string, apiKey: string): PublicLangBotConnection {
    const connection = this.requireConnection(id);
    if (!apiKey.trim()) throw new Error("langbot-api-key-required");
    this.secrets.saveSecret(connection.apiSecretRef, apiKey);
    this.repository.disableConnection(id, "credential-rotated-retest-required");
    this.audit.record({
      eventType: "langbot.connection.credential-rotated",
      actor: "local-operator",
      connectionId: id,
      scope: {},
      result: "retest-required",
    });
    return this.get(id)!;
  }

  delete(id: string): boolean {
    const connection = this.requireConnection(id);
    const deleted = this.repository.deleteConnection(id);
    if (deleted) {
      this.secrets.deleteSecret(connection.apiSecretRef);
      this.secrets.deleteSecret(connection.webhookSecretRef);
    }
    return deleted;
  }

  getApiKey(id: string): string | undefined {
    const connection = this.repository.getConnection(id);
    return connection
      ? this.secrets.getSecret(connection.apiSecretRef)
      : undefined;
  }

  getWebhookSecret(id: string): string | undefined {
    const connection = this.repository.getConnection(id);
    return connection
      ? this.secrets.getSecret(connection.webhookSecretRef)
      : undefined;
  }

  private requireConnection(id: string): LangBotConnection {
    const connection = this.repository.getConnection(id);
    if (!connection) throw new Error("langbot-connection-not-found");
    return connection;
  }

  private publicView(
    connection: LangBotConnection,
  ): PublicLangBotConnection {
    return {
      id: connection.id,
      name: connection.name,
      baseUrl: connection.baseUrl,
      compatibilityProfile: connection.compatibilityProfile,
      enabled: connection.enabled,
      trustMode: connection.trustMode,
      compatibilityState: connection.compatibilityState,
      hasApiCredential: !!this.secrets.getSecret(connection.apiSecretRef),
      hasWebhookCredential: !!this.secrets.getSecret(
        connection.webhookSecretRef,
      ),
      ...(connection.lastCheckedAt
        ? { lastCheckedAt: connection.lastCheckedAt }
        : {}),
      ...(connection.lastErrorCode
        ? { lastErrorCode: connection.lastErrorCode }
        : {}),
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }
}
