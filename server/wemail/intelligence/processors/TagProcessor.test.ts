import { insertCanonicalTestAccount } from "../../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  IntelligenceJob,
  TagResult,
} from "../../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import {
  LlmClientError,
  type LlmClient,
  type LlmResponse,
} from "../../ai/LlmClient.js";
import { BUILTIN_TAGS } from "../../ai/prompts/tagPrompt.js";
import { openOrCreateMailDatabase } from "../../database/Database.js";
import {
  TagFeedbackRuleRepository,
  deriveSubjectPattern,
} from "../../feedback/TagFeedbackRuleRepository.js";
import type { ProcessorContext } from "../MailIntelligenceProcessor.js";
import {
  TAG_PROCESSOR_VERSION,
  TagProcessor,
  TagProcessorError,
} from "./TagProcessor.js";

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-tagproc-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1", email: "a@x.com" });
  return { db, feedback: new TagFeedbackRuleRepository(db) };
}

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "acct-1:INBOX:1:100",
    accountId: "acct-1",
    folder: "INBOX",
    messageId: "<m-100@x.com>",
    from: { email: "foo@example.com", name: "Foo" },
    to: [{ email: "me@x.com" }],
    cc: [],
    bcc: [],
    subject: "Daily build #12",
    snippet: "Today's build finished",
    bodyText: "Build number 12 passed all checks.",
    receivedAt: "2026-04-24T10:00:00Z",
    hasAttachments: false,
    attachments: [],
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: { uid: 100, uidValidity: 1, internalDate: "2026-04-24T10:00:00Z" },
    ...overrides,
  };
}

function makeJob(): IntelligenceJob {
  return {
    id: "job-1",
    emailId: "acct-1:INBOX:1:100",
    type: "tags",
    status: "running",
    attempts: 0,
    maxAttempts: 2,
    createdAt: "2026-04-24T10:00:00Z",
    updatedAt: "2026-04-24T10:00:00Z",
  };
}

function makeCtx(
  msg: MailMessage | null,
  workspace?: ProcessorContext["workspace"],
): ProcessorContext {
  return workspace
    ? { getMessage: () => msg, workspace }
    : { getMessage: () => msg };
}

function fakeClient(impl: (req: unknown) => Promise<LlmResponse>): LlmClient {
  return { generate: impl as LlmClient["generate"] };
}

function userTag(id: string, name: string) {
  return {
    id,
    accountId: "acct-1",
    name,
    description: `${name}邮件`,
    prompt: `匹配${name}`,
    effectivePrompt: `匹配${name}`,
    creationSource: "manual" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function systemResult(matches: { important?: boolean; actionRequired?: boolean; invoice?: boolean }) {
  const signal = (matched = false) => ({ matched, confidence: matched ? 0.9 : 0.2, reason: "test", source: "ai" as const });
  return {
    important: signal(matches.important),
    actionRequired: { ...signal(matches.actionRequired), actions: matches.actionRequired ? ["确认"] : [] },
    invoice: { ...signal(matches.invoice), evidence: matches.invoice ? ["发票附件"] : [] },
  };
}

test("invoice subject overrides an AI false negative without attachments", async () => {
  const { db, feedback } = makeRepo();
  try {
    const processor = new TagProcessor({
      model: "test", feedbackRules: feedback,
      llmClient: fakeClient(async () => ({
        text: JSON.stringify({ tags: [], system: systemResult({}) }), finishReason: "stop",
      })),
    });
    const result = await processor.handle(makeJob(), makeCtx(makeMessage({ subject: "电子发票通知" }))) as TagResult;
    assert.equal(result.system?.invoice.matched, true);
    assert.equal(result.system?.invoice.source, "rule");
  } finally {
    db.close();
  }
});

test("TagProcessor returns independent system signals, content topics, and configured user tags", async () => {
  const { feedback } = makeRepo();
  const logs: Array<{ event: string; fields: Record<string, string | number> }> = [];
  let receivedReq: Record<string, unknown> | null = null;
  let usageCommitted = false;

  const processor = new TagProcessor({
    model: "gpt-4o-mini",
    feedbackRules: feedback,
    llmClient: fakeClient(async (req) => {
      receivedReq = req as Record<string, unknown>;
      return {
        text: JSON.stringify({
          system: systemResult({ important: true, actionRequired: true }),
          contentTags: [{ name: "构建日报", confidence: 0.9, source: "ai", tier: "auto" }],
          tags: [{ name: "工程周报", confidence: 0.9, source: "ai" }, { name: "not-a-tag", confidence: 0.5, source: "ai" }],
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
    logger: (event, fields) => logs.push({ event, fields }),
    getUserTags: async () => [userTag("tag-1", "工程周报")],
    usage: { record: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      usageCommitted = true;
    } },
    onContentTags: (_mail, contentTags) =>
      contentTags.map((tag) => ({ ...tag, topicId: "topic-1" })),
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TagResult;

  assert.equal(result.type, "tags");
  assert.equal(usageCommitted, true, "the processor waits for the asynchronous usage commit");
  assert.deepEqual(result.tags.map((t) => t.name), ["工程周报"]);
  assert.deepEqual(result.contentTags?.map((t) => t.name), ["构建日报"]);
  assert.equal(result.contentTags?.[0]?.topicId, "topic-1");
  assert.equal(result.system?.important.matched, true);
  assert.equal(result.system?.actionRequired.matched, true);

  // Correct system prompt + schema + timeout threading.
  assert.ok(receivedReq !== null);
  assert.equal(typeof (receivedReq as { system: string }).system, "string");
  assert.ok((receivedReq as { jsonSchema: unknown }).jsonSchema);
  assert.equal((receivedReq as { timeoutMs: number }).timeoutMs, 45_000);

  // Body-free: success event must not contain subject body text.
  const ok = logs.find((l) => l.event === "tags-ok");
  assert.ok(ok);
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes("Build number 12"));
  // Content topics are not counted as legacy dynamic sidebar categories.
  assert.equal(ok!.fields.dynamicTags, 0);
});

test("TagProcessor drops configured user tags rejected by a pre-seeded feedback rule", async () => {
  const { feedback } = makeRepo();
  feedback.addRejection({
    accountId: "acct-1",
    tagName: "工程通知",
    senderPattern: "foo@example.com",
    subjectPattern: deriveSubjectPattern("Daily build"),
  });

  const processor = new TagProcessor({
    model: "x",
    feedbackRules: feedback,
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        tags: [
          { name: "工程通知", confidence: 0.9, source: "ai" },
          { name: "工程日报", confidence: 0.8, source: "ai" },
        ],
      }),
      finishReason: "stop",
    })),
    getUserTags: () => [userTag("tag-1", "工程通知"), userTag("tag-2", "工程日报")],
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TagResult;
  // Rejected configured tag is stripped; the other configured tag is retained.
  assert.deepEqual(
    result.tags.map((t) => t.name),
    ["工程日报"],
  );
});

test("TagProcessor propagates LlmClientError (retryable flag preserved)", async () => {
  const { feedback } = makeRepo();
  const processor = new TagProcessor({
    model: "x",
    feedbackRules: feedback,
    llmClient: fakeClient(async () => {
      throw new LlmClientError({ status: 503, code: "overloaded", message: "busy" });
    }),
  });
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal((err as LlmClientError).retryable, true);
      return true;
    },
  );
});

test("TagProcessor salvages a schema-mismatched response via rawText", async () => {
  const { feedback } = makeRepo();
  const events: string[] = [];
  const rawText = JSON.stringify({
    system: {
      important: { matched: true, confidence: 0.9, reason: "test", source: "ai" },
      // actionRequired deliberately misses the required `actions` field.
      actionRequired: { matched: true, confidence: 0.8, reason: "test", source: "ai" },
      invoice: { matched: false, confidence: 0.2, reason: "test", source: "ai" },
    },
    contentTags: [{ name: "构建日报", confidence: 0.9, source: "ai", tier: "auto" }],
    tags: [{ name: "工程周报", confidence: 0.9, source: "ai" }],
  });
  const processor = new TagProcessor({
    model: "x",
    feedbackRules: feedback,
    llmClient: fakeClient(async () => {
      throw new LlmClientError({
        code: "STRUCTURED_OUTPUT_SCHEMA_MISMATCH",
        message: "structured-output-schema-mismatch",
        rawText,
      });
    }),
    getUserTags: () => [userTag("tag-1", "工程周报")],
    logger: (event) => events.push(event),
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TagResult;

  assert.equal(result.type, "tags");
  assert.deepEqual(result.tags.map((t) => t.name), ["工程周报"]);
  assert.equal(result.system?.important.matched, true);
  assert.equal(result.system?.actionRequired.matched, true);
  assert.deepEqual(result.system?.actionRequired.actions, []);
  assert.ok(events.includes("tags-schema-fallback"));
  assert.ok(!events.includes("tags-llm-error"));
});

test("TagProcessor treats parse failure as terminal non-retryable", async () => {
  const { feedback } = makeRepo();
  const processor = new TagProcessor({
    model: "x",
    feedbackRules: feedback,
    llmClient: fakeClient(async () => ({ text: "not json", finishReason: "stop" })),
  });
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof TagProcessorError);
      assert.equal((err as TagProcessorError).retryable, false);
      assert.match((err as Error).message, /response-not-json/);
      return true;
    },
  );
});

test("TagProcessor accepts fenced JSON and treats length truncation as terminal", async () => {
  const { feedback } = makeRepo();
  const fenced = new TagProcessor({
    model: "x",
    feedbackRules: feedback,
    llmClient: fakeClient(async () => ({
      text: "```json\n" + JSON.stringify({ tags: [] }) + "\n```",
      finishReason: "stop",
    })),
  });
  const fencedResult = await fenced.handle(makeJob(), makeCtx(makeMessage()));
  assert.equal(fencedResult.type, "tags");
  assert.deepEqual(fencedResult.tags, []);

  const truncated = new TagProcessor({
    model: "x",
    feedbackRules: feedback,
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({ tags: [] }),
      finishReason: "length",
    })),
  });
  await assert.rejects(
    () => truncated.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.equal((err as TagProcessorError).code, "truncated");
      assert.equal((err as TagProcessorError).retryable, false);
      return true;
    },
  );
});

test("TagProcessor throws when mail row is missing", async () => {
  const { feedback } = makeRepo();
  const processor = new TagProcessor({
    model: "x",
    feedbackRules: feedback,
    llmClient: fakeClient(async () => {
      throw new Error("should not be called");
    }),
  });
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: Error) => err.message.includes("mail-missing"),
  );
});

test("TagProcessor built-in vocabulary is exactly 8 and in-prompt", () => {
  assert.equal(BUILTIN_TAGS.length, 8);
});

test("TagProcessor sends the approved enterprise classification definitions", async () => {
  const { feedback } = makeRepo();
  const receivedReqs: Array<{ system?: unknown }> = [];
  const processor = new TagProcessor({
    model: "gpt-4o-mini",
    feedbackRules: feedback,
    llmClient: fakeClient(async (req) => {
      receivedReqs.push(req as { system?: unknown });
      return {
        text: JSON.stringify({
          classification: {
            categoryId: "notification",
            reason: "system notification",
            confidence: 0.9,
          },
          tags: [{ name: "通知", confidence: 0.9, source: "ai" }],
        }),
        finishReason: "stop",
      };
    }),
  });

  await processor.handle(makeJob(), makeCtx(makeMessage()));

  const receivedReq = receivedReqs[0];
  assert.ok(receivedReq);
  const system = receivedReq.system as string;
  assert.match(system, /three INDEPENDENT system signals/);
  assert.match(system, /important:/);
  assert.match(system, /actionRequired:/);
  assert.match(system, /invoice:/);
  assert.match(system, /Exclude payment receipts/);
  assert.match(system, /zero to three contentTags/);
});

test("TagProcessor stores the tag definition fingerprint in result metadata", async () => {
  const { feedback } = makeRepo();
  const processor = new TagProcessor({
    model: "gpt-4o-mini",
    feedbackRules: feedback,
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        classification: {
          categoryId: "notification",
          reason: "system notification",
          confidence: 0.9,
        },
        tags: [{ name: "通知", confidence: 0.9, source: "ai" }],
      }),
      finishReason: "stop",
    })),
  });

  const result = await processor.handle(makeJob(), makeCtx(makeMessage()));

  assert.equal(typeof result._metadata?.tagDefinitionFingerprint, "string");
  assert.ok(result._metadata!.tagDefinitionFingerprint!.length >= 16);
});

// ── Route C / WP C: model-emitted classification ───────────────────

test("TagProcessor uses model-emitted classification when valid", async () => {
  const { feedback } = makeRepo();
  const processor = new TagProcessor({
    model: "x",
    feedbackRules: feedback,
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        classification: {
          categoryId: "important",
          reason: "VP escalation tagged with response deadline",
          confidence: 0.92,
        },
        tags: [{ name: "待回复", confidence: 0.9, source: "ai" }],
      }),
      finishReason: "stop",
    })),
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TagResult;

  assert.ok(result.classification);
  assert.equal(result.classification.categoryId, "important");
  assert.equal(
    result.classification.reason,
    "VP escalation tagged with response deadline",
  );
  assert.equal(result.classification.confidence, 0.92);
});

test("TagProcessor falls back to deriveClassification when model omits classification", async () => {
  const { feedback } = makeRepo();
  const processor = new TagProcessor({
    model: "x",
    feedbackRules: feedback,
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        // No `classification` block → fallback path.
        tags: [{ name: "通知", confidence: 0.9, source: "ai" }],
      }),
      finishReason: "stop",
    })),
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TagResult;

  // Fallback derives from the tag list. '通知' isn't a system category
  // id, so the fallback emits 'other' with low confidence.
  assert.ok(result.classification);
  assert.equal(result.classification.categoryId, "other");
});

test("TagProcessor falls back when model emits a categoryId outside the system vocabulary", async () => {
  const { feedback } = makeRepo();
  const processor = new TagProcessor({
    model: "x",
    feedbackRules: feedback,
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        classification: {
          categoryId: "totally-made-up",
          reason: "should be rejected",
          confidence: 0.95,
        },
        tags: [{ name: "通知", confidence: 0.9, source: "ai" }],
      }),
      finishReason: "stop",
    })),
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TagResult;
  // Invalid categoryId rejected → fallback to deriveClassification.
  assert.ok(result.classification);
  assert.equal(result.classification.categoryId, "other");
});

test("TagProcessor falls back when feedback rule suppresses the model's classification", async () => {
  const { feedback } = makeRepo();
  // User rejected `important` for this sender+subject combo, so
  // the model's preference must be suppressed and the fallback used.
  feedback.addRejection({
    accountId: "acct-1",
    tagName: "important",
    senderPattern: "foo@example.com",
    subjectPattern: deriveSubjectPattern("Daily build"),
  });

  const processor = new TagProcessor({
    model: "x",
    feedbackRules: feedback,
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        classification: {
          categoryId: "important",
          reason: "VP escalation",
          confidence: 0.92,
        },
        tags: [{ name: "待回复", confidence: 0.9, source: "ai" }],
      }),
      finishReason: "stop",
    })),
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TagResult;

  assert.ok(result.classification);
  // 'important' was suppressed; fallback derives from non-suppressed tags
  // — '待回复' isn't a system category id, so we land on 'other'.
  assert.notEqual(result.classification.categoryId, "important");
});

test("TAG_PROCESSOR_VERSION reflects the WP C schema bump", () => {
  // Sanity guard: any future schema change MUST bump this version
  // so observability / quality eval knows when results are comparable.
  assert.equal(TAG_PROCESSOR_VERSION >= 2, true);
});

// ── Workspace injection (Codex review #2 regression guard) ──────────

test("TagProcessor: undefined workspace yields a baseline user message without [CATEGORIES_CUSTOM_MD]", async () => {
  const { feedback } = makeRepo();
  let captured = "";
  const processor = new TagProcessor({
    model: "gpt-4o-mini",
    feedbackRules: feedback,
    llmClient: fakeClient(async (req) => {
      captured = (req as { messages: Array<{ content: string }> }).messages[0].content;
      return {
        text: JSON.stringify({
          classification: {
            categoryId: "notification",
            reason: "test",
            confidence: 0.9,
          },
          tags: [{ name: "通知", confidence: 0.8, source: "ai" }],
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });
  await processor.handle(makeJob(), makeCtx(makeMessage()));
  assert.ok(!captured.includes("CATEGORIES_CUSTOM_MD"), "baseline must not include workspace block");
});

test("TagProcessor: ctx.workspace injects <<<CATEGORIES_CUSTOM_MD>>> block into user message", async () => {
  const { feedback } = makeRepo();
  let captured = "";
  const processor = new TagProcessor({
    model: "gpt-4o-mini",
    feedbackRules: feedback,
    llmClient: fakeClient(async (req) => {
      captured = (req as { messages: Array<{ content: string }> }).messages[0].content;
      return {
        text: JSON.stringify({
          classification: {
            categoryId: "notification",
            reason: "test",
            confidence: 0.9,
          },
          tags: [{ name: "通知", confidence: 0.8, source: "ai" }],
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });
  await processor.handle(
    makeJob(),
    makeCtx(makeMessage(), {
      sections: [
        {
          path: "categories/custom.md",
          content: "招聘 — 把任何提到候选人简历或面试安排的邮件归到 important。",
        },
      ],
      totalTokenEstimate: 24,
      truncated: false,
    }),
  );
  assert.ok(
    captured.includes("<<<CATEGORIES_CUSTOM_MD>>>"),
    "workspace block header must reach the LLM request",
  );
  assert.ok(
    captured.includes("招聘 — 把任何提到候选人"),
    "workspace content must be preserved verbatim in the user message",
  );
});
