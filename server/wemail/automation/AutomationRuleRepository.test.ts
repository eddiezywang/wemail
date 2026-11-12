import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { AutomationRuleRepository } from "./AutomationRuleRepository.js";

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-rules-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1", email: "a@example.com" });
  return {
    db,
    rules: new AutomationRuleRepository(db, () => "2026-06-26T00:00:00.000Z"),
  };
}

test("AutomationRuleRepository persists trigger and natural-language condition", () => {
  const { rules } = makeRepo();
  const rule = rules.create({
    accountId: "acct-1",
    name: "Boss urgent",
    trigger: { type: "mailReceived" },
    naturalLanguageCondition: "Needs a reply today",
    conditions: { sender: "boss@example.com" },
    actions: [{ type: "markRead" }],
  });

  const saved = rules.get(rule.id);

  assert.deepEqual(saved?.trigger, { type: "mailReceived" });
  assert.equal(saved?.naturalLanguageCondition, "Needs a reply today");
});

test("AutomationRuleRepository defaults legacy rows to manual trigger", () => {
  const { db, rules } = makeRepo();
  db.prepare(
    `INSERT INTO automation_rules (
      id, account_id, name, enabled, conditions_json, actions_json, created_at, updated_at
    ) VALUES (
      'rule-legacy', 'acct-1', 'Legacy', 1, '{}', '[{"type":"markRead"}]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )`,
  ).run();

  const rule = rules.get("rule-legacy");

  assert.deepEqual(rule?.trigger, { type: "manual" });
  assert.equal(rule?.naturalLanguageCondition, undefined);
});

test("AutomationRuleRepository persists condition rules", () => {
  const { rules } = makeRepo();
  const rule = rules.create({
    accountId: "acct-1",
    name: "Flexible filter",
    trigger: { type: "mailReceived" },
    conditions: {},
    conditionMode: "any",
    conditionRules: [
      {
        id: "rule-row-1",
        field: "sender",
        operator: "contains",
        value: "github.com",
      },
    ],
    actions: [{ type: "star" }],
  });

  const saved = rules.get(rule.id);
  const listed = rules.list("acct-1").find((item) => item.id === rule.id);

  assert.equal(saved?.conditionMode, "any");
  assert.deepEqual(saved?.conditionRules, [
    {
      id: "rule-row-1",
      field: "sender",
      operator: "contains",
      value: "github.com",
    },
  ]);
  assert.equal(listed?.conditionMode, "any");
  assert.deepEqual(listed?.conditionRules, saved?.conditionRules);
});

test("AutomationRuleRepository logs trigger execution details", () => {
  const { db, rules } = makeRepo();
  const rule = rules.create({
    accountId: "acct-1",
    name: "Incoming",
    trigger: { type: "mailReceived" },
    conditions: { sender: "boss@example.com" },
    actions: [{ type: "star" }],
  });

  rules.logRun({
    ruleId: rule.id,
    accountId: "acct-1",
    dryRun: false,
    matchedCount: 1,
    appliedCount: 1,
    triggerKind: "mailReceived",
    triggerKey: "mailReceived:m-1",
    status: "applied",
    actionResults: [{ type: "star", status: "applied", emailId: "m-1" }],
  });

  const row = db
    .prepare(
      "SELECT trigger_kind, trigger_key, status, action_results_json FROM automation_rule_runs WHERE rule_id = ?",
    )
    .get(rule.id) as {
    trigger_kind: string;
    trigger_key: string;
    status: string;
    action_results_json: string;
  };

  assert.equal(row.trigger_kind, "mailReceived");
  assert.equal(row.trigger_key, "mailReceived:m-1");
  assert.equal(row.status, "applied");
  assert.deepEqual(JSON.parse(row.action_results_json), [
    { type: "star", status: "applied", emailId: "m-1" },
  ]);
});

test("AutomationRuleRepository ignores duplicate durable trigger logs", () => {
  const { db, rules } = makeRepo();
  const rule = rules.create({
    accountId: "acct-1",
    name: "Incoming",
    trigger: { type: "mailReceived" },
    conditions: {},
    actions: [{ type: "star" }],
  });
  const input = {
    ruleId: rule.id,
    accountId: "acct-1",
    dryRun: false,
    matchedCount: 1,
    appliedCount: 0,
    triggerKind: "mailReceived",
    triggerKey: "mailReceived:m-duplicate",
    status: "matched" as const,
    actionResults: [{ status: "scheduled" }],
  };

  assert.doesNotThrow(() => {
    rules.logRun(input);
    rules.logRun(input);
  });
  const row = db.prepare(
    `SELECT COUNT(*) AS count
     FROM automation_rule_runs
     WHERE rule_id = ? AND trigger_key = ?`,
  ).get(rule.id, input.triggerKey) as { count: number };
  assert.equal(row.count, 1);
});

test("AutomationRuleRepository excludes archived V2 rules from runtime listings", () => {
  const { db, rules } = makeRepo();
  const rule = rules.createV2({
    schemaVersion: 2,
    accountId: "acct-1",
    name: "Archived pipeline",
    enabled: true,
    trigger: { type: "mailReceived" },
    conditions: {},
    pipeline: [],
    authorization: { capabilities: [] },
    capabilitySnapshots: [],
  });

  db.prepare("UPDATE automation_rules SET archived_at = ? WHERE id = ?")
    .run("2026-06-26T01:00:00.000Z", rule.id);

  assert.equal(rules.getV2(rule.id)?.archivedAt, "2026-06-26T01:00:00.000Z");
  assert.deepEqual(rules.listV2("acct-1"), []);
});

test("AutomationRuleRepository persists compiled Skill and recipe snapshots for V2 rules", () => {
  const { rules } = makeRepo();
  const saved = rules.createV2({
    schemaVersion: 2,
    accountId: "acct-1",
    name: "Daily monitoring report",
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
    skillSnapshots: [
      {
        skillId: "builtin:wemail/artifact-review",
        version: "1.0.0",
        contentHash: "skill-hash",
        scope: "builtin",
      },
    ],
    dataSelectionRecipe: {
      version: 1,
      source: "mail",
      scope: { type: "calendar_day", timezone: "Asia/Shanghai" },
      filters: [
        {
          field: "category",
          operator: "in",
          value: ["monitoring-alert", "execution-report"],
        },
      ],
      limits: { maxMessages: 500 },
    },
    analysisRecipe: {
      version: 2,
      inputKinds: ["mail-collection"],
      dimensions: [{ id: "hour", field: "receivedHour" }],
      metrics: [
        {
          id: "requestCount",
          label: "调用量",
          aggregation: "sum",
          field: "count",
        },
      ],
      modelTasks: [],
      conclusions: [],
      outputSchema: { type: "dataset" },
    },
    artifactRecipe: {
      version: 2,
      format: "html",
      title: "银行电销会话分析平台日报",
      components: [
        {
          id: "requests",
          type: "line_chart",
          binding: { x: "hour", y: "requestCount" },
        },
      ],
      layout: { structure: "overview-to-detail", sections: ["requests"] },
      theme: { name: "monitoring" },
      accessibility: {
        includeTextSummary: true,
        chartDescriptions: true,
      },
      emptyState: "当日暂无数据",
      errorState: "报告生成失败",
      outputSchema: { type: "artifact-reference" },
    },
    deliveryPlan: {
      version: 1,
      destinations: [
        { type: "message_center", enabled: true },
        { type: "connected_bot", enabled: true },
      ],
      content: {
        includeSummary: true,
        includeImage: false,
        includeArtifactLink: true,
      },
      fallbackPolicy: {
        type: "first_available",
        priority: ["feishu_bot", "wecom_bot"],
        messageCenterRequired: true,
      },
    },
    acceptedReviews: [
      {
        checkpointId: "artifact-review-1",
        target: "artifact",
        targetVersion: 2,
        contentHash: "artifact-hash",
      },
    ],
    compiledPipelineHash: "pipeline-hash",
  });

  const reloaded = rules.getV2(saved.id);
  assert.deepEqual(reloaded?.skillSnapshots, saved.skillSnapshots);
  assert.deepEqual(reloaded?.dataSelectionRecipe, saved.dataSelectionRecipe);
  assert.deepEqual(reloaded?.analysisRecipe, saved.analysisRecipe);
  assert.deepEqual(reloaded?.artifactRecipe, saved.artifactRecipe);
  assert.deepEqual(reloaded?.deliveryPlan, saved.deliveryPlan);
  assert.deepEqual(reloaded?.acceptedReviews, saved.acceptedReviews);
  assert.equal(reloaded?.compiledPipelineHash, "pipeline-hash");
});
