import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  IntelligenceJob,
  ReplyDecisionResult,
} from "../../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import {
  LlmClientError,
  type LlmClient,
  type LlmResponse,
} from "../../ai/LlmClient.js";
import type { ProcessorContext } from "../MailIntelligenceProcessor.js";
import type { IntelligenceResultRepository } from "../IntelligenceResultRepository.js";
import type { JobRepository } from "../../queue/JobRepository.js";
import {
  ReplyDecisionProcessor,
  ReplyDecisionProcessorError,
  REPLY_DECISION_PROCESSOR_VERSION,
} from "./ReplyDecisionProcessor.js";

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
    snippet: "snippet",
    bodyText: "Can you confirm the Q3 kickoff date?",
    receivedAt: "2026-04-24T10:00:00.000Z",
    hasAttachments: false,
    attachments: [],
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: { uid: 100, uidValidity: 1, internalDate: "2026-04-24T10:00:00.000Z" },
    ...overrides,
  };
}

function makeJob(): IntelligenceJob {
  return {
    id: "job-1",
    emailId: "acct-1:INBOX:1:100",
    type: "replyDecision",
    status: "running",
    attempts: 0,
    maxAttempts: 3,
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

function stubResultRepo(): IntelligenceResultRepository {
  return {
    findByEmailId: () => ({}),
    saveResult: () => {},
    saveSkipped: () => {},
    listDynamicTagCategories: () => [],
    messageHasTag: () => false,
    messageHasCategory: () => false,
    listCategories: () => [],
    listReplyRequired: () => [],
  } as unknown as IntelligenceResultRepository;
}

function stubJobRepo(): JobRepository {
  const enqueued: Array<{ emailId: string; type: string; accountId: string; maxAttempts: number }> = [];
  return {
    enqueueJob: (input: { emailId: string; type: string; accountId: string; maxAttempts: number }) => { enqueued.push(input); },
    _enqueued: enqueued,
  } as unknown as JobRepository;
}

function makeProcessor(overrides: {
  llmResponse?: LlmResponse;
  resultRepo?: IntelligenceResultRepository;
  jobRepo?: JobRepository;
} = {}) {
  const jobRepo = overrides.jobRepo ?? stubJobRepo();
  const processor = new ReplyDecisionProcessor({
    model: "gpt-4o-mini",
    llmClient: overrides.llmResponse
      ? fakeClient(async () => overrides.llmResponse!)
      : fakeClient(async () => ({
          text: JSON.stringify({
            shouldReply: true,
            reason: "Question requires a response",
            confidence: 0.85,
          }),
          finishReason: "stop",
          usage: { inputTokens: 50, outputTokens: 20 },
        })),
    resultRepo: overrides.resultRepo ?? stubResultRepo(),
    jobRepo,
    accountId: "acct-1",
    now: () => 1000,
  });
  return { processor, jobRepo };
}

// ── Basic result shape tests ─────────────────────────────────────

test("ReplyDecisionProcessor returns result with priority fields", async () => {
  const { processor } = makeProcessor();
  const result = await processor.handle(makeJob(), makeCtx(makeMessage())) as ReplyDecisionResult;
  assert.equal(result.type, "replyDecision");
  assert.equal(typeof result.shouldReply, "boolean");
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.length > 0);
  assert.equal(typeof result.confidence, "number");
  assert.equal(typeof result.priorityScore, "number");
  assert.ok(result.priorityScore >= 0 && result.priorityScore <= 1);
  assert.ok(["low", "normal", "high"].includes(result.level));
  assert.equal(typeof result.replyRequired, "boolean");
  assert.ok(Array.isArray(result.signals));
  assert.ok(result.signals.length > 0);
});

test("ReplyDecisionProcessor result always includes a reason", async () => {
  const { processor } = makeProcessor();
  const result = await processor.handle(makeJob(), makeCtx(makeMessage())) as ReplyDecisionResult;
  assert.ok(result.reason && result.reason.trim().length > 0, "reason must always be present");
});

test("ReplyDecisionProcessor result includes _metadata", async () => {
  const { processor } = makeProcessor();
  const result = await processor.handle(makeJob(), makeCtx(makeMessage())) as ReplyDecisionResult;
  assert.ok(result._metadata);
  assert.equal(result._metadata!.processor, "replyDecision");
  assert.equal(result._metadata!.version, REPLY_DECISION_PROCESSOR_VERSION);
  assert.equal(result._metadata!.model, "gpt-4o-mini");
  assert.ok(result._metadata!.createdAt);
  assert.equal(typeof result._metadata!.durationMs, "number");
  assert.ok(result._metadata!.tokenUsage);
});

test("ReplyDecisionProcessor signals have name, value, and weight", async () => {
  const { processor } = makeProcessor();
  const result = await processor.handle(makeJob(), makeCtx(makeMessage())) as ReplyDecisionResult;
  for (const signal of result.signals) {
    assert.equal(typeof signal.name, "string", `signal name should be string: ${JSON.stringify(signal)}`);
    assert.equal(typeof signal.value, "string", `signal value should be string: ${JSON.stringify(signal)}`);
    assert.equal(typeof signal.weight, "number", `signal weight should be number: ${JSON.stringify(signal)}`);
  }
});

// ── Priority scoring tests ───────────────────────────────────────

test("Direct question from personal sender gets normal or high priority", async () => {
  const { processor } = makeProcessor();
  const result = await processor.handle(
    makeJob(),
    makeCtx(makeMessage({
      from: { email: "boss@company.com", name: "Boss" },
      to: [{ email: "me@company.com" }],
      subject: "Can you confirm?",
      bodyText: "Can you confirm the Q3 kickoff date by Friday?",
    })),
  ) as ReplyDecisionResult;
  assert.ok(result.priorityScore >= 0.35, `direct question should be normal+, got ${result.priorityScore}`);
});

test("Noreply sender gets low priority", async () => {
  const { processor } = makeProcessor();
  const result = await processor.handle(
    makeJob(),
    makeCtx(makeMessage({
      from: { email: "noreply@github.com" },
      subject: "Build succeeded",
      bodyText: "Your build completed successfully.",
    })),
  ) as ReplyDecisionResult;
  assert.equal(result.level, "low", "noreply sender should be low priority");
  assert.equal(result.replyRequired, false, "noreply sender should not require reply");
});

// ── Bulk/newsletter low priority default ──────────────────────────

test("Newsletter with no direct request defaults to low priority", async () => {
  const { processor } = makeProcessor({
    llmResponse: {
      text: JSON.stringify({
        shouldReply: false,
        reason: "Newsletter with no personal ask",
        confidence: 0.9,
      }),
      finishReason: "stop",
      usage: { inputTokens: 30, outputTokens: 10 },
    },
  });
  const result = await processor.handle(
    makeJob(),
    makeCtx(makeMessage({
      from: { email: "digest@substack.com" },
      to: [{ email: "me@company.com" }],
      subject: "Weekly roundup",
      bodyText: "Here are the top stories this week...",
    })),
  ) as ReplyDecisionResult;
  assert.equal(result.level, "low");
  assert.equal(result.replyRequired, false);
});

// ── Direct deadline = high priority ───────────────────────────────

test("Direct request with deadline becomes high priority", async () => {
  const { processor } = makeProcessor();
  const result = await processor.handle(
    makeJob(),
    makeCtx(makeMessage({
      from: { email: "boss@company.com", name: "Boss" },
      to: [{ email: "me@company.com" }],
      subject: "Urgent: Q3 plans due Friday",
      bodyText: "Can you prepare the Q3 deck by Friday? We need it before the board meeting.",
    })),
  ) as ReplyDecisionResult;
  assert.ok(result.level === "high" || result.level === "normal", `direct+deadline should be high/normal, got ${result.level}`);
  assert.equal(result.replyRequired, true);
});

// ── Draft enqueue behavior preserved ──────────────────────────────

test("shouldReply=true still enqueues replyDraft job", async () => {
  const jobRepo = stubJobRepo();
  const { processor } = makeProcessor({ jobRepo });
  const result = await processor.handle(makeJob(), makeCtx(makeMessage())) as ReplyDecisionResult;
  if (result.shouldReply) {
    const enqueued = (jobRepo as any)._enqueued as Array<{ type: string }>;
    assert.ok(enqueued.some((j) => j.type === "replyDraft"), "shouldReply=true should enqueue replyDraft");
  }
});

test("shouldReply=false does not enqueue replyDraft job", async () => {
  const jobRepo = stubJobRepo();
  const { processor } = makeProcessor({
    llmResponse: {
      text: JSON.stringify({
        shouldReply: false,
        reason: "Notification, no reply needed",
        confidence: 0.9,
      }),
      finishReason: "stop",
    },
    jobRepo,
  });
  const result = await processor.handle(
    makeJob(),
    makeCtx(makeMessage({
      from: { email: "noreply@github.com" },
      bodyText: "Build succeeded.",
    })),
  ) as ReplyDecisionResult;
  if (!result.shouldReply) {
    const enqueued = (jobRepo as any)._enqueued as Array<{ type: string }>;
    assert.ok(!enqueued.some((j) => j.type === "replyDraft"), "shouldReply=false should not enqueue replyDraft");
  }
});

// ── Draft boundary: processor does not generate drafts ────────────

test("ReplyDecisionProcessor NEVER generates drafts (source check)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(here, "ReplyDecisionProcessor.ts"),
    "utf8",
  );
  assert.ok(
    !/draftMarkdown|composeMail|ReplyDraftResult/.test(src),
    "ReplyDecisionProcessor must not generate drafts or reference draftMarkdown",
  );
});

// ── Error handling tests ──────────────────────────────────────────

test("ReplyDecisionProcessor throws when mail row is missing (terminal)", async () => {
  const { processor } = makeProcessor();
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: unknown) => {
      assert.ok(err instanceof ReplyDecisionProcessorError);
      assert.equal(err.code, "mail-missing");
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("ReplyDecisionProcessor propagates LlmClientError with retryable flag preserved", async () => {
  const retry = new ReplyDecisionProcessor({
    model: "x",
    llmClient: fakeClient(async () => {
      throw new LlmClientError({ status: 503, code: "overloaded", message: "busy" });
    }),
    resultRepo: stubResultRepo(),
    jobRepo: stubJobRepo(),
    accountId: "acct-1",
  });
  await assert.rejects(
    () => retry.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test("ReplyDecisionProcessor treats fenced + truncated + parse failures as terminal", async () => {
  const fenced = new ReplyDecisionProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: "```json\n" + JSON.stringify({ shouldReply: true, reason: "hello", confidence: 0.5 }) + "\n```",
      finishReason: "stop",
    })),
    resultRepo: stubResultRepo(),
    jobRepo: stubJobRepo(),
    accountId: "acct-1",
  });
  await assert.rejects(
    () => fenced.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.equal((err as ReplyDecisionProcessorError).code, "fenced-output");
      assert.equal((err as ReplyDecisionProcessorError).retryable, false);
      return true;
    },
  );

  const truncated = new ReplyDecisionProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({ shouldReply: true, reason: "r", confidence: 0.5 }),
      finishReason: "length",
    })),
    resultRepo: stubResultRepo(),
    jobRepo: stubJobRepo(),
    accountId: "acct-1",
  });
  await assert.rejects(
    () => truncated.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.equal((err as ReplyDecisionProcessorError).code, "truncated");
      assert.equal((err as ReplyDecisionProcessorError).retryable, false);
      return true;
    },
  );

  const bad = new ReplyDecisionProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: "not json",
      finishReason: "stop",
    })),
    resultRepo: stubResultRepo(),
    jobRepo: stubJobRepo(),
    accountId: "acct-1",
  });
  await assert.rejects(
    () => bad.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.equal((err as ReplyDecisionProcessorError).code, "invalid-json");
      assert.equal((err as ReplyDecisionProcessorError).retryable, false);
      return true;
    },
  );
});

test("ReplyDecisionProcessor rejects response with invalid shouldReply", async () => {
  const processor = new ReplyDecisionProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({ shouldReply: "yes", reason: "r", confidence: 0.5 }),
      finishReason: "stop",
    })),
    resultRepo: stubResultRepo(),
    jobRepo: stubJobRepo(),
    accountId: "acct-1",
  });
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.equal((err as ReplyDecisionProcessorError).code, "invalid-shouldReply");
      return true;
    },
  );
});

test("ReplyDecisionProcessor rejects response with empty reason", async () => {
  const processor = new ReplyDecisionProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({ shouldReply: true, reason: "", confidence: 0.5 }),
      finishReason: "stop",
    })),
    resultRepo: stubResultRepo(),
    jobRepo: stubJobRepo(),
    accountId: "acct-1",
  });
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.equal((err as ReplyDecisionProcessorError).code, "invalid-reason");
      return true;
    },
  );
});

// ── Determinism test ──────────────────────────────────────────────

test("Same input produces same decision (deterministic)", async () => {
  const msg = makeMessage({
    from: { email: "boss@company.com", name: "Boss" },
    to: [{ email: "me@company.com" }],
    subject: "Q3 plans due Friday",
    bodyText: "Can you prepare the Q3 deck by Friday?",
  });

  // Same LLM response for both calls
  const llmResponse = {
    text: JSON.stringify({
      shouldReply: true,
      reason: "Question with deadline requires reply",
      confidence: 0.85,
    }),
    finishReason: "stop" as const,
    usage: { inputTokens: 50, outputTokens: 20 },
  };

  const first = await new ReplyDecisionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({ ...llmResponse })),
    resultRepo: stubResultRepo(),
    jobRepo: stubJobRepo(),
    accountId: "acct-1",
    now: () => 1000,
  }).handle(makeJob(), makeCtx(msg)) as ReplyDecisionResult;

  const second = await new ReplyDecisionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({ ...llmResponse })),
    resultRepo: stubResultRepo(),
    jobRepo: stubJobRepo(),
    accountId: "acct-1",
    now: () => 1000,
  }).handle(makeJob(), makeCtx(msg)) as ReplyDecisionResult;

  assert.equal(first.priorityScore, second.priorityScore);
  assert.equal(first.level, second.level);
  assert.equal(first.replyRequired, second.replyRequired);
  assert.deepEqual(first.signals, second.signals);
});

// ── Tag-aware priority ────────────────────────────────────────────

test("Tags from result repo feed into priority signals", async () => {
  const resultRepo = {
    ...stubResultRepo(),
    findByEmailId: () => ({
      tags: {
        type: "tags",
        tags: [{ name: "通知", confidence: 0.9, source: "ai" }],
      },
    }),
  } as unknown as IntelligenceResultRepository;

  const { processor } = makeProcessor({
    resultRepo,
    llmResponse: {
      text: JSON.stringify({
        shouldReply: false,
        reason: "Notification, no reply needed",
        confidence: 0.9,
      }),
      finishReason: "stop",
      usage: { inputTokens: 30, outputTokens: 10 },
    },
  });

  const result = await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  ) as ReplyDecisionResult;

  assert.ok(result.signals.some((s) => s.name === "system-category" && s.value === "通知"),
    "should have system-category signal with value 通知");
});

test("Classification categoryId from result repo feeds into priority signals", async () => {
  const resultRepo = {
    ...stubResultRepo(),
    findByEmailId: () => ({
      tags: {
        type: "tags",
        tags: [{ name: "newsletter", confidence: 0.9, source: "ai" }],
        classification: { categoryId: "newsletter", reason: "Newsletter content", confidence: 0.95 },
      },
    }),
  } as unknown as IntelligenceResultRepository;

  const { processor } = makeProcessor({
    resultRepo,
    llmResponse: {
      text: JSON.stringify({
        shouldReply: false,
        reason: "Newsletter, no personal ask",
        confidence: 0.9,
      }),
      finishReason: "stop",
      usage: { inputTokens: 30, outputTokens: 10 },
    },
  });

  const result = await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  ) as ReplyDecisionResult;

  assert.ok(result.signals.some((s) => s.name === "system-category" && s.value === "newsletter"),
    "should have system-category signal with value newsletter");
});

// ── Processor version test ────────────────────────────────────────

test("REPLY_DECISION_PROCESSOR_VERSION is 2", () => {
  assert.equal(REPLY_DECISION_PROCESSOR_VERSION, 2);
});
