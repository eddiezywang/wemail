import assert from "node:assert/strict";
import test from "node:test";
import type {
  AutomationDetail,
  AutomationRunDetail,
  AutomationTemplateDefinition,
  SubscriptionInsightResult,
} from "./automationCenter.js";
import type { AutomationRule, AutomationRuleV2 } from "./automation.js";

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("automation center contracts serialize account and local-profile ownership", () => {
  const owners = [
    { type: "account" as const, accountId: "acct-1" },
    { type: "localProfile" as const, profileId: "default" as const },
  ];
  assert.deepEqual(roundTrip(owners), owners);
});

test("template definition keeps declarative pipeline and renderer bindings", () => {
  const template: AutomationTemplateDefinition = {
    schemaVersion: 1,
    id: "subscription-daily-insight",
    version: "1.0.0",
    scope: "builtin",
    protected: true,
    metadata: {
      fallbackLocale: "zh-CN",
      locales: {
        "zh-CN": { name: "邮箱速览", description: "整理有价值的订阅邮件" },
      },
    },
    configurationSchema: {
      type: "object",
      additionalProperties: false,
      properties: { localTime: { type: "string" } },
    },
    uiSchema: {
      version: 1,
      fields: [
        {
          path: "localTime",
          control: "time",
          label: "执行时间",
          section: "trigger",
          order: 1,
        },
      ],
    },
    pipelineBlueprint: {
      version: 1,
      steps: [
        {
          id: "collect",
          capabilityId: "mail.collect",
          input: {},
          onError: { policy: "stop", retries: 1 },
        },
      ],
      bindings: { "collect.timezone": { type: "resolvedTimezone" } },
    },
    resultSchemaId: "subscription-insight",
    resultSchemaVersion: 1,
    rendererId: "subscription-insight",
    rendererVersion: "1.0.0",
    defaultConfiguration: { localTime: "08:30" },
    contentHash: "hash-template",
  };
  assert.deepEqual(roundTrip(template), template);
  assert.equal("executor" in template, false);
});

test("unified detail can project legacy and pipeline rules without provider fields", () => {
  const v1: AutomationRule = {
    id: "rule-v1",
    accountId: "acct-1",
    name: "旧规则",
    enabled: true,
    trigger: { type: "manual" },
    conditions: {},
    actions: [{ type: "star" }],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
  const v2: AutomationRuleV2 = {
    schemaVersion: 2,
    id: "rule-v2",
    version: 1,
    accountId: "acct-1",
    name: "新规则",
    enabled: true,
    trigger: { type: "manual" },
    conditions: {},
    pipeline: [],
    authorization: { capabilities: [] },
    capabilitySnapshots: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
  const base = {
    version: 1,
    owner: { type: "account" as const, accountId: "acct-1" },
    accountScope: { type: "currentAccount" as const, accountId: "acct-1" },
    enabled: true,
    triggerSummary: "仅手动运行",
    workflowSummary: "处理邮件",
    deliverySummary: "无外部投递",
    health: "never_run" as const,
    stages: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    recentRuns: [],
    trigger: { type: "manual" as const },
    configuration: {},
  };
  const details: AutomationDetail[] = [
    { ...base, id: v1.id, schemaVersion: 1, name: v1.name, sourceRule: v1 },
    { ...base, id: v2.id, schemaVersion: 2, name: v2.name, sourceRule: v2 },
  ];
  const serialized = JSON.stringify(details);
  assert.equal(serialized.includes("\"provider\""), false);
  assert.deepEqual(roundTrip(details), details);
});

test("run detail serializes frozen manifest, partial delivery, and expiry", () => {
  const run: AutomationRunDetail = {
    id: "run-1",
    ruleId: "rule-1",
    ruleVersion: 2,
    owner: { type: "localProfile", profileId: "default" },
    accountScope: { type: "selectedAccounts", accountIds: ["acct-1", "acct-2"] },
    resolvedAccountIds: ["acct-1", "acct-2"],
    dryRun: false,
    outcome: "partial",
    startedAt: "2026-07-30T00:00:00.000Z",
    inputCount: 2,
    resultCount: 1,
    truncated: false,
    revision: 4,
    deliveries: [
      { destination: "message_center", status: "succeeded", outputId: "msg-1" },
      { destination: "wecom_bot", status: "failed", retrySafe: true },
    ],
    manifest: {
      version: 1,
      items: [
        {
          accountId: "acct-1",
          emailId: "mail-1",
          receivedAt: "2026-07-29T23:00:00.000Z",
          contentHash: "mail-hash",
          selectedReasons: ["list-id"],
        },
      ],
      accountCounts: {
        "acct-1": { scanned: 1, selected: 1, excluded: 0 },
      },
      globalLimit: 200,
      perAccountLimit: 100,
      truncated: false,
      frozenAt: "2026-07-30T00:00:00.000Z",
    },
    manifestAvailability: "available",
    resultAvailability: "available",
    capabilityFingerprints: ["mail.collect@1"],
    steps: [],
    recoveryActions: [
      {
        id: "retry-bot",
        type: "retry_delivery",
        label: "重试企业微信投递",
        runId: "run-1",
      },
    ],
    warnings: [],
  };
  assert.deepEqual(roundTrip(run), run);
});

test("subscription insight result requires account-qualified provenance", () => {
  const source = {
    type: "email" as const,
    accountId: "acct-1",
    emailId: "mail-1",
  };
  const result: SubscriptionInsightResult = {
    type: "subscriptionDailyInsight",
    schemaVersion: 1,
    window: {
      start: "2026-07-29T00:30:00.000Z",
      end: "2026-07-30T00:30:00.000Z",
      timezone: "Asia/Shanghai",
    },
    accountCount: 1,
    topHighlights: [
      { id: "h1", kind: "content", text: "产品更新", sourceEmails: [source] },
    ],
    curatedCategories: [],
    recommendedActions: [],
    keepSubscriptions: [],
    stats: {
      scanned: 10,
      selected: 1,
      excluded: 9,
      groups: 1,
      truncated: false,
      perAccount: {
        "acct-1": { scanned: 10, selected: 1, excluded: 9 },
      },
    },
  };
  assert.deepEqual(roundTrip(result), result);
  assert.equal(result.topHighlights[0]?.sourceEmails[0]?.accountId, "acct-1");
});
