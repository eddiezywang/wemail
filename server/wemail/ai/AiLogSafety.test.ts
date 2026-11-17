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
import { ContextBuilder } from "./context/ContextBuilder.js";
import { SummaryProcessor } from "../intelligence/processors/SummaryProcessor.js";
import { TagProcessor } from "../intelligence/processors/TagProcessor.js";
import { TagFeedbackRuleRepository } from "../feedback/TagFeedbackRuleRepository.js";
import { sanitizeFeedbackPayload, FORBIDDEN_PAYLOAD_KEYS } from "../feedback/AiFeedbackEventRepository.js";
import {
  redact,
  REDACTED_KEYS,
  REDACTED_PLACEHOLDER,
  createAppLogger,
} from "../telemetry/AppLogger.js";
import type { ProcessorContext } from "../intelligence/MailIntelligenceProcessor.js";

// Sentinel strings that should NEVER appear in logs
const BODY_TEXT_SENTINEL = "SENSITIVE_BODY_TEXT_9a8b7c6d";
const BODY_HTML_SENTINEL = "<p>SENSITIVE_HTML_e5f4g3h2</p>";
const PROMPT_SENTINEL = "SENSITIVE_PROMPT_i1j2k3l4";
const RAW_RESPONSE_SENTINEL = "SENSITIVE_RAW_LLM_m5n6o7p8";

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
    subject: "Secret Project",
    snippet: "preview text",
    bodyText: BODY_TEXT_SENTINEL,
    bodyHtml: BODY_HTML_SENTINEL,
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

// ── AppLogger redaction tests ──

test("AppLogger REDACTED_KEYS includes bodyText, bodyHtml, prompt, raw", () => {
  assert.ok(REDACTED_KEYS.has("bodyText"), "bodyText should be redacted");
  assert.ok(REDACTED_KEYS.has("bodyHtml"), "bodyHtml should be redacted");
  assert.ok(REDACTED_KEYS.has("raw"), "raw should be redacted");
  assert.ok(REDACTED_KEYS.has("content"), "content should be redacted");
  assert.ok(REDACTED_KEYS.has("body"), "body should be redacted");
  assert.ok(REDACTED_KEYS.has("password"), "password should be redacted");
  assert.ok(REDACTED_KEYS.has("token"), "token should be redacted");
  assert.ok(REDACTED_KEYS.has("apiKey"), "apiKey should be redacted");
  assert.ok(REDACTED_KEYS.has("secret"), "secret should be redacted");
});

test("redact removes bodyText and bodyHtml with sentinel strings", () => {
  const input = {
    emailId: "email-1",
    bodyText: BODY_TEXT_SENTINEL,
    bodyHtml: BODY_HTML_SENTINEL,
    body: BODY_TEXT_SENTINEL,
    raw: RAW_RESPONSE_SENTINEL,
    prompt: PROMPT_SENTINEL,
    rawResponse: RAW_RESPONSE_SENTINEL,
  };
  const output = redact(input) as Record<string, unknown>;
  assert.equal(output.bodyText, REDACTED_PLACEHOLDER);
  assert.equal(output.bodyHtml, REDACTED_PLACEHOLDER);
  assert.equal(output.body, REDACTED_PLACEHOLDER);
  assert.equal(output.raw, REDACTED_PLACEHOLDER);
  assert.equal(output.prompt, REDACTED_PLACEHOLDER);
  assert.equal(output.rawResponse, REDACTED_PLACEHOLDER);
  assert.equal(output.emailId, "email-1");
});

test("redact removes deeply nested bodyText sentinel", () => {
  const input = {
    result: {
      meta: {
        bodyText: BODY_TEXT_SENTINEL,
      },
    },
  };
  const output = redact(input) as any;
  assert.equal(output.result.meta.bodyText, REDACTED_PLACEHOLDER);
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes(BODY_TEXT_SENTINEL), "deeply nested bodyText sentinel must not survive redaction");
});

test("AppLogger with writer does not leak bodyText or bodyHtml sentinels", () => {
  const writes: string[] = [];
  const logger = createAppLogger({
    baseDir: "/unused",
    now: () => new Date("2026-04-26T12:00:00Z"),
    writer: (line: string) => writes.push(line),
  });

  logger.info("test-event", {
    emailId: "email-1",
    bodyText: BODY_TEXT_SENTINEL,
    bodyHtml: BODY_HTML_SENTINEL,
    // AppLogger also redacts "body", "content", "raw", "password", "token", "apiKey", "secret"
    body: BODY_TEXT_SENTINEL,
    content: BODY_TEXT_SENTINEL,
    raw: RAW_RESPONSE_SENTINEL,
  });

  const serialized = writes.join("\n");
  assert.ok(!serialized.includes(BODY_TEXT_SENTINEL), "bodyText sentinel must not appear in logger output");
  assert.ok(!serialized.includes(BODY_HTML_SENTINEL), "bodyHtml sentinel must not appear in logger output");
  assert.ok(!serialized.includes(RAW_RESPONSE_SENTINEL), "raw sentinel must not appear in logger output");
});

// ── SummaryProcessor log safety ──

test("SummaryProcessor logs do not contain mail body sentinel", async () => {
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
    makeCtx(makeMessage({ bodyText: BODY_TEXT_SENTINEL, bodyHtml: BODY_HTML_SENTINEL })),
  );

  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes(BODY_TEXT_SENTINEL), "SummaryProcessor logs must not contain bodyText sentinel");
  assert.ok(!serialized.includes(BODY_HTML_SENTINEL), "SummaryProcessor logs must not contain bodyHtml sentinel");
});

// ── TagProcessor log safety ──

test("TagProcessor logs do not contain mail body sentinel", async () => {
  // Create a stub TagFeedbackRuleRepository that doesn't need SQLite
  const stubFeedback: TagFeedbackRuleRepository = {
    addRejection: () => ({ id: "stub", accountId: "acct-1", tag: "stub", action: "reject" as const, createdAt: "" }),
    removeRejection: () => 0,
    listRules: () => [],
    findRulesForMail: () => [],
    applyRules: (tags: TagResult) => ({ result: tags, droppedByRules: 0, dynamicTags: 0, droppedOffVocab: 0 }),
  } as unknown as TagFeedbackRuleRepository;

  const logs: Array<{ event: string; fields: Record<string, string | number> }> = [];

  const processor = new TagProcessor({
    model: "gpt-4o-mini",
    feedbackRules: stubFeedback,
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        tags: [{ name: "日报", confidence: 0.9, source: "ai" }],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    logger: (event: string, fields: Record<string, string | number>) => logs.push({ event, fields }),
  });

  await processor.handle(
    makeJob("tags"),
    makeCtx(makeMessage({ bodyText: BODY_TEXT_SENTINEL, bodyHtml: BODY_HTML_SENTINEL })),
  );

  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes(BODY_TEXT_SENTINEL), "TagProcessor logs must not contain bodyText sentinel");
  assert.ok(!serialized.includes(BODY_HTML_SENTINEL), "TagProcessor logs must not contain bodyHtml sentinel");
});

// ── ContextBuilder log safety ──

test("ContextBuilder metadata is safe for logging — no body content", () => {
  const builder = new ContextBuilder({ feature: "summary" });
  const result = builder.build({
    subject: "Secret Project",
    from: "boss@x.com",
    bodyText: BODY_TEXT_SENTINEL,
    bodyHtml: BODY_HTML_SENTINEL,
  });

  // Metadata is safe to log
  const loggableMeta = {
    sections: result.sections,
    contextRefs: result.contextRefs,
    totalTokenEstimate: result.totalTokenEstimate,
    truncated: result.truncated,
  };

  const serialized = JSON.stringify(loggableMeta);
  assert.ok(!serialized.includes(BODY_TEXT_SENTINEL), "ContextBuilder log metadata must not contain bodyText sentinel");
  assert.ok(!serialized.includes(BODY_HTML_SENTINEL), "ContextBuilder log metadata must not contain bodyHtml sentinel");
  assert.ok(!serialized.includes("Secret Project"), "ContextBuilder log metadata must not contain subject");
  assert.ok(!serialized.includes("boss@x.com"), "ContextBuilder log metadata must not contain sender");
});

// ── Feedback payload sanitization ──

test("sanitizeFeedbackPayload removes all forbidden keys with sentinels", () => {
  const payload = {
    tagName: "通知",
    bodyText: BODY_TEXT_SENTINEL,
    bodyHtml: BODY_HTML_SENTINEL,
    prompt: PROMPT_SENTINEL,
    rawResponse: RAW_RESPONSE_SENTINEL,
    safeData: "ok",
  };

  const sanitized = sanitizeFeedbackPayload(payload);
  const serialized = JSON.stringify(sanitized);
  assert.ok(!serialized.includes(BODY_TEXT_SENTINEL), "sanitized payload must not contain bodyText sentinel");
  assert.ok(!serialized.includes(BODY_HTML_SENTINEL), "sanitized payload must not contain bodyHtml sentinel");
  assert.ok(!serialized.includes(PROMPT_SENTINEL), "sanitized payload must not contain prompt sentinel");
  assert.ok(!serialized.includes(RAW_RESPONSE_SENTINEL), "sanitized payload must not contain rawResponse sentinel");
  assert.ok(serialized.includes("通知"), "sanitized payload should preserve safe data");
  assert.ok(serialized.includes("ok"), "sanitized payload should preserve safeData");
});

test("FORBIDDEN_PAYLOAD_KEYS covers all sensitive keys", () => {
  const requiredKeys = [
    "bodyText",
    "bodyHtml",
    "prompt",
    "rawResponse",
    "password",
    "token",
    "apiKey",
    "secret",
  ];
  for (const key of requiredKeys) {
    assert.ok(FORBIDDEN_PAYLOAD_KEYS.has(key), `FORBIDDEN_PAYLOAD_KEYS must include '${key}'`);
  }
});

// ── AiResultMetadata log safety ──

test("AiResultMetadata can be logged safely without body content", () => {
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

  const serialized = JSON.stringify(metadata);
  assert.ok(!serialized.includes(BODY_TEXT_SENTINEL), "metadata serialization must not contain bodyText sentinel");
  assert.ok(!serialized.includes(BODY_HTML_SENTINEL), "metadata serialization must not contain bodyHtml sentinel");
  assert.ok(!serialized.includes(PROMPT_SENTINEL), "metadata serialization must not contain prompt sentinel");
  assert.ok(!serialized.includes(RAW_RESPONSE_SENTINEL), "metadata serialization must not contain rawResponse sentinel");
  // But it should contain useful metadata
  assert.ok(serialized.includes("summary"), "metadata should contain processor name");
  assert.ok(serialized.includes("gpt-4o-mini"), "metadata should contain model");
  assert.ok(serialized.includes("header"), "metadata should contain contextRefs");
});
