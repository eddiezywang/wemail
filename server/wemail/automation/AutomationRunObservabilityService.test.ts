import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationRuleV2 } from "../../../shared/wemail/automation.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { ApplicationMessageRepository } from "../applicationMessages/ApplicationMessageRepository.js";
import { AutomationRuleRepository } from "./AutomationRuleRepository.js";
import {
  AutomationRunObservabilityService,
  stageForStep,
} from "./AutomationRunObservabilityService.js";
import { AutomationStepRunRepository } from "./AutomationStepRunRepository.js";
import { ChannelConnectionRepository } from "../channels/ChannelConnectionRepository.js";
import { ChannelDeliveryRepository } from "../channels/ChannelLedgerRepository.js";

const startedAt = "2026-07-30T12:00:00.000Z";

function makeRule(rules: AutomationRuleRepository): AutomationRuleV2 {
  return rules.createV2({
    schemaVersion: 2,
    accountId: "acct-1",
    name: "可观测日报",
    enabled: true,
    trigger: {
      type: "scheduled",
      schedule: {
        type: "daily",
        localTime: "21:00",
        timezone: "Asia/Shanghai",
      },
    },
    conditions: {},
    pipeline: [
      {
        id: "deliver",
        name: "发送到 Bot",
        provider: "bot",
        capability: "publish",
        capabilityFingerprint: "fingerprint-1",
        input: {},
      },
    ],
    authorization: { capabilities: [] },
    capabilitySnapshots: [],
    owner: { type: "localProfile", profileId: "default" },
    accountScope: {
      type: "selectedAccounts",
      accountIds: ["acct-1", "acct-2"],
    },
  });
}

test("run claim freezes identity and manifest, suppresses duplicates, and persists progress", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    const rules = new AutomationRuleRepository(db, () => startedAt);
    const rule = makeRule(rules);
    const service = new AutomationRunObservabilityService(
      db,
      () => startedAt,
    );
    const stepRuns = new AutomationStepRunRepository(db);
    const collection = {
      messages: {
        type: "mail-collection",
        messages: [
          {
            accountId: "acct-1",
            emailId: "mail-1",
            subject: "日报",
            receivedAt: "2026-07-30T10:00:00.000Z",
          },
          {
            accountId: "acct-2",
            emailId: "mail-2",
            subject: "告警",
            receivedAt: "2026-07-30T11:00:00.000Z",
          },
        ],
      },
      window: {
        start: "2026-07-30T00:00:00.000Z",
        end: "2026-07-30T12:00:00.000Z",
      },
    };
    const first = service.claim({
      rule,
      runId: "run-1",
      occurrenceKey: "daily:2026-07-30",
      plannedAt: "2026-07-30T11:00:00.000Z",
      actualStartedAt: startedAt,
      delayed: true,
      collection,
    });
    assert.equal(first.claimed, true);
    const duplicate = service.claim({
      rule,
      runId: "run-duplicate",
      occurrenceKey: "daily:2026-07-30",
      plannedAt: "2026-07-30T11:00:00.000Z",
      actualStartedAt: startedAt,
      delayed: true,
      collection,
    });
    assert.deepEqual(duplicate, {
      runId: "run-1",
      claimed: false,
      revision: 1,
    });

    const step = rule.pipeline[0]!;
    const startRevision = service.beginStep("run-1", step, 0);
    const stepRunId = stepRuns.start({
      runId: "run-1",
      ruleId: rule.id,
      ruleVersion: rule.version,
      stepId: step.id,
      provider: step.provider,
      capability: step.capability,
      capabilityFingerprint: step.capabilityFingerprint,
      stage: stageForStep(step),
      sequence: 0,
      runRevision: startRevision,
      inputSummary: { count: 2 },
      startedAt,
    });
    const completeRevision = service.completeStep("run-1");
    stepRuns.complete(stepRunId, {
      runRevision: completeRevision,
      result: {
        status: "failed",
        error: {
          code: "timeout",
          message: "bot timeout token=secret-value",
          retryable: true,
          retrySafe: true,
        },
        warnings: [],
        sideEffects: [],
        audit: {
          provider: "bot",
          capability: "publish",
          capabilityFingerprint: "fingerprint-1",
          startedAt,
          completedAt: startedAt,
          durationMs: 0,
        },
      },
    });
    service.completeRun("run-1", "partial", 0);
    new ApplicationMessageRepository(db, () => startedAt).create({
      accountId: "acct-1",
      owner: { type: "localProfile", profileId: "default" },
      sourceType: "automation",
      sourceRuleId: rule.id,
      sourceRunId: "run-1",
      type: "analysis",
      severity: "success",
      title: "日报结果",
      preview: "发现 2 条需要关注的告警。",
      content: [{ type: "paragraph", text: "发现 2 条需要关注的告警。" }],
      references: [],
      interactions: [],
    });

    const detail = service.detail("run-1", {
      accountId: "acct-1",
      profileId: "default",
    });
    assert.ok(detail);
    assert.equal(detail.outcome, "partial");
    assert.equal(detail.manifest?.items.length, 2);
    assert.deepEqual(detail.resolvedAccountIds, ["acct-1", "acct-2"]);
    assert.equal(detail.steps[0]?.stage, "delivery");
    assert.equal(detail.steps[0]?.retrySafe, true);
    assert.equal(detail.output?.type, "application_message");
    assert.equal(detail.output?.preview, "发现 2 条需要关注的告警。");
    assert.equal(detail.recoveryActions[0]?.type, "retry_delivery");
    assert.equal(
      service.progress("run-1", { accountId: "acct-1" }, detail.revision)
        ?.changed,
      false,
    );
    assert.equal(
      service.canRetryStep("run-1", "deliver", "fingerprint-1").ok,
      true,
    );
    assert.deepEqual(
      service.canRetryStep("run-1", "deliver", "changed"),
      {
        ok: false,
        code: "capability-changed",
        message: "执行能力已变化，请发起一次新运行。",
      },
    );
  } finally {
    db.close();
  }
});

test("terminal Bot delivery failures reconcile the completed run to partial", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    const rules = new AutomationRuleRepository(db, () => startedAt);
    const rule = makeRule(rules);
    const service = new AutomationRunObservabilityService(db, () => startedAt);
    service.claim({
      rule,
      runId: "run-delivery",
      occurrenceKey: "delivery:2026-07-30",
      actualStartedAt: startedAt,
      delayed: false,
      collection: {},
    });
    service.completeRun("run-delivery", "succeeded", 1);

    const stepRuns = new AutomationStepRunRepository(db);
    const messageStep = stepRuns.start({
      runId: "run-delivery",
      ruleId: rule.id,
      ruleVersion: rule.version,
      stepId: "message-center",
      provider: "application-message",
      capability: "publish",
      stage: "delivery",
    });
    stepRuns.complete(messageStep, {
      result: {
        status: "succeeded",
        warnings: [],
        sideEffects: [],
        audit: {
          provider: "application-message",
          capability: "publish",
          capabilityFingerprint: "message-center",
          startedAt,
          completedAt: startedAt,
          durationMs: 0,
        },
      },
    });

    const connections = new ChannelConnectionRepository(db, () => new Date(startedAt));
    const connection = connections.createConnection({
      id: "connection-1",
      name: "Bot Core",
      baseUrl: "http://127.0.0.1:5300",
      compatibilityProfile: "langbot-v4",
      apiSecretRef: "secret://test/api",
      webhookSecretRef: "secret://test/webhook",
      trustMode: "loopback",
    });
    const profile = connections.saveProfile({
      id: "profile-1",
      connectionId: connection.id,
      botUuid: "bot-1",
      platform: "wecom",
      displayName: "企业微信",
      adapterName: "wecom",
      enabled: true,
      onboardingState: "ready",
    });
    const deliveries = new ChannelDeliveryRepository(db, () => new Date(startedAt));
    const delivery = deliveries.enqueue({
      connectionId: connection.id,
      profileId: profile.id,
      botUuid: profile.botUuid,
      platform: profile.platform,
      targetType: "person",
      targetId: "owner-1",
      purpose: "automation",
      text: "日报",
      sequence: 0,
      maxAttempts: 3,
      correlationKey: "delivery:first-available",
      automationRuleId: rule.id,
      automationRunId: "run-delivery",
      automationActionIndex: 0,
    });
    assert.equal(service.reconcileChannelDeliveries("run-delivery"), "pending");
    assert.deepEqual(
      db.prepare("SELECT status FROM automation_rule_runs WHERE id = ?")
        .get("run-delivery"),
      { status: "running" },
    );
    deliveries.markFailed(delivery.id, "platform-unavailable");

    assert.equal(service.reconcileChannelDeliveries("run-delivery"), "partial");
    assert.equal(
      service.detail("run-delivery", { accountId: "acct-1", profileId: "default" })
        ?.outcome,
      "partial",
    );
    const firstTerminal = db.prepare(`
      SELECT status, completed_at AS completedAt, run_revision AS revision
      FROM automation_rule_runs WHERE id = ?
    `).get("run-delivery");
    assert.equal(service.reconcileChannelDeliveries("run-delivery"), "partial");
    assert.deepEqual(
      db.prepare(`
        SELECT status, completed_at AS completedAt, run_revision AS revision
        FROM automation_rule_runs WHERE id = ?
      `).get("run-delivery"),
      firstTerminal,
    );

    service.claim({
      rule,
      runId: "run-partial-pending",
      occurrenceKey: "delivery:2026-07-31",
      actualStartedAt: startedAt,
      delayed: false,
      collection: {},
    });
    const failedAnalysis = stepRuns.start({
      runId: "run-partial-pending",
      ruleId: rule.id,
      ruleVersion: rule.version,
      stepId: "analysis",
      provider: "analysis",
      capability: "execute",
      stage: "analysis",
    });
    stepRuns.complete(failedAnalysis, {
      result: {
        status: "failed",
        error: {
          code: "execution-failed",
          message: "analysis failed",
          retryable: true,
          retrySafe: true,
        },
        warnings: [],
        sideEffects: [],
        audit: {
          provider: "analysis",
          capability: "execute",
          capabilityFingerprint: "analysis",
          startedAt,
          completedAt: startedAt,
          durationMs: 0,
        },
      },
    });
    service.completeRun("run-partial-pending", "partial", 0);
    const eventualDelivery = deliveries.enqueue({
      connectionId: connection.id,
      profileId: profile.id,
      botUuid: profile.botUuid,
      platform: profile.platform,
      targetType: "person",
      targetId: "owner-1",
      purpose: "automation",
      text: "部分成功日报",
      sequence: 0,
      maxAttempts: 3,
      correlationKey: "delivery:partial-pending",
      automationRuleId: rule.id,
      automationRunId: "run-partial-pending",
      automationActionIndex: 0,
    });
    assert.equal(
      service.reconcileChannelDeliveries("run-partial-pending"),
      "pending",
    );
    assert.equal(
      db.prepare("SELECT status FROM automation_rule_runs WHERE id = ?")
        .pluck()
        .get("run-partial-pending"),
      "running",
    );
    deliveries.markSent(eventualDelivery.id);
    assert.equal(
      service.reconcileChannelDeliveries("run-partial-pending"),
      "partial",
    );
    const settledPartial = db.prepare(`
      SELECT status, completed_at AS completedAt, run_revision AS revision
      FROM automation_rule_runs WHERE id = ?
    `).get("run-partial-pending") as {
      status: string;
      completedAt: string | null;
      revision: number;
    };
    assert.equal(settledPartial.status, "partial");
    assert.ok(settledPartial.completedAt);
    assert.equal(
      service.reconcileChannelDeliveries("run-partial-pending"),
      "partial",
    );
    assert.deepEqual(
      db.prepare(`
        SELECT status, completed_at AS completedAt, run_revision AS revision
        FROM automation_rule_runs WHERE id = ?
      `).get("run-partial-pending"),
      settledPartial,
    );
  } finally {
    db.close();
  }
});

test("run detail expires explicitly and unsafe side effects refuse retry after restart", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    const rules = new AutomationRuleRepository(db, () => startedAt);
    const rule = makeRule(rules);
    const initial = new AutomationRunObservabilityService(
      db,
      () => startedAt,
    );
    initial.claim({
      rule,
      runId: "run-expired",
      occurrenceKey: "occurrence-expired",
      actualStartedAt: startedAt,
      delayed: false,
      collection: { messages: { type: "mail-collection", messages: [] } },
    });
    const stepRuns = new AutomationStepRunRepository(db);
    const step = rule.pipeline[0]!;
    const stepRunId = stepRuns.start({
      runId: "run-expired",
      ruleId: rule.id,
      ruleVersion: rule.version,
      stepId: step.id,
      provider: step.provider,
      capability: step.capability,
      stage: "delivery",
    });
    stepRuns.complete(stepRunId, {
      result: {
        status: "failed",
        error: {
          code: "execution-failed",
          message: "unknown delivery result",
          retryable: true,
          retrySafe: true,
        },
        warnings: [],
        sideEffects: [{ type: "external-request", summary: "request sent" }],
        audit: {
          provider: "bot",
          capability: "publish",
          capabilityFingerprint: "fingerprint-1",
          startedAt,
          completedAt: startedAt,
          durationMs: 0,
        },
      },
    });
    assert.deepEqual(
      initial.canRetryStep("run-expired", "deliver", "fingerprint-1"),
      {
        ok: false,
        code: "uncertain-side-effect",
        message: "无法证明上次执行没有产生副作用，已拒绝自动重试。",
      },
    );

    const afterRetention = new AutomationRunObservabilityService(
      db,
      () => "2026-09-01T00:00:00.000Z",
    );
    const detail = afterRetention.detail("run-expired", {
      accountId: "acct-1",
    });
    assert.equal(detail?.manifestAvailability, "expired");
    assert.equal(detail?.resultAvailability, "expired");
    assert.deepEqual(detail?.steps, []);
    assert.match(detail?.warnings[0] ?? "", /保留期/);
  } finally {
    db.close();
  }
});
