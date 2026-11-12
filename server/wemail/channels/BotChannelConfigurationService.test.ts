import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { BotCoreInboundEnvelope } from "../../../shared/wemail/botCoreProtocol.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import type { SecretStore } from "../security/SecretStore.js";
import { ChannelAuditRepository } from "./ChannelAuditRepository.js";
import { ChannelBindingRepository } from "./ChannelBindingRepository.js";
import { BotChannelConfigurationService } from "./BotChannelConfigurationService.js";
import { BotChannelRuntime } from "./BotChannelRuntime.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import {
  ChannelDeliveryRepository,
  ChannelInboundRepository,
} from "./ChannelLedgerRepository.js";
import { ChannelPairingService } from "./ChannelPairingService.js";
import { ChannelDestinationRepository } from "./ChannelDestinationRepository.js";

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  saveSecret(key: string, value: string): void {
    this.values.set(key, value);
  }
  getSecret(key: string): string | undefined {
    return this.values.get(key);
  }
  deleteSecret(key: string): void {
    this.values.delete(key);
  }
  isEncryptionAvailable(): boolean {
    return true;
  }
}

test("platform configuration is one-per-platform, redacted, and resolves only for Bot Core", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const secrets = new MemorySecrets();
  const connections = new ChannelConnectionRepository(db);
  const inbound = new ChannelInboundRepository(db);
  const destinations = new ChannelDestinationRepository(db);
  const runtime = new BotChannelRuntime(inbound, connections, destinations);
  const service = new BotChannelConfigurationService(
    db,
    connections,
    secrets,
    new ChannelAuditRepository(db),
    runtime,
  );
  let changes = 0;
  runtime.onConfigurationChanged(() => {
    changes += 1;
  });

  const saved = service.save({
    platform: "feishu",
    externalBotId: "cli_test_app",
    secret: "feishu-super-secret",
  });
  assert.equal(saved.platform, "feishu");
  assert.equal(saved.displayName, "WeMail 飞书机器人");
  assert.equal(saved.hasCredential, true);
  assert.doesNotMatch(JSON.stringify(saved), /feishu-super-secret/);
  assert.doesNotMatch(
    JSON.stringify(
      db.prepare("SELECT * FROM bot_channel_configurations").all(),
    ),
    /feishu-super-secret/,
  );
  assert.doesNotMatch(
    JSON.stringify(db.prepare("SELECT * FROM langbot_connections").all()),
    /feishu-super-secret/,
  );
  assert.equal(service.resolvedConfigurations()[0]?.platform, "feishu");
  assert.match(
    JSON.stringify(service.resolvedConfigurations()),
    /feishu-super-secret/,
  );

  service.save({
    platform: "feishu",
    externalBotId: "cli_id_updated_without_secret",
  });
  assert.match(
    JSON.stringify(service.resolvedConfigurations()),
    /feishu-super-secret/,
  );

  service.disable("feishu");
  assert.equal(service.list()[0]?.enabled, false);
  assert.equal(service.resolvedConfigurations().length, 0);
  service.enable("feishu");
  assert.equal(service.list()[0]?.enabled, true);
  assert.equal(service.resolvedConfigurations().length, 1);

  service.save({
    platform: "feishu",
    externalBotId: "cli_updated_app",
    secret: "rotated-secret",
  });
  assert.equal(service.list().length, 1);
  assert.equal(connections.listProfiles("feishu").length, 1);
  assert.equal(changes, 5);
});

test("replacing a Bot clears stale lifecycle state while preserving history", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => new Date("2026-07-31T00:00:00.000Z");
  insertCanonicalTestAccount(db, { id: "account-1", email: "owner@example.com", displayName: "Owner" });
  const secrets = new MemorySecrets();
  const connections = new ChannelConnectionRepository(db, now);
  const inbound = new ChannelInboundRepository(db, now);
  const destinations = new ChannelDestinationRepository(db, now);
  const runtime = new BotChannelRuntime(inbound, connections, destinations);
  const service = new BotChannelConfigurationService(
    db,
    connections,
    secrets,
    new ChannelAuditRepository(db, now),
    runtime,
    now,
  );
  const original = service.save({
    platform: "feishu",
    externalBotId: "cli_old",
    secret: "old-secret",
  });
  const owner = connections.replaceOwner(original.profileId, {
    userId: "owner-old",
  });
  connections.setProfileState(original.profileId, {
    state: "ready",
    enabled: true,
    initializationVersion: 1,
    initializedAt: now().toISOString(),
  });
  const bindings = new ChannelBindingRepository(db, now);
  const binding = bindings.save({
    connectionId: original.connectionId,
    profileId: original.profileId,
    botUuid: "cli_old",
    platform: "feishu",
    chatKind: "person",
    chatId: "owner-old",
    senderId: "owner-old",
    accountId: "account-1",
    conversationId: "conversation-1",
    enabled: true,
    requireMention: false,
  });
  destinations.save({
    profileId: original.profileId,
    type: "person",
    externalId: "owner-old",
    verified: true,
  });
  const deliveries = new ChannelDeliveryRepository(db, now);
  const pending = deliveries.enqueue({
    connectionId: original.connectionId,
    profileId: original.profileId,
    botUuid: "cli_old",
    platform: "feishu",
    targetType: "person",
    targetId: "owner-old",
    purpose: "diagnostic",
    text: "pending",
    sequence: 0,
    maxAttempts: 3,
    ownerBindingVersion: owner.bindingVersion,
  });
  const pairing = new ChannelPairingService(
    db,
    connections,
    deliveries,
    bindings,
    new ChannelAuditRepository(db, now),
    () => "account-1",
    now,
  );
  pairing.createChallenge(original.profileId);

  service.save({
    platform: "feishu",
    externalBotId: "cli_new",
    secret: "new-secret",
  });

  const reset = connections.getProfile(original.profileId)!;
  assert.equal(reset.botUuid, "cli_new");
  assert.equal(reset.owner, undefined);
  assert.equal(reset.onboardingState, "bot_selected");
  assert.equal(reset.enabled, true);
  assert.equal(reset.initializedAt, undefined);
  assert.equal(bindings.listByProfile(original.profileId).find((item) => item.id === binding.id)?.enabled, false);
  assert.equal(destinations.list(original.profileId).length, 0);
  assert.equal(deliveries.get(pending.id)?.state, "needs_reauthorization");
  assert.ok(
    db
      .prepare(
        "SELECT redeemed_at FROM channel_pairing_challenges WHERE profile_id = ?",
      )
      .pluck()
      .get(original.profileId),
  );
  assert.equal(
    connections.replaceOwner(original.profileId, { userId: "owner-new" })
      .bindingVersion,
    2,
  );
});

test("manual lifecycle reset keeps credentials and returns to owner pairing", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const secrets = new MemorySecrets();
  const connections = new ChannelConnectionRepository(db);
  const runtime = new BotChannelRuntime(
    new ChannelInboundRepository(db),
    connections,
    new ChannelDestinationRepository(db),
  );
  const service = new BotChannelConfigurationService(
    db,
    connections,
    secrets,
    new ChannelAuditRepository(db),
    runtime,
  );
  const configuration = service.save({
    platform: "wecom",
    externalBotId: "wecom-bot",
    secret: "wecom-secret",
  });
  connections.replaceOwner(configuration.profileId, { userId: "owner-1" });
  service.disable("wecom");

  const reset = service.resetProfile(configuration.profileId);

  assert.equal(reset.owner, undefined);
  assert.equal(reset.onboardingState, "bot_selected");
  assert.equal(reset.enabled, true);
  assert.equal(service.list()[0]?.enabled, true);
  assert.equal(service.resolvedConfigurations().length, 1);
});

test("Bot Core inbound envelopes are profile-validated and deduplicated", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const timestamp = "2026-07-29T00:00:00.000Z";
  insertCanonicalTestAccount(db, { id: "account-1", email: "owner@example.com", displayName: "Owner" });
  const secrets = new MemorySecrets();
  const connections = new ChannelConnectionRepository(db);
  const inbound = new ChannelInboundRepository(db);
  const destinations = new ChannelDestinationRepository(db);
  const runtime = new BotChannelRuntime(inbound, connections, destinations);
  const service = new BotChannelConfigurationService(
    db,
    connections,
    secrets,
    new ChannelAuditRepository(db),
    runtime,
  );
  const configuration = service.save({
    platform: "wecom",
    externalBotId: "wecom-bot",
    secret: "wecom-secret",
  });
  const envelope: BotCoreInboundEnvelope = {
    eventId: "message-1",
    connectionId: configuration.connectionId,
    profileId: configuration.profileId,
    botUuid: configuration.externalBotId,
    platform: "wecom",
    chatKind: "group",
    chatId: "group-1",
    chatName: "Operations",
    senderId: "user-1",
    senderName: "Owner",
    text: "请检查邮件",
    mentionedBot: true,
    occurredAt: "2026-07-29T00:00:00.000Z",
    attachments: [
      {
        type: "file",
        mimeType: "application/pdf",
        fileName: "report.pdf",
      },
    ],
  };

  assert.equal(runtime.ingest(envelope).duplicate, false);
  assert.equal(runtime.ingest(envelope).duplicate, true);
  const leased = inbound.leaseNext("test-worker");
  assert.equal(leased?.event.adapterName, "@qwen-code/channel-wecom");
  assert.equal(leased?.event.peerKey, "wecom:wecom-bot:group:group-1:user-1");
  assert.equal(leased?.event.message[1]?.sourceType, "file");
  assert.deepEqual(
    destinations.list(configuration.profileId).map((destination) => ({
      type: destination.type,
      externalId: destination.externalId,
      verified: destination.verified,
    })),
    [{ type: "group", externalId: "group-1", verified: true }],
  );
  inbound.complete(leased!.id);

  const pairing = new ChannelPairingService(
    db,
    connections,
    new ChannelDeliveryRepository(db),
    new ChannelBindingRepository(db),
    new ChannelAuditRepository(db),
    () => "account-1",
  );
  const challenge = pairing.createChallenge(configuration.profileId);
  runtime.ingest({
    ...envelope,
    eventId: "pairing-message",
    chatKind: "person",
    chatId: "user-1",
    text: challenge.command,
    mentionedBot: false,
    attachments: [],
  });
  const pairingEvent = inbound.leaseNext("pairing-worker");
  const pairingResult = pairing.intercept(pairingEvent!.event);
  assert.equal(pairingResult.handled, true);
  if (!pairingResult.handled) assert.fail("pairing command was not handled");
  assert.equal(pairingResult.outcome, "paired");
  assert.equal(
    connections.getProfile(configuration.profileId)?.owner?.userId,
    "user-1",
  );

  assert.throws(
    () => runtime.ingest({ ...envelope, profileId: "other-profile" }),
    /bot-profile-not-enabled/,
  );
});
