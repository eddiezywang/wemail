import assert from "node:assert/strict";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { AutomationRuleRepository } from "./AutomationRuleRepository.js";
import {
  AutomationDeleteBlockedError,
  AutomationNotVisibleError,
  UnifiedAutomationQueryService,
} from "./UnifiedAutomationQueryService.js";

const now = "2026-07-30T12:00:00.000Z";

function harness() {
  const db = openOrCreateMailDatabase(":memory:");
  const rules = new AutomationRuleRepository(db, () => now);
  const service = new UnifiedAutomationQueryService(db, rules);
  return { db, rules, service };
}

test("unified automation query projects V1, V2, Agent rules and health without duplicates", () => {
  const { db, rules, service } = harness();
  try {
    const legacy = rules.create({
      accountId: "acct-1",
      name: "旧规则",
      enabled: false,
      trigger: { type: "manual" },
      conditions: {},
      actions: [{ type: "star" }],
    });
    const upgradeableLegacy = rules.create({
      accountId: "acct-1",
      name: "旧版邮件摘要",
      enabled: true,
      trigger: { type: "scheduled", intervalMinutes: 60 },
      conditions: { subjectKeyword: "日报" },
      processing: {
        mode: "collection",
        scope: { type: "rollingWindow", amount: 1, unit: "day" },
        processors: [{ type: "mailDigest" }],
      },
      actions: [
        {
          type: "publishApplicationMessage",
          title: "邮件摘要",
        },
      ],
    });
    const pipeline = rules.createV2({
      schemaVersion: 2,
      accountId: "acct-1",
      name: "Agent 创建的日报",
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
          id: "read",
          provider: "mail",
          capability: "search",
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
      dataSelectionRecipe: {
        version: 1,
        source: "mail",
        scope: { type: "calendar_day", timezone: "Asia/Shanghai" },
        filters: [],
        limits: { maxMessages: 100, maxAttachments: 20, maxBytes: 1000 },
      },
    });
    rules.create({
      accountId: "acct-hidden",
      name: "其他账号",
      trigger: { type: "manual" },
      conditions: {},
      actions: [{ type: "star" }],
    });
    db.prepare(`
      INSERT INTO automation_rule_runs (
        id, rule_id, account_id, dry_run, matched_count, applied_count,
        status, action_results_json, created_at, completed_at, run_revision,
        rule_version
      ) VALUES (?, ?, ?, 0, 12, 10, 'partial', '[]', ?, ?, 3, 1)
    `).run("run-1", pipeline.id, "acct-1", now, now);

    const result = service.list({
      accountId: "acct-1",
      profileId: "default",
    });
    assert.deepEqual(
      result.automations.map((item) => item.id).sort(),
      [legacy.id, upgradeableLegacy.id, pipeline.id].sort(),
    );
    assert.equal(new Set(result.automations.map((item) => item.id)).size, 3);
    assert.equal(
      result.automations.find((item) => item.id === legacy.id)?.health,
      "disabled",
    );
    assert.equal(
      result.automations.find((item) => item.id === pipeline.id)?.health,
      "needs_attention",
    );
    assert.deepEqual(
      result.automations.find((item) => item.id === upgradeableLegacy.id)
        ?.upgrade,
      {
        available: true,
        currentVersion: "V1",
        targetVersion: "V2",
        summary: [
          "转换为可预览、可评审、可回退的版本化工作流",
          "现有规则在最终确认前继续运行且不会被修改",
        ],
        requiresPreview: true,
      },
    );
    assert.equal(
      result.automations.find((item) => item.id === legacy.id)?.upgrade,
      undefined,
    );

    const detail = service.detail(pipeline.id, {
      accountId: "acct-1",
      profileId: "default",
    });
    assert.equal(detail.latestRun?.outcome, "partial");
    assert.equal(detail.owner.type, "localProfile");
    assert.equal(JSON.stringify(detail).includes("\"provider\""), false);
    assert.throws(
      () =>
        service.detail(legacy.id, {
          accountId: "acct-hidden",
          profileId: "default",
        }),
      AutomationNotVisibleError,
    );
  } finally {
    db.close();
  }
});

test("archive hides a rule while permanent deletion is reference-aware", () => {
  const { db, rules, service } = harness();
  try {
    const rule = rules.create({
      accountId: "acct-1",
      name: "可归档规则",
      trigger: { type: "manual" },
      conditions: {},
      actions: [{ type: "star" }],
    });
    const archived = service.archive(rule.id, { accountId: "acct-1" });
    assert.ok(archived.archivedAt);
    assert.equal(archived.enabled, false);
    assert.equal(rules.get(rule.id)?.enabled, false);
    assert.equal(service.list({ accountId: "acct-1" }).automations.length, 0);

    db.prepare(`
      INSERT INTO automation_rule_references (
        rule_id, reference_type, reference_id, created_at
      ) VALUES (?, 'application_message', 'message-1', ?)
    `).run(rule.id, now);
    assert.throws(
      () => service.deletePermanently(rule.id, { accountId: "acct-1" }),
      AutomationDeleteBlockedError,
    );
    db.prepare("DELETE FROM automation_rule_references WHERE rule_id = ?").run(
      rule.id,
    );
    service.deletePermanently(rule.id, { accountId: "acct-1" });
    assert.equal(rules.get(rule.id), null);
  } finally {
    db.close();
  }
});
