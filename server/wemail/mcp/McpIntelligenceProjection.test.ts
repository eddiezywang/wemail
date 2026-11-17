import assert from "node:assert/strict";
import test from "node:test";
import { toMcpIntelligence } from "./McpComposition.js";
import { WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME } from "./McpToolCatalog.js";
import { validateMcpSchema } from "./McpSchemaValidator.js";
import type { EmailIntelligenceState } from "../../../shared/wemail/intelligence.js";

const baseState: EmailIntelligenceState = {
  emailId: "mail-1",
  summary: {
    status: "succeeded",
    result: {
      type: "summary",
      bullets: Array.from({ length: 25 }, (_, i) => `bullet ${i} ${"x".repeat(600)}`),
      actionItems: ["do A", "do B"],
      urgency: "high",
      headline: "Important update",
    },
    canRetry: true,
  },
  tags: {
    status: "succeeded",
    result: {
      type: "tags",
      tags: Array.from({ length: 60 }, (_, i) => ({ name: `tag-${i}`, confidence: 0.9, source: "ai", tier: "auto" })),
    },
  },
  replyDecision: {
    status: "succeeded",
    result: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Action required".repeat(200),
      confidence: 0.8,
      priorityScore: 0.9,
      level: "high",
      replyRequired: true,
      signals: [],
    },
  },
  replyDraft: {
    status: "succeeded",
    result: {
      type: "replyDraft",
      draftMarkdown: "x".repeat(20_000),
      language: "en",
    },
  },
  todoExtraction: {
    status: "succeeded",
    result: { type: "todoExtraction", todos: Array.from({ length: 5 }, (_, i) => ({ title: `todo ${i}`, confidence: 0.5, status: "suggested" })) },
  },
  linkExtraction: {
    status: "succeeded",
    result: { type: "linkExtraction", links: [{ url: "https://a", actionText: "open", risk: false, category: "navigate", riskReasons: [] }], unsubscribeUrl: null },
  },
  translation: {
    status: "succeeded",
    result: { type: "translation", targetLanguage: "zh", translatedText: "y".repeat(20_000), cached: false },
  },
};

test("toMcpIntelligence projects only schema-allowed fields and validates", () => {
  const projected = toMcpIntelligence(baseState) as Record<string, any>;

  // No raw nested domains leak through.
  assert.ok(!("_metadata" in projected.summary), "summary _metadata must not leak");
  assert.ok(!("job" in projected.summary), "summary job must not leak");
  assert.ok(!("system" in projected.tags), "tags system must not leak");
  assert.ok(!("signals" in projected.replyDecision), "replyDecision signals must not leak");
  assert.ok(!("variants" in projected.replyDraft), "replyDraft variants must not leak");
  assert.ok(!("paragraphs" in projected.translation), "translation paragraphs must not leak");

  const schema = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("get_mail_intelligence")!.outputSchema;
  const issues = validateMcpSchema(schema, { intelligence: projected });
  assert.deepEqual(issues, [], "get_mail_intelligence output must validate");
});

test("toMcpIntelligence bounds arrays and truncates long text with flags", () => {
  const projected = toMcpIntelligence(baseState) as Record<string, any>;
  assert.equal(projected.summary.bullets.length, 20, "bullets capped at 20");
  assert.equal(projected.summary.actionItems.length, 2);
  assert.equal(projected.tags.tagNames.length, 50, "tagNames capped at 50");
  assert.equal(projected.replyDraft.draftMarkdown.length, 8000, "draftMarkdown truncated to 8000");
  assert.equal(projected.replyDraft.truncated, true, "draftMarkdown truncated flag set");
  assert.equal(projected.translation.translatedText, "y".repeat(8000));
  assert.equal(projected.translation.truncated, true);
});

test("toMcpIntelligence reports ready=false when capability has no result", () => {
  const projected = toMcpIntelligence({
    ...baseState,
    replyDraft: { status: "not-needed" },
    summary: { status: "pending" },
  }) as Record<string, any>;
  assert.equal(projected.summary.ready, false);
  assert.equal(projected.summary.bullets, undefined);
  assert.equal(projected.replyDraft.ready, false);
  assert.equal(projected.replyDraft.draftMarkdown, undefined);
});

test("toMcpIntelligence omits optional capabilities when absent", () => {
  const projected = toMcpIntelligence({
    emailId: "mail-1",
    summary: { status: "skipped" },
    tags: { status: "skipped" },
    replyDecision: { status: "skipped" },
    replyDraft: { status: "skipped" },
  });
  assert.ok(!("todoExtraction" in projected), "todoExtraction omitted when absent");
  assert.ok(!("linkExtraction" in projected), "linkExtraction omitted when absent");
  assert.ok(!("translation" in projected), "translation omitted when absent");
  const schema = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("get_mail_intelligence")!.outputSchema;
  assert.deepEqual(validateMcpSchema(schema, { intelligence: projected }), []);
});
