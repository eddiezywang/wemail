import { insertCanonicalTestAccount } from "../../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ChannelConnectionRepository } from "../../channels/ChannelConnectionRepository.js";
import { ChannelBindingRepository } from "../../channels/ChannelBindingRepository.js";
import { ChannelDeliveryRepository } from "../../channels/ChannelLedgerRepository.js";
import { ChannelDestinationRepository } from "../../channels/ChannelDestinationRepository.js";
import { openOrCreateMailDatabase } from "../../database/Database.js";
import { MessageArtifactRepository } from "../../design/MessageArtifactRepository.js";
import type {
  AutomationProviderContext,
  CompiledAutomationStep,
} from "./AutomationProvider.js";
import { AutomationProviderRegistry } from "./AutomationProviderRegistry.js";
import {
  BotMessageAutomationProvider,
  subscriptionInsightNotificationDecision,
} from "./BotMessageAutomationProvider.js";

const NOW = "2026-07-29T13:00:00.000Z";

test("connected Bot delivery accepts rules saved before the delivery-policy upgrade", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-bot-provider-compat-"));
  const db = openOrCreateMailDatabase(path.join(root, "wemail.sqlite"));
  try {
    insertCanonicalTestAccount(db, { id: "account-1" });
    const connections = new ChannelConnectionRepository(db, () => new Date(NOW));
    const provider = new BotMessageAutomationProvider(
      connections,
      new ChannelBindingRepository(db, () => new Date(NOW)),
      new ChannelDestinationRepository(db, () => new Date(NOW)),
      new ChannelDeliveryRepository(db, () => new Date(NOW)),
      new MessageArtifactRepository(db, root, () => NOW),
    );
    const registry = new AutomationProviderRegistry();
    registry.register(provider);
    addReadyBot(connections, new ChannelBindingRepository(db, () => new Date(NOW)), "wecom");

    for (const capabilityFingerprint of [
      "1e34bee8d566658cfc66f1091aa54984788c24277f3ecefdc71c5445e4f3551a",
      "29e492b91a86981e724408c01c9ecf61f1cef743b867c836548ce61d7d6d277d",
    ]) {
      await assert.doesNotReject(() => registry.compile({
        id: "notify",
        provider: "bot-message",
        capability: "publish-connected",
        capabilityFingerprint,
        input: {},
      }));
    }
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("connected Bot delivery requires an explicit both/priority policy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-bot-provider-"));
  const db = openOrCreateMailDatabase(path.join(root, "wemail.sqlite"));
  const nowDate = () => new Date(NOW);
  try {
    insertCanonicalTestAccount(db, { id: "account-1", email: "owner@example.test", displayName: "Owner" });
    const connections = new ChannelConnectionRepository(db, nowDate);
    const bindings = new ChannelBindingRepository(db, nowDate);
    const deliveries = new ChannelDeliveryRepository(db, nowDate);
    const provider = new BotMessageAutomationProvider(
      connections,
      bindings,
      new ChannelDestinationRepository(db, nowDate),
      deliveries,
      new MessageArtifactRepository(db, root, () => NOW),
    );
    const context: AutomationProviderContext = {
      run: {
        id: "run-1",
        ruleId: "rule-1",
        ruleVersion: 1,
        accountId: "account-1",
        occurrenceKey: "occurrence-1",
        actualStartedAt: NOW,
        delayed: false,
      },
      trigger: {},
      steps: {},
      dryRun: false,
    };

    assert.match(
      (await provider.validate(step(), {}, context))[0] ?? "",
      /没有已连接/,
    );
    assert.equal((await provider.execute(step(), {}, context)).status, "failed");

    addReadyBot(connections, bindings, "feishu");
    assert.deepEqual(await provider.validate(step(), {}, context), []);
    const quietInsight = subscriptionInsight(false, 0);
    let result = await provider.execute(
      step(),
      {
        value: { type: "scalar", value: quietInsight },
        notificationPolicy: "risk_or_actionable",
      },
      context,
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.sideEffects.length, 0);
    assert.deepEqual(deliveryPlatforms(db, "run-1"), []);

    const urgentDecision = subscriptionInsightNotificationDecision(
      subscriptionInsight(true, 1),
      "risk_or_actionable",
    );
    assert.deepEqual(
      { suppress: urgentDecision.suppress, urgent: urgentDecision.urgent },
      { suppress: false, urgent: true },
    );
    result = await provider.execute(step(), { title: "日报" }, context);
    assert.equal(result.status, "succeeded");
    assert.equal(deliveryPlatforms(db, "run-1").join(","), "feishu");
    const delivered = deliveries.get(
      (db.prepare(
        "SELECT id FROM channel_deliveries WHERE automation_run_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get("run-1") as { id: string }).id,
    );
    assert.match(delivered?.text ?? "", /日报/);

    addReadyBot(connections, bindings, "wecom");
    assert.match(
      (await provider.validate(step(), {}, context))[0] ?? "",
      /请确认发送到两者/,
    );
    result = await provider.execute(
      step(),
      {},
      { ...context, run: { ...context.run, id: "run-no-policy", occurrenceKey: "occurrence-no-policy" } },
    );
    assert.equal(result.status, "failed");

    result = await provider.execute(
      step(),
      { policy: "all_available" },
      {
        ...context,
        trigger: {
          notificationTitle: "新邮件摘要：预算确认",
          notificationBody: "标签：重要\n摘要：\n• 请在周五前确认预算",
        },
        run: { ...context.run, id: "run-all", occurrenceKey: "occurrence-all" },
      },
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(deliveryPlatforms(db, "run-all"), ["feishu", "wecom"]);
    assert.equal(
      (db.prepare(
        "SELECT target_id FROM channel_deliveries WHERE automation_run_id = ? AND platform = 'wecom'",
      ).get("run-all") as { target_id: string }).target_id,
      "chat-wecom",
    );
    const contextFallbackDelivery = deliveries.get(
      (db.prepare(
        "SELECT id FROM channel_deliveries WHERE automation_run_id = ? ORDER BY sequence ASC LIMIT 1",
      ).get("run-all") as { id: string }).id,
    );
    assert.match(contextFallbackDelivery?.text ?? "", /新邮件摘要：预算确认/);
    assert.match(contextFallbackDelivery?.text ?? "", /标签：重要/);

    result = await provider.execute(
      step(),
      { policy: "first_available", priority: ["wecom", "feishu"] },
      { ...context, run: { ...context.run, id: "run-priority", occurrenceKey: "occurrence-priority" } },
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(deliveryPlatforms(db, "run-priority"), ["wecom"]);
    const primaryId = db.prepare(
      "SELECT id FROM channel_deliveries WHERE automation_run_id = ?",
    ).get("run-priority") as { id: string };
    const primary = deliveries.get(primaryId.id)!;
    assert.deepEqual(
      primary.fallbackTargets?.map((target) => target.platform),
      ["feishu"],
    );
    deliveries.markFailed(primary.id, "wecom-unavailable");
    const fallback = deliveries.activateNextFallback(primary);
    assert.equal(fallback?.platform, "feishu");
    assert.deepEqual(deliveryPlatforms(db, "run-priority"), ["wecom", "feishu"]);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function addReadyBot(
  connections: ChannelConnectionRepository,
  bindings: ChannelBindingRepository,
  platform: "feishu" | "wecom",
) {
  const connection = connections.createConnection({
    id: `connection-${platform}`,
    name: platform,
    baseUrl: "http://127.0.0.1:5300",
    compatibilityProfile: "langbot-v4",
    apiSecretRef: `secret://test/${platform}/api`,
    webhookSecretRef: `secret://test/${platform}/webhook`,
    trustMode: "loopback",
  });
  connections.setConnectionCheck(connection.id, {
    compatible: true,
    enabled: true,
  });
  const profile = connections.saveProfile({
    id: `profile-${platform}`,
    connectionId: connection.id,
    botUuid: `bot-${platform}`,
    platform,
    displayName: `${platform} Bot`,
    adapterName: platform,
    enabled: false,
    onboardingState: "owner_pairing",
  });
  connections.replaceOwner(profile.id, { userId: `owner-${platform}` });
  bindings.save({
    connectionId: connection.id,
    profileId: profile.id,
    botUuid: profile.botUuid,
    platform,
    chatKind: "person",
    chatId: `chat-${platform}`,
    senderId: `owner-${platform}`,
    accountId: "account-1",
    conversationId: `channel:${profile.id}:person:chat-${platform}:owner-${platform}`,
    enabled: true,
    requireMention: false,
  });
  connections.setProfileState(profile.id, {
    state: "ready",
    enabled: true,
    initializedAt: NOW,
  });
}

function step(): CompiledAutomationStep {
  return {
    id: "notify",
    provider: "bot-message",
    capability: "publish-connected",
    input: {},
    descriptor: {
      provider: "bot-message",
      id: "publish-connected",
      version: "1",
      kind: "sink",
      label: "Bot",
      description: "Bot",
      inputSchema: {},
      outputSchema: {},
      risk: "external-mutation",
      sideEffects: ["publish-message"],
      previewSupport: "full",
      idempotency: "keyed",
      discoveryConfidence: "declared",
      fingerprint: "bot-fingerprint",
    },
  };
}

function deliveryPlatforms(
  db: ReturnType<typeof openOrCreateMailDatabase>,
  runId: string,
): string[] {
  return (
    db.prepare(
      "SELECT platform FROM channel_deliveries WHERE automation_run_id = ? ORDER BY sequence ASC",
    ).all(runId) as Array<{ platform: string }>
  ).map((row) => row.platform);
}

function subscriptionInsight(risk: boolean, actions: number) {
  return {
    type: "subscriptionDailyInsight",
    schemaVersion: 1,
    window: { start: NOW, end: NOW, timezone: "Asia/Shanghai" },
    accountCount: 1,
    topHighlights: risk
      ? [{ id: "risk", kind: "risk", text: "安全提醒", sourceEmails: [] }]
      : [],
    curatedCategories: [],
    recommendedActions: Array.from({ length: actions }, (_, index) => ({
      type: "verify_security_notice",
      id: `action-${index}`,
      label: "核验安全提醒",
      status: "available",
      sourceEmails: [],
    })),
    keepSubscriptions: [],
    stats: {
      scanned: 1,
      selected: 1,
      excluded: 0,
      groups: 1,
      truncated: false,
      perAccount: { "account-1": { scanned: 1, selected: 1, excluded: 0 } },
    },
  };
}
