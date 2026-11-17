import type { ChannelChatKind, ChannelPlatform } from "./channels.js";

export const BOT_CORE_PROTOCOL_VERSION = 5;

/**
 * Outcome of a single WeCom stream-frame send, returned in `bot-core.response`.
 *
 * - `sent`: the SDK accepted the frame (intermediate or terminal).
 * - `skipped`: an intermediate frame was dropped because a prior frame for the
 *   same req_id is still pending its WebSocket ack (SDK non-blocking back
 *   pressure). Benign — the next frame overwrites the bubble.
 * - `failed`: the SDK call threw (connection/auth/payload error). The caller
 *   should treat the stream as broken and fall back to a one-shot delivery.
 * - `no-frame`: no cached inbound frame exists for `sourceEventId` (expired,
 *   never captured, or the inbound had no msgid). Passive streaming is
 *   impossible; fall back to a proactive one-shot send.
 */
export type BotCoreStreamResult = "sent" | "skipped" | "failed" | "no-frame";

export interface BotCoreInboundEnvelope {
  eventId: string;
  connectionId: string;
  profileId: string;
  botUuid: string;
  platform: ChannelPlatform;
  chatKind: "person" | "group";
  chatId: string;
  chatName?: string;
  senderId: string;
  senderName?: string;
  text: string;
  mentionedBot: boolean;
  occurredAt: string;
  attachments: Array<{
    type: "image" | "file" | "audio" | "video";
    mimeType: string;
    fileName?: string;
  }>;
}

interface BotCoreConfigurationBase {
  connectionId: string;
  profileId: string;
  botUuid: string;
  displayName: string;
  enabled: boolean;
}

export interface FeishuBotCoreConfiguration extends BotCoreConfigurationBase {
  platform: "feishu";
  appId: string;
  appSecret: string;
}

export interface WeComBotCoreConfiguration extends BotCoreConfigurationBase {
  platform: "wecom";
  botId: string;
  botSecret: string;
  wsUrl?: string;
}

export type BotCoreConfiguration =
  | FeishuBotCoreConfiguration
  | WeComBotCoreConfiguration;

export type BotCoreRequest =
  | {
      type: "bot-core.configure";
      requestId: string;
      configurations: BotCoreConfiguration[];
    }
  | {
      type: "bot-core.send";
      requestId: string;
      profileId: string;
      targetType: ChannelChatKind;
      targetId: string;
      text: string;
    }
  | {
      /**
       * Push one WeCom streaming frame as a passive reply keyed on the cached
       * inbound frame for `sourceEventId` (= the inbound's msgid, surfaced to
       * the server as `BotCoreInboundEnvelope.eventId`). `streamId` is owned by
       * the server-side session and reused every frame so WeCom replaces the
       * bubble in place. `finish=true` is the terminal frame. The req_id never
       * crosses the process boundary — bot-core resolves it from its cache.
       */
      type: "bot-core.stream-frame";
      requestId: string;
      profileId: string;
      sourceEventId: string;
      streamId: string;
      content: string;
      finish: boolean;
    }
  | {
      /**
       * Feishu Card Kit V1 streaming ops. Card Kit's `sequence` must be monotonic
       * across the whole card (the server-side session owns it); each op carries
       * a stable `uuid` so a bot-core-timeout retry is idempotent (Feishu dedups
       * by uuid). `receiveId` is the chat_id (works for p2p and group). The
       * `lark.Client` (auto-managed tenant_access_token) lives in bot-core.
       */
      type: "bot-core.feishu-stream";
      requestId: string;
      profileId: string;
      op: "create";
      receiveId: string;
      uuid: string;
    }
  | {
      type: "bot-core.feishu-stream";
      requestId: string;
      profileId: string;
      op: "text";
      cardId: string;
      elementId: string;
      text: string;
      sequence: number;
      uuid: string;
    }
  | {
      type: "bot-core.feishu-stream";
      requestId: string;
      profileId: string;
      op: "end";
      cardId: string;
      sequence: number;
      uuid: string;
    }
  | {
      type: "bot-core.feishu-stream";
      requestId: string;
      profileId: string;
      op: "abort";
      messageId: string;
    }
  | {
      type: "bot-core.reaction";
      requestId: string;
      profileId: string;
      messageId: string;
      emojiType: string;
      action: "add" | "remove";
    }
  | {
      type: "bot-core.probe";
      requestId: string;
      profileId: string;
    };

export type BotCoreControlMessage =
  | {
      type: "bot-core.bootstrap";
      protocolVersion: number;
    }
  | {
      type: "bot-core.ready";
      protocolVersion: number;
      pid: number;
    }
  | { type: "bot-core.heartbeat"; at: number; pid: number }
  | { type: "bot-core.shutdown" }
  | { type: "bot-core.shutdown-complete" }
  | BotCoreRequest
  | {
      type: "bot-core.response";
      requestId: string;
      ok: boolean;
      errorCode?: string;
      /** Present only for `bot-core.stream-frame` responses. */
      streamResult?: BotCoreStreamResult;
      /** Present only for `bot-core.feishu-stream` responses. */
      feishuStream?: {
        outcome: "created" | "sent" | "failed";
        cardId?: string;
        messageId?: string;
      };
    }
  | {
      type: "bot-core.inbound";
      envelope: BotCoreInboundEnvelope;
    }
  | {
      type: "bot-core.status";
      profileId: string;
      platform: ChannelPlatform;
      state: "connecting" | "connected" | "disconnected";
      observedAt: string;
      errorCode?: string;
    };
