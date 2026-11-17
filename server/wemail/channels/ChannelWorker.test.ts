import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentRunInput,
  AgentRuntime,
} from "../agent/AgentRuntime.js";
import { AgentConversationRepository } from "../agent/AgentConversationRepository.js";
import type { SecretStore } from "../security/SecretStore.js";
import { AgentPendingActionRepository } from "../agent/AgentPendingActionRepository.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { ChannelApprovalService } from "./ChannelApprovalService.js";
import { ChannelAuditRepository } from "./ChannelAuditRepository.js";
import { ChannelBindingRepository } from "./ChannelBindingRepository.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import {
  ChannelDeliveryRepository,
  ChannelInboundRepository,
} from "./ChannelLedgerRepository.js";
import { ChannelPairingService } from "./ChannelPairingService.js";
import { LangBotConnectionService } from "./LangBotConnectionService.js";
import { parseLangBotWebhook } from "./LangBotProtocol.js";
import {
  ChannelWorker,
  CHANNEL_DELIVERY_RETRY_WINDOW_MS,
  channelDeliveryRetryDeadline,
  safeAgentPresentation,
  splitChannelText,
} from "./ChannelWorker.js";

test("channel delivery retry window is retained for exactly ten minutes", () => {
  const createdAt = "2026-07-29T00:00:00.000Z";
  assert.equal(CHANNEL_DELIVERY_RETRY_WINDOW_MS, 10 * 60_000);
  assert.equal(
    channelDeliveryRetryDeadline({ createdAt }).toISOString(),
    "2026-07-29T00:10:00.000Z",
  );
});

class MemorySecrets implements SecretStore {
  private values = new Map<string, string>();
  saveSecret(key: string, value: string) {
    this.values.set(key, value);
  }
  getSecret(key: string) {
    return this.values.get(key);
  }
  deleteSecret(key: string) {
    this.values.delete(key);
  }
  isEncryptionAvailable() {
    return true;
  }
}

test("channel presentation excludes reasoning and tool payloads", () => {
  assert.deepEqual(
    safeAgentPresentation({
      type: "reasoning_delta",
      contentIndex: 0,
      text: "hidden",
    }),
    { kind: "ignored" },
  );
  assert.deepEqual(
    safeAgentPresentation({
      type: "tool_result",
      tool: "mail.search",
      output: { body: "secret mail" },
    }),
    { kind: "ignored" },
  );
  const visible = safeAgentPresentation({
    type: "assistant_text",
    text: "完成 token=abc C:\\private\\mail.txt",
  });
  assert.equal(visible.kind, "text");
  if (visible.kind === "text") {
    assert.doesNotMatch(visible.text, /abc|private/);
  }
});

test("oversized channel replies split deterministically and preserve order", () => {
  const source = `${"A".repeat(3_900)}。${"B".repeat(4_200)}`;
  const first = splitChannelText(source);
  const second = splitChannelText(source);
  assert.deepEqual(first, second);
  assert.ok(first.length >= 2);
  assert.ok(first.every((part) => part.length <= 4_000));
  assert.equal(first.join("").replace(/\s/g, ""), source.replace(/\s/g, ""));
});

test("worker dispatches only the exact binding and delivers the final safe reply", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => new Date("2026-07-29T00:00:00.000Z");
  insertCanonicalTestAccount(db, { id: "account-1", email: "a@example.com", displayName: "A" });
  const connections = new ChannelConnectionRepository(db, now);
  connections.createConnection({
    id: "connection-1",
    name: "LangBot",
    baseUrl: "http://127.0.0.1:5300",
    compatibilityProfile: "langbot-service-api-v4.9",
    apiSecretRef: "api-ref",
    webhookSecretRef: "webhook-ref",
    trustMode: "loopback",
  });
  connections.setConnectionCheck("connection-1", {
    compatible: true,
    enabled: true,
  });
  const profile = connections.saveProfile({
    id: "profile-1",
    connectionId: "connection-1",
    botUuid: "bot-1",
    platform: "feishu",
    displayName: "飞书助手",
    adapterName: "lark",
  });
  connections.replaceOwner(profile.id, { userId: "sender-1" });
  const bindings = new ChannelBindingRepository(db, now);
  bindings.save({
    connectionId: "connection-1",
    profileId: profile.id,
    botUuid: "bot-1",
    platform: "feishu",
    chatKind: "person",
    chatId: "sender-1",
    senderId: "sender-1",
    accountId: "account-1",
    conversationId: "conversation-1",
    enabled: true,
    requireMention: false,
  });
  const inbound = new ChannelInboundRepository(db, now);
  const deliveries = new ChannelDeliveryRepository(db, now);
  const audit = new ChannelAuditRepository(db, now);
  const secrets = new MemorySecrets();
  secrets.saveSecret("api-ref", "api-key");
  secrets.saveSecret("webhook-ref", "webhook-key");
  const connectionService = new LangBotConnectionService(
    connections,
    secrets,
    audit,
  );
  const pairing = new ChannelPairingService(
    db,
    connections,
    deliveries,
    bindings,
    audit,
    () => "account-1",
    now,
  );
  const pending = new AgentPendingActionRepository({
    db,
    now: () => now().toISOString(),
  });
  const approvals = new ChannelApprovalService(
    db,
    pending,
    { execute: async () => ({ ok: true, summary: "ok" }) },
    now,
  );
  let conversationClock = 0;
  const conversations = new AgentConversationRepository(
    db,
    () => new Date(now().getTime() + conversationClock++ * 1_000).toISOString(),
  );
  const runtimeInputs: AgentRunInput[] = [];
  const runtime: AgentRuntime = {
    async *run(input) {
      runtimeInputs.push(input);
      yield { type: "reasoning_delta", contentIndex: 0, text: "hidden" };
      yield {
        type: "assistant_text",
        text: "处理完成 token=secret",
      };
      yield { type: "done" };
    },
    registerTool() {},
    listTools: () => [],
  };
  const sent: string[] = [];
  const worker = new ChannelWorker(
    inbound,
    deliveries,
    bindings,
    connections,
    connectionService,
    pairing,
    approvals,
    audit,
    runtime,
    {
      now,
      conversations,
      clientFactory: () => ({
        sendMessage: async (input) => {
          sent.push(input.text);
          return { sent: true };
        },
      }),
    },
  );
  const boundEvent = parseLangBotWebhook(
    {
      uuid: "event-bound",
      event_type: "bot.person_message",
      data: {
        bot_uuid: "bot-1",
        adapter_name: "lark",
        sender: { id: "sender-1" },
        message: [{ type: "Plain", text: "hello" }],
        timestamp: 1785283200,
      },
    },
    "connection-1",
  );
  inbound.accept(boundEvent, profile.id);
  await worker.runOnce();
  assert.equal(runtimeInputs.length, 1);
  assert.equal(runtimeInputs[0]?.accountId, "account-1");
  assert.equal(runtimeInputs[0]?.sessionId, "conversation-1");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /处理完成/);
  assert.doesNotMatch(sent[0]!, /secret|hidden/);

  const followUpEvent = parseLangBotWebhook(
    {
      uuid: "event-follow-up",
      event_type: "bot.person_message",
      data: {
        bot_uuid: "bot-1",
        adapter_name: "lark",
        sender: { id: "sender-1" },
        message: [{ type: "Plain", text: "继续" }],
        timestamp: 1785283201,
      },
    },
    "connection-1",
  );
  inbound.accept(followUpEvent, profile.id);
  await worker.runOnce();
  assert.equal(runtimeInputs.length, 2);
  assert.deepEqual(runtimeInputs[1]?.context?.recentConversation, [
    {
      role: "user",
      text: "hello",
      at: "2026-07-29T00:00:01.000Z",
    },
    {
      role: "assistant",
      text: "处理完成 token=[已隐藏]",
      at: "2026-07-29T00:00:02.000Z",
    },
  ]);
  assert.deepEqual(
    conversations
      .listMessages("conversation-1")
      .map((message) => ({
        role: message.role,
        text: message.body.text,
        eventId: message.body.channelEventId,
      })),
    [
      { role: "user", text: "hello", eventId: "event-bound" },
      {
        role: "assistant",
        text: "处理完成 token=[已隐藏]",
        eventId: "event-bound",
      },
      { role: "user", text: "继续", eventId: "event-follow-up" },
      {
        role: "assistant",
        text: "处理完成 token=[已隐藏]",
        eventId: "event-follow-up",
      },
    ],
  );

  const ownerGroupEvent = parseLangBotWebhook(
    {
      uuid: "event-owner-group",
      event_type: "bot.group_message",
      data: {
        bot_uuid: "bot-1",
        adapter_name: "lark",
        sender: { id: "sender-1" },
        group: { id: "group-1" },
        message: [
          { type: "At", target: "bot-1" },
          { type: "Plain", text: "群里也查一下" },
        ],
        timestamp: 1785283200,
      },
    },
    "connection-1",
  );
  inbound.accept(ownerGroupEvent, profile.id);
  await worker.runOnce();
  assert.equal(runtimeInputs.length, 3);
  assert.equal(runtimeInputs[2]?.accountId, "account-1");
  assert.equal(
    bindings.resolve({
      connectionId: "connection-1",
      botUuid: "bot-1",
      platform: "feishu",
      chatKind: "group",
      chatId: "group-1",
      senderId: "sender-1",
    })?.requireMention,
    true,
  );

  const unknownEvent = parseLangBotWebhook(
    {
      uuid: "event-unknown",
      event_type: "bot.person_message",
      data: {
        bot_uuid: "bot-1",
        adapter_name: "lark",
        sender: { id: "sender-2" },
        message: [{ type: "Plain", text: "hello" }],
        timestamp: 1785283200,
      },
    },
    "connection-1",
  );
  inbound.accept(unknownEvent, profile.id);
  await worker.runOnce();
  assert.equal(runtimeInputs.length, 3);
  assert.equal(sent.length, 3);
  const ignored = db
    .prepare(
      "SELECT status, last_error_code FROM channel_inbound_events WHERE event_uuid = 'event-unknown'",
    )
    .get() as { status: string; last_error_code: string };
  assert.deepEqual(ignored, {
    status: "ignored",
    last_error_code: "identity-not-bound",
  });
});
