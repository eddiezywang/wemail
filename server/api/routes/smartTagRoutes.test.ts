import assert from "node:assert/strict";
import test from "node:test";
import type { SmartTagBackfillRun } from "../../wemail/intelligence/SmartTagBackfillRepository.js";
import type { TopicCandidate } from "../../wemail/intelligence/TopicCandidateRepository.js";
import type { UserTag } from "../../wemail/intelligence/UserTagRepository.js";
import { buildSmartTagRoutes, type SmartTagRoutesDeps } from "./smartTagRoutes.js";

function fixture() {
  const topic: TopicCandidate = {
    id: "topic-1",
    accountId: "acct-1",
    normalizedKey: "构建日报",
    displayName: "构建日报",
    aliases: [],
    state: "collecting",
    mailCount: 1,
    threadCount: 1,
    senderCount: 1,
    positiveCount: 1,
    negativeCount: 0,
    firstSeenAt: "2026-08-08T00:00:00.000Z",
    lastSeenAt: "2026-08-08T00:00:00.000Z",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
  const tags: UserTag[] = [];
  const relations: Array<{ emailId: string; userTagId: string; source: string }> = [];
  const actions: Array<{ emailId: string; tagId: string; actionType: string }> = [];
  const backfills: SmartTagBackfillRun[] = [];
  let transactionCount = 0;
  const previewCalls: Array<Record<string, unknown>> = [];
  const deps = {
    getActiveAccountId: () => "acct-1",
    promotions: {
      resolveSource: () => ({
        message: { id: "mail-1", accountId: "acct-1" },
        candidate: { name: "构建日报", confidence: 0.9, source: "ai", tier: "auto" },
        topic,
      }),
      preview: async (input: Record<string, unknown>) => {
        previewCalls.push(input);
        return {
          name: "构建日报",
          description: "构建结果日报",
          topicId: topic.id,
          sourceEmailId: "mail-1",
          generationStatus: "generated",
        };
      },
    },
    tags: {
      listByAccount: () => tags,
      getById: (id: string) => tags.find((tag) => tag.id === id) ?? null,
      upsert: (input: {
        accountId: string;
        name: string;
        description: string;
        prompt: string;
        creationSource: "topic-suggestion";
        sourceTopicId: string;
      }) => {
        const tag: UserTag = {
          id: `tag-${tags.length + 1}`,
          ...input,
          effectivePrompt: input.prompt,
          createdAt: "2026-08-08T00:00:00.000Z",
          updatedAt: "2026-08-08T00:00:00.000Z",
        };
        tags.push(tag);
        return tag;
      },
    },
    topics: {
      markCreated: (_id: string, _accountId: string, tagId: string) => {
        topic.state = "created";
        topic.userTagId = tagId;
        return topic;
      },
    },
    relations: {
      transaction: <T>(work: () => T) => {
        transactionCount += 1;
        return work();
      },
      get: (emailId: string, tagId: string) =>
        relations.find((item) => item.emailId === emailId && item.userTagId === tagId) ?? null,
      upsert: (input: { emailId: string; userTagId: string; source: string }) => {
        relations.push(input);
        return input;
      },
    },
    actions: {
      record: (input: { emailId: string; tagId: string; actionType: string }) => {
        actions.push(input);
        return input;
      },
    },
    backfills: {
      create: () => {
        const run: SmartTagBackfillRun = {
          id: `backfill-${backfills.length + 1}`,
          accountId: "acct-1",
          reason: "smart-tag-backfill",
          status: "running",
          scope: "account-scan",
          scannedCount: 0,
          queuedCount: 0,
          recentCount: 0,
          historicalCount: 0,
          processedCount: 0,
          failedCount: 0,
          retainedCount: 0,
          removedCount: 0,
          createdAt: "2026-08-08T00:00:00.000Z",
          updatedAt: "2026-08-08T00:00:00.000Z",
        };
        backfills.push(run);
        return run;
      },
      listByAccount: () => [...backfills].reverse(),
      finishEnqueue: (id: string) => {
        const run = backfills.find((item) => item.id === id) ?? null;
        if (run) run.status = "completed";
        return run;
      },
    },
    mail: {
      listAllMessagesByAccountPage: () => [],
    },
    learningRuns: { listByAccount: () => [] },
    revisions: {},
    results: {},
    promptCompiler: {
      compile: async ({ name, description }: { name: string; description: string }) =>
        `编译规则：${name}；${description}`,
    },
    tagBackfillIntervalMs: 0,
  } as unknown as SmartTagRoutesDeps;
  return {
    app: buildSmartTagRoutes(deps),
    topic,
    tags,
    relations,
    actions,
    backfills,
    transactionCount: () => transactionCount,
    previewCalls: () => previewCalls,
  };
}

const requestBody = {
  emailId: "mail-1",
  candidateName: "构建日报",
  topicId: "topic-1",
  name: "构建日报",
  description: "持续集成系统发送的构建结果日报。",
};

test("promotion preview forwards the refresh flag", async () => {
  const state = fixture();
  const response = await state.app.request("/promotions/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      emailId: "mail-1",
      candidateName: "构建日报",
      topicId: "topic-1",
      refresh: true,
    }),
  });
  const body = await response.json() as { ok: boolean };
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(state.previewCalls(), [{
    accountId: "acct-1",
    emailId: "mail-1",
    candidateName: "构建日报",
    topicId: "topic-1",
    refresh: true,
  }]);
});

test("promotion creation writes the tag, source relation, positive action and one backfill", async () => {
  const state = fixture();
  const response = await state.app.request("/promotions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const body = await response.json() as { ok: boolean; idempotent: boolean };
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.idempotent, false);
  assert.equal(state.transactionCount(), 1);
  assert.equal(state.tags[0]?.creationSource, "topic-suggestion");
  assert.equal(state.tags[0]?.sourceTopicId, "topic-1");
  assert.equal(state.tags[0]?.prompt, `编译规则：构建日报；${requestBody.description}`);
  assert.deepEqual(state.relations[0], {
    accountId: "acct-1",
    emailId: "mail-1",
    userTagId: "tag-1",
    source: "user",
    confidence: 1,
  });
  assert.equal(state.actions.length, 1);
  assert.equal(state.actions[0]?.actionType, "apply");
  assert.equal(state.backfills.length, 1);

  const duplicate = await state.app.request("/promotions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const duplicateBody = await duplicate.json() as { idempotent: boolean };
  assert.equal(duplicate.status, 200);
  assert.equal(duplicateBody.idempotent, true);
  assert.equal(state.tags.length, 1);
  assert.equal(state.actions.length, 1);
  assert.equal(state.backfills.length, 1);
});

test("promotion creation rejects a same-name formal tag without overwriting it", async () => {
  const state = fixture();
  state.tags.push({
    id: "existing-tag",
    accountId: "acct-1",
    name: "构建日报",
    description: "原有描述",
    prompt: "原有提示词",
    effectivePrompt: "原有提示词",
    creationSource: "manual",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  });
  const response = await state.app.request("/promotions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const body = await response.json() as { code: string };
  assert.equal(response.status, 409);
  assert.equal(body.code, "SMART_TAG_NAME_EXISTS");
  assert.equal(state.tags[0]?.description, "原有描述");
  assert.equal(state.relations.length, 0);
  assert.equal(state.backfills.length, 0);
});
