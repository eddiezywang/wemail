import type {
  ChannelInboundEvent,
  ChannelMessagePart,
  ChannelPlatform,
} from "../../../shared/wemail/channels.js";

export const LANGBOT_COMPATIBILITY_PROFILE = "langbot-service-api-v4.9";
export const LANGBOT_PINNED_VERSION = "4.9.7";
export const LANGBOT_MAX_WEBHOOK_BYTES = 256 * 1024;
export const LANGBOT_MAX_MESSAGE_PARTS = 64;
export const LANGBOT_MAX_TEXT_CHARS = 32_000;

export class LangBotPayloadError extends Error {
  constructor(
    public readonly code:
      | "payload-too-large"
      | "invalid-payload"
      | "unsupported-event"
      | "unsupported-adapter",
  ) {
    super(code);
    this.name = "LangBotPayloadError";
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function requiredString(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  if (!result || result.length > maxLength) return undefined;
  return result;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, maxLength);
}

export function normalizeLangBotPlatform(adapterName: string): ChannelPlatform | undefined {
  const value = adapterName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (value.includes("lark") || value.includes("feishu")) return "feishu";
  if (
    value.includes("wecom") ||
    value.includes("wechatwork") ||
    value.includes("workwechat")
  ) {
    return "wecom";
  }
  return undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.length <= 64) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function normalizeMessage(value: unknown): {
  parts: ChannelMessagePart[];
  text: string;
  mentionedBot: boolean;
} {
  if (!Array.isArray(value) || value.length > LANGBOT_MAX_MESSAGE_PARTS) {
    throw new LangBotPayloadError("invalid-payload");
  }
  const parts: ChannelMessagePart[] = [];
  let textLength = 0;
  let mentionedBot = false;
  for (const rawPart of value) {
    const part = object(rawPart);
    const type = requiredString(part?.type, 64);
    if (!part || !type) throw new LangBotPayloadError("invalid-payload");
    if (type.toLowerCase() === "plain") {
      const text = typeof part.text === "string" ? part.text : undefined;
      if (text === undefined) throw new LangBotPayloadError("invalid-payload");
      textLength += text.length;
      if (textLength > LANGBOT_MAX_TEXT_CHARS) {
        throw new LangBotPayloadError("payload-too-large");
      }
      parts.push({ type: "text", text });
      continue;
    }
    if (type.toLowerCase() === "at" || type.toLowerCase() === "mention") {
      mentionedBot = true;
      parts.push({
        type: "mention",
        targetId:
          optionalString(part.target, 256) ??
          optionalString(part.target_id, 256) ??
          optionalString(part.id, 256),
        text: optionalString(part.display, 256) ?? optionalString(part.name, 256),
      });
      continue;
    }
    parts.push({
      type: "unsupported",
      sourceType: type,
      text: `[不支持的消息元素：${type.slice(0, 40)}]`,
    });
  }
  return {
    parts,
    text: parts
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join("")
      .trim(),
    mentionedBot,
  };
}

export function stableChannelPeerKey(input: {
  connectionId: string;
  botUuid: string;
  platform: ChannelPlatform;
  chatKind: "person" | "group";
  chatId: string;
  senderId: string;
}): string {
  return [
    input.connectionId,
    input.botUuid,
    input.platform,
    input.chatKind,
    input.chatId,
    input.senderId,
  ]
    .map((value) => encodeURIComponent(value))
    .join(":");
}

export function parseLangBotWebhook(
  input: unknown,
  connectionId: string,
): ChannelInboundEvent {
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > LANGBOT_MAX_WEBHOOK_BYTES) {
    throw new LangBotPayloadError("payload-too-large");
  }
  const root = object(input);
  const eventId = requiredString(root?.uuid, 200);
  const eventType = requiredString(root?.event_type, 64);
  const data = object(root?.data);
  if (!root || !eventId || !eventType || !data) {
    throw new LangBotPayloadError("invalid-payload");
  }
  if (
    eventType !== "bot.person_message" &&
    eventType !== "bot.group_message"
  ) {
    throw new LangBotPayloadError("unsupported-event");
  }

  const botUuid = requiredString(data.bot_uuid, 200);
  const adapterName = requiredString(data.adapter_name, 100);
  const sender = object(data.sender);
  const senderId = requiredString(sender?.id, 512);
  const occurredAt = normalizeTimestamp(data.timestamp);
  if (!botUuid || !adapterName || !sender || !senderId || !occurredAt) {
    throw new LangBotPayloadError("invalid-payload");
  }
  const platform = normalizeLangBotPlatform(adapterName);
  if (!platform) throw new LangBotPayloadError("unsupported-adapter");

  const chatKind = eventType === "bot.person_message" ? "person" : "group";
  const group = chatKind === "group" ? object(data.group) : undefined;
  const chatId =
    chatKind === "person" ? senderId : requiredString(group?.id, 512);
  if (!chatId) throw new LangBotPayloadError("invalid-payload");

  const message = normalizeMessage(data.message);
  return {
    eventId,
    connectionId,
    botUuid,
    platform,
    adapterName,
    chatKind,
    chatId,
    chatName: optionalString(group?.name, 300),
    senderId,
    senderName: optionalString(sender.name, 300),
    text: message.text,
    message: message.parts,
    mentionedBot: message.mentionedBot,
    occurredAt,
    peerKey: stableChannelPeerKey({
      connectionId,
      botUuid,
      platform,
      chatKind,
      chatId,
      senderId,
    }),
  };
}
