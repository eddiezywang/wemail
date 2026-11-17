import type { MessagePortMain } from "electron";
import { isChannelProactiveDeliveryError } from "@qwen-code/channel-base";
import {
  BOT_CORE_PROTOCOL_VERSION,
  type BotCoreConfiguration,
  type BotCoreControlMessage,
  type BotCoreRequest,
  type BotCoreStreamResult,
} from "../../shared/wemail/botCoreProtocol.js";
import {
  createManagedBotChannel,
  type ManagedBotChannel,
} from "./channels.js";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Bot Core must run as an Electron Utility Process");

let controlPort: MessagePortMain | null = null;
let heartbeat: NodeJS.Timeout | null = null;
const channels = new Map<string, ManagedBotChannel>();
let configurationQueue = Promise.resolve();

parentPort.once("message", (event) => {
  const input = event.data as { type?: string; protocolVersion?: number };
  const [port] = event.ports;
  if (
    input?.type !== "bot-core.bootstrap" ||
    input.protocolVersion !== BOT_CORE_PROTOCOL_VERSION ||
    !port
  ) {
    throw new Error("Bot Core bootstrap protocol mismatch");
  }
  controlPort = port;
  controlPort.on("message", (messageEvent) => {
    const message = messageEvent.data as BotCoreControlMessage;
    if (message.type === "bot-core.shutdown") {
      void handleMessage(message);
      return;
    }
    if (message.type === "bot-core.configure") {
      const next = configurationQueue.then(() => handleMessage(message));
      configurationQueue = next.catch(() => undefined);
      void next;
      return;
    }
    void configurationQueue.then(() => handleMessage(message));
  });
  controlPort.start();
  controlPort.postMessage({
    type: "bot-core.ready",
    protocolVersion: BOT_CORE_PROTOCOL_VERSION,
    pid: process.pid,
  } satisfies BotCoreControlMessage);
  heartbeat = setInterval(() => {
    controlPort?.postMessage({
      type: "bot-core.heartbeat",
      at: Date.now(),
      pid: process.pid,
    } satisfies BotCoreControlMessage);
  }, 2_000);
  heartbeat.unref();
});

async function handleMessage(message: BotCoreControlMessage): Promise<void> {
  if (message.type === "bot-core.shutdown") {
    await disconnectAll();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    controlPort?.postMessage({
      type: "bot-core.shutdown-complete",
    } satisfies BotCoreControlMessage);
    controlPort?.close();
    controlPort = null;
    process.exit(0);
  }
  if (
    message.type === "bot-core.configure" ||
    message.type === "bot-core.send" ||
    message.type === "bot-core.reaction" ||
    message.type === "bot-core.probe" ||
    message.type === "bot-core.stream-frame" ||
    message.type === "bot-core.feishu-stream"
  ) {
    await handleRequest(message);
  }
}

async function handleRequest(request: BotCoreRequest): Promise<void> {
  try {
    if (request.type === "bot-core.configure") {
      await replaceConfigurations(request.configurations);
    } else if (request.type === "bot-core.send") {
      const channel = channels.get(request.profileId);
      if (!channel) throw new BotCoreError("bot-profile-not-connected");
      await channel.transport.sendDelivery(
        request.targetType,
        request.targetId,
        request.text,
      );
    } else if (request.type === "bot-core.reaction") {
      const channel = channels.get(request.profileId);
      if (!channel) throw new BotCoreError("bot-profile-not-connected");
      if (channel.configuration.platform !== "feishu") {
        throw new BotCoreError("platform-reaction-unsupported");
      }
      await channel.transport.setReaction(
        request.messageId,
        request.emojiType,
        request.action,
      );
    } else if (request.type === "bot-core.stream-frame") {
      const channel = channels.get(request.profileId);
      if (!channel) throw new BotCoreError("bot-profile-not-connected");
      if (channel.configuration.platform !== "wecom") {
        throw new BotCoreError("platform-streaming-unsupported");
      }
      if (!channel.transport.streamFrame) {
        throw new BotCoreError("platform-streaming-unsupported");
      }
      const streamResult = await channel.transport.streamFrame({
        sourceEventId: request.sourceEventId,
        streamId: request.streamId,
        content: request.content,
        finish: request.finish,
      });
      respond(request.requestId, true, undefined, streamResult);
      return;
    } else if (request.type === "bot-core.feishu-stream") {
      await handleFeishuStream(request);
      return;
    } else {
      if (!channels.has(request.profileId)) {
        throw new BotCoreError("bot-profile-not-connected");
      }
    }
    respond(request.requestId, true);
  } catch (error) {
    respond(request.requestId, false, classifyError(error));
  }
}

async function handleFeishuStream(
  request: Extract<BotCoreRequest, { type: "bot-core.feishu-stream" }>,
): Promise<void> {
  const channel = channels.get(request.profileId);
  if (!channel) throw new BotCoreError("bot-profile-not-connected");
  if (channel.configuration.platform !== "feishu") {
    throw new BotCoreError("platform-streaming-unsupported");
  }
  const transport = channel.transport;
  try {
    if (request.op === "create") {
      if (!transport.feishuStreamStart) {
        throw new BotCoreError("platform-streaming-unsupported");
      }
      const result = await transport.feishuStreamStart({
        receiveId: request.receiveId,
        uuid: request.uuid,
      });
      if (result.outcome === "failed") {
        respond(request.requestId, false, "feishu-stream-create-failed");
        return;
      }
      respond(request.requestId, true, undefined, undefined, {
        outcome: "created",
        cardId: result.cardId,
        messageId: result.messageId,
      });
      return;
    }
    if (request.op === "text") {
      if (!transport.feishuStreamText) {
        throw new BotCoreError("platform-streaming-unsupported");
      }
      const outcome = await transport.feishuStreamText({
        cardId: request.cardId,
        elementId: request.elementId,
        text: request.text,
        sequence: request.sequence,
        uuid: request.uuid,
      });
      respond(request.requestId, true, undefined, undefined, { outcome });
      return;
    }
    if (request.op === "end") {
      if (!transport.feishuStreamEnd) {
        throw new BotCoreError("platform-streaming-unsupported");
      }
      const outcome = await transport.feishuStreamEnd({
        cardId: request.cardId,
        sequence: request.sequence,
        uuid: request.uuid,
      });
      respond(request.requestId, true, undefined, undefined, { outcome });
      return;
    }
    if (!transport.feishuStreamAbort) {
      throw new BotCoreError("platform-streaming-unsupported");
    }
    await transport.feishuStreamAbort(request.messageId);
    respond(request.requestId, true, undefined, undefined, { outcome: "sent" });
  } catch (error) {
    respond(request.requestId, false, classifyError(error));
  }
}

async function replaceConfigurations(
  configurations: BotCoreConfiguration[],
): Promise<void> {
  const desired = new Map(
    configurations
      .filter((configuration) => configuration.enabled)
      .map((configuration) => [configuration.profileId, configuration]),
  );
  for (const [profileId, channel] of channels) {
    const next = desired.get(profileId);
    if (next && sameConfiguration(channel.configuration, next)) continue;
    channel.transport.disconnect();
    channels.delete(profileId);
    status(channel.configuration, "disconnected");
  }
  for (const configuration of desired.values()) {
    if (channels.has(configuration.profileId)) continue;
    status(configuration, "connecting");
    let channel: ManagedBotChannel | undefined;
    channel = createManagedBotChannel(
      configuration,
      (envelope) => {
        controlPort?.postMessage({
          type: "bot-core.inbound",
          envelope,
        } satisfies BotCoreControlMessage);
      },
      (code) => {
        // A channel declared a fatal connection failure it cannot recover
        // from on its own (e.g. a duplicate WeCom connection). Drop it so the
        // next configure() recreates it cleanly, and surface the cause.
        if (channels.get(configuration.profileId) !== channel) return;
        channels.delete(configuration.profileId);
        status(configuration, "disconnected", code);
      },
    );
    try {
      await channel.transport.connect();
      channels.set(configuration.profileId, channel);
      status(configuration, "connected");
    } catch (error) {
      // The upstream WeCom SDK re-throws its connect() error without surfacing
      // it anywhere (WeComAdapter.js). Capture the real cause here so it flows
      // out on Bot Core stderr, which the supervisor persists to startup.log.
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      process.stderr.write(
        `[bot-core] profile ${configuration.profileId} (${configuration.platform}) connect failed: ${classifyError(error)} — ${detail}\n`,
      );
      channel.transport.disconnect();
      status(configuration, "disconnected", classifyError(error));
      throw error;
    }
  }
}

async function disconnectAll(): Promise<void> {
  for (const channel of channels.values()) channel.transport.disconnect();
  channels.clear();
}

function respond(
  requestId: string,
  ok: boolean,
  errorCode?: string,
  streamResult?: BotCoreStreamResult,
  feishuStream?: {
    outcome: "created" | "sent" | "failed";
    cardId?: string;
    messageId?: string;
  },
): void {
  controlPort?.postMessage({
    type: "bot-core.response",
    requestId,
    ok,
    ...(errorCode ? { errorCode } : {}),
    ...(streamResult ? { streamResult } : {}),
    ...(feishuStream ? { feishuStream } : {}),
  } satisfies BotCoreControlMessage);
}

function status(
  configuration: BotCoreConfiguration,
  state: "connecting" | "connected" | "disconnected",
  errorCode?: string,
): void {
  controlPort?.postMessage({
    type: "bot-core.status",
    profileId: configuration.profileId,
    platform: configuration.platform,
    state,
    observedAt: new Date().toISOString(),
    ...(errorCode ? { errorCode } : {}),
  } satisfies BotCoreControlMessage);
}

function sameConfiguration(
  left: BotCoreConfiguration,
  right: BotCoreConfiguration,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

class BotCoreError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function classifyError(error: unknown): string {
  if (error instanceof BotCoreError) return error.code;
  if (isChannelProactiveDeliveryError(error)) {
    return error.disposition === "permanent"
      ? "platform-delivery-rejected"
      : "platform-temporarily-unavailable";
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("auth") || message.includes("credential")) {
    return "platform-authentication-failed";
  }
  if (message.includes("timeout") || message.includes("network")) {
    return "platform-temporarily-unavailable";
  }
  return "platform-connection-failed";
}
