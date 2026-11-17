import assert from "node:assert/strict";
import test from "node:test";
import type { LlmRequest } from "../ai/LlmClient.js";
import type { LlmRuntime } from "../ai/LlmRuntime.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type { IntelligenceResultRepository } from "./IntelligenceResultRepository.js";
import { SmartTagPromotionService } from "./SmartTagPromotionService.js";
import type {
  TopicCandidate,
  TopicCandidateRepository,
} from "./TopicCandidateRepository.js";

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

function createService(input?: {
  generate?: (request: LlmRequest) => Promise<{ text: string; finishReason: "stop" }>;
  contentTag?: { name: string; confidence: number; source: "ai"; tier: "auto"; topicId?: string };
}) {
  const message = {
    id: "mail-1",
    accountId: "acct-1",
    mailboxId: "acct-1",
    folderId: "inbox",
    threadId: "thread-1",
    subject: "Daily build 8472 for Alice on 2026-08-08",
    from: { name: "Build Bot", email: "bot@example.com" },
    to: [],
    cc: [],
    bcc: [],
    receivedAt: "2026-08-08T00:00:00.000Z",
    bodyText: "",
    bodyHtml: `<script>SECRET_SCRIPT</script><p>${"build passed ".repeat(900)}</p>`,
    attachments: [],
  };
  let recorded = 0;
  let cached: string | null = null;
  const mail = {
    getMessageById: (id: string, accountId?: string) =>
      id === message.id && (!accountId || accountId === message.accountId) ? message : null,
  } as unknown as CanonicalMailRepository;
  const results = {
    findByEmailId: () => ({
      tags: {
        type: "tags",
        tags: [],
        contentTags: [input?.contentTag ?? {
          name: "构建日报",
          confidence: 0.91,
          source: "ai",
          tier: "auto",
        }],
      },
    }),
  } as unknown as IntelligenceResultRepository;
  const topics = {
    getById: (id: string) => id === topic.id ? topic : null,
    listEvidence: () => [{ emailId: message.id }],
    recordEvidence: () => {
      recorded += 1;
      return topic;
    },
    getPromotionDescription: () => cached,
    setPromotionDescription: (_id: string, description: string) => {
      cached = description;
    },
  } as unknown as TopicCandidateRepository;
  const llmRuntime = {
    snapshot: () => ({
      client: input?.generate ? { generate: input.generate } : undefined,
      modelFor: () => input?.generate ? "test-model" : undefined,
    }),
  } as unknown as LlmRuntime;
  return {
    service: new SmartTagPromotionService({ mail, results, topics, llmRuntime }),
    recorded: () => recorded,
    cachedDescription: () => cached,
  };
}

test("promotion preview uses only the current cleaned and truncated email context", async () => {
  let request: LlmRequest | undefined;
  const { service, recorded } = createService({
    generate: async (value) => {
      request = value;
      return {
        text: JSON.stringify({
          description: "持续集成或构建系统发送的构建结果日报。",
        }),
        finishReason: "stop",
      };
    },
  });
  const draft = await service.preview({
    accountId: "acct-1",
    emailId: "mail-1",
    candidateName: "构建日报",
  });

  assert.equal(recorded(), 1, "historical contentTags without topicId should create evidence");
  assert.equal(draft.generationStatus, "generated");
  assert.equal(draft.topicId, "topic-1");
  assert.equal(draft.description, "持续集成或构建系统发送的构建结果日报。");
  const content = request?.messages[0]?.content ?? "";
  assert.match(content, /Subject: Daily build 8472/);
  assert.match(content, /From: Build Bot <bot@example.com>/);
  assert.doesNotMatch(content, /SECRET_SCRIPT/);
  assert.match(content, /\[\.\.\. truncated \.\.\.\]/);
  assert.ok(content.length < 9_000, "context should remain bounded");
});

test("promotion preview returns an editable fallback when no model is configured", async () => {
  const { service } = createService();
  const draft = await service.preview({
    accountId: "acct-1",
    emailId: "mail-1",
    candidateName: "构建日报",
  });
  assert.equal(draft.generationStatus, "fallback");
  assert.equal(draft.generationError, "MODEL_UNAVAILABLE");
  assert.equal(draft.name, "构建日报");
  assert.match(draft.description, /构建日报/);
});

test("promotion preview falls back without exposing an invalid raw model response", async () => {
  const { service } = createService({
    generate: async () => ({ text: "PRIVATE_RAW_RESPONSE", finishReason: "stop" }),
  });
  const draft = await service.preview({
    accountId: "acct-1",
    emailId: "mail-1",
    candidateName: "构建日报",
  });
  assert.equal(draft.generationStatus, "fallback");
  assert.equal(draft.generationError, "INVALID_MODEL_RESULT");
  assert.doesNotMatch(JSON.stringify(draft), /PRIVATE_RAW_RESPONSE/);
});

test("promotion preview caches the generated description and reuses it without another model call", async () => {
  let calls = 0;
  const { service, cachedDescription } = createService({
    generate: async () => {
      calls += 1;
      return {
        text: JSON.stringify({ description: "持续集成或构建系统发送的构建结果日报。" }),
        finishReason: "stop",
      };
    },
  });
  const first = await service.preview({
    accountId: "acct-1",
    emailId: "mail-1",
    candidateName: "构建日报",
  });
  const second = await service.preview({
    accountId: "acct-1",
    emailId: "mail-1",
    candidateName: "构建日报",
  });
  assert.equal(first.generationStatus, "generated");
  assert.equal(second.generationStatus, "generated");
  assert.equal(second.description, first.description);
  assert.equal(calls, 1, "second preview should reuse the cache, not call the model");
  assert.equal(cachedDescription(), first.description, "generated description should be persisted");
});

test("promotion preview refresh bypasses the cache and overwrites it", async () => {
  let calls = 0;
  const { service, cachedDescription } = createService({
    generate: async () => {
      calls += 1;
      return {
        text: JSON.stringify({ description: `第 ${calls} 版描述` }),
        finishReason: "stop",
      };
    },
  });
  const first = await service.preview({
    accountId: "acct-1",
    emailId: "mail-1",
    candidateName: "构建日报",
  });
  const refreshed = await service.preview({
    accountId: "acct-1",
    emailId: "mail-1",
    candidateName: "构建日报",
    refresh: true,
  });
  assert.equal(first.description, "第 1 版描述");
  assert.equal(refreshed.description, "第 2 版描述");
  assert.equal(calls, 2, "refresh should force a fresh model call");
  assert.equal(cachedDescription(), "第 2 版描述", "refresh should overwrite the cached description");
});

test("promotion preview does not cache a fallback result", async () => {
  const { service, cachedDescription } = createService();
  const draft = await service.preview({
    accountId: "acct-1",
    emailId: "mail-1",
    candidateName: "构建日报",
  });
  assert.equal(draft.generationStatus, "fallback");
  assert.equal(cachedDescription(), null);
});
