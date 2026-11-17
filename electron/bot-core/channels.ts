import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  FeishuChannel,
} from "@qwen-code/channel-feishu";
import {
  WeComChannel,
} from "@qwen-code/channel-wecom";
import * as lark from "@larksuiteoapi/node-sdk";
import type {
  AvailableCommand,
  ChannelAgentBridge,
  ChannelConfig,
  Envelope,
  SessionTarget,
} from "@qwen-code/channel-base";
import type {
  BotCoreConfiguration,
  BotCoreInboundEnvelope,
  BotCoreStreamResult,
} from "../../shared/wemail/botCoreProtocol.js";
import type { ChannelChatKind } from "../../shared/wemail/channels.js";
import { ReconnectPacer } from "./reconnectPacer.js";
import { buildFeishuStreamingCardJson } from "../../server/wemail/channels/feishuStreamingCard.js";

type QwenTransport = {
  connect(): Promise<void>;
  disconnect(): void;
  sendDelivery(
    targetType: ChannelChatKind,
    targetId: string,
    text: string,
  ): Promise<void>;
  setReaction(
    messageId: string,
    emojiType: string,
    action: "add" | "remove",
  ): Promise<void>;
  /**
   * Optional WeCom streaming capability. Absent on platforms without passive
   * streaming (Feishu). Pushes one stream frame keyed on the cached inbound
   * frame for `sourceEventId`. The req_id never leaves bot-core.
   */
  streamFrame?(input: {
    sourceEventId: string;
    streamId: string;
    content: string;
    finish: boolean;
  }): Promise<BotCoreStreamResult>;
  /** Optional Feishu Card Kit streaming capability (Feishu only). */
  feishuStreamStart?(input: {
    receiveId: string;
    uuid: string;
  }): Promise<
    | { outcome: "created"; cardId: string; messageId: string }
    | { outcome: "failed" }
  >;
  feishuStreamText?(input: {
    cardId: string;
    elementId: string;
    text: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed">;
  feishuStreamEnd?(input: {
    cardId: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed">;
  feishuStreamAbort?(messageId: string): Promise<void>;
};

export interface FeishuReactionApi {
  create(input: {
    path: { message_id: string };
    data: { reaction_type: { emoji_type: string } };
  }): Promise<{
    code?: number;
    data?: { reaction_id?: string };
  }>;
  delete(input: {
    path: { message_id: string; reaction_id: string };
  }): Promise<{ code?: number }>;
}

export class FeishuReactionManager {
  private readonly reactionIds = new Map<string, string>();

  constructor(private readonly api: FeishuReactionApi) {}

  async setReaction(
    messageId: string,
    emojiType: string,
    action: "add" | "remove",
  ): Promise<void> {
    const key = `${messageId}:${emojiType}`;
    if (action === "add") {
      if (this.reactionIds.has(key)) return;
      const response = await this.api.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      const reactionId = response.data?.reaction_id;
      if ((response.code ?? 0) !== 0 || !reactionId) {
        throw new Error(`feishu-reaction-add-failed:${response.code ?? "unknown"}`);
      }
      this.reactionIds.set(key, reactionId);
      return;
    }

    const reactionId = this.reactionIds.get(key);
    if (!reactionId) return;
    const response = await this.api.delete({
      path: {
        message_id: messageId,
        reaction_id: reactionId,
      },
    });
    if ((response.code ?? 0) !== 0) {
      throw new Error(
        `feishu-reaction-remove-failed:${response.code ?? "unknown"}`,
      );
    }
    this.reactionIds.delete(key);
  }

  clear(): void {
    this.reactionIds.clear();
  }
}

class DisabledAgentBridge implements ChannelAgentBridge {
  readonly availableCommands: AvailableCommand[] = [];
  private readonly events = new EventEmitter();
  readonly on = this.events.on.bind(this.events) as ChannelAgentBridge["on"];
  readonly off = this.events.off.bind(this.events) as ChannelAgentBridge["off"];

  async newSession(): Promise<string> {
    throw new Error("bot-core-agent-bridge-disabled");
  }

  async loadSession(): Promise<string> {
    throw new Error("bot-core-agent-bridge-disabled");
  }

  async prompt(): Promise<string> {
    throw new Error("bot-core-agent-bridge-disabled");
  }

  async cancelSession(): Promise<void> {}
}

class WemailFeishuChannel extends FeishuChannel {
  private readonly reactions: FeishuReactionManager;
  /** Reused for reactions AND Card Kit streaming (auto-managed tenant token). */
  private readonly larkClient: lark.Client;

  constructor(
    private readonly channelName: string,
    config: ChannelConfig,
    private readonly emitInbound: (envelope: Envelope) => void,
  ) {
    super(channelName, config, new DisabledAgentBridge());
    this.larkClient = new lark.Client({
      appId: config.clientId!,
      appSecret: config.clientSecret!,
    });
    this.reactions = new FeishuReactionManager(
      this.larkClient.im.v1.messageReaction,
    );
  }

  protected override async processInbound(envelope: Envelope): Promise<void> {
    this.emitInbound(envelope);
  }

  async sendDelivery(
    targetType: ChannelChatKind,
    targetId: string,
    text: string,
  ): Promise<void> {
    await deliverFeishuMessage(
      (target, content) => this.pushProactiveDelivery(target, content),
      this.channelName,
      targetType,
      targetId,
      text,
    );
  }

  async setReaction(
    messageId: string,
    emojiType: string,
    action: "add" | "remove",
  ): Promise<void> {
    await this.reactions.setReaction(messageId, emojiType, action);
  }

  /**
   * Create a streaming-mode card entity and send it to `receiveId` (a chat_id).
   * Returns the card_id + message_id, or `failed`. `uuid` makes the message send
   * idempotent across bot-core-timeout retries.
   */
  async feishuStreamStart(input: {
    receiveId: string;
    uuid: string;
  }): Promise<
    | { outcome: "created"; cardId: string; messageId: string }
    | { outcome: "failed" }
  > {
    try {
      const card = (await this.larkClient.cardkit.v1.card.create({
        data: {
          type: "card_json",
          data: JSON.stringify(buildFeishuStreamingCardJson()),
        },
      })) as { data?: { card_id?: string } };
      const cardId = card.data?.card_id;
      if (!cardId) return { outcome: "failed" };
      const message = (await this.larkClient.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: input.receiveId,
          msg_type: "interactive",
          content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
          uuid: input.uuid,
        },
      })) as { data?: { message_id?: string } };
      const messageId = message.data?.message_id;
      if (!messageId) return { outcome: "failed" };
      return { outcome: "created", cardId, messageId };
    } catch {
      return { outcome: "failed" };
    }
  }

  /** Stream-update one card element's full text (platform renders typewriter). */
  async feishuStreamText(input: {
    cardId: string;
    elementId: string;
    text: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed"> {
    try {
      const res = (await this.larkClient.cardkit.v1.cardElement.content({
        data: {
          content: input.text,
          sequence: input.sequence,
          uuid: input.uuid,
        },
        path: { card_id: input.cardId, element_id: input.elementId },
      })) as { code?: number };
      return res.code === 0 ? "sent" : "failed";
    } catch {
      return "failed";
    }
  }

  /** End streaming mode on the card (makes it forwardable, drops [生成中...]). */
  async feishuStreamEnd(input: {
    cardId: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed"> {
    try {
      const res = (await this.larkClient.cardkit.v1.card.settings({
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence: input.sequence,
          uuid: input.uuid,
        },
        path: { card_id: input.cardId },
      })) as { code?: number };
      return res.code === 0 ? "sent" : "failed";
    } catch {
      return "failed";
    }
  }

  /** Best-effort delete of a residual message (used when aborting before the
   *  card was ever visible). Errors are swallowed. */
  async feishuStreamAbort(messageId: string): Promise<void> {
    try {
      await this.larkClient.im.v1.message.delete({
        path: { message_id: messageId },
      });
    } catch {
      // best-effort cleanup; the message may already be gone
    }
  }

  override disconnect(): void {
    this.reactions.clear();
    super.disconnect();
  }
}

/**
 * A server kick ("a new connection has been established, this connection will be
 * closed") means a second client authenticated with the same bot credentials.
 * WeCom only allows one long connection per smart bot, so the two keep kicking
 * each other; reconnecting immediately just re-triggers the fight and trips the
 * 45009 (too-many-requests) rate limit. We count how often a *fresh* server-kick
 * event arrives; when they pile up within a short window we treat it as a
 * duplicate-connection conflict and surface a connection failure instead of
 * looping forever (the upstream SDK otherwise retries every 15 minutes ad
 * infinitum and never reports the failure).
 */
export const WECOM_DUPLICATE_KICK_LIMIT = 4;
export const WECOM_DUPLICATE_KICK_WINDOW_MS = 90_000;
export const WECOM_DUPLICATE_CONNECTION_ERROR_CODE = "wecom-duplicate-connection";

export class WecomDuplicateKickPolicy {
  private streak = 0;
  private windowStart = 0;
  constructor(
    private readonly limit = WECOM_DUPLICATE_KICK_LIMIT,
    private readonly windowMs = WECOM_DUPLICATE_KICK_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record a fresh server-kick event. Returns `{ fail: true }` once the kick
   *  rate exceeds the limit within the sliding window. */
  registerServerKick(): { fail: boolean } {
    const at = this.now();
    if (at - this.windowStart >= this.windowMs) {
      this.streak = 0;
      this.windowStart = at;
    }
    this.streak += 1;
    return { fail: this.streak > this.limit };
  }

  reset(): void {
    this.streak = 0;
    this.windowStart = 0;
  }
}

/**
 * Minimal view of the `@wecom/aibot-node-sdk` WSClient surface we use for
 * streaming passive replies. The full client lives behind the
 * `@qwen-code/channel-wecom` adapter (private `client` field, reassigned on
 * connect/reconnect — see WeComAdapter.js), so we reach it via the same
 * cast-to-private pattern as `bindDuplicateKickGuard`.
 */
interface WecomSdkStreamClient {
  replyStream(
    frame: { headers: WecomFrameHeadersValue },
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown>;
  replyStreamNonBlocking(
    frame: { headers: WecomFrameHeadersValue },
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown | "skipped">;
}

/** Inbound WS frame headers — the only part the SDK needs for a passive reply. */
type WecomFrameHeadersValue = { req_id: string; [key: string]: unknown };

/** A raw inbound WSClient event payload (the adapter's `onMessage` argument). */
interface WecomRawFrame {
  headers?: unknown;
  body?: unknown;
}

/** Cached inbound frame, keyed by the WeCom msgid (= envelope.eventId). */
interface CachedInboundFrame {
  headers: WecomFrameHeadersValue;
  ts: number;
}

/** Bounded LRU for inbound reply frames. Replies happen within ~120s; the TTL
 *  and cap just prevent unbounded growth under high message volume. */
const WECOM_FRAME_CACHE_TTL_MS = 30 * 60_000;
const WECOM_FRAME_CACHE_MAX = 200;
/**
 * Minimum spacing between reconnects. Reconnecting faster makes the WeCom
 * server see the old and new connection overlap and kick the new one, starting
 * a kick→reconnect→kick feedback loop. This gives the server time to release
 * the old slot. Real disconnects still recover within this window.
 */
const WECOM_MIN_RECONNECT_GAP_MS = 8_000;

class WemailWeComChannel extends WeComChannel {
  private readonly channelName: string;
  private readonly kickPolicy = new WecomDuplicateKickPolicy();
  private fatallyFailed = false;
  private readonly reconnectPacer = new ReconnectPacer({
    gapMs: WECOM_MIN_RECONNECT_GAP_MS,
  });
  /**
   * Inbound reply frames, keyed by WeCom msgid (which the server knows as
   * `BotCoreInboundEnvelope.eventId`). Captured by wrapping the adapter's
   * private `onMessage` so association is per-inbound-message — never
   * per-chat — which prevents a second message from overwriting the first
   * message's req_id mid-stream.
   */
  private readonly inboundFrames = new Map<string, CachedInboundFrame>();

  constructor(
    name: string,
    config: ChannelConfig & Record<string, unknown>,
    private readonly emitInbound: (envelope: Envelope) => void,
    private readonly onFatalError: (code: string) => void,
  ) {
    super(name, config, new DisabledAgentBridge());
    this.channelName = name;
    this.bindDuplicateKickGuard();
    this.bindInboundFrameCache();
  }

  /**
   * The upstream SDK declares `startKickReconnect` private, but it is the
   * prototype entry point invoked by the server-kick event handler. We rebind
   * the instance method so a fresh kick (the handler calls it with a single
   * argument, leaving `reconnectReason` undefined) is counted by our policy,
   * while scheduled retries and other internal callers — which always pass
   * `reconnectReason` explicitly — pass through unchanged.
   */
  private bindDuplicateKickGuard(): void {
    const self = this as unknown as {
      startKickReconnect: (reason: unknown, reconnectReason?: string) => void;
    };
    const upstream = self.startKickReconnect.bind(this);
    self.startKickReconnect = (reason, reconnectReason) => {
      if (this.fatallyFailed) return;
      if (reconnectReason === undefined) {
        const { fail } = this.kickPolicy.registerServerKick();
        if (fail) {
          this.declareFatalFailure();
          return;
        }
      }
      // Space reconnects apart so the WeCom server releases the old connection
      // slot before we reconnect; reconnecting too fast makes the server see an
      // overlap and kick the new connection, which starts a
      // kick→reconnect→kick feedback loop. Coalesce bursts into one reconnect.
      this.reconnectPacer.schedule(() => upstream(reason, reconnectReason));
    };
  }

  override async connect(): Promise<void> {
    await super.connect();
    this.disableUpstreamActivityWatchdog();
  }

  /**
   * The upstream activity watchdog reconnects after 5 minutes with no INBOUND
   * messages. A quiet connection is healthy as long as the SDK heartbeat (30s)
   * keeps flowing, and a truly dead connection is detected by the SDK
   * heartbeat failing (→ disconnected/error → the reconnect path). The
   * watchdog's reconnect churn makes WeCom see overlapping connections and
   * kick us — the seed of the kick→reconnect feedback loop — so clear it and
   * rely on heartbeat-based liveness instead.
   */
  private disableUpstreamActivityWatchdog(): void {
    (
      this as unknown as { clearActivityWatchdog?: () => void }
    ).clearActivityWatchdog?.();
  }

  /**
   * Wrap the adapter's private `onMessage(payload, generation)` (the prototype
   * entry point invoked by the SDK message handler) so each inbound's raw
   * frame — which carries `headers.req_id` and `body.msgid` — is cached before
   * the adapter normalizes and emits the envelope. This does not depend on the
   * private `client` field (reassigned on connect/reconnect), so it survives
   * reconnects. Same wrap-private-prototype-method pattern as
   * `bindDuplicateKickGuard`.
   */
  private bindInboundFrameCache(): void {
    const self = this as unknown as {
      onMessage: (payload: WecomRawFrame, generation: number) => Promise<void>;
    };
    const upstream = self.onMessage.bind(this);
    self.onMessage = async (payload, generation) => {
      this.cacheInboundFrame(payload);
      await upstream(payload, generation);
    };
  }

  private cacheInboundFrame(payload: unknown): void {
    const frame = payload as WecomRawFrame | null | undefined;
    if (!frame || typeof frame !== "object") return;
    const headers = frame.headers;
    if (
      !headers ||
      typeof headers !== "object" ||
      typeof (headers as { req_id?: unknown }).req_id !== "string"
    ) {
      return;
    }
    const body =
      frame.body && typeof frame.body === "object" ? frame.body : frame;
    const msgid = (body as { msgid?: unknown }).msgid;
    if (typeof msgid !== "string" || !msgid) return;
    this.inboundFrames.set(msgid, {
      headers: headers as WecomFrameHeadersValue,
      ts: Date.now(),
    });
    this.pruneFrameCache();
  }

  private freshFrame(msgid: string): CachedInboundFrame | undefined {
    const cached = this.inboundFrames.get(msgid);
    if (!cached) return undefined;
    if (Date.now() - cached.ts > WECOM_FRAME_CACHE_TTL_MS) {
      this.inboundFrames.delete(msgid);
      return undefined;
    }
    return cached;
  }

  private pruneFrameCache(): void {
    if (this.inboundFrames.size <= WECOM_FRAME_CACHE_MAX) return;
    const oldest = this.inboundFrames.keys().next();
    if (!oldest.done && typeof oldest.value === "string") {
      this.inboundFrames.delete(oldest.value);
    }
  }

  private sdkStreamClient(): WecomSdkStreamClient | undefined {
    const client = (this as unknown as { client?: unknown }).client;
    if (!client || typeof client !== "object") return undefined;
    const candidate = client as WecomSdkStreamClient;
    if (
      typeof candidate.replyStream !== "function" ||
      typeof candidate.replyStreamNonBlocking !== "function"
    ) {
      return undefined;
    }
    return candidate;
  }

  async streamFrame(input: {
    sourceEventId: string;
    streamId: string;
    content: string;
    finish: boolean;
  }): Promise<BotCoreStreamResult> {
    const client = this.sdkStreamClient();
    if (!client) return "failed";
    const cached = this.freshFrame(input.sourceEventId);
    if (!cached) return "no-frame";
    const frame = { headers: cached.headers };
    try {
      if (input.finish) {
        // Terminal frame: blocking, awaits the SDK ack. On throw the caller
        // treats the stream as broken and falls back to a one-shot send.
        await client.replyStream(frame, input.streamId, input.content, true);
        this.inboundFrames.delete(input.sourceEventId);
        return "sent";
      }
      // Intermediate frame: non-blocking; the SDK returns "skipped" when a
      // prior frame for this req_id is still pending ack (benign back
      // pressure — the next frame overwrites the bubble).
      const result = await client.replyStreamNonBlocking(
        frame,
        input.streamId,
        input.content,
        false,
      );
      return result === "skipped" ? "skipped" : "sent";
    } catch {
      return "failed";
    }
  }

  private declareFatalFailure(): void {
    if (this.fatallyFailed) return;
    this.fatallyFailed = true;
    process.stderr.write(
      `[WeCom:${this.channelName}] duplicate connection detected — server kept kicking this connection. ` +
        `Declaring failure to avoid the 45009 rate limit; close the other client (another instance, the WeCom devtool, or another machine) and reset.\n`,
    );
    this.kickPolicy.reset();
    try {
      this.disconnect();
    } catch {
      // teardown must not mask the failure report
    }
    this.onFatalError(WECOM_DUPLICATE_CONNECTION_ERROR_CODE);
  }

  protected override async processInbound(envelope: Envelope): Promise<void> {
    this.emitInbound(envelope);
  }

  override disconnect(): void {
    // req_ids are scoped to the current WS session; drop them on disconnect so
    // a stale cached frame can never drive a reply after reconnect.
    this.inboundFrames.clear();
    this.reconnectPacer.cancel();
    super.disconnect();
  }

  async sendDelivery(
    _targetType: ChannelChatKind,
    targetId: string,
    text: string,
  ): Promise<void> {
    await this.sendMessage(targetId, text);
  }

  async setReaction(): Promise<void> {
    throw new Error("platform-reaction-unsupported");
  }
}

export interface ManagedBotChannel {
  configuration: BotCoreConfiguration;
  transport: QwenTransport;
}

export async function deliverFeishuMessage(
  deliver: (target: SessionTarget, text: string) => Promise<void>,
  channelName: string,
  targetType: ChannelChatKind,
  targetId: string,
  text: string,
): Promise<void> {
  await deliver(
    {
      channelName,
      senderId: targetId,
      chatId: targetId,
      isGroup: targetType === "group",
    },
    text,
  );
}

export function createManagedBotChannel(
  configuration: BotCoreConfiguration,
  onInbound: (envelope: BotCoreInboundEnvelope) => void,
  onFatalError?: (code: string) => void,
): ManagedBotChannel {
  const emitInbound = (envelope: Envelope) => {
    const eventId =
      envelope.messageId?.trim() ||
      `${configuration.platform}:${configuration.profileId}:${randomUUID()}`;
    onInbound({
      eventId,
      connectionId: configuration.connectionId,
      profileId: configuration.profileId,
      botUuid: configuration.botUuid,
      platform: configuration.platform,
      chatKind: envelope.isGroup ? "group" : "person",
      chatId: envelope.chatId,
      ...(envelope.chatName ? { chatName: envelope.chatName } : {}),
      senderId: envelope.senderId,
      ...(envelope.senderName ? { senderName: envelope.senderName } : {}),
      text: envelope.text,
      mentionedBot: envelope.isMentioned,
      occurredAt: new Date().toISOString(),
      attachments: (envelope.attachments ?? []).map((attachment) => ({
        type: attachment.type,
        mimeType: attachment.mimeType,
        ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      })),
    });
  };
  const base: ChannelConfig = {
    type: configuration.platform,
    token: "",
    senderPolicy: "open",
    allowedUsers: [],
    sessionScope: "chat_thread",
    cwd: process.cwd(),
    groupPolicy: "open",
    dmPolicy: "open",
    groups: {},
  };
  const transport =
    configuration.platform === "feishu"
      ? new WemailFeishuChannel(
          `wemail-feishu-${configuration.profileId}`,
          {
            ...base,
            clientId: configuration.appId,
            clientSecret: configuration.appSecret,
          },
          emitInbound,
        )
      : new WemailWeComChannel(
          `wemail-wecom-${configuration.profileId}`,
          {
            ...base,
            botId: configuration.botId,
            secret: configuration.botSecret,
            ...(configuration.wsUrl ? { wsUrl: configuration.wsUrl } : {}),
          },
          emitInbound,
          onFatalError ?? (() => undefined),
        );
  return { configuration, transport };
}
