import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AutomationDataset } from "../../../shared/wemail/automation.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { ApplicationMessageRepository } from "../applicationMessages/ApplicationMessageRepository.js";
import { MessageArtifactRepository } from "../design/MessageArtifactRepository.js";
import { AutomationRuleRepository } from "./AutomationRuleRepository.js";
import { AutomationRuleService } from "./AutomationRuleService.js";
import { AutomationRulePreviewRepository } from "./AutomationRulePreviewRepository.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import { AutomationRuleRuntimeRepository } from "./AutomationRuleRuntimeRepository.js";
import { AutomationStepRunRepository } from "./AutomationStepRunRepository.js";
import { AutomationRunObservabilityService } from "./AutomationRunObservabilityService.js";
import {
  boundedPreviousExecutionStart,
  commandPathLimit,
  PipelineAutomationRuleService,
  renderReceivedMailSummaryNotification,
} from "./PipelineAutomationRuleService.js";
import { ApplicationMessageAutomationProvider } from "./providers/ApplicationMessageAutomationProvider.js";
import { AutomationProviderRegistry } from "./providers/AutomationProviderRegistry.js";
import { DesignAutomationProvider } from "./providers/DesignAutomationProvider.js";
import type {
  AutomationCapabilityDescriptor,
  AutomationProvider,
} from "./providers/AutomationProvider.js";
import { descriptorFingerprint } from "./providers/AutomationProviderRegistry.js";
import type { SummaryResult, TagResult } from "../../../shared/wemail/intelligence.js";

test("command scope comes from validated provider metadata", () => {
  const descriptor = { metadata: { commandPath: ["mail", "list"] } } as unknown as AutomationCapabilityDescriptor;
  assert.deepEqual(commandPathLimit(descriptor), { allowedCommandPath: ["mail", "list"] });
  assert.deepEqual(commandPathLimit({} as AutomationCapabilityDescriptor), {});
  assert.throws(() => commandPathLimit({ metadata: { commandPath: ["mail", "list;bad"] } } as unknown as AutomationCapabilityDescriptor), /invalid-automation-command-path/);
});

test("bounded previous-execution window takes the shorter of both periods", () => {
  const upperBound = "2026-08-10T09:00:00.000Z";
  const maxLookback = { amount: 24, unit: "hour" as const };

  assert.equal(
    boundedPreviousExecutionStart(
      upperBound,
      "2026-08-10T01:00:00.000Z",
      maxLookback,
    ),
    "2026-08-10T01:00:00.000Z",
  );
  assert.equal(
    boundedPreviousExecutionStart(
      upperBound,
      "2026-08-08T09:00:00.000Z",
      maxLookback,
    ),
    "2026-08-09T09:00:00.000Z",
  );
  assert.equal(
    boundedPreviousExecutionStart(upperBound, undefined, maxLookback),
    "2026-08-09T09:00:00.000Z",
  );
});

test("received-mail notification includes summary text and AI labels as plain text", () => {
  const summary = {
    type: "summary",
    bullets: ["需要在周五前确认预算"],
    actionItems: ["回复财务"],
    urgency: "medium",
  } satisfies SummaryResult;
  const tags = {
    type: "tags",
    tags: [{ name: "重要", confidence: 0.99, source: "ai", tier: "auto" }],
    contentTags: [{ name: "预算", confidence: 0.9, source: "ai", tier: "auto" }],
  } satisfies TagResult;
  const notification = renderReceivedMailSummaryNotification(
    {
      subject: "预算确认",
      from: { name: "财务", email: "finance@example.com" },
      receivedAt: "2026-08-03T16:22:59.000Z",
    },
    summary,
    tags,
  );

  assert.equal(notification.title, "新邮件摘要：预算确认");
  assert.doesNotMatch(notification.body, /主题：预算确认/);
  assert.match(notification.body, /标签：重要、预算/);
  assert.match(notification.body, /接收时间：2026-08-04 00:22:59/);
  assert.match(notification.body, /需要在周五前确认预算/);
  assert.match(notification.body, /回复财务/);
  assert.doesNotMatch(notification.body, /<html/i);
});

test("received-mail notification does not duplicate structured summary fields", () => {
  const notification = renderReceivedMailSummaryNotification(
    {
      subject: "SDL 门禁待办",
      from: { name: "运营平台", email: "platform@example.com" },
      receivedAt: "2026-08-05T02:30:37.000Z",
    },
    {
      type: "summary",
      schemaVersion: 2,
      headline: "有 1 条 SDL 门禁待办",
      details: ["预计发布时间 2026-08-10"],
      bullets: ["有 1 条 SDL 门禁待办", "预计发布时间 2026-08-10"],
      actionItems: [],
      urgency: "medium",
    },
  );

  assert.equal(
    notification.body.split("\n").filter((line) => line === "• 有 1 条 SDL 门禁待办").length,
    1,
  );
  assert.equal(
    notification.body.split("\n").filter((line) => line === "• 预计发布时间 2026-08-10").length,
    1,
  );
});

test("V2 preview snapshot commits and executes dataset to design artifact to application message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-pipeline-v2-"));
  const db = openOrCreateMailDatabase(path.join(dir, "db.sqlite"));
  const now = () => "2026-07-27T12:00:00.000Z";
  try {
    const artifacts = new MessageArtifactRepository(db, dir, now);
    const messages = new ApplicationMessageRepository(db, now);
    const providers = new AutomationProviderRegistry();
    providers.register(new DesignAutomationProvider(artifacts));
    providers.register(new ApplicationMessageAutomationProvider(messages, artifacts));
    const rules = new AutomationRuleRepository(db, now);
    const service = new PipelineAutomationRuleService({ db, rules, providers, stepRuns: new AutomationStepRunRepository(db), runtime: new AutomationRuleRuntimeRepository(db, now), now });
    const dataset: AutomationDataset = { type: "dataset", schema: { fields: [{ name: "team", type: "string" }, { name: "count", type: "number" }] }, rows: [{ team: "A", count: 3 }], summary: { total: 3 }, provenance: [{ outputPath: "rows.0", sourceType: "mail", emailIds: ["mail-1"] }] };
    const preview = await service.preview({
      schemaVersion: 2, accountId: "acct-1", name: "邮件数据报告", enabled: true,
      trigger: { type: "manual" }, conditions: {},
      pipeline: [
        { id: "design", provider: "design", capability: "render", input: { dataset: { type: "literal", value: dataset }, title: { type: "literal", value: "团队邮件报告" }, mode: { type: "literal", value: "report" } } },
        { id: "notify", provider: "application-message", capability: "publish", input: { artifact: { type: "path", from: "step", stepId: "design", path: "" }, title: { type: "literal", value: "团队邮件报告" } } },
      ],
    });
    const legacy = new AutomationRuleService({ rules, previews: new AutomationRulePreviewRepository(db, now),
      mail: {} as CanonicalMailRepository, now, editionValidation: {}, editionCapabilities: {} });
    assert.throws(() => legacy.commit({ accountId: "acct-1", previewId: preview.previewId, ruleHash: preview.ruleHash }), /automation-preview-format-mismatch/);
    const rule = await service.commit({ accountId: "acct-1", previewId: preview.previewId, ruleHash: preview.ruleHash });
    const duplicate = await service.commit({ accountId: "acct-1", previewId: preview.previewId, ruleHash: preview.ruleHash });
    assert.equal(duplicate.id, rule.id);
    const changedProviders = new AutomationProviderRegistry();
    const resumed = new PipelineAutomationRuleService({ db, rules, providers: changedProviders, stepRuns: new AutomationStepRunRepository(db), runtime: new AutomationRuleRuntimeRepository(db, now), now });
    assert.equal((await resumed.commit({ accountId: "acct-1", previewId: preview.previewId, ruleHash: preview.ruleHash })).id, rule.id);
    assert.equal(rule.schemaVersion, 2);
    assert.equal(rules.list("acct-1").length, 0);
    assert.equal(rules.listV2("acct-1").length, 1);
    const result = await service.run(rule);
    assert.equal(result.ok, true);
    const delivered = messages.list("acct-1").messages[0];
    assert.equal(delivered?.title, "团队邮件报告");
    assert.equal(delivered?.artifact?.kind, "report");
    assert.ok(delivered?.interactions.some((item) => item.type === "openArtifact"));
    assert.equal(new AutomationStepRunRepository(db).list(result.runId).length, 2);
    rules.replaceV2(rule.id, { ...rule, enabled: false }, rule.version);
    await assert.rejects(service.commit({ accountId: "acct-1", previewId: preview.previewId, ruleHash: preview.ruleHash }), /automation-committed-rule-changed/);
    await assert.rejects(service.run(rule), /automation-source-rule-stale/);
    assert.equal(messages.list("acct-1").messages.length, 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("scheduled runtime is restart-safe, idempotent, and does not require a general Agent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-pipeline-schedule-"));
  const databasePath = path.join(dir, "db.sqlite");
  const now = () => "2026-07-29T13:00:00.000Z";
  let db = openOrCreateMailDatabase(databasePath);
  let executions = 0;
  try {
    insertCanonicalTestAccount(db, { id: "acct-schedule", email: "owner@example.test", displayName: "Owner" });
    const providers = new AutomationProviderRegistry();
    const fixedProvider = countingProvider(() => {
      executions += 1;
    });
    providers.register(fixedProvider);
    const [descriptor] = await fixedProvider.discover();
    const rules = new AutomationRuleRepository(db, now);
    rules.createV2({
      schemaVersion: 2,
      accountId: "acct-schedule",
      name: "每日固定执行",
      enabled: true,
      trigger: {
        type: "scheduled",
        schedule: {
          type: "daily",
          localTime: "12:00",
          timezone: "Asia/Shanghai",
        },
        nextRunAt: "2026-07-29T12:00:00.000Z",
      },
      conditions: {},
      pipeline: [{
        id: "fixed",
        provider: "fixed",
        capability: "run",
        capabilityFingerprint: descriptor!.fingerprint,
        input: {},
      }],
      authorization: {
        capabilities: [{
          provider: "fixed",
          capability: "run",
          fingerprint: descriptor!.fingerprint,
          risk: "read",
          limits: { allowedAccountId: "acct-schedule" },
        }],
      },
      capabilitySnapshots: [{
        provider: "fixed",
        capability: "run",
        fingerprint: descriptor!.fingerprint,
        risk: "read",
        inputSchemaHash: "schema",
      }],
      skillSnapshots: [{
        skillId: "wemail-insight-report",
        version: "1.0.0",
        contentHash: "immutable-skill-hash",
        scope: "builtin",
      }],
    });
    let service = new PipelineAutomationRuleService({
      db,
      rules,
      providers,
      stepRuns: new AutomationStepRunRepository(db),
      runtime: new AutomationRuleRuntimeRepository(db, now),
      now,
    });
    await service.runDueScheduled("acct-schedule");
    await service.runDueScheduled("acct-schedule");
    assert.equal(executions, 1);
    const scheduled = rules.listV2("acct-schedule")[0]!;
    const runtimeBeforeManual = new AutomationRuleRuntimeRepository(db, now).get(scheduled.id);
    await service.runManually(scheduled);
    assert.deepEqual(new AutomationRuleRuntimeRepository(db, now).get(scheduled.id), runtimeBeforeManual);
    assert.equal(executions, 2);

    db.close();
    db = openOrCreateMailDatabase(databasePath);
    service = new PipelineAutomationRuleService({
      db,
      rules: new AutomationRuleRepository(db, now),
      providers,
      stepRuns: new AutomationStepRunRepository(db),
      runtime: new AutomationRuleRuntimeRepository(db, now),
      now,
    });
    await service.runDueScheduled("acct-schedule");
    assert.equal(executions, 2);
    assert.equal(
      new AutomationRuleRepository(db, now).listV2("acct-schedule")[0]
        ?.skillSnapshots?.[0]?.contentHash,
      "immutable-skill-hash",
    );
    const reopenedRules = new AutomationRuleRepository(db, now);
    const oldRule = reopenedRules.listV2("acct-schedule")[0]!;
    const edited = reopenedRules.replaceV2(oldRule.id, {
      ...oldRule, trigger: { type: "scheduled", intervalMinutes: 30 },
    }, oldRule.version);
    await service.runDueScheduled("acct-schedule");
    const editedState = new AutomationRuleRuntimeRepository(db, now).get(edited.id);
    assert.equal(editedState?.ruleVersion, edited.version);
    assert.equal(editedState?.nextRunAt, "2026-07-29T13:30:00.000Z");
    assert.equal(executions, 2);
    const runtime = new AutomationRuleRuntimeRepository(db, now);
    assert.equal(runtime.settleScheduled({
      ruleId: edited.id, ruleVersion: oldRule.version, plannedAt: "2026-07-29T12:00:00.000Z",
      startedAt: now(), completedAt: now(), nextRunAt: "2026-07-30T12:00:00.000Z", consecutiveFailures: 0,
    }), false);
    assert.equal(runtime.get(edited.id)?.nextRunAt, "2026-07-29T13:30:00.000Z");
    db.prepare("UPDATE automation_rule_runtime_state SET paused_reason = 'stale-catch-up-skipped' WHERE rule_id = ?").run(edited.id);
    runtime.settleScheduled({
      ruleId: edited.id, ruleVersion: oldRule.version, plannedAt: "2026-07-29T12:00:00.000Z",
      startedAt: now(), completedAt: now(), nextRunAt: "2026-07-30T12:00:00.000Z",
      consecutiveFailures: 1, pausedReason: "execution-outcome-unknown",
    });
    assert.equal(runtime.get(edited.id)?.pausedReason, "execution-outcome-unknown");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduled automation pauses when execution outcome is unknown", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => "2026-07-29T13:00:00.000Z";
  try {
    const providers = new AutomationProviderRegistry();
    let shouldThrow = true;
    const provider = countingProvider(() => { if (shouldThrow) throw new Error("connection-lost"); });
    providers.register(provider);
    const [descriptor] = await provider.discover();
    const rules = new AutomationRuleRepository(db, now);
    const rule = rules.createV2({
      schemaVersion: 2, accountId: "acct-schedule", name: "定时任务", enabled: true,
      trigger: { type: "scheduled", intervalMinutes: 60, nextRunAt: "2026-07-29T12:00:00.000Z" },
      conditions: {}, pipeline: [{ id: "fixed", provider: "fixed", capability: "run", capabilityFingerprint: descriptor!.fingerprint, input: {} }],
      authorization: { capabilities: [{ provider: "fixed", capability: "run", fingerprint: descriptor!.fingerprint, risk: "read" }] },
      capabilitySnapshots: [{ provider: "fixed", capability: "run", fingerprint: descriptor!.fingerprint, risk: "read", inputSchemaHash: "schema" }],
    });
    const runtime = new AutomationRuleRuntimeRepository(db, now);
    const service = new PipelineAutomationRuleService({ db, rules, providers, stepRuns: new AutomationStepRunRepository(db), runtime, now });
    await service.runDueScheduled("acct-schedule");
    assert.equal(runtime.get(rule.id)?.pausedReason, "execution-outcome-unknown");
    assert.equal(runtime.get(rule.id)?.lastScheduledAt, "2026-07-29T12:00:00.000Z");
    db.prepare("UPDATE automation_rule_runtime_state SET paused_reason = NULL, next_run_at = ? WHERE rule_id = ?")
      .run("2026-07-29T12:00:00.000Z", rule.id);
    await service.runDueScheduled("acct-schedule");
    assert.equal(runtime.get(rule.id)?.pausedReason, "execution-outcome-unknown");
    shouldThrow = false;
    await service.runManually(rule);
    assert.equal(runtime.get(rule.id)?.pausedReason, "execution-outcome-unknown");
    assert.equal(runtime.get(rule.id)?.lastScheduledAt, "2026-07-29T12:00:00.000Z");
    rules.replaceV2(rule.id, { ...rule, name: "修改后的定时任务" }, rule.version);
    await service.runDueScheduled("acct-schedule");
    assert.equal(runtime.get(rule.id)?.pausedReason, "execution-outcome-unknown");
    shouldThrow = true;
    const manualRule = rules.createV2({ ...rule, name: "手动运行的定时任务" });
    await assert.rejects(service.runManually(manualRule), /automation-run-outcome-unknown/);
    assert.equal(runtime.get(manualRule.id)?.pausedReason, "execution-outcome-unknown");
  } finally {
    db.close();
  }
});

test("mail-received automation executes once when the same mail event is repeated", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => "2026-08-07T12:00:00.000Z";
  let executions = 0;
  try {
    insertCanonicalTestAccount(db, {
      id: "acct-mail-idempotency",
      email: "owner@example.test",
      displayName: "Owner",
    });
    const providers = new AutomationProviderRegistry();
    const provider = countingProvider(() => {
      executions += 1;
    });
    providers.register(provider);
    const [descriptor] = await provider.discover();
    const rules = new AutomationRuleRepository(db, now);
    const firstRule = rules.createV2({
      schemaVersion: 2,
      accountId: "acct-mail-idempotency",
      name: "新邮件通知",
      enabled: true,
      trigger: { type: "mailReceived" },
      conditions: {},
      pipeline: [{
        id: "fixed",
        provider: "fixed",
        capability: "run",
        capabilityFingerprint: descriptor!.fingerprint,
        input: {},
      }],
      authorization: {
        capabilities: [{
          provider: descriptor!.provider,
          capability: descriptor!.id,
          fingerprint: descriptor!.fingerprint,
          risk: descriptor!.risk,
          limits: { allowedAccountId: "acct-mail-idempotency" },
        }],
      },
      capabilitySnapshots: [{
        provider: descriptor!.provider,
        capability: descriptor!.id,
        fingerprint: descriptor!.fingerprint,
        risk: descriptor!.risk,
        inputSchemaHash: "schema",
      }],
    });
    const service = new PipelineAutomationRuleService({
      db,
      rules,
      providers,
      stepRuns: new AutomationStepRunRepository(db),
      runtime: new AutomationRuleRuntimeRepository(db, now),
      now,
    });
    const mail = {
      id: "mail-1",
      accountId: "acct-mail-idempotency",
      subject: "预算确认",
    };

    await Promise.all([
      service.runForMailReceived("acct-mail-idempotency", mail),
      service.runForMailReceived("acct-mail-idempotency", mail),
    ]);
    await service.runForMailReceived("acct-mail-idempotency", mail);

    assert.equal(executions, 1);
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) FROM automation_rule_runs WHERE account_id = ?",
      ).pluck().get("acct-mail-idempotency"),
      1,
    );
    rules.createV2({ ...firstRule, name: "第二条规则" });
    db.prepare("UPDATE automation_rule_runs SET status = 'outcome_unknown' WHERE rule_id = ?").run(firstRule.id);
    await assert.rejects(service.runForMailReceived("acct-mail-idempotency", mail), /automation-mail-rules-failed/);
    assert.equal(executions, 2);
    db.prepare("UPDATE automation_rule_runs SET trigger_key = ?, rule_version = ? WHERE rule_id = ?")
      .run(`${firstRule.id}:${firstRule.version}:summary:acct-mail-idempotency:mail-1`, firstRule.version, firstRule.id);
    db.prepare("DELETE FROM automation_run_manifest_items WHERE run_id IN (SELECT id FROM automation_rule_runs WHERE rule_id = ?)").run(firstRule.id);
    assert.equal(service["hasSummaryNotificationRun"](firstRule.id, "acct-mail-idempotency", "mail-1"), true);
    db.prepare("UPDATE automation_rule_runs SET trigger_key = ? WHERE rule_id = ?")
      .run(`summary:${JSON.stringify(["acct-mail-idempotency", "mail-1"])}`, firstRule.id);
    assert.equal(service["hasSummaryNotificationRun"](firstRule.id, "acct-mail-idempotency", "mail-1"), true);
    assert.equal(service["hasSummaryNotificationRun"](firstRule.id, "acct-mail-idempotency", "mail-2"), false);
  } finally {
    db.close();
  }
});

test("safe retry executes only the failed step and preserves successful upstream work", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => "2026-07-30T12:00:00.000Z";
  try {
    const providers = new AutomationProviderRegistry();
    const counts = { prepare: 0, deliver: 0 };
    let deliverySucceeds = false;
    let deliveryThrows = false;
    const provider = retryProvider(counts, () => {
      if (deliveryThrows) throw new Error("provider-disconnected");
      return deliverySucceeds;
    });
    providers.register(provider);
    const descriptors = await provider.discover();
    const prepare = descriptors.find((item) => item.id === "prepare")!;
    const deliver = descriptors.find((item) => item.id === "deliver")!;
    const rules = new AutomationRuleRepository(db, now);
    const rule = rules.createV2({
      schemaVersion: 2,
      accountId: "acct-retry",
      name: "精确重试",
      enabled: true,
      trigger: { type: "manual" },
      conditions: {},
      pipeline: [
        {
          id: "prepare",
          provider: "retry-test",
          capability: "prepare",
          capabilityFingerprint: prepare.fingerprint,
          input: {},
        },
        {
          id: "deliver",
          provider: "retry-test",
          capability: "deliver",
          capabilityFingerprint: deliver.fingerprint,
          input: {
            value: {
              type: "path",
              from: "step",
              stepId: "prepare",
              path: "",
            },
          },
        },
        {
          id: "later",
          provider: "retry-test",
          capability: "prepare",
          capabilityFingerprint: prepare.fingerprint,
          input: {},
        },
      ],
      authorization: {
        capabilities: descriptors.map((descriptor) => ({
          provider: descriptor.provider,
          capability: descriptor.id,
          fingerprint: descriptor.fingerprint,
          risk: descriptor.risk,
        })),
      },
      capabilitySnapshots: descriptors.map((descriptor) => ({
        provider: descriptor.provider,
        capability: descriptor.id,
        fingerprint: descriptor.fingerprint,
        risk: descriptor.risk,
        inputSchemaHash: "schema",
      })),
    });
    const service = new PipelineAutomationRuleService({
      db,
      rules,
      providers,
      stepRuns: new AutomationStepRunRepository(db),
      runtime: new AutomationRuleRuntimeRepository(db, now),
      now,
    });
    const initial = await service.run(rule);
    assert.equal(initial.status, "partial");
    assert.deepEqual(counts, { prepare: 1, deliver: 1 });

    const wrongVersion = await service.retryFailedStep({
      rule: { ...rule, version: rule.version + 1 },
      runId: initial.runId,
      stepId: "deliver",
    });
    assert.equal(wrongVersion.ok, false);
    if (!wrongVersion.ok) assert.equal(wrongVersion.code, "rule-version-changed");
    assert.deepEqual(counts, { prepare: 1, deliver: 1 });

    deliverySucceeds = true;
    const request = { rule, runId: initial.runId, stepId: "deliver" };
    const attempts = await Promise.all([
      service.retryFailedStep(request),
      service.retryFailedStep(request),
    ]);
    assert.deepEqual(attempts.find((attempt) => attempt.ok), {
      ok: true,
      runId: initial.runId,
      stepId: "deliver",
      status: "succeeded",
    });
    assert.equal(attempts.filter((attempt) => !attempt.ok).length, 1);
    assert.deepEqual(counts, { prepare: 1, deliver: 2 });
    const detail = new AutomationRunObservabilityService(db, now).detail(initial.runId, { accountId: "acct-retry" });
    assert.equal(detail?.steps.filter((step) => step.stepId === "deliver").length, 1);
    assert.equal(detail?.steps.find((step) => step.stepId === "deliver")?.status, "succeeded");
    assert.deepEqual(detail?.recoveryActions, []);
    assert.equal(detail?.outcome, "partial");

    deliveryThrows = true;
    await assert.rejects(service.run(rule), /automation-run-outcome-unknown/);
    const interrupted = db.prepare("SELECT id, status FROM automation_rule_runs WHERE rule_id = ? ORDER BY rowid DESC LIMIT 1").get(rule.id) as { id: string; status: string };
    assert.equal(interrupted.status, "outcome_unknown");
    const interruptedDetail = new AutomationRunObservabilityService(db, now).detail(interrupted.id, { accountId: "acct-retry" });
    assert.equal(interruptedDetail?.steps.find((step) => step.stepId === "deliver")?.retrySafe, false);
  } finally {
    db.close();
  }
});

function countingProvider(onExecute: () => void): AutomationProvider {
  const base = {
    provider: "fixed",
    id: "run",
    version: "1",
    kind: "processor" as const,
    label: "固定执行",
    description: "固定执行",
    inputSchema: {},
    outputSchema: {},
    risk: "read" as const,
    sideEffects: [] as const,
    previewSupport: "full" as const,
    idempotency: "keyed" as const,
    discoveryConfidence: "declared" as const,
  };
  const descriptor: AutomationCapabilityDescriptor = {
    ...base,
    sideEffects: [],
    fingerprint: descriptorFingerprint({ ...base, sideEffects: [] }),
  };
  return {
    id: "fixed",
    version: "1",
    async discover() {
      return [descriptor];
    },
    async compile(_capability, step) {
      return { ...step, descriptor };
    },
    async validate() {
      return [];
    },
    async preview() {
      return {
        plannedOperation: "固定执行",
        resolvedInputSummary: {},
        warnings: [],
        sideEffects: [],
      };
    },
    async execute() {
      onExecute();
      return {
        status: "succeeded",
        output: { type: "scalar", value: "ok" },
        warnings: [],
        sideEffects: [],
        audit: {
          provider: "fixed",
          capability: "run",
          capabilityFingerprint: descriptor.fingerprint,
          startedAt: nowIso(),
          completedAt: nowIso(),
          durationMs: 0,
        },
      };
    },
    checkCompatibility(previous) {
      return previous === descriptor.fingerprint ? "identical" : "breaking";
    },
  };
}

function nowIso() {
  return "2026-07-29T13:00:00.000Z";
}

function retryProvider(
  counts: { prepare: number; deliver: number },
  deliverySucceeds: () => boolean,
): AutomationProvider {
  const makeDescriptor = (
    id: "prepare" | "deliver",
  ): AutomationCapabilityDescriptor => {
    const base = {
      provider: "retry-test",
      id,
      version: "1",
      kind: id === "deliver" ? ("sink" as const) : ("processor" as const),
      label: id,
      description: id,
      inputSchema: {},
      outputSchema: {},
      risk: "read" as const,
      sideEffects: [] as const,
      previewSupport: "full" as const,
      idempotency: "keyed" as const,
      discoveryConfidence: "declared" as const,
    };
    return {
      ...base,
      sideEffects: [],
      fingerprint: descriptorFingerprint({ ...base, sideEffects: [] }),
    };
  };
  const descriptors = [makeDescriptor("prepare"), makeDescriptor("deliver")];
  return {
    id: "retry-test",
    version: "1",
    async discover() {
      return descriptors;
    },
    async compile(capability, step) {
      return { ...step, descriptor: capability };
    },
    async validate() {
      return [];
    },
    async preview() {
      return {
        plannedOperation: "test",
        resolvedInputSummary: {},
        warnings: [],
        sideEffects: [],
      };
    },
    async execute(step) {
      const descriptor = step.descriptor;
      if (descriptor.id === "prepare") {
        counts.prepare += 1;
        return {
          status: "succeeded",
          output: { type: "scalar", value: "prepared" },
          warnings: [],
          sideEffects: [],
          audit: {
            provider: descriptor.provider,
            capability: descriptor.id,
            capabilityFingerprint: descriptor.fingerprint,
            startedAt: nowIso(),
            completedAt: nowIso(),
            durationMs: 0,
          },
        };
      }
      counts.deliver += 1;
      return {
        status: deliverySucceeds() ? "succeeded" : "failed",
        ...(deliverySucceeds()
          ? { output: { type: "scalar" as const, value: "delivered" } }
          : {
              error: {
                code: "timeout" as const,
                message: "temporary",
                retryable: true,
                retrySafe: true,
              },
            }),
        warnings: [],
        sideEffects: [],
        audit: {
          provider: descriptor.provider,
          capability: descriptor.id,
          capabilityFingerprint: descriptor.fingerprint,
          startedAt: nowIso(),
          completedAt: nowIso(),
          durationMs: 0,
        },
      };
    },
    checkCompatibility(previous, current) {
      return previous === current.fingerprint ? "identical" : "breaking";
    },
  };
}
