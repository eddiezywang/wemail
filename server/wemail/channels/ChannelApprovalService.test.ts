import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActionExecutor } from "../agent/AgentActionExecutor.js";
import { AgentConversationRepository } from "../agent/AgentConversationRepository.js";
import { AgentPendingActionRepository } from "../agent/AgentPendingActionRepository.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { ChannelApprovalService, classifyConfirmationIntent } from "./ChannelApprovalService.js";
import { ChannelBindingRepository } from "./ChannelBindingRepository.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import { parseLangBotWebhook } from "./LangBotProtocol.js";

function harness(
  buildExecutor?: (count: { value: number }) => AgentActionExecutor,
) {
  const db = openOrCreateMailDatabase(":memory:");
  const clock = { value: new Date("2026-07-29T00:00:00.000Z") };
  const now = () => clock.value;
  insertCanonicalTestAccount(db, { id: "account-1", email: "owner@example.com", displayName: "Owner" });
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
  connections.saveProfile({
    id: "profile-1",
    connectionId: "connection-1",
    botUuid: "bot-1",
    platform: "feishu",
    displayName: "飞书助手",
    adapterName: "lark",
  });
  const binding = new ChannelBindingRepository(db, now).save({
    connectionId: "connection-1",
    profileId: "profile-1",
    botUuid: "bot-1",
    platform: "feishu",
    chatKind: "person",
    chatId: "owner-1",
    senderId: "owner-1",
    accountId: "account-1",
    conversationId: "conversation-1",
    enabled: true,
    requireMention: false,
  });
  const pending = new AgentPendingActionRepository({
    db,
    now: () => clock.value.toISOString(),
  });
  // agent_pending_actions.conversation_id carries a foreign key to
  // agent_conversations; production creates the conversation (ChannelWorker
  // ensureConversation) before any channel-scoped pending action is inserted.
  new AgentConversationRepository(db, () => clock.value.toISOString())
    .ensureConversation({ id: "conversation-1", accountId: "account-1" });
  pending.insert({
    id: "pending-1",
    accountId: "account-1",
    actionType: "archive",
    description: "归档邮件",
    inputJson: "{}",
    riskReason: "会移动邮件",
  });
  const count = { value: 0 };
  const executor: AgentActionExecutor = buildExecutor
    ? buildExecutor(count)
    : {
        execute: async () => {
          count.value += 1;
          return { ok: true, summary: "已归档" };
        },
      };
  return {
    binding,
    pending,
    approvals: new ChannelApprovalService(db, pending, executor, now),
    executions: () => count.value,
    clock,
  };
}

function event(text: string, senderId = "owner-1") {
  return parseLangBotWebhook(
    {
      uuid: `event-${senderId}-${text}`,
      event_type: "bot.person_message",
      data: {
        bot_uuid: "bot-1",
        adapter_name: "lark",
        sender: { id: senderId },
        message: [{ type: "Plain", text }],
        timestamp: 1785283200,
      },
    },
    "connection-1",
  );
}

test("approval reference executes once only in its exact binding scope", async () => {
  const h = harness();
  const created = h.approvals.create(event("request"), h.binding, {
    id: "pending-1",
    actionType: "archive",
    description: "归档邮件",
    toolName: "propose_action",
    inputJson: "{}",
    riskReason: "会移动邮件",
    riskLevel: "medium",
  });
  assert.doesNotMatch(created.prompt, /inputJson|account-1/);
  const crossBinding = { ...h.binding, senderId: "attacker" };
  const rejected = await h.approvals.intercept(
    event(`/approve ${created.reference}`, "attacker"),
    crossBinding,
  );
  assert.equal(rejected.handled, true);
  if (rejected.handled) assert.equal(rejected.outcome, "invalid");
  assert.equal(h.executions(), 0);

  const approved = await h.approvals.intercept(
    event(`/approve ${created.reference}`),
    h.binding,
  );
  assert.equal(approved.handled, true);
  if (approved.handled) assert.equal(approved.outcome, "approved");
  assert.equal(h.executions(), 1);
  assert.equal(h.pending.getById("pending-1")?.status, "confirmed");

  const replay = await h.approvals.intercept(
    event(`/approve ${created.reference}`),
    h.binding,
  );
  assert.equal(replay.handled, true);
  if (replay.handled) assert.equal(replay.outcome, "replayed");
  assert.equal(h.executions(), 1);
});

test("denial resolves without executing and expiration fails closed", async () => {
  const deniedHarness = harness();
  const denied = deniedHarness.approvals.create(
    event("request"),
    deniedHarness.binding,
    {
      id: "pending-1",
      actionType: "archive",
      description: "归档邮件",
      toolName: "propose_action",
      inputJson: "{}",
      riskReason: "会移动邮件",
      riskLevel: "medium",
    },
  );
  const denial = await deniedHarness.approvals.intercept(
    event(`/deny ${denied.reference}`),
    deniedHarness.binding,
  );
  assert.equal(denial.handled, true);
  if (denial.handled) assert.equal(denial.outcome, "denied");
  assert.equal(deniedHarness.executions(), 0);
  assert.equal(deniedHarness.pending.getById("pending-1")?.status, "rejected");

  const expiredHarness = harness();
  const expired = expiredHarness.approvals.create(
    event("request"),
    expiredHarness.binding,
    {
      id: "pending-1",
      actionType: "archive",
      description: "归档邮件",
      toolName: "propose_action",
      inputJson: "{}",
      riskReason: "会移动邮件",
      riskLevel: "medium",
    },
    1_000,
  );
  expiredHarness.clock.value = new Date("2026-07-29T00:00:02.000Z");
  const outcome = await expiredHarness.approvals.intercept(
    event(`/approve ${expired.reference}`),
    expiredHarness.binding,
  );
  assert.equal(outcome.handled, true);
  if (outcome.handled) assert.equal(outcome.outcome, "expired");
  assert.equal(expiredHarness.executions(), 0);
  assert.equal(expiredHarness.pending.getById("pending-1")?.status, "expired");
});

test("preauthorized owner send and scheduled send execute only for the bound account", async () => {
  const h = harness();
  h.pending.insert({
    id: "pending-send",
    accountId: "account-1",
    actionType: "send",
    description: "发送会议通知",
    inputJson: "{}",
    riskReason: "对外发送邮件",
  });
  const action = {
    id: "pending-send",
    actionType: "send" as const,
    description: "发送会议通知",
    toolName: "propose_send_mail",
    inputJson: "{}",
    riskReason: "对外发送邮件",
    riskLevel: "high" as const,
  };
  const crossAccount = await h.approvals.executePreauthorizedOwnerMailAction(
    { ...h.binding, accountId: "account-2" },
    action,
  );
  assert.equal(crossAccount.ok, false);
  assert.equal(h.executions(), 0);
  assert.equal(h.pending.getById("pending-send")?.status, "pending");

  const result = await h.approvals.executePreauthorizedOwnerMailAction(
    h.binding,
    action,
  );
  assert.deepEqual(result, { ok: true, summary: "已归档" });
  assert.equal(h.executions(), 1);
  assert.equal(h.pending.getById("pending-send")?.status, "confirmed");

  const replay = await h.approvals.executePreauthorizedOwnerMailAction(
    h.binding,
    action,
  );
  assert.equal(replay.ok, false);
  assert.equal(h.executions(), 1);

  h.pending.insert({
    id: "pending-schedule",
    accountId: "account-1",
    actionType: "schedule_send",
    description: "定时发送会议通知",
    inputJson: "{}",
    riskReason: "未来对外发送邮件",
  });
  const scheduled =
    await h.approvals.executePreauthorizedOwnerMailAction(h.binding, {
      ...action,
      id: "pending-schedule",
      actionType: "schedule_send",
      toolName: "propose_schedule_mail",
    });
  assert.equal(scheduled.ok, true);
  assert.equal(h.executions(), 2);
  assert.equal(h.pending.getById("pending-schedule")?.status, "confirmed");
});

test("classifyConfirmationIntent: short confirm/deny, rejects questions and long text", () => {
  for (const confirm of ["确认删除", "确认", "可以", "好的", "ok", "yes", "approve"]) {
    assert.equal(classifyConfirmationIntent(confirm), "confirm", confirm);
  }
  for (const deny of ["取消", "不要", "不行", "no", "cancel", "别删"]) {
    assert.equal(classifyConfirmationIntent(deny), "deny", deny);
  }
  // contains a confirm word but is a question / new request → must NOT confirm
  assert.equal(classifyConfirmationIntent("确认一下是不是这封"), null);
  assert.equal(classifyConfirmationIntent("好的，另外帮我查一下未读邮件"), null);
  assert.equal(classifyConfirmationIntent("帮我查一下最近邮件"), null);
  assert.equal(classifyConfirmationIntent(""), null);
});

test("resolveByNaturalLanguage executes the pending action on a short confirm", async () => {
  const h = harness();
  h.pending.insert({
    id: "pending-nl-confirm",
    conversationId: "conversation-1",
    accountId: "account-1",
    actionType: "archive",
    description: "归档邮件",
    inputJson: "{}",
    riskReason: "会移动邮件",
  });
  const result = await h.approvals.resolveByNaturalLanguage(event("确认删除"), h.binding);
  assert.equal(result.handled, true);
  if (result.handled) {
    assert.equal(result.outcome, "approved");
    assert.match(result.message, /已归档/);
  }
  assert.equal(h.executions(), 1);
  assert.equal(h.pending.getById("pending-nl-confirm")?.status, "confirmed");
  assert.equal(h.pending.getById("pending-nl-confirm")?.execution_state, "succeeded");
});

test("resolveByNaturalLanguage rejects on a short deny without executing", async () => {
  const h = harness();
  h.pending.insert({
    id: "pending-nl-deny",
    conversationId: "conversation-1",
    accountId: "account-1",
    actionType: "archive",
    description: "归档邮件",
    inputJson: "{}",
    riskReason: "会移动邮件",
  });
  const result = await h.approvals.resolveByNaturalLanguage(event("取消"), h.binding);
  assert.equal(result.handled, true);
  if (result.handled) assert.equal(result.outcome, "denied");
  assert.equal(h.executions(), 0);
  assert.equal(h.pending.getById("pending-nl-deny")?.status, "rejected");
});

test("resolveByNaturalLanguage falls through for non-confirmation replies", async () => {
  const h = harness();
  h.pending.insert({
    id: "pending-nl-fallthrough",
    conversationId: "conversation-1",
    accountId: "account-1",
    actionType: "archive",
    description: "归档邮件",
    inputJson: "{}",
    riskReason: "会移动邮件",
  });
  const result = await h.approvals.resolveByNaturalLanguage(
    event("好的，另外帮我查一下未读邮件"),
    h.binding,
  );
  assert.equal(result.handled, false);
  assert.equal(h.executions(), 0);
  assert.equal(h.pending.getById("pending-nl-fallthrough")?.status, "pending");
});

test("resolveByNaturalLanguage leaves send/schedule_send to the preview flow", async () => {
  const h = harness();
  h.pending.insert({
    id: "pending-nl-send",
    conversationId: "conversation-1",
    accountId: "account-1",
    actionType: "send",
    description: "发送邮件",
    inputJson: "{}",
    riskReason: "对外发送",
  });
  const result = await h.approvals.resolveByNaturalLanguage(event("确认"), h.binding);
  assert.equal(result.handled, false);
  assert.equal(h.executions(), 0);
  assert.equal(h.pending.getById("pending-nl-send")?.status, "pending");
});

test("resolveByNaturalLanguage consumes the confirmation when execution fails", async () => {
  // Executor throws on the first confirm. Execution is at-most-once (pinned in
  // AgentPendingActionRepository.execution.test.ts): a thrown execution marks
  // the action status='confirmed' with execution_state='failed', so the same
  // confirmation cannot be reused. The next "确认删除" falls through to a fresh
  // agent run that re-proposes a new pending action instead of re-executing.
  const h = harness((count) => ({
    execute: async () => {
      count.value += 1;
      if (count.value === 1) throw new Error("target-folder-not-found:Trash");
      return { ok: true, summary: "已永久删除" };
    },
  }));
  h.pending.insert({
    id: "pending-nl-retry",
    conversationId: "conversation-1",
    accountId: "account-1",
    actionType: "permanent_delete",
    description: "永久删除邮件",
    inputJson: "{}",
    riskReason: "不可恢复",
  });

  const first = await h.approvals.resolveByNaturalLanguage(event("确认删除"), h.binding);
  assert.equal(first.handled, true);
  if (first.handled) {
    assert.equal(first.outcome, "invalid");
    assert.equal(first.message, "操作执行失败，请稍后重试。");
  }
  assert.equal(h.executions(), 1);
  assert.equal(h.pending.getById("pending-nl-retry")?.status, "confirmed");
  assert.equal(h.pending.getById("pending-nl-retry")?.execution_state, "failed");

  const second = await h.approvals.resolveByNaturalLanguage(event("确认删除"), h.binding);
  assert.equal(second.handled, false);
  assert.equal(h.executions(), 1);
  assert.equal(h.pending.getById("pending-nl-retry")?.status, "confirmed");
  assert.equal(h.pending.getById("pending-nl-retry")?.execution_state, "failed");
});
