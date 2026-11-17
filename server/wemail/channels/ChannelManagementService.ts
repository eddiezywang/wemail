import { randomUUID } from "node:crypto";
import type {
  ChannelBotProfile,
  ChannelDiagnostics,
  ChannelPlatform,
} from "../../../shared/wemail/channels.js";
import { ChannelBindingRepository } from "./ChannelBindingRepository.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import { ChannelDeliveryRepository } from "./ChannelLedgerRepository.js";
import { ChannelDestinationRepository } from "./ChannelDestinationRepository.js";
import { LangBotClient, LangBotClientError } from "./LangBotClient.js";
import type { LangBotConnectionService } from "./LangBotConnectionService.js";
import type { BotChannelRuntime } from "./BotChannelRuntime.js";
import { BotChannelTransportError } from "./BotChannelRuntime.js";

export class ChannelManagementService {
  constructor(
    private readonly connections: ChannelConnectionRepository,
    private readonly connectionService: LangBotConnectionService,
    private readonly bindings: ChannelBindingRepository,
    private readonly destinations: ChannelDestinationRepository,
    private readonly deliveries: ChannelDeliveryRepository,
    private readonly options: {
      botRuntime?: BotChannelRuntime;
      clientFactory?: (
        connectionId: string,
      ) => Pick<
        LangBotClient,
        "listBots" | "getBot" | "checkCompatibility"
      >;
    } = {},
  ) {}

  async listEligibleBots(connectionId: string, platform: ChannelPlatform) {
    const client = this.client(connectionId);
    return (await client.listBots()).filter((bot) => bot.platform === platform);
  }

  async selectBot(input: {
    connectionId: string;
    botUuid: string;
    platform: ChannelPlatform;
  }): Promise<ChannelBotProfile> {
    const bot = await this.client(input.connectionId).getBot(input.botUuid);
    if (bot.platform !== input.platform) {
      throw new Error("channel-bot-platform-mismatch");
    }
    return this.connections.saveProfile({
      connectionId: input.connectionId,
      botUuid: bot.uuid,
      platform: input.platform,
      displayName: bot.name,
      adapterName: bot.adapter,
      enabled: false,
      onboardingState: "bot_selected",
    });
  }

  async detect(profileId: string): Promise<ChannelDiagnostics> {
    const profile = this.requireProfile(profileId);
    let botExists = false;
    let botEnabled = false;
    let platformMatches = false;
    let errorCode: string | undefined;
    try {
      if (this.options.botRuntime) {
        await this.options.botRuntime.probe(profile.id);
        botExists = true;
        botEnabled = profile.enabled;
        platformMatches = true;
        if (!botEnabled) errorCode = "channel-bot-disabled";
      } else {
        const client = this.client(profile.connectionId);
        await client.checkCompatibility();
        const bot = await client.getBot(profile.botUuid);
        botExists = true;
        botEnabled = bot.enabled;
        platformMatches = bot.platform === profile.platform;
        if (!botEnabled) errorCode = "langbot-bot-disabled";
        else if (!platformMatches) errorCode = "channel-bot-platform-mismatch";
      }
    } catch (error) {
      errorCode =
        error instanceof BotChannelTransportError
          ? error.code
          : error instanceof LangBotClientError
          ? error.code
          : "platform-connection-failed";
    }
    const success = botExists && botEnabled && platformMatches && !errorCode;
    const transientRuntimeState =
      errorCode === "bot-core-not-ready" ||
      errorCode === "bot-profile-not-connected";
    this.connections.setProfileActivity(profileId, "detection", {
      success,
      errorCode,
    });
    this.connections.upsertObservation({
      entryKey: `channel:${profile.platform}:${profile.id}`,
      integrationId: profile.platform,
      profileId: profile.id,
      state: transientRuntimeState
        ? "unknown"
        : success &&
            !!profile.owner &&
            !!profile.initializedAt &&
            profile.onboardingState === "ready"
          ? "connected"
          : success
            ? "attention"
            : "disconnected",
      reasonCode:
        (transientRuntimeState
          ? "channel-runtime-starting"
          : errorCode) ??
        (!profile.owner
          ? "owner-pairing-required"
          : !profile.initializedAt
            ? "initialization-pending"
            : undefined),
      nextAction:
        transientRuntimeState
          ? "正在等待 Bot Core 完成连接"
          : !profile.owner
          ? "请完成主人配对"
          : !profile.initializedAt
            ? "请重试初始化消息"
            : errorCode
              ? "请检查平台机器人凭据与长连接状态"
              : undefined,
    });
    const latest = this.requireProfile(profileId);
    const counts = this.deliveries.counts(profileId);
    return {
      profile: latest,
      gateway: {
        reachable:
          !errorCode ||
          (!errorCode.includes("connection") &&
            !errorCode.includes("unavailable")),
        authenticated:
          errorCode !== "platform-authentication-failed" &&
          errorCode !== "langbot-unauthorized",
        compatible: errorCode !== "langbot-incompatible",
        checkedAt: latest.lastDetectedAt,
        ...(errorCode ? { errorCode } : {}),
      },
      bot: {
        exists: botExists,
        enabled: botEnabled,
        platformMatches,
        checkedAt: latest.lastDetectedAt,
        ...(errorCode ? { errorCode } : {}),
      },
      inbound: { lastSuccessAt: latest.lastInboundAt },
      outbound: {
        lastSuccessAt: latest.lastOutboundAt,
        pending: counts.pending,
        failed: counts.failed,
      },
    };
  }

  queueTestMessage(profileId: string) {
    const profile = this.requireReadyOwner(profileId);
    const targetId = profile.platform === "wecom"
      ? this.bindings.findActiveOwner(profile.id, profile.owner!.userId)?.chatId ??
        profile.owner!.userId
      : profile.owner!.userId;
    return this.deliveries.enqueue({
      connectionId: profile.connectionId,
      profileId: profile.id,
      botUuid: profile.botUuid,
      platform: profile.platform,
      targetType: "person",
      targetId,
      purpose: "diagnostic",
      text: `【WeMail 连接测试】${profile.displayName} 的消息发送通道工作正常。`,
      sequence: 0,
      maxAttempts: 3,
      correlationKey: `diagnostic:${profile.id}:${randomUUID()}`,
      ownerBindingVersion: profile.owner!.bindingVersion,
    });
  }

  disconnectProfile(profileId: string): ChannelBotProfile {
    const profile = this.requireProfile(profileId);
    for (const binding of this.bindings.listByProfile(profileId)) {
      if (binding.enabled) this.bindings.setEnabled(binding.id, false);
    }
    const updated = this.connections.setProfileState(profileId, {
      state: "bot_selected",
      enabled: false,
      errorCode: "channel-disconnected-by-user",
    });
    this.connections.upsertObservation({
      entryKey: `channel:${profile.platform}:${profile.id}`,
      integrationId: profile.platform,
      profileId: profile.id,
      state: "disconnected",
      reasonCode: "channel-disconnected-by-user",
      nextAction: "请重新配对主人并完成初始化",
    });
    return updated!;
  }

  createBinding(input: {
    profileId: string;
    accountId: string;
    chatKind: "person" | "group";
    chatId: string;
    senderId: string;
    conversationId?: string;
    requireMention?: boolean;
  }) {
    const profile = this.requireProfile(input.profileId);
    return this.bindings.save({
      connectionId: profile.connectionId,
      profileId: profile.id,
      botUuid: profile.botUuid,
      platform: profile.platform,
      chatKind: input.chatKind,
      chatId: input.chatId,
      senderId: input.senderId,
      accountId: input.accountId,
      conversationId:
        input.conversationId ??
        `channel:${profile.id}:${input.chatKind}:${input.chatId}:${input.senderId}`,
      enabled: true,
      requireMention:
        input.chatKind === "group" ? input.requireMention !== false : false,
    });
  }

  private client(
    connectionId: string,
  ): Pick<LangBotClient, "listBots" | "getBot" | "checkCompatibility"> {
    const injected = this.options.clientFactory?.(connectionId);
    if (injected) return injected;
    const connection = this.connections.getConnection(connectionId);
    const apiKey = this.connectionService.getApiKey(connectionId);
    if (!connection || !apiKey) throw new Error("langbot-connection-not-ready");
    return new LangBotClient({ baseUrl: connection.baseUrl, apiKey });
  }

  private requireProfile(profileId: string): ChannelBotProfile {
    const profile = this.connections.getProfile(profileId);
    if (!profile) throw new Error("channel-profile-not-found");
    return profile;
  }

  private requireReadyOwner(profileId: string): ChannelBotProfile {
    const profile = this.requireProfile(profileId);
    if (
      !profile.owner ||
      !profile.enabled ||
      profile.onboardingState !== "ready"
    ) {
      throw new Error("channel-profile-not-ready");
    }
    return profile;
  }
}
