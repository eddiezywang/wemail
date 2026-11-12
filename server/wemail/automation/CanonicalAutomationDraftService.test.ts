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

function harness() {
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
  );
  return { db, rules, drafts, service };
}

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
      conditions: { sender: "alerts@example.com" },
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
    assert.equal(result.draft.advancedPolicy?.upgradeFromLegacy, true);
    assert.equal(rules.get(legacy.id)?.name, "旧版摘要");
    assert.equal(rules.getV2(legacy.id), null);
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
