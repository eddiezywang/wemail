import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { SecretStore } from "../security/SecretStore.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { ChannelAuditRepository } from "./ChannelAuditRepository.js";
import { ChannelBindingRepository } from "./ChannelBindingRepository.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import { ChannelDestinationRepository } from "./ChannelDestinationRepository.js";
import { ChannelDeliveryRepository } from "./ChannelLedgerRepository.js";
import { ChannelManagementService } from "./ChannelManagementService.js";
import { LangBotConnectionService } from "./LangBotConnectionService.js";

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

test("management rejects platform mismatch and detection never sends a message", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => new Date("2026-07-29T00:00:00.000Z");
  const connections = new ChannelConnectionRepository(db, now);
  const bindings = new ChannelBindingRepository(db, now);
  const deliveries = new ChannelDeliveryRepository(db, now);
  const secrets = new MemorySecrets();
  const connectionService = new LangBotConnectionService(
    connections,
    secrets,
    new ChannelAuditRepository(db, now),
  );
  connectionService.create({
    id: "connection-1",
    name: "LangBot",
    baseUrl: "http://127.0.0.1:5300",
    apiKey: "api-key",
    webhookSecret: "webhook-key",
    trustMode: "loopback",
  });
  let bot = {
    uuid: "bot-1",
    name: "渠道助手",
    adapter: "wecom_intelligent_bot",
    platform: "wecom" as "feishu" | "wecom",
    enabled: true,
  };
  const management = new ChannelManagementService(
    connections,
    connectionService,
    bindings,
    new ChannelDestinationRepository(db, now),
    deliveries,
    {
      clientFactory: () => ({
        listBots: async () => [bot],
        getBot: async () => bot,
        checkCompatibility: async () => ({
          compatible: true,
          profile: "langbot-service-api-v4.9",
          botCount: 1,
          checkedAt: now().toISOString(),
        }),
      }),
    },
  );

  await assert.rejects(
    () =>
      management.selectBot({
        connectionId: "connection-1",
        botUuid: "bot-1",
        platform: "feishu",
      }),
    /channel-bot-platform-mismatch/,
  );

  bot = { ...bot, adapter: "lark", platform: "feishu" };
  const profile = await management.selectBot({
    connectionId: "connection-1",
    botUuid: "bot-1",
    platform: "feishu",
  });
  const owner = connections.replaceOwner(profile.id, {
    userId: "owner-1",
    displayName: "主人",
  });
  connections.setProfileState(profile.id, {
    state: "ready",
    enabled: true,
    initializationVersion: 1,
    initializedAt: now().toISOString(),
  });

  await management.detect(profile.id);
  await management.detect(profile.id);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM channel_deliveries").pluck().get(),
    0,
  );
  const observation = connections
    .listObservations()
    .find((item) => item.profileId === profile.id);
  assert.equal(observation?.state, "connected");

  const firstTest = management.queueTestMessage(profile.id);
  const secondTest = management.queueTestMessage(profile.id);
  assert.notEqual(firstTest.id, secondTest.id);
  assert.equal(firstTest.purpose, "diagnostic");
  assert.equal(firstTest.targetId, owner.userId);
  assert.equal(firstTest.ownerBindingVersion, owner.bindingVersion);
});

test("disconnecting a profile disables its bindings and publishes a disconnected observation", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => new Date("2026-07-29T00:00:00.000Z");
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
  const profile = connections.saveProfile({
    id: "profile-1",
    connectionId: "connection-1",
    botUuid: "bot-1",
    platform: "feishu",
    displayName: "飞书助手",
    adapterName: "lark",
    enabled: true,
    onboardingState: "ready",
  });
  const bindings = new ChannelBindingRepository(db, now);
  const deliveries = new ChannelDeliveryRepository(db, now);
  const management = new ChannelManagementService(
    connections,
    new LangBotConnectionService(
      connections,
      new MemorySecrets(),
      new ChannelAuditRepository(db, now),
    ),
    bindings,
    new ChannelDestinationRepository(db, now),
    deliveries,
  );
  const binding = management.createBinding({
    profileId: profile.id,
    accountId: "account-1",
    chatKind: "person",
    chatId: "owner-1",
    senderId: "owner-1",
  });

  const disconnected = management.disconnectProfile(profile.id);
  assert.equal(disconnected.enabled, false);
  assert.equal(disconnected.onboardingState, "bot_selected");
  assert.equal(
    bindings.resolve({
      connectionId: "connection-1",
      botUuid: "bot-1",
      platform: "feishu",
      chatKind: "person",
      chatId: "owner-1",
      senderId: "owner-1",
    }),
    undefined,
  );
  assert.equal(
    bindings.resolve({
      connectionId: "connection-1",
      botUuid: "bot-1",
      platform: "feishu",
      chatKind: "person",
      chatId: "owner-1",
      senderId: "owner-1",
      includeDisabled: true,
    })?.id,
    binding.id,
  );
  assert.equal(
    connections
      .listObservations()
      .find((item) => item.profileId === profile.id)?.state,
    "disconnected",
  );
});
