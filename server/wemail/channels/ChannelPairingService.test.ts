import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { ChannelAuditRepository } from "./ChannelAuditRepository.js";
import { ChannelBindingRepository } from "./ChannelBindingRepository.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import { ChannelDeliveryRepository } from "./ChannelLedgerRepository.js";
import { ChannelPairingService } from "./ChannelPairingService.js";
import { parseLangBotWebhook } from "./LangBotProtocol.js";

function setup() {
  const db = openOrCreateMailDatabase(":memory:");
  const clock = { value: new Date("2026-07-29T00:00:00.000Z") };
  const now = () => clock.value;
  const connections = new ChannelConnectionRepository(db, now);
  insertCanonicalTestAccount(db, { id: "account-1", email: "owner@example.com", displayName: "Owner" });
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
  const deliveries = new ChannelDeliveryRepository(db, now);
  const bindings = new ChannelBindingRepository(db, now);
  const pairing = new ChannelPairingService(
    db,
    connections,
    deliveries,
    bindings,
    new ChannelAuditRepository(db, now),
    () => "account-1",
    now,
  );
  return { db, clock, connections, deliveries, bindings, pairing };
}

function event(
  command: string,
  overrides: {
    type?: string;
    botUuid?: string;
    senderId?: string;
    connectionId?: string;
  } = {},
) {
  return parseLangBotWebhook(
    {
      uuid: `event-${Math.random()}`,
      event_type: overrides.type ?? "bot.person_message",
      data: {
        bot_uuid: overrides.botUuid ?? "bot-1",
        adapter_name: "lark",
        sender: { id: overrides.senderId ?? "owner-1", name: "主人" },
        ...(overrides.type === "bot.group_message"
          ? { group: { id: "group-1" } }
          : {}),
        message: [{ type: "Plain", text: command }],
        timestamp: 1785283200,
      },
    },
    overrides.connectionId ?? "connection-1",
  );
}

test("owner pairing is direct-message only, single-use, and queues initialization", () => {
  const h = setup();
  const challenge = h.pairing.createChallenge("profile-1");
  assert.deepEqual(
    h.pairing.intercept(
      event(challenge.command, { type: "bot.group_message" }),
    ),
    { handled: true, outcome: "wrong-scope" },
  );
  assert.deepEqual(h.pairing.intercept(event(challenge.command)), {
    handled: true,
    outcome: "paired",
  });
  const profile = h.connections.getProfile("profile-1")!;
  assert.equal(profile.owner?.userId, "owner-1");
  assert.equal(profile.owner?.bindingVersion, 1);
  assert.equal(profile.onboardingState, "initialization_pending");
  assert.equal(
    h.bindings.resolve({
      connectionId: "connection-1",
      botUuid: "bot-1",
      platform: "feishu",
      chatKind: "person",
      chatId: "owner-1",
      senderId: "owner-1",
    })?.accountId,
    "account-1",
  );
  const delivery = h.deliveries.leaseNext("worker");
  assert.equal(delivery?.purpose, "initialization");
  assert.equal(delivery?.targetId, "owner-1");
  assert.doesNotMatch(delivery?.text ?? "", new RegExp(challenge.code));
  assert.deepEqual(h.pairing.intercept(event(challenge.command)), {
    handled: true,
    outcome: "replayed",
  });
});

test("expired pairing does not assign an owner", () => {
  const h = setup();
  const challenge = h.pairing.createChallenge("profile-1", 1_000);
  h.clock.value = new Date("2026-07-29T00:00:02.000Z");
  assert.deepEqual(h.pairing.intercept(event(challenge.command)), {
    handled: true,
    outcome: "expired",
  });
  assert.equal(h.connections.getProfile("profile-1")?.owner, undefined);
});

test("wrong bot and connection cannot consume a pairing challenge", () => {
  const h = setup();
  const challenge = h.pairing.createChallenge("profile-1");
  assert.deepEqual(
    h.pairing.intercept(event(challenge.command, { botUuid: "bot-other" })),
    { handled: true, outcome: "wrong-scope" },
  );
  assert.deepEqual(
    h.pairing.intercept(
      event(challenge.command, { connectionId: "connection-other" }),
    ),
    { handled: true, outcome: "wrong-scope" },
  );
  assert.deepEqual(h.pairing.intercept(event(challenge.command)), {
    handled: true,
    outcome: "paired",
  });
  assert.equal(h.connections.getProfile("profile-1")?.owner?.userId, "owner-1");
});

test("cancelling owner replacement invalidates the command and restores the current owner", () => {
  const h = setup();
  const first = h.pairing.createChallenge("profile-1");
  assert.deepEqual(h.pairing.intercept(event(first.command)), {
    handled: true,
    outcome: "paired",
  });
  h.connections.setProfileState("profile-1", {
    state: "ready",
    enabled: true,
    initializedAt: h.clock.value.toISOString(),
  });

  const replacement = h.pairing.createChallenge("profile-1");
  assert.equal(h.connections.getProfile("profile-1")?.onboardingState, "owner_pairing");
  const restored = h.pairing.cancelChallenge("profile-1");

  assert.equal(restored.onboardingState, "ready");
  assert.equal(restored.enabled, true);
  assert.equal(restored.owner?.userId, "owner-1");
  assert.deepEqual(h.pairing.intercept(event(replacement.command)), {
    handled: true,
    outcome: "replayed",
  });
});

test("startup reconciliation backfills an existing owner without re-pairing", () => {
  const h = setup();
  const challenge = h.pairing.createChallenge("profile-1");
  assert.deepEqual(h.pairing.intercept(event(challenge.command)), {
    handled: true,
    outcome: "paired",
  });
  h.bindings.revokeByProfile("profile-1");
  assert.equal(
    h.bindings.listByProfile("profile-1").filter((binding) => binding.enabled).length,
    0,
  );

  assert.equal(h.pairing.reconcileCurrentMailboxBindings(), 1);
  const active = h.bindings
    .listByProfile("profile-1")
    .find((binding) => binding.enabled);
  assert.equal(active?.accountId, "account-1");
  assert.equal(active?.senderId, "owner-1");
});

test("initialization retry reuses one durable delivery and owner replacement versions it", () => {
  const h = setup();
  const first = h.pairing.createChallenge("profile-1");
  assert.deepEqual(h.pairing.intercept(event(first.command)), {
    handled: true,
    outcome: "paired",
  });
  const firstDelivery = h.deliveries.leaseNext("worker")!;
  h.deliveries.markFailed(firstDelivery.id, "langbot-unreachable");

  const retried = h.pairing.retryInitialization("profile-1");
  assert.equal(retried.id, firstDelivery.id);
  assert.equal(retried.state, "pending");
  assert.equal(h.pairing.retryInitialization("profile-1").id, firstDelivery.id);
  assert.equal(
    h.db.prepare("SELECT COUNT(*) FROM channel_initializations").pluck().get(),
    1,
  );
  assert.equal(
    h.db.prepare("SELECT COUNT(*) FROM channel_deliveries").pluck().get(),
    1,
  );

  const replacement = h.pairing.createChallenge("profile-1");
  assert.deepEqual(
    h.pairing.intercept(
      event(replacement.command, { senderId: "owner-2" }),
    ),
    { handled: true, outcome: "paired" },
  );
  const profile = h.connections.getProfile("profile-1")!;
  assert.equal(profile.owner?.userId, "owner-2");
  assert.equal(profile.owner?.bindingVersion, 2);
  assert.equal(
    h.bindings.listByProfile("profile-1").filter((binding) => binding.enabled).length,
    1,
  );
  assert.equal(
    h.bindings.listByProfile("profile-1").find((binding) => binding.enabled)?.senderId,
    "owner-2",
  );
  assert.equal(
    h.db.prepare("SELECT COUNT(*) FROM channel_initializations").pluck().get(),
    2,
  );
  assert.equal(
    h.db
      .prepare(
        "SELECT COUNT(*) FROM channel_owner_history WHERE profile_id = ?",
      )
      .pluck()
      .get("profile-1"),
    2,
  );
});
