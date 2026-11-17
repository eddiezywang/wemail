import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { AgentCapabilityCatalogService } from "../workflows/AgentCapabilityCatalogService.js";
import { ExecutionPipelineDraftRepository } from "../workflows/ExecutionPipelineDraftRepository.js";
import { ExecutionPipelineService } from "../workflows/ExecutionPipelineService.js";
import { AutomationProviderRegistry } from "./providers/AutomationProviderRegistry.js";
import { AutomationRuleRepository } from "./AutomationRuleRepository.js";
import { CanonicalAutomationDraftService } from "./CanonicalAutomationDraftService.js";

const now = "2026-07-30T12:00:00.000Z";

function harness(editionProcessorCapabilities?: Readonly<Record<string, string>>) {
  const db = openOrCreateMailDatabase(":memory:");
  insertCanonicalTestAccount(db, { id: "acct-1", email: "owner@example.test" });
  const rules = new AutomationRuleRepository(db, () => now);
  const providers = new AutomationProviderRegistry();
  const catalog = new AgentCapabilityCatalogService(providers, []);
  const pipeline = new ExecutionPipelineService(catalog, providers, () => now);
  const drafts = new ExecutionPipelineDraftRepository(db);
  const service = new CanonicalAutomationDraftService(
    drafts,
    rules,
    catalog,
    pipeline,
    () => now,
    editionProcessorCapabilities,
  );
  return { db, rules, drafts, service };
}

test("legacy edition processors are preserved in upgrade drafts or rejected", async () => {
  for (const enabled of [false, true]) {
    const { db, rules, service } = harness(enabled ? { invoiceReadinessAnalysis: "analysis.invoiceReadiness" } : undefined);
    try {
      const rule = rules.create({
        accountId: "acct-1",
        name: "旧版发票规则",
        trigger: { type: "manual" },
        conditions: {},
        processing: {
          mode: "collection",
          scope: { type: "rollingWindow", amount: 1, unit: "day" },
          processors: [{ type: "invoiceReadinessAnalysis" }],
        },
        actions: [{ type: "publishApplicationMessage", title: "发票" }],
      });
      const request = { ruleId: rule.id, accountId: "acct-1" };
      if (!enabled) {
        await assert.rejects(service.resumeFromRule(request), /legacy-processor-upgrade-not-supported/);
      } else {
        const { draft } = await service.resumeFromRule(request);
        assert.ok(draft.steps.some((step) => step.capabilityId === "analysis.invoiceReadiness"));
      }
    } finally {
      db.close();
    }
  }
});

test("unsupported legacy data-selection conditions cannot be silently discarded", async () => {
  const { db, rules, service } = harness();
  try {
    const rule = rules.create({
      accountId: "acct-1", name: "带标签的旧规则", trigger: { type: "manual" },
      conditions: { aiTag: "important" },
      processing: { mode: "collection", scope: { type: "rollingWindow", amount: 1, unit: "day" }, processors: [{ type: "mailDigest" }] },
      actions: [{ type: "publishApplicationMessage", title: "摘要" }],
    });
    await assert.rejects(service.resumeFromRule({ ruleId: rule.id, accountId: "acct-1" }), /legacy-data-selection-upgrade-not-supported/);
  } finally {
    db.close();
  }
});

test("structured and Agent editing resume the same V2 draft with optimistic conflicts", async () => {
  const { db, rules, service } = harness();
  try {
    const rule = rules.createV2({
      schemaVersion: 2,
      accountId: "acct-1",
      name: "共享草稿",
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
      pipeline: [],
      authorization: { capabilities: [] },
      capabilitySnapshots: [],
      owner: { type: "localProfile", profileId: "default" },
      accountScope: {
        type: "selectedAccounts",
        accountIds: ["acct-1", "acct-2"],
      },
    });
    const structured = await service.resumeFromRule({
      ruleId: rule.id,
      accountId: "acct-1",
    });
    const agent = await service.resumeFromRule({
      ruleId: rule.id,
      accountId: "acct-1",
      sessionId: "agent-session",
    });
    assert.equal(structured.resumed, false);
    assert.equal(agent.resumed, true);
    assert.equal(agent.draft.id, structured.draft.id);

    const updated = await service.patch({
      draftId: structured.draft.id,
      accountId: "acct-1",
      patch: {
        expectedRevision: 1,
        accountScope: {
          type: "selectedAccounts",
          accountIds: ["acct-1"],
        },
        advancedPolicy: { catchUp: "latest_only" },
      },
    });
    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.accountScope, {
      type: "selectedAccounts",
      accountIds: ["acct-1"],
    });
    await assert.rejects(
      service.patch({
        draftId: structured.draft.id,
        accountId: "acct-1",
        patch: {
          expectedRevision: 1,
          advancedPolicy: { retentionDays: 30 },
        },
      }),
      (error: unknown) => {
        const value = error as {
          message?: string;
          summary?: { currentRevision?: number; changedSections?: string[] };
        };
        assert.equal(value.message, "pipeline-draft-revision-conflict");
        assert.equal(value.summary?.currentRevision, 2);
        assert.ok((value.summary?.changedSections?.length ?? 0) <= 8);
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test("material edits to a V1 rule create an upgrade draft without mutating legacy storage", async () => {
  const { db, rules, service } = harness();
  try {
    const legacy = rules.create({
      accountId: "acct-1",
      name: "旧版摘要",
      trigger: {
        type: "scheduled",
        schedule: {
          type: "daily",
          localTime: "09:00",
          timezone: "Asia/Shanghai",
        },
      },
      conditions: { sender: "alerts@example.com", subjectKeyword: "日报", hasAttachment: true },
      processing: {
        mode: "collection",
        scope: {
          type: "rollingWindow",
          amount: 1,
          unit: "day",
          limit: 100,
        },
        processors: [{ type: "mailDigest" }],
      },
      actions: [
        {
          type: "publishApplicationMessage",
          title: "摘要",
        },
      ],
    });
    const result = await service.resumeFromRule({
      ruleId: legacy.id,
      accountId: "acct-1",
    });
    assert.equal(result.upgrade, true);
    assert.equal(result.draft.sourceRuleVersion, 1);
    assert.equal(result.draft.mode, "automation");
    assert.equal(result.draft.steps.find((step) => step.capabilityId === "delivery.messageCenter.publish")?.input.title, "摘要");
    assert.deepEqual(result.draft.dataSelection?.filters, [
      { field: "sender", operator: "contains", value: "alerts@example.com" },
      { field: "subject", operator: "contains", value: "日报" },
      { field: "hasAttachment", operator: "equals", value: true },
    ]);
    assert.equal(result.draft.advancedPolicy?.upgradeFromLegacy, true);
    assert.equal(rules.get(legacy.id)?.name, "旧版摘要");
    assert.equal(rules.getV2(legacy.id), null);
  } finally {
    db.close();
  }
});

test("legacy bot delivery cannot be silently redirected during upgrade", async () => {
  const { db, rules, service } = harness();
  try {
    const rule = rules.create({
      accountId: "acct-1", name: "Bot 规则", trigger: { type: "manual" }, conditions: {},
      processing: { mode: "collection", scope: { type: "rollingWindow", amount: 1, unit: "day" }, processors: [{ type: "mailDigest" }] },
      actions: [{ type: "publishBotMessage", botProfileId: "bot-1", destination: { type: "conversation", destinationId: "conversation-1" } }],
    });
    await assert.rejects(service.resumeFromRule({ ruleId: rule.id, accountId: "acct-1" }), /legacy-actions-upgrade-not-supported/);
  } finally {
    db.close();
  }
});

test("confirmed V2 replacement keeps one rule identity and appends an immutable version", () => {
  const { db, rules } = harness();
  try {
    const rule = rules.createV2({
      schemaVersion: 2,
      accountId: "acct-1",
      name: "原名称",
      enabled: true,
      trigger: { type: "manual" },
      conditions: {},
      pipeline: [],
      authorization: { capabilities: [] },
      capabilitySnapshots: [],
    });
    const updated = rules.replaceV2(
      rule.id,
      {
        ...rule,
        name: "新名称",
      },
      1,
    );
    assert.equal(updated.id, rule.id);
    assert.equal(updated.version, 2);
    assert.equal(rules.listV2("acct-1").length, 1);
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM automation_rule_versions WHERE rule_id = ?",
          )
          .get(rule.id) as { count: number }
      ).count,
      2,
    );
  } finally {
    db.close();
  }
});
