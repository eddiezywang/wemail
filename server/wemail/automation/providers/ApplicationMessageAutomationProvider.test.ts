import assert from "node:assert/strict";
import test from "node:test";
import type { SubscriptionInsightResult } from "../../../../shared/wemail/automationCenter.js";
import { ApplicationMessageRepository } from "../../applicationMessages/ApplicationMessageRepository.js";
import { openOrCreateMailDatabase } from "../../database/Database.js";
import { MessageArtifactRepository } from "../../design/MessageArtifactRepository.js";
import { ApplicationMessageAutomationProvider } from "./ApplicationMessageAutomationProvider.js";

const now = "2026-07-30T13:00:00.000Z";

test("application-message provider publishes one local-profile 邮箱速览 with account-qualified sources", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    const messages = new ApplicationMessageRepository(db, () => now);
    const attention: Array<Record<string, unknown>> = [];
    const provider = new ApplicationMessageAutomationProvider(
      messages,
      new MessageArtifactRepository(db, ".", () => now),
      (event) => attention.push(event),
    );
    const descriptor = (await provider.discover())[0]!;
    const step = await provider.compile(descriptor, {
      id: "publish",
      provider: descriptor.provider,
      capability: descriptor.id,
      input: {},
    });
    const result = await provider.execute(
      step,
      { value: { type: "scalar", value: insight() } },
      context(),
    );
    assert.equal(result.status, "succeeded");
    const published = messages.list("another-current-account").messages;
    assert.equal(published.length, 1);
    assert.equal(published[0]?.title, "邮箱速览");
    assert.equal(published[0]?.owner?.type, "localProfile");
    assert.deepEqual(
      published[0]?.interactions[0],
      {
        type: "openEmails",
        emailIds: ["mail-1"],
        references: [{ accountId: "acct-source", emailId: "mail-1" }],
        label: "查看重点来源",
      },
    );
    assert.deepEqual(attention, [
      {
        accountId: "acct-anchor",
        messageId: published[0]?.id,
        title: "邮箱速览 · 安全提醒",
        detail: "整理出 1 个内容组、0 项建议。",
        urgent: true,
      },
    ]);
  } finally {
    db.close();
  }
});

test("application-message provider suppresses default empty insight publication", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    const messages = new ApplicationMessageRepository(db, () => now);
    const provider = new ApplicationMessageAutomationProvider(
      messages,
      new MessageArtifactRepository(db, ".", () => now),
    );
    const descriptor = (await provider.discover())[0]!;
    const step = await provider.compile(descriptor, {
      id: "publish",
      provider: descriptor.provider,
      capability: descriptor.id,
      input: {},
    });
    const empty = insight();
    empty.topHighlights = [];
    empty.emptyReason = "noCandidates";
    const result = await provider.execute(
      step,
      { value: { type: "scalar", value: empty } },
      context(),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.sideEffects.length, 0);
    assert.equal(messages.list("any-account").messages.length, 0);
  } finally {
    db.close();
  }
});

function context() {
  return {
    run: {
      id: "run-1",
      ruleId: "rule-1",
      ruleVersion: 1,
      accountId: "acct-anchor",
      occurrenceKey: "occurrence-1",
      actualStartedAt: now,
      delayed: false,
    },
    trigger: {},
    collection: {},
    steps: {},
    dryRun: false,
    owner: { type: "localProfile" as const, profileId: "default" as const },
  };
}

function insight(): SubscriptionInsightResult {
  return {
    type: "subscriptionDailyInsight",
    schemaVersion: 1,
    window: {
      start: "2026-07-29T13:00:00.000Z",
      end: now,
      timezone: "Asia/Shanghai",
    },
    accountCount: 2,
    topHighlights: [
      {
        id: "highlight-1",
        kind: "risk",
        text: "安全更新",
        sourceEmails: [
          {
            type: "email",
            accountId: "acct-source",
            emailId: "mail-1",
            subject: "安全更新",
          },
        ],
      },
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
      perAccount: {},
    },
  };
}
