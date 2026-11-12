import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { ChannelBindingRepository } from "./ChannelBindingRepository.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import { ChannelDestinationRepository } from "./ChannelDestinationRepository.js";
import {
  ChannelDeliveryRepository,
  ChannelInboundRepository,
} from "./ChannelLedgerRepository.js";
import { parseLangBotWebhook } from "./LangBotProtocol.js";
import { MailDatabaseWriter } from "../database/MailDatabaseWriter.js";

function harness() {
  const db = openOrCreateMailDatabase(":memory:");
  const clock = { value: new Date("2026-07-29T00:00:00.000Z") };
  const now = () => clock.value;
  const connections = new ChannelConnectionRepository(db, now);
  const bindings = new ChannelBindingRepository(db, now);
  const inbound = new ChannelInboundRepository(db, now);
  const deliveries = new ChannelDeliveryRepository(db, now);
  const connection = connections.createConnection({
    id: "connection-1",
    name: "Local LangBot",
    baseUrl: "http://127.0.0.1:5300",
    compatibilityProfile: "langbot-service-api-v4.9",
    apiSecretRef: "wemail:langbot:connection-1:api-key",
    webhookSecretRef: "wemail:langbot:connection-1:webhook-secret",
    trustMode: "loopback",
  });
  const profile = connections.saveProfile({
    id: "profile-1",
    connectionId: connection.id,
    botUuid: "bot-1",
    platform: "feishu",
    displayName: "飞书助手",
    adapterName: "lark",
  });
  return {
    db,
    clock,
    connections,
    bindings,
    inbound,
    deliveries,
    destinations: new ChannelDestinationRepository(db, now),
    connection,
    profile,
  };
}

test("migration 62 creates channel tables and repositories omit secret values", () => {
  const h = harness();
  const tables = h.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'channel_%'",
    )
    .all() as Array<{ name: string }>;
  assert.ok(tables.some((row) => row.name === "channel_bot_profiles"));
  assert.ok(tables.some((row) => row.name === "channel_deliveries"));
  const serialized = JSON.stringify(h.connections.getConnection("connection-1"));
  assert.doesNotMatch(serialized, /actual-api-key|actual-webhook-secret/);
});

test("empty channel claims stay read-only, including the writer entry", () => {
  const h = harness();
  try {
    const writer = new MailDatabaseWriter(h.db);
    h.db.pragma("query_only = ON");
    assert.equal(h.inbound.leaseNext("worker"), undefined);
    assert.equal(h.deliveries.leaseNext("worker"), undefined);
    assert.equal(writer.leaseChannelWork({ queue: "inbound", workerId: "worker" }), undefined);
    assert.equal(writer.leaseChannelWork({ queue: "delivery", workerId: "worker" }), undefined);
    assert.throws(() => writer.leaseChannelWork({ queue: "inbound", workerId: "" }));
    assert.throws(() => writer.leaseChannelWork({ queue: "delivery", workerId: "worker", leaseMs: 0 }));
  } finally { h.db.close(); }
});

test("writer channel claims serialize numeric fields and exclude active leases", () => {
  const h = harness();
  try {
    h.deliveries.enqueue({
      connectionId: "connection-1", profileId: "profile-1", botUuid: "bot-1",
      platform: "feishu", targetType: "person", targetId: "owner-a",
      purpose: "automation", text: "message", sequence: 2, maxAttempts: 3,
      ownerBindingVersion: 1,
    });
    const event = parseLangBotWebhook({
      uuid: "writer-event", event_type: "bot.person_message",
      data: { bot_uuid: "bot-1", adapter_name: "lark", sender: { id: "sender-1" },
        message: [{ type: "Plain", text: "hello" }], timestamp: 1767225600 },
    }, "connection-1");
    h.inbound.accept(event, "profile-1");
    h.db.defaultSafeIntegers(true);
    const writer = new MailDatabaseWriter(h.db);
    for (const queue of ["inbound", "delivery"] as const) {
      const claim = writer.leaseChannelWork({ queue, workerId: "worker-a" });
      assert.ok(claim);
      assert.equal(claim.attempts, 1);
      assert.doesNotThrow(() => JSON.stringify(claim));
      assert.equal(writer.leaseChannelWork({ queue, workerId: "worker-b" }), undefined);
    }
  } finally { h.db.close(); }
});

test("owner replacement is unique, versioned, and auditable in history", () => {
  const h = harness();
  const first = h.connections.replaceOwner("profile-1", {
    userId: "owner-a",
    displayName: "主人 A",
  });
  const second = h.connections.replaceOwner("profile-1", {
    userId: "owner-b",
    displayName: "主人 B",
  });
  assert.equal(first.bindingVersion, 1);
  assert.equal(second.bindingVersion, 2);
  assert.equal(h.connections.getProfile("profile-1")?.owner?.userId, "owner-b");
  const active = h.db
    .prepare(
      "SELECT COUNT(*) count FROM channel_owner_history WHERE profile_id = ? AND revoked_at IS NULL",
    )
    .get("profile-1") as { count: number };
  assert.equal(active.count, 1);
});

test("bindings isolate bot, connection, group, and sender scopes", () => {
  const h = harness();
  insertCanonicalTestAccount(h.db, { id: "account-1", email: "a@example.com", displayName: "A" });
  const binding = h.bindings.save({
    connectionId: "connection-1",
    profileId: "profile-1",
    botUuid: "bot-1",
    platform: "feishu",
    chatKind: "group",
    chatId: "group-1",
    senderId: "sender-1",
    accountId: "account-1",
    conversationId: "conversation-1",
    enabled: true,
    requireMention: true,
  });
  assert.equal(
    h.bindings.resolve({
      connectionId: "connection-1",
      botUuid: "bot-1",
      platform: "feishu",
      chatKind: "group",
      chatId: "group-1",
      senderId: "sender-1",
    })?.id,
    binding.id,
  );
  assert.equal(
    h.bindings.resolve({
      connectionId: "connection-1",
      botUuid: "bot-1",
      platform: "feishu",
      chatKind: "group",
      chatId: "group-1",
      senderId: "sender-2",
    }),
    undefined,
  );
  assert.equal(h.bindings.revoke(binding.id), true);
  assert.equal(
    h.bindings.resolve({
      connectionId: "connection-1",
      botUuid: "bot-1",
      platform: "feishu",
      chatKind: "group",
      chatId: "group-1",
      senderId: "sender-1",
    }),
    undefined,
  );
});

test("inbound UUID deduplication and expired lease recovery are durable", () => {
  const h = harness();
  const event = parseLangBotWebhook(
    {
      uuid: "event-1",
      event_type: "bot.person_message",
      data: {
        bot_uuid: "bot-1",
        adapter_name: "lark",
        sender: { id: "sender-1" },
        message: [{ type: "Plain", text: "hello" }],
        timestamp: 1767225600,
      },
    },
    "connection-1",
  );
  assert.equal(h.inbound.accept(event, "profile-1").duplicate, false);
  assert.equal(h.inbound.accept(event, "profile-1").duplicate, true);
  const firstLease = h.inbound.leaseNext("worker-a", 1000);
  assert.equal(firstLease?.attempts, 1);
  h.clock.value = new Date("2026-07-29T00:00:02.000Z");
  const recovered = h.inbound.leaseNext("worker-b", 1000);
  assert.equal(recovered?.id, firstLease?.id);
  assert.equal(recovered?.attempts, 2);
  h.inbound.fail(recovered!.id, "agent-unavailable");
  assert.equal(h.inbound.retryFailed(recovered!.id), true);
});

test("delivery correlation prevents duplicates and preserves ordered retry state", () => {
  const h = harness();
  const base = {
    connectionId: "connection-1",
    profileId: "profile-1",
    botUuid: "bot-1",
    platform: "feishu" as const,
    targetType: "person" as const,
    targetId: "owner-a",
    purpose: "automation" as const,
    text: "message",
    sequence: 0,
    maxAttempts: 3,
    correlationKey: "run-1:action-0:profile-1:owner-v1",
    ownerBindingVersion: 1,
  };
  const first = h.deliveries.enqueue(base);
  const duplicate = h.deliveries.enqueue(base);
  assert.equal(first.id, duplicate.id);
  const lease = h.deliveries.leaseNext("worker-a", 1000);
  assert.equal(lease?.attempts, 1);
  h.deliveries.markRetry(
    lease!.id,
    "langbot-timeout",
    "2026-07-29T00:02:00.000Z",
  );
  assert.equal(h.deliveries.get(lease!.id)?.state, "retrying");
  assert.deepEqual(h.deliveries.counts("profile-1"), {
    pending: 1,
    failed: 0,
  });
});

test("connection deletion cascades channel state while account data remains", () => {
  const h = harness();
  assert.equal(h.connections.deleteConnection("connection-1"), true);
  assert.equal(h.connections.getProfile("profile-1"), undefined);
});

test("destinations are bot-profile scoped even when external ids match", () => {
  const h = harness();
  h.connections.saveProfile({
    id: "profile-2",
    connectionId: "connection-1",
    botUuid: "bot-2",
    platform: "wecom",
    displayName: "企业微信助手",
    adapterName: "wecom",
  });
  h.destinations.save({
    profileId: "profile-1",
    type: "person",
    externalId: "same-user",
    verified: true,
  });
  h.destinations.save({
    profileId: "profile-2",
    type: "person",
    externalId: "same-user",
    verified: false,
  });
  assert.equal(h.destinations.list("profile-1")[0]?.verified, true);
  assert.equal(h.destinations.list("profile-2")[0]?.verified, false);
});

test("deleting an account invalidates its binding without crossing accounts", () => {
  const h = harness();
  for (const id of ["account-a", "account-b"]) {
    insertCanonicalTestAccount(h.db, { id: id, email: `${id}@example.com`, displayName: id });
  }
  for (const [accountId, senderId] of [
    ["account-a", "sender-a"],
    ["account-b", "sender-b"],
  ]) {
    h.bindings.save({
      connectionId: "connection-1",
      profileId: "profile-1",
      botUuid: "bot-1",
      platform: "feishu",
      chatKind: "person",
      chatId: senderId,
      senderId,
      accountId,
      conversationId: `conversation-${senderId}`,
      enabled: true,
      requireMention: false,
    });
  }
  h.db.prepare("DELETE FROM mail_accounts WHERE public_id = ?").run("account-a");
  assert.equal(h.bindings.listByAccount("account-a").length, 0);
  assert.equal(h.bindings.listByAccount("account-b").length, 1);
});

test("persisted automation delivery is recoverable without recreating rule work", () => {
  const h = harness();
  h.deliveries.enqueue({
    connectionId: "connection-1",
    profileId: "profile-1",
    botUuid: "bot-1",
    platform: "feishu",
    targetType: "person",
    targetId: "owner-1",
    purpose: "automation",
    text: "frozen summary",
    sequence: 0,
    maxAttempts: 3,
    correlationKey: "automation:rule-1:run-1:0",
    automationRuleId: "rule-1",
    automationRunId: "run-1",
    automationActionIndex: 0,
    ownerBindingVersion: 1,
  });
  const afterRestart = new ChannelDeliveryRepository(h.db, () => h.clock.value);
  const recovered = afterRestart.leaseNext("worker-after-restart");
  assert.equal(recovered?.text, "frozen summary");
  assert.equal(recovered?.automationRuleId, "rule-1");
  assert.equal(recovered?.automationRunId, "run-1");
  assert.equal(recovered?.automationActionIndex, 0);
});
