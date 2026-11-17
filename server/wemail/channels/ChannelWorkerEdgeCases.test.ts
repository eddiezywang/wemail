import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActionExecutor } from "../agent/AgentActionExecutor.js";
import { AgentConversationRepository } from "../agent/AgentConversationRepository.js";
import type { AgentRuntime, AgentRunInput } from "../agent/AgentRuntime.js";
import { AgentPendingActionRepository } from "../agent/AgentPendingActionRepository.js";
import type { SecretStore } from "../security/SecretStore.js";
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
import { BotChannelRuntime } from "./BotChannelRuntime.js";
import { ChannelWorker } from "./ChannelWorker.js";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import type { LeasedChannelInbound } from "../../../shared/wemail/channels.js";

class MemorySecrets implements SecretStore {
  private readonly values = new Map<string, string>();
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

function createHarness(
  runtime: AgentRuntime,
  options: {
    platform?: "feishu" | "wecom";
    ownerUserId?: string;
    executeAction?: AgentActionExecutor["execute"];
    onAutomationDeliverySettled?: () => void;
    ledger?: Pick<MailDatabaseClient, "leaseChannelInbound" | "leaseChannelDelivery">;
  } = {},
) {
  let currentTime = new Date("2026-07-29T00:00:00.000Z");
  const now = () => currentTime;
  const db = openOrCreateMailDatabase(":memory:");
  for (const [id, email] of [
    ["account-1", "one@example.com"],
    ["account-2", "two@example.com"],
  ]) {
    insertCanonicalTestAccount(db, { id: id, email: email, displayName: id });
  }
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
    platform: options.platform ?? "feishu",
    displayName: options.platform === "wecom" ? "企业微信助手" : "飞书助手",
    adapterName:
      options.platform === "wecom" ? "wecom_intelligent_bot" : "lark",
  });
  if (options.ownerUserId) {
    connections.replaceOwner(profile.id, { userId: options.ownerUserId });
  }
  const bindings = new ChannelBindingRepository(db, now);
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
    {
      execute:
        options.executeAction ??
        (async () => ({ ok: true, summary: "ok" })),
    },
    now,
  );
  const sent: Array<{ targetId: string; text: string }> = [];
  const reactions: Array<{
    profileId: string;
    messageId: string;
    emojiType: string;
    action: "add" | "remove";
  }> = [];
  const botRuntime = new BotChannelRuntime(inbound, connections);
  botRuntime.attachTransport({
    send: async (input) => {
      sent.push({ targetId: input.targetId, text: input.text });
    },
    setReaction: async (input) => {
      reactions.push(input);
    },
    probe: async () => {},
  });
  let conversationClock = 0;
  const conversations = new AgentConversationRepository(
    db,
    () =>
      new Date(
        now().getTime() + conversationClock++ * 1_000,
      ).toISOString(),
  );
  const makeWorker = () =>
    new ChannelWorker(
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
        botRuntime,
        ledger: options.ledger,
        onAutomationDeliverySettled: options.onAutomationDeliverySettled,
      },
    );
  return {
    db,
    profile,
    bindings,
    inbound,
    deliveries,
    audit,
    pending,
    conversations,
    sent,
    reactions,
    makeWorker,
    advance(ms: number) {
      currentTime = new Date(currentTime.getTime() + ms);
    },
  };
}

test("remote channel claims never fall back to synchronous repositories", async () => {
  const calls: string[] = [];
  let fail = false;
  const h = createHarness({ async *run() {}, registerTool() {}, listTools: () => [] }, {
    ledger: {
      async leaseChannelInbound() {
        calls.push("inbound");
        if (fail) throw new Error("writer unavailable");
        return undefined;
      },
      async leaseChannelDelivery() { calls.push("delivery"); return undefined; },
    },
  });
  try {
    h.inbound.leaseNext = h.deliveries.leaseNext = () => { throw new Error("main-thread claim"); };
    const worker = h.makeWorker();
    await worker.runOnce();
    assert.deepEqual(calls, ["inbound", "delivery"]);
    fail = true;
    await assert.rejects(worker.runOnce(), /writer unavailable/);
    assert.deepEqual(calls, ["inbound", "delivery", "inbound"]);
  } finally { h.db.close(); }
});

test("stopping during an asynchronous claim prevents later channel work", async () => {
  let resolve!: (value: LeasedChannelInbound) => void;
  let deliveryClaims = 0;
  let ignoredLateClaim = false;
  const h = createHarness({ async *run() {}, registerTool() {}, listTools: () => [] }, {
    ledger: {
      leaseChannelInbound: () => new Promise<LeasedChannelInbound>((done) => { resolve = done; }),
      async leaseChannelDelivery() { deliveryClaims += 1; return undefined; },
    },
  });
  try {
    const worker = h.makeWorker();
    h.inbound.ignore = () => { ignoredLateClaim = true; };
    const running = worker.runOnce();
    worker.stop();
    resolve({ id: "late-claim", event: personEvent("late-event", "unknown-user"), attempts: 1 });
    await running;
    assert.equal(deliveryClaims, 0);
    assert.equal(ignoredLateClaim, false);
  } finally { h.db.close(); }
});

test("post-send audit and reconciliation failures do not retry automation delivery", async () => {
  const runtime: AgentRuntime = {
    async *run() {
      yield { type: "done" };
    },
    registerTool() {},
    listTools: () => [],
  };
  const harness = createHarness(runtime, {
    onAutomationDeliverySettled: () => {
      throw new Error("reconciliation unavailable");
    },
  });
  harness.audit.record = (() => {
    throw new Error("audit unavailable");
  }) as typeof harness.audit.record;
  const delivery = harness.deliveries.enqueue({
    connectionId: "connection-1",
    profileId: harness.profile.id,
    botUuid: harness.profile.botUuid,
    platform: harness.profile.platform,
    targetType: "person",
    targetId: "owner-1",
    purpose: "automation",
    text: "投递一次",
    sequence: 0,
    maxAttempts: 3,
    correlationKey: "automation:post-send-isolation",
    automationRuleId: "rule-1",
    automationRunId: "run-1",
    automationActionIndex: 0,
  });

  const worker = harness.makeWorker();
  await worker.runOnce();
  await worker.runOnce();

  assert.deepEqual(harness.sent, [
    { targetId: "owner-1", text: "投递一次" },
  ]);
  assert.deepEqual(
    harness.db.prepare(`
      SELECT state, attempts, error_code AS errorCode
      FROM channel_deliveries WHERE id = ?
    `).get(delivery.id),
    { state: "sent", attempts: 1, errorCode: null },
  );
});

test("Feishu processing uses a native reaction on the inbound message", async () => {
  const runtime: AgentRuntime = {
    async *run() {
      yield { type: "assistant_text", text: "处理完成" };
      yield { type: "done" };
    },
    registerTool() {},
    listTools: () => [],
  };
  const harness = createHarness(runtime, {
    platform: "feishu",
    ownerUserId: "owner-1",
  });
  harness.bindings.save({
    connectionId: "connection-1",
    profileId: harness.profile.id,
    botUuid: "bot-1",
    platform: "feishu",
    chatKind: "person",
    chatId: "owner-1",
    senderId: "owner-1",
    accountId: "account-1",
    conversationId: "conversation-reaction",
    enabled: true,
    requireMention: false,
  });
  harness.inbound.accept(
    personEvent("event-reaction-ignored", "unknown-user"),
    harness.profile.id,
  );
  await harness.makeWorker().runOnce();
  assert.deepEqual(harness.reactions, []);

  harness.inbound.accept(
    personEvent("event-reaction-1", "owner-1"),
    harness.profile.id,
  );

  await harness.makeWorker().runOnce();

  assert.deepEqual(harness.reactions, [
    {
      profileId: harness.profile.id,
      messageId: "event-reaction-1",
      emojiType: "OnIt",
      action: "add",
    },
    {
      profileId: harness.profile.id,
      messageId: "event-reaction-1",
      emojiType: "OnIt",
      action: "remove",
    },
  ]);
  assert.deepEqual(harness.sent, [
    { targetId: "owner-1", text: "处理完成" },
  ]);
});

test("Feishu person replies use the sender open_id instead of the chat id", async () => {
  const runtime: AgentRuntime = {
    async *run() {
      yield { type: "assistant_text", text: "回复本人" };
      yield { type: "done" };
    },
    registerTool() {},
    listTools: () => [],
  };
  const harness = createHarness(runtime, {
    platform: "feishu",
    ownerUserId: "ou_owner-1",
  });
  harness.bindings.save({
    connectionId: "connection-1",
    profileId: harness.profile.id,
    botUuid: "bot-1",
    platform: "feishu",
    chatKind: "person",
    chatId: "oc_person-1",
    senderId: "ou_owner-1",
    accountId: "account-1",
    conversationId: "conversation-person-1",
    enabled: true,
    requireMention: false,
  });
  const event = personEvent("event-person-chat", "ou_owner-1");
  harness.inbound.accept(
    {
      ...event,
      chatId: "oc_person-1",
      peerKey: "feishu:bot-1:person:oc_person-1:ou_owner-1",
    },
    harness.profile.id,
  );

  await harness.makeWorker().runOnce();

  assert.deepEqual(harness.sent, [
    { targetId: "ou_owner-1", text: "回复本人" },
  ]);
});

test("channel retries one transient empty-agent response", async () => {
  let attempts = 0;
  const runtime: AgentRuntime = {
    async *run() {
      attempts += 1;
      if (attempts === 1) {
        yield {
          type: "conclusion",
          status: "failed",
          summary: "本次执行未完成。",
          reason: "Agent 未返回任何可展示内容，可能是模型服务未正常响应。",
        };
      } else {
        yield { type: "assistant_text", text: "重试后完成" };
      }
      yield { type: "done" };
    },
    registerTool() {},
    listTools: () => [],
  };
  const harness = createHarness(runtime, {
    platform: "feishu",
    ownerUserId: "ou_retry-owner",
  });
  harness.bindings.save({
    connectionId: "connection-1",
    profileId: harness.profile.id,
    botUuid: "bot-1",
    platform: "feishu",
    chatKind: "person",
    chatId: "oc_retry-chat",
    senderId: "ou_retry-owner",
    accountId: "account-1",
    conversationId: "conversation-retry",
    enabled: true,
    requireMention: false,
  });
  harness.inbound.accept(
    {
      ...personEvent("event-retry", "ou_retry-owner"),
      chatId: "oc_retry-chat",
      peerKey: "feishu:bot-1:person:oc_retry-chat:ou_retry-owner",
    },
    harness.profile.id,
  );

  await harness.makeWorker().runOnce();

  assert.equal(attempts, 2);
  assert.deepEqual(harness.sent, [
    { targetId: "ou_retry-owner", text: "重试后完成" },
  ]);
});

function personEvent(
  eventId: string,
  senderId: string,
  text = "hello",
  adapterName = "lark",
) {
  return parseLangBotWebhook(
    {
      uuid: eventId,
      event_type: "bot.person_message",
      data: {
        bot_uuid: "bot-1",
        adapter_name: adapterName,
        sender: { id: senderId },
        message: [{ type: "Plain", text }],
        timestamp: 1785283200,
      },
    },
    "connection-1",
  );
}

test("verified WeCom owner confirmed preview executes without an approval message", async () => {
  let executions = 0;
  const inputs: AgentRunInput[] = [];
  const runtime: AgentRuntime = {
    async *run(input) {
      inputs.push(input);
      const confirmed = input.userText.includes("确认");
      const scheduled = input.userText.includes("定时");
      yield {
        type: "pending_action",
        action: {
          id: scheduled
            ? "pending-schedule"
            : confirmed
              ? "pending-send"
              : "pending-too-early",
          actionType: scheduled ? "schedule_send" : "send",
          description: "发送会议通知",
          toolName: scheduled
            ? "propose_schedule_mail"
            : "propose_send_mail",
          inputJson: scheduled
            ? JSON.stringify({ sendAt: "2026-07-31T05:00:00.000Z" })
            : "{}",
          riskReason: "对外发送邮件",
          riskLevel: "high",
        },
      };
      if (confirmed) {
        yield {
          type: "assistant_text",
          text: "【最终结果：等待确认】请在确认卡片通过后执行。",
        };
      }
      yield { type: "done" };
    },
    registerTool() {},
    listTools: () => [],
  };
  const harness = createHarness(runtime, {
    platform: "wecom",
    ownerUserId: "owner-1",
    executeAction: async (action) => {
      executions += 1;
      return action.action_type === "schedule_send"
        ? {
            ok: true,
            summary: "邮件已安排在 2026-07-31T05:00:00.000Z 发送",
          }
        : { ok: true, summary: "邮件已发送给 eddiewang@example.com" };
    },
  });
  harness.bindings.save({
    connectionId: "connection-1",
    profileId: harness.profile.id,
    botUuid: "bot-1",
    platform: "wecom",
    chatKind: "person",
    chatId: "owner-1",
    senderId: "owner-1",
    accountId: "account-1",
    conversationId: "owner-conversation",
    enabled: true,
    requireMention: false,
  });
  harness.pending.insert({
    id: "pending-too-early",
    accountId: "account-1",
    actionType: "send",
    description: "发送会议通知",
    inputJson: "{}",
    riskReason: "对外发送邮件",
  });
  harness.pending.insert({
    id: "pending-send",
    accountId: "account-1",
    actionType: "send",
    description: "发送会议通知",
    inputJson: "{}",
    riskReason: "对外发送邮件",
  });
  harness.inbound.accept(
    personEvent(
      "owner-send-too-early",
      "owner-1",
      "直接发出会议通知",
      "wecom_intelligent_bot",
    ),
  );
  const worker = harness.makeWorker();
  await worker.runOnce();
  assert.equal(executions, 0);
  assert.equal(
    harness.pending.getById("pending-too-early")?.status,
    "rejected",
  );
  assert.match(harness.sent[0]!.text, /本次未发送|邮件预览/);
  assert.equal(
    harness.db
      .prepare(
        "SELECT COUNT(*) FROM channel_approval_references WHERE pending_action_id = ?",
      )
      .pluck()
      .get("pending-too-early"),
    0,
  );

  harness.conversations.ensureConversation({
    id: "owner-conversation",
    accountId: "account-1",
  });
  harness.conversations.addMessage({
    conversationId: "owner-conversation",
    role: "assistant",
    body: {
      text: [
        "【邮件预览】",
        "收件人：eddiewang@example.com",
        "主题：会议通知",
        "请确认发送，或告诉我需要调整的内容。",
      ].join("\n"),
      channelEventId: "preview-event",
      channelPlatform: "wecom",
    },
  });
  harness.inbound.accept(
    personEvent(
      "owner-send",
      "owner-1",
      "确认发送",
      "wecom_intelligent_bot",
    ),
  );

  await worker.runOnce();

  assert.equal(executions, 1);
  assert.equal(
    inputs[1]?.context?.channel &&
      (inputs[1].context.channel as Record<string, unknown>)
        .ownerMailPreviewConfirmed,
    true,
  );
  assert.equal(harness.pending.getById("pending-send")?.status, "confirmed");
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[1]!.text, /邮件已发送/);
  assert.doesNotMatch(harness.sent[1]!.text, /approve|确认|等待/);
  assert.equal(
    harness.db
      .prepare(
        "SELECT COUNT(*) FROM channel_approval_references WHERE pending_action_id = ?",
      )
      .pluck()
      .get("pending-send"),
    0,
  );

  harness.pending.insert({
    id: "pending-schedule",
    accountId: "account-1",
    actionType: "schedule_send",
    description: "定时发送会议通知",
    inputJson: JSON.stringify({
      sendAt: "2026-07-31T05:00:00.000Z",
    }),
    riskReason: "未来对外发送邮件",
  });
  harness.conversations.addMessage({
    conversationId: "owner-conversation",
    role: "assistant",
    body: {
      text: [
        "【定时邮件预览】",
        "收件人：eddiewang@example.com",
        "计划发送时间：今天 13:00（Asia/Shanghai）",
        "请确认定时发送，或告诉我需要调整的内容。",
      ].join("\n"),
      channelEventId: "schedule-preview-event",
      channelPlatform: "wecom",
    },
  });
  harness.inbound.accept(
    personEvent(
      "owner-schedule",
      "owner-1",
      "确认定时发送",
      "wecom_intelligent_bot",
    ),
  );
  await worker.runOnce();

  assert.equal(executions, 2);
  assert.equal(
    harness.pending.getById("pending-schedule")?.status,
    "confirmed",
  );
  assert.equal(harness.sent.length, 3);
  // The reply reformats sendAt into the host timezone (ownerMailExecutionReply
  // uses Intl.DateTimeFormat().resolvedOptions().timeZone). Derive the
  // expected rendering from the same inputs so the assertion holds under any
  // CI/host zone — 2026-07-31T05:00:00.000Z is 13:00 in Asia/Shanghai but
  // 05:00 in UTC.
  const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const expectedLocalTime = new Intl.DateTimeFormat("zh-CN", {
    timeZone: hostTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date("2026-07-31T05:00:00.000Z"));
  assert.equal(
    harness.sent[2]!.text,
    `邮件已安排在 ${expectedLocalTime}（${hostTimezone}）发送。`,
  );
  assert.doesNotMatch(harness.sent[2]!.text, /确认|等待|卡片/);
});

function groupEvent(
  eventId: string,
  senderId: string,
  mentionedBot: boolean,
) {
  return parseLangBotWebhook(
    {
      uuid: eventId,
      event_type: "bot.group_message",
      data: {
        bot_uuid: "bot-1",
        adapter_name: "lark",
        group: { id: "group-1" },
        sender: { id: senderId },
        message: [
          ...(mentionedBot ? [{ type: "At", target: "bot" }] : []),
          { type: "Plain", text: "group hello" },
        ],
        timestamp: 1785283200,
      },
    },
    "connection-1",
  );
}

test("worker isolates accounts and group participants and enforces mention gating", async () => {
  const inputs: AgentRunInput[] = [];
  const runtime: AgentRuntime = {
    async *run(input) {
      inputs.push(input);
      yield { type: "assistant_text", text: `reply:${input.accountId}` };
      yield { type: "done" };
    },
    registerTool() {},
    listTools: () => [],
  };
  const harness = createHarness(runtime);
  for (const [senderId, accountId, conversationId] of [
    ["member-1", "account-1", "group-member-1"],
    ["member-2", "account-2", "group-member-2"],
  ]) {
    harness.bindings.save({
      connectionId: "connection-1",
      profileId: harness.profile.id,
      botUuid: "bot-1",
      platform: "feishu",
      chatKind: "group",
      chatId: "group-1",
      senderId,
      accountId,
      conversationId,
      enabled: true,
      requireMention: true,
    });
  }
  const worker = harness.makeWorker();
  harness.inbound.accept(groupEvent("group-no-mention", "member-1", false));
  await worker.runOnce();
  harness.inbound.accept(groupEvent("group-member-1", "member-1", true));
  await worker.runOnce();
  harness.inbound.accept(groupEvent("group-member-2", "member-2", true));
  await worker.runOnce();
  harness.inbound.accept(groupEvent("group-unknown", "member-3", true));
  await worker.runOnce();

  assert.deepEqual(
    inputs.map((input) => [input.accountId, input.sessionId]),
    [
      ["account-1", "group-member-1"],
      ["account-2", "group-member-2"],
    ],
  );
  assert.equal(
    harness.db
      .prepare(
        "SELECT last_error_code FROM channel_inbound_events WHERE event_uuid = ?",
      )
      .pluck()
      .get("group-no-mention"),
    "mention-required",
  );
  assert.equal(
    harness.db
      .prepare(
        "SELECT last_error_code FROM channel_inbound_events WHERE event_uuid = ?",
      )
      .pluck()
      .get("group-unknown"),
    "identity-not-bound",
  );
});

test("runtime unavailability is retried then becomes a terminal inbound failure", async () => {
  const runtime: AgentRuntime = {
    async *run() {
      throw new Error("runtime offline");
    },
    registerTool() {},
    listTools: () => [],
  };
  const harness = createHarness(runtime);
  harness.bindings.save({
    connectionId: "connection-1",
    profileId: harness.profile.id,
    botUuid: "bot-1",
    platform: "feishu",
    chatKind: "person",
    chatId: "owner-1",
    senderId: "owner-1",
    accountId: "account-1",
    conversationId: "owner-conversation",
    enabled: true,
    requireMention: false,
  });
  harness.inbound.accept(personEvent("runtime-offline", "owner-1"));
  const worker = harness.makeWorker();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await worker.runOnce();
    harness.advance(65_000);
  }
  assert.deepEqual(
    harness.db
      .prepare(
        "SELECT status, attempts, last_error_code FROM channel_inbound_events WHERE event_uuid = ?",
      )
      .get("runtime-offline"),
    {
      status: "failed",
      attempts: 3,
      last_error_code: "agent-runtime-unavailable",
    },
  );
  assert.equal(harness.sent.length, 0);
});

test("stopping the worker aborts an active agent run and leaves it recoverable", async () => {
  let observedSignal: AbortSignal | undefined;
  let runStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    runStarted = resolve;
  });
  const runtime: AgentRuntime = {
    async *run(input) {
      observedSignal = input.signal;
      runStarted();
      await new Promise<void>((_resolve, reject) => {
        input.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
      yield { type: "done" };
    },
    registerTool() {},
    listTools: () => [],
  };
  const harness = createHarness(runtime);
  harness.bindings.save({
    connectionId: "connection-1",
    profileId: harness.profile.id,
    botUuid: "bot-1",
    platform: "feishu",
    chatKind: "person",
    chatId: "owner-1",
    senderId: "owner-1",
    accountId: "account-1",
    conversationId: "owner-conversation",
    enabled: true,
    requireMention: false,
  });
  harness.inbound.accept(personEvent("cancelled-run", "owner-1"));
  const worker = harness.makeWorker();
  const running = worker.runOnce();
  await started;
  worker.stop();
  await running;

  assert.equal(observedSignal?.aborted, true);
  assert.deepEqual(
    harness.db
      .prepare(
        "SELECT status, attempts, last_error_code FROM channel_inbound_events WHERE event_uuid = ?",
      )
      .get("cancelled-run"),
    {
      status: "pending",
      attempts: 1,
      last_error_code: "agent-runtime-unavailable",
    },
  );
});

test("duplicate inbound work runs once and ordered chunks recover after restart", async () => {
  let runtimeRuns = 0;
  const longReply = `${"一".repeat(4_000)}${"二".repeat(4_000)}${"三".repeat(100)}`;
  const runtime: AgentRuntime = {
    async *run() {
      runtimeRuns += 1;
      yield { type: "assistant_text", text: longReply };
      yield { type: "done" };
    },
    registerTool() {},
    listTools: () => [],
  };
  const harness = createHarness(runtime);
  harness.bindings.save({
    connectionId: "connection-1",
    profileId: harness.profile.id,
    botUuid: "bot-1",
    platform: "feishu",
    chatKind: "person",
    chatId: "owner-1",
    senderId: "owner-1",
    accountId: "account-1",
    conversationId: "owner-conversation",
    enabled: true,
    requireMention: false,
  });
  const event = personEvent("duplicate-event", "owner-1");
  assert.equal(harness.inbound.accept(event).duplicate, false);
  assert.equal(harness.inbound.accept(event).duplicate, true);

  const firstWorker = harness.makeWorker();
  await firstWorker.runOnce();
  assert.equal(runtimeRuns, 1);
  assert.equal(harness.sent.length, 1);
  const stranded = harness.deliveries.leaseNext("stopped-worker");
  assert.equal(stranded?.sequence, 1);

  harness.advance(65_000);
  const restartedWorker = harness.makeWorker();
  await restartedWorker.runOnce();
  await restartedWorker.runOnce();

  assert.equal(runtimeRuns, 1);
  assert.equal(harness.sent.length, 3);
  assert.equal(harness.sent.map((item) => item.text).join(""), longReply);
  assert.deepEqual(
    harness.db
      .prepare(
        "SELECT sequence, state FROM channel_deliveries ORDER BY sequence",
      )
      .all(),
    [
      { sequence: 0, state: "sent" },
      { sequence: 1, state: "sent" },
      { sequence: 2, state: "sent" },
    ],
  );
});
