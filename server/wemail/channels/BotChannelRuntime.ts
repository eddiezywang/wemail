import type {
  BotCoreInboundEnvelope,
  BotCoreStreamResult,
} from "../../../shared/wemail/botCoreProtocol.js";
import type {
  ChannelInboundEvent,
  ChannelChatKind,
  ChannelPlatform,
} from "../../../shared/wemail/channels.js";
import type { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import type { ChannelInboundRepository } from "./ChannelLedgerRepository.js";
import type { ChannelDestinationRepository } from "./ChannelDestinationRepository.js";

export interface BotChannelTransport {
  send(input: {
    profileId: string;
    targetType: ChannelChatKind;
    targetId: string;
    text: string;
  }): Promise<void>;
  setReaction(input: {
    profileId: string;
    messageId: string;
    emojiType: string;
    action: "add" | "remove";
  }): Promise<void>;
  probe(profileId: string): Promise<void>;
  /** Optional WeCom passive streaming capability. */
  streamFrame?(input: {
    profileId: string;
    sourceEventId: string;
    streamId: string;
    content: string;
    finish: boolean;
  }): Promise<BotCoreStreamResult>;
  /** Optional Feishu Card Kit streaming capability. */
  feishuStreamStart?(input: {
    profileId: string;
    receiveId: string;
    uuid: string;
  }): Promise<
    | { outcome: "created"; cardId: string; messageId: string }
    | { outcome: "failed" }
  >;
  feishuStreamText?(input: {
    profileId: string;
    cardId: string;
    elementId: string;
    text: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed">;
  feishuStreamEnd?(input: {
    profileId: string;
    cardId: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed">;
  feishuStreamAbort?(input: { profileId: string; messageId: string }): Promise<void>;
}

export class BotChannelTransportError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

/**
 * Default ceiling on a single connectivity probe. The transport probe crosses
 * into Bot Core over IPC and awaits the platform long-connection, which has no
 * internal deadline — without this cap a stuck connection would hang channel
 * detection (and the per-profile detect endpoint) indefinitely.
 */
const PROBE_TIMEOUT_MS = 10_000;

export class BotChannelRuntime {
  private transport?: BotChannelTransport;
  private readonly configurationListeners = new Set<() => void>();

  constructor(
    private readonly inbound: ChannelInboundRepository,
    private readonly connections: ChannelConnectionRepository,
    private readonly destinations?: ChannelDestinationRepository,
    private readonly probeTimeoutMs: number = PROBE_TIMEOUT_MS,
  ) {}

  attachTransport(transport: BotChannelTransport): () => void {
    this.transport = transport;
    return () => {
      if (this.transport === transport) this.transport = undefined;
    };
  }

  onConfigurationChanged(listener: () => void): () => void {
    this.configurationListeners.add(listener);
    return () => this.configurationListeners.delete(listener);
  }

  notifyConfigurationChanged(): void {
    for (const listener of this.configurationListeners) listener();
  }

  async send(input: {
    profileId: string;
    targetType: ChannelChatKind;
    targetId: string;
    text: string;
  }): Promise<void> {
    if (!this.transport) {
      throw new BotChannelTransportError("bot-core-not-ready", true);
    }
    await this.transport.send(input);
  }

  async probe(profileId: string): Promise<void> {
    const transport = this.transport;
    if (!transport) {
      throw new BotChannelTransportError("bot-core-not-ready", true);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transport.probe(profileId),
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new BotChannelTransportError(
                  "channel-connection-timeout",
                  true,
                ),
              ),
            this.probeTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async setReaction(input: {
    profileId: string;
    messageId: string;
    emojiType: string;
    action: "add" | "remove";
  }): Promise<void> {
    if (!this.transport) {
      throw new BotChannelTransportError("bot-core-not-ready", true);
    }
    await this.transport.setReaction(input);
  }

  /**
   * Push one WeCom streaming frame. Throws `bot-core-not-ready` when bot-core
   * is unavailable or the platform does not support streaming, so the caller
   * can fall back to a one-shot send.
   */
  async streamFrame(input: {
    profileId: string;
    sourceEventId: string;
    streamId: string;
    content: string;
    finish: boolean;
  }): Promise<BotCoreStreamResult> {
    if (!this.transport?.streamFrame) {
      throw new BotChannelTransportError("bot-core-not-ready", true);
    }
    return this.transport.streamFrame(input);
  }

  async feishuStreamStart(input: {
    profileId: string;
    receiveId: string;
    uuid: string;
  }): Promise<
    | { outcome: "created"; cardId: string; messageId: string }
    | { outcome: "failed" }
  > {
    if (!this.transport?.feishuStreamStart) {
      throw new BotChannelTransportError("bot-core-not-ready", true);
    }
    return this.transport.feishuStreamStart(input);
  }

  async feishuStreamText(input: {
    profileId: string;
    cardId: string;
    elementId: string;
    text: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed"> {
    if (!this.transport?.feishuStreamText) {
      throw new BotChannelTransportError("bot-core-not-ready", true);
    }
    return this.transport.feishuStreamText(input);
  }

  async feishuStreamEnd(input: {
    profileId: string;
    cardId: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed"> {
    if (!this.transport?.feishuStreamEnd) {
      throw new BotChannelTransportError("bot-core-not-ready", true);
    }
    return this.transport.feishuStreamEnd(input);
  }

  async feishuStreamAbort(input: {
    profileId: string;
    messageId: string;
  }): Promise<void> {
    if (!this.transport?.feishuStreamAbort) {
      throw new BotChannelTransportError("bot-core-not-ready", true);
    }
    await this.transport.feishuStreamAbort(input);
  }

  ingest(envelope: BotCoreInboundEnvelope): {
    id: string;
    duplicate: boolean;
  } {
    const profile = this.connections.getProfile(envelope.profileId);
    if (
      !profile ||
      (!profile.enabled && profile.onboardingState !== "owner_pairing") ||
      profile.connectionId !== envelope.connectionId ||
      profile.botUuid !== envelope.botUuid ||
      profile.platform !== envelope.platform
    ) {
      throw new BotChannelTransportError("bot-profile-not-enabled", false);
    }
    const event = normalizeInbound(envelope);
    const accepted = this.inbound.accept(event, profile.id);
    if (!accepted.duplicate) {
      this.destinations?.save({
        profileId: profile.id,
        type: envelope.chatKind,
        externalId: envelope.chatId,
        displayName:
          envelope.chatName ??
          (envelope.chatKind === "person" ? envelope.senderName : undefined),
        verified: true,
      });
      this.connections.setProfileActivity(profile.id, "inbound", {
        success: true,
      });
    }
    return accepted;
  }
}

function normalizeInbound(
  envelope: BotCoreInboundEnvelope,
): ChannelInboundEvent {
  const unsupported = envelope.attachments.map((attachment) => ({
    type: "unsupported" as const,
    sourceType: attachment.type,
    text: attachment.fileName
      ? `[暂不支持的${attachment.type}：${attachment.fileName}]`
      : `[暂不支持的${attachment.type}]`,
  }));
  return {
    eventId: envelope.eventId,
    connectionId: envelope.connectionId,
    botUuid: envelope.botUuid,
    platform: envelope.platform,
    adapterName: qwenAdapterName(envelope.platform),
    chatKind: envelope.chatKind,
    chatId: envelope.chatId,
    ...(envelope.chatName ? { chatName: envelope.chatName } : {}),
    senderId: envelope.senderId,
    ...(envelope.senderName ? { senderName: envelope.senderName } : {}),
    text: envelope.text,
    message: [
      ...(envelope.text ? [{ type: "text" as const, text: envelope.text }] : []),
      ...unsupported,
    ],
    mentionedBot: envelope.mentionedBot,
    occurredAt: envelope.occurredAt,
    peerKey: buildPeerKey(envelope),
  };
}

function buildPeerKey(envelope: BotCoreInboundEnvelope): string {
  return [
    envelope.platform,
    envelope.botUuid,
    envelope.chatKind,
    envelope.chatId,
    envelope.chatKind === "group" ? envelope.senderId : "",
  ].join(":");
}

function qwenAdapterName(platform: ChannelPlatform): string {
  return platform === "feishu"
    ? "@qwen-code/channel-feishu"
    : "@qwen-code/channel-wecom";
}
