import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AiResultMetadata,
  IntelligenceJob,
  SummaryResult,
  TagResult,
} from "../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import { type LlmClient, type LlmResponse } from "./LlmClient.js";
import type { ProcessorContext } from "../intelligence/MailIntelligenceProcessor.js";
import { SummaryProcessor, SUMMARY_PROCESSOR_VERSION } from "../intelligence/processors/SummaryProcessor.js";
import { TagProcessor, TAG_PROCESSOR_VERSION } from "../intelligence/processors/TagProcessor.js";
import { TagFeedbackRuleRepository } from "../feedback/TagFeedbackRuleRepository.js";

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "acct-1:INBOX:1:100",
    accountId: "acct-1",
    folder: "INBOX",
    messageId: "<m-100@x.com>",
    from: { email: "boss@x.com", name: "Boss" },
    to: [{ email: "me@x.com" }],
    cc: [],
    bcc: [],
    subject: "Q3 plans",
    snippet: "we need",
    bodyText: "Please prepare the Q3 deck by Friday.",
    receivedAt: "2026-04-24T10:00:00.000Z",
    hasAttachments: false,
    attachments: [],
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: { uid: 100, uidValidity: 1, internalDate: "2026-04-24T10:00:00Z" },
    ...overrides,
  };
}

function makeJob(type: "summary" | "tags" = "summary"): IntelligenceJob {
  return {
    id: "job-1",
    emailId: "acct-1:INBOX:1:100",
    type,
    status: "running",
    attempts: 0,
    maxAttempts: 2,
    createdAt: "2026-04-24T10:00:00Z",
    updatedAt: "2026-04-24T10:00:00Z",
  };
}

function makeCtx(msg: MailMessage | null): ProcessorContext {
  return { getMessage: () => msg };
}

function fakeClient(impl: (req: unknown) => Promise<LlmResponse>): LlmClient {
  return { generate: impl as LlmClient["generate"] };
}

function stubFeedback(): TagFeedbackRuleRepository {
  return {
    addRejection: () => ({ id: "stub", accountId: "acct-1", tag: "stub", action: "reject" as const, createdAt: "" }),
    removeRejection: () => 0,
    listRules: () => [],
    findRulesForMail: () => [],
    applyRules: (tags: TagResult) => ({ result: tags, droppedByRules: 0, dynamicTags: 0, droppedOffVocab: 0 }),
  } as unknown as TagFeedbackRuleRepository;
}

test("SummaryProcessor result includes AiResultMetadata with all required fields", async () => {
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["one", "two", "three"],
        actionItems: ["prepare deck"],
        urgency: "medium",
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
  });

  const result = (await processor.handle(
    makeJob("summary"),
    makeCtx(makeMessage()),
  )) as SummaryResult;

  assert.ok(result._metadata, "result should have _metadata");
  const meta = result._metadata!;
  assert.equal(meta.processor, "summary");
  assert.equal(meta.version, SUMMARY_PROCESSOR_VERSION);
  assert.equal(meta.model, "gpt-4o-mini");
  assert.ok(Array.isArray(meta.contextRefs));
  assert.ok(meta.contextRefs.length > 0, "contextRefs should not be empty");
  assert.ok(meta.createdAt);
  assert.ok(typeof meta.durationMs === "number");
  assert.ok(meta.durationMs >= 0);
  assert.ok(meta.tokenUsage);
  assert.equal(meta.tokenUsage.inputTokens, 10);
  assert.equal(meta.tokenUsage.outputTokens, 5);
});

test("TagProcessor result includes AiResultMetadata with all required fields", async () => {
  const processor = new TagProcessor({
    model: "gpt-4o-mini",
    feedbackRules: stubFeedback(),
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        tags: [
          { name: "日报", confidence: 0.9, source: "ai" },
        ],
      }),
      finishReason: "stop",
      usage: { inputTokens: 8, outputTokens: 3 },
    })),
  });

  const result = (await processor.handle(
    makeJob("tags"),
    makeCtx(makeMessage()),
  )) as TagResult;

  assert.ok(result._metadata, "result should have _metadata");
  const meta = result._metadata!;
  assert.equal(meta.processor, "tags");
  assert.equal(meta.version, TAG_PROCESSOR_VERSION);
  assert.equal(meta.model, "gpt-4o-mini");
  assert.ok(Array.isArray(meta.contextRefs));
  assert.ok(meta.tokenUsage);
  assert.equal(meta.tokenUsage.inputTokens, 8);
  assert.equal(meta.tokenUsage.outputTokens, 3);
});

test("AiResultMetadata serialization preserves all fields through JSON round-trip", () => {
  const metadata: AiResultMetadata = {
    processor: "summary",
    version: 1,
    model: "gpt-4o-mini",
    confidence: 0.85,
    contextRefs: ["header", "body-text"],
    createdAt: "2026-04-26T12:00:00.000Z",
    durationMs: 1500,
    tokenUsage: { inputTokens: 100, outputTokens: 50 },
  };

  const result: SummaryResult = {
    type: "summary",
    bullets: ["one", "two", "three"],
    actionItems: [],
    urgency: "low",
    _metadata: metadata,
  };

  // Simulate persistence round-trip via JSON serialization
  const serialized = JSON.stringify(result);
  const deserialized = JSON.parse(serialized) as SummaryResult;

  assert.ok(deserialized._metadata, "deserialized result should have _metadata");
  assert.equal(deserialized._metadata!.processor, "summary");
  assert.equal(deserialized._metadata!.version, 1);
  assert.equal(deserialized._metadata!.model, "gpt-4o-mini");
  assert.equal(deserialized._metadata!.confidence, 0.85);
  assert.deepEqual(deserialized._metadata!.contextRefs, ["header", "body-text"]);
  assert.equal(deserialized._metadata!.durationMs, 1500);
  assert.deepEqual(deserialized._metadata!.tokenUsage, { inputTokens: 100, outputTokens: 50 });
});

test("AiResultMetadata confidence is optional", async () => {
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["one", "two", "three"],
        actionItems: [],
        urgency: "low",
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
  });

  const result = (await processor.handle(
    makeJob("summary"),
    makeCtx(makeMessage()),
  )) as SummaryResult;

  assert.ok(result._metadata);
  assert.equal(result._metadata!.confidence, undefined, "confidence should be optional");
});

test("SummaryProcessor context metadata in logs does not contain body", async () => {
  const logs: Array<{ event: string; fields: Record<string, string | number> }> = [];
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["one", "two", "three"],
        actionItems: [],
        urgency: "low",
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    logger: (event: string, fields: Record<string, string | number>) => logs.push({ event, fields }),
  });

  await processor.handle(
    makeJob("summary"),
    makeCtx(makeMessage({ bodyText: "SENSITIVE_BODY_SENTINEL_12345" })),
  );

  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes("SENSITIVE_BODY_SENTINEL_12345"), "logs must not contain mail body");
});
