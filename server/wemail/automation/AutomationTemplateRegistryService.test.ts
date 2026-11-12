import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AutomationTemplateDefinition } from "../../../shared/wemail/automationCenter.js";
import type { AgentCapabilityDescriptor } from "../../../shared/wemail/skillCenter.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { AgentCapabilityCatalogService } from "../workflows/AgentCapabilityCatalogService.js";
import { ExecutionPipelineDraftRepository } from "../workflows/ExecutionPipelineDraftRepository.js";
import { ExecutionPipelineService } from "../workflows/ExecutionPipelineService.js";
import { AutomationProviderRegistry } from "./providers/AutomationProviderRegistry.js";
import type { PipelineAutomationRuleService } from "./PipelineAutomationRuleService.js";
import { AutomationRuleRepository } from "./AutomationRuleRepository.js";
import {
  AutomationTemplateRegistryService,
  definitionHash,
  resolveAutomationTemplateRegistryPaths,
} from "./AutomationTemplateRegistryService.js";

const now = "2026-07-30T12:00:00.000Z";

function harness() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "wemail-template-registry-"),
  );
  const db = openOrCreateMailDatabase(path.join(root, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1", email: "owner@example.test" });
  const providers = new AutomationProviderRegistry();
  const catalog = new AgentCapabilityCatalogService(providers, []);
  const pipeline = new ExecutionPipelineService(catalog, providers, () => now);
  const rules = new AutomationRuleRepository(db, () => now);
  const drafts = new ExecutionPipelineDraftRepository(db);
  const service = new AutomationTemplateRegistryService({
    db,
    paths: resolveAutomationTemplateRegistryPaths({
      repositoryRoot: process.cwd(),
      userDataDir: root,
    }),
    drafts,
    rules,
    catalog,
    pipeline,
    now: () => now,
  });
  return { root, db, rules, drafts, pipeline, catalog, service };
}

test("adding a template creates one enabled configured automation", async () => {
  const { root, db, rules, pipeline, service } = harness();
  try {
    await service.synchronize();
    const definition = service.inspect("subscription-daily-insight")!;
    const preview = await service.previewInstantiation({
      templateId: definition.id,
      accountId: "acct-1",
      configuration: definition.defaultConfiguration,
    });
    pipeline.compile = async () => ({
      trigger: { type: "manual" },
      pipeline: [],
      hash: "compiled-template",
    });
    let normalized:
      | Parameters<PipelineAutomationRuleService["preview"]>[0]
      | undefined;
    const ruleService = {
      preview: async (
        draft: Parameters<PipelineAutomationRuleService["preview"]>[0],
      ) => {
        normalized = draft;
        return {
          previewId: "rule-preview-1",
          ruleHash: "rule-hash-1",
        };
      },
      commit: async () => {
        assert.ok(normalized);
        return rules.createV2({
          ...normalized,
          authorization: { capabilities: [] },
          capabilitySnapshots: [],
        });
      },
    } as unknown as PipelineAutomationRuleService;

    const rule = await service.instantiate({
      accountId: "acct-1",
      previewId: preview.previewId,
      previewHash: preview.previewHash,
      ruleService,
    });

    assert.equal(rule.enabled, true);
    assert.equal(rule.name, "邮箱速览");
    assert.equal(rule.templateBinding?.templateId, definition.id);
    await assert.rejects(
      service.instantiate({
        accountId: "acct-1",
        previewId: preview.previewId,
        previewHash: preview.previewHash,
        ruleService,
      }),
      /automation-template-already-added/,
    );
  } finally {
    db.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("registry discovers immutable built-ins and instantiates a canonical draft by exact preview hash", async () => {
  const { root, db, drafts, service } = harness();
  try {
    await service.synchronize();
    const templates = await service.list("zh-CN", "acct-1");
    assert.ok(templates.some((item) => item.id === "wemail.mail-digest"));
    assert.ok(
      templates.some(
        (item) =>
          item.id === "subscription-daily-insight" &&
          item.name === "邮箱速览" &&
          item.defaultTiming?.includes("09:00"),
      ),
    );
    const insightDefinition = service.inspect("subscription-daily-insight");
    assert.ok(insightDefinition);
    assert.equal(insightDefinition.version, "1.3.0");
    assert.equal(
      definitionHash(insightDefinition),
      insightDefinition.contentHash,
    );
    assert.equal(
      insightDefinition.defaultConfiguration.dataWindowMode,
      "boundedPreviousRun",
    );
    assert.equal(insightDefinition.defaultConfiguration.windowHours, 24);
    const botPreview = await service.previewInstantiation({
      templateId: insightDefinition.id,
      accountId: "acct-1",
      configuration: {
        ...insightDefinition.defaultConfiguration,
        delivery: {
          destinations: [
            { type: "message_center", enabled: true },
            { type: "connected_bot", enabled: true },
          ],
        },
      },
    });
    assert.deepEqual(botPreview.draft.dataSelection?.scope, {
      type: "previous_schedule_window",
      maxLookback: { amount: 24, unit: "hour" },
    });
    assert.equal(
      botPreview.draft.steps.some(
        (step) =>
          step.capabilityId === "delivery.bot.sendConnected" &&
          (step.input.notificationPolicy as { value?: string })?.value ===
            "risk_or_actionable",
      ),
      false,
      "an optional Bot destination must not block template creation when no Bot is connected",
    );
    assert.equal(
      botPreview.draft.delivery?.destinations.find(
        (destination) => destination.type === "connected_bot",
      )?.enabled,
      false,
    );
    const definition = service.inspect("wemail.mail-digest");
    assert.ok(definition);
    assert.equal(definitionHash(definition), definition.contentHash);

    const preview = await service.previewInstantiation({
      templateId: definition.id,
      accountId: "acct-1",
      configuration: {
        localTime: "21:00",
        timezone: "Asia/Shanghai",
        accountScope: { type: "currentAccount" },
        delivery: {
          destinations: [{ type: "message_center", enabled: true }],
        },
        maxMessages: 100,
      },
    });
    assert.equal(preview.draft.templateBinding?.templateId, definition.id);
    assert.equal(preview.draft.trigger?.event, "schedule");
    assert.throws(
      () =>
        service.confirmInstantiation({
          accountId: "acct-1",
          previewId: preview.previewId,
          previewHash: "changed",
        }),
      /hash-mismatch/,
    );
    const draft = service.confirmInstantiation({
      accountId: "acct-1",
      previewId: preview.previewId,
      previewHash: preview.previewHash,
    });
    assert.equal(drafts.get(draft.id, "acct-1")?.id, draft.id);
  } finally {
    db.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("received-mail notification falls back to message center when no Bot is connected", async () => {
  const { root, db, rules, catalog, service } = harness();
  try {
    catalog.list = async () => [
      {
        id: "delivery.messageCenter.publish",
        category: "delivery",
        name: "推送应用消息",
        description: "发布到消息中心",
        inputSchema: {},
        outputSchema: { automationValue: "scalar" },
        inputKinds: ["analysis-result", "artifact-reference"],
        outputKinds: ["delivery-receipt"],
        availability: { state: "ready" },
        risk: "local_write",
        previewSupport: "full",
        idempotency: "keyed",
        version: "1",
        fingerprint: "message-center-fingerprint",
        executorKey: "application-message/publish",
      },
      {
        id: "delivery.bot.sendConnected",
        category: "delivery",
        name: "发送到已连接 Bot",
        description: "发送到飞书或企业微信 Bot",
        inputSchema: {},
        outputSchema: { automationValue: "scalar" },
        inputKinds: ["analysis-result"],
        outputKinds: ["delivery-receipt"],
        availability: {
          state: "not_connected",
          reason: "当前没有已连接且可投递的飞书或企业微信 Bot。",
        },
        risk: "external_side_effect",
        previewSupport: "plan_only",
        idempotency: "keyed",
        version: "0",
        fingerprint: "bot-not-connected-fingerprint",
        executorKey: "bot-message/publish-connected",
      },
    ] as AgentCapabilityDescriptor[];

    await service.synchronize();
    const summary = (await service.list("zh-CN", "acct-1")).find(
      (item) => item.id === "wemail.received-mail-summary-notification",
    );
    assert.equal(summary?.readiness, "ready");
    // Ready via message-center fallback still surfaces why the Bot delivery
    // step is unavailable, so users know the notification lands in-app.
    assert.equal(
      summary?.readinessMessage,
      "当前没有已连接且可投递的飞书或企业微信 Bot。",
    );

    const definition = service.inspect(
      "wemail.received-mail-summary-notification",
    )!;
    const preview = await service.previewInstantiation({
      templateId: definition.id,
      accountId: "acct-1",
      configuration: definition.defaultConfiguration,
    });
    assert.equal(preview.draft.validation.status, "valid");
    assert.deepEqual(
      preview.draft.steps.map((step) => step.capabilityId),
      ["delivery.messageCenter.publish"],
    );
    assert.deepEqual(preview.draft.delivery?.destinations, [
      { type: "connected_bot", enabled: false },
      { type: "message_center", enabled: true },
    ]);

    let normalized:
      | Parameters<PipelineAutomationRuleService["preview"]>[0]
      | undefined;
    const ruleService = {
      preview: async (
        draft: Parameters<PipelineAutomationRuleService["preview"]>[0],
      ) => {
        normalized = draft;
        return { previewId: "rule-preview-fallback", ruleHash: "rule-hash-fallback" };
      },
      commit: async () => {
        assert.ok(normalized);
        return rules.createV2({
          ...normalized,
          authorization: { capabilities: [] },
          capabilitySnapshots: [],
        });
      },
    } as unknown as PipelineAutomationRuleService;
    const rule = await service.instantiate({
      accountId: "acct-1",
      previewId: preview.previewId,
      previewHash: preview.previewHash,
      ruleService,
    });
    assert.equal(rule.pipeline[0]?.provider, "application-message");
    assert.equal(rule.deliveryPlan?.destinations[1]?.type, "message_center");
  } finally {
    db.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("personal templates are sanitized, cannot shadow protected IDs, and reject executable UI", async () => {
  const { root, db, service } = harness();
  try {
    await service.synchronize();
    const builtin = service.inspect("wemail.mail-digest")!;
    const personal: AutomationTemplateDefinition = {
      ...builtin,
      id: "personal.focus-digest",
      scope: "personal",
      protected: false,
      version: "1.0.0",
      contentHash: "",
    };
    personal.contentHash = definitionHash(personal);
    service.installPersonal(personal);
    assert.equal(
      service.inspect("personal.focus-digest")?.scope,
      "personal",
    );

    const shadow = {
      ...builtin,
      scope: "personal" as const,
      contentHash: "",
    };
    shadow.contentHash = definitionHash(shadow);
    assert.throws(
      () => service.installPersonal(shadow),
      /protected-id/,
    );

    const executable: AutomationTemplateDefinition = {
      ...personal,
      id: "personal.executable",
      uiSchema: {
        version: 1,
        fields: [
          {
            path: "rawHtml",
            control: "text",
            label: "HTML",
            section: "advanced",
            order: 1,
          },
        ],
      },
      configurationSchema: {
        type: "object",
        properties: { rawHtml: { type: "string" } },
      },
      contentHash: "",
    };
    executable.contentHash = definitionHash(executable);
    assert.throws(
      () => service.installPersonal(executable),
      /ui-schema-invalid/,
    );
  } finally {
    db.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("registry detects on-disk tampering and supports explicit rule rollback", async () => {
  const { root, db, rules, service } = harness();
  try {
    await service.synchronize();
    const definition = service.inspect("wemail.mail-digest")!;
    const rule = rules.createV2({
      schemaVersion: 2,
      accountId: "acct-1",
      name: "模板规则",
      enabled: true,
      trigger: { type: "manual" },
      conditions: {},
      pipeline: [],
      authorization: { capabilities: [] },
      capabilitySnapshots: [],
      templateBinding: {
        templateId: definition.id,
        templateVersion: definition.version,
        templateHash: definition.contentHash,
        resultSchemaId: definition.resultSchemaId,
        resultSchemaVersion: definition.resultSchemaVersion,
        rendererId: definition.rendererId,
        rendererVersion: definition.rendererVersion,
        configuration: {},
      },
    });
    rules.replaceV2(
      rule.id,
      { ...rule, name: "第二版" },
      rule.version,
    );
    const rolledBack = service.rollbackRule(rule.id, 1);
    assert.equal(rolledBack.version, 3);
    assert.equal(rolledBack.name, "模板规则");

    const tamperedRoot = path.join(root, "tampered");
    const target = path.join(tamperedRoot, "mail", "1.0.0");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, "template.json"),
      JSON.stringify({ ...definition, rendererVersion: "tampered" }),
      "utf8",
    );
    const providers = new AutomationProviderRegistry();
    const catalog = new AgentCapabilityCatalogService(providers, []);
    const tampered = new AutomationTemplateRegistryService({
      db,
      paths: {
        builtinRoot: tamperedRoot,
        personalRoot: path.join(root, "personal-tampered"),
      },
      drafts: new ExecutionPipelineDraftRepository(db),
      rules,
      catalog,
      pipeline: new ExecutionPipelineService(catalog, providers, () => now),
      now: () => now,
    });
    await assert.rejects(tampered.synchronize(), /content-hash-mismatch/);
  } finally {
    db.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("application synchronization activates the newest immutable version and exposes an explicit upgrade", async () => {
  const { root, db, rules } = harness();
  try {
    const source = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          "automation-templates",
          "builtin",
          "mail-digest",
          "1.0.0",
          "template.json",
        ),
        "utf8",
      ),
    ) as AutomationTemplateDefinition;
    const builtinRoot = path.join(root, "upgrade-builtins");
    for (const version of ["1.2.0", "1.10.0"]) {
      const definition = {
        ...source,
        version,
        rendererVersion: version,
        contentHash: "",
      };
      definition.contentHash = definitionHash(definition);
      const directory = path.join(builtinRoot, "mail-digest", version);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "template.json"),
        JSON.stringify(definition),
        "utf8",
      );
    }
    const providers = new AutomationProviderRegistry();
    const catalog = new AgentCapabilityCatalogService(providers, []);
    const service = new AutomationTemplateRegistryService({
      db,
      paths: {
        builtinRoot,
        personalRoot: path.join(root, "upgrade-personal"),
      },
      drafts: new ExecutionPipelineDraftRepository(db),
      rules,
      catalog,
      pipeline: new ExecutionPipelineService(catalog, providers, () => now),
      now: () => now,
    });
    await service.synchronize();
    assert.equal(service.inspect(source.id)?.version, "1.10.0");
    const old = service.inspect(source.id, "1.2.0")!;
    const rule = rules.createV2({
      schemaVersion: 2,
      accountId: "acct-1",
      name: "待升级",
      enabled: true,
      trigger: { type: "manual" },
      conditions: {},
      pipeline: [],
      authorization: { capabilities: [] },
      capabilitySnapshots: [],
      templateBinding: {
        templateId: old.id,
        templateVersion: old.version,
        templateHash: old.contentHash,
        resultSchemaId: old.resultSchemaId,
        resultSchemaVersion: old.resultSchemaVersion,
        rendererId: old.rendererId,
        rendererVersion: old.rendererVersion,
        configuration: {},
      },
    });
    assert.deepEqual(service.upgradeFor(rule), {
      available: true,
      currentVersion: "1.2.0",
      targetVersion: "1.10.0",
      targetHash: service.inspect(source.id)?.contentHash,
      summary: ["结果展示方式发生变化"],
      requiresPreview: true,
    });
    const preview = await service.previewUpgrade({
      ruleId: rule.id,
      accountId: "acct-1",
    });
    assert.equal(preview.draft.sourceRuleId, rule.id);
    assert.equal(preview.draft.sourceRuleVersion, rule.version);
    assert.equal(
      preview.draft.templateBinding?.templateVersion,
      "1.10.0",
    );
    assert.equal(rules.getV2(rule.id)?.version, 1);
    const upgradeDraft = service.confirmInstantiation({
      accountId: "acct-1",
      previewId: preview.previewId,
      previewHash: preview.previewHash,
    });
    assert.equal(upgradeDraft.sourceRuleId, rule.id);
    assert.deepEqual(service.listRuleVersions(rule.id), [
      {
        version: 1,
        templateVersion: "1.2.0",
        createdAt: now,
        current: true,
      },
    ]);
  } finally {
    db.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
});
