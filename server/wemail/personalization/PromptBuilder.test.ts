import assert from "node:assert/strict";
import { test } from "node:test";
import type { LearningSummary } from "../../../shared/wemail/intelligence.js";
import type { AiProfileSettings } from "../../../shared/wemail/settings.js";
import { PromptBuilder, sanitizeForLog, LOG_FORBIDDEN_KEYS } from "./PromptBuilder.js";

test("PromptBuilder builds prompt with profile settings", () => {
  const builder = new PromptBuilder();
  const profile: AiProfileSettings = {
    userDisplayName: "Alice",
    assistantPreference: "concise",
    defaultSummaryLanguage: "en",
    defaultReplyTone: "formal",
    signaturePreference: "Best, Alice",
    importantContacts: ["bob@example.com"],
    updatedAt: "2026-04-26T12:00:00Z",
  };

  const result = builder.build({
    feature: "summary",
    profile,
    learningSummary: null,
    basePrompt: "Summarize the following email.",
  });

  assert.ok(result.promptText.includes("User name: Alice"));
  assert.ok(result.promptText.includes("Assistant style: concise"));
  assert.ok(result.promptText.includes("Summary language: en"));
  assert.ok(result.promptText.includes("Reply tone: formal"));
  assert.ok(result.promptText.includes("Signature preference: Best, Alice"));
  assert.ok(result.promptText.includes("Important contacts: bob@example.com"));
  assert.ok(result.promptText.includes("Summarize the following email."));
  assert.ok(result.meta.profileFieldsUsed.includes("userDisplayName"));
  assert.ok(result.meta.profileFieldsUsed.includes("assistantPreference"));
  assert.ok(result.meta.profileFieldsUsed.includes("defaultSummaryLanguage"));
  assert.ok(result.meta.profileFieldsUsed.includes("defaultReplyTone"));
  assert.ok(result.meta.profileFieldsUsed.includes("signaturePreference"));
  assert.ok(result.meta.profileFieldsUsed.includes("importantContacts"));
  assert.equal(result.meta.feature, "summary");
  assert.equal(result.meta.learningSummaryUsed, false);
});

test("PromptBuilder builds prompt with learning summary for tags", () => {
  const builder = new PromptBuilder();
  const learningSummary: LearningSummary = {
    feature: "tags",
    accountId: "acct-1",
    signals: { suppressedTags: ["newsletter", "marketing"] },
    updatedAt: "2026-04-26T12:00:00Z",
  };

  const result = builder.build({
    feature: "tags",
    profile: null,
    learningSummary,
    basePrompt: "Tag the following email.",
  });

  assert.ok(result.promptText.includes("newsletter"));
  assert.ok(result.promptText.includes("marketing"));
  assert.ok(result.promptText.includes("Avoid suggesting these tags"));
  assert.equal(result.meta.learningSummaryUsed, true);
});

test("PromptBuilder builds prompt with learning summary for replyDraft", () => {
  const builder = new PromptBuilder();
  const learningSummary: LearningSummary = {
    feature: "replyDraft",
    accountId: "acct-1",
    signals: {
      writingFeedback: { editCount: 5, acceptCount: 3, editRatio: 0.625 },
    },
    updatedAt: "2026-04-26T12:00:00Z",
  };

  const result = builder.build({
    feature: "replyDraft",
    profile: null,
    learningSummary,
    basePrompt: "Draft a reply.",
  });

  assert.ok(result.promptText.includes("Writing feedback"));
  assert.ok(result.promptText.includes("5 edits"));
  assert.ok(result.promptText.includes("3 accepts"));
  assert.equal(result.meta.learningSummaryUsed, true);
});

test("PromptBuilder builds prompt with learning summary for summary ratings", () => {
  const builder = new PromptBuilder();
  const learningSummary: LearningSummary = {
    feature: "summary",
    accountId: "acct-1",
    signals: { averageRating: 4.2 },
    updatedAt: "2026-04-26T12:00:00Z",
  };

  const result = builder.build({
    feature: "summary",
    profile: null,
    learningSummary,
    basePrompt: "Summarize.",
  });

  assert.ok(result.promptText.includes("4.2"));
  assert.equal(result.meta.learningSummaryUsed, true);
});

test("PromptBuilder meta does NOT include raw feedback text", () => {
  const builder = new PromptBuilder();
  const loggedEntries: Array<{ event: string; meta: Record<string, unknown> }> = [];

  const loggingBuilder = new PromptBuilder({
    logger: (event, meta) => loggedEntries.push({ event, meta }),
  });

  const learningSummary: LearningSummary = {
    feature: "tags",
    accountId: "acct-1",
    signals: { suppressedTags: ["newsletter"] },
    updatedAt: "2026-04-26T12:00:00Z",
  };

  loggingBuilder.build({
    feature: "tags",
    profile: null,
    learningSummary,
    basePrompt: "Tag this.",
  });

  assert.equal(loggedEntries.length, 1);
  const logEntry = loggedEntries[0]!;
  const serialized = JSON.stringify(logEntry.meta);

  // The log must NOT contain raw feedback text or the prompt text
  assert.ok(!serialized.includes("Tag this."), "Prompt text must not be in logs");
  assert.ok(!serialized.includes("newsletter"), "Learned tag names must not be in log metadata");
  // But it SHOULD contain safe metadata
  assert.equal(logEntry.meta.feature, "tags");
  assert.equal(logEntry.meta.version, 1);
  assert.equal(logEntry.meta.learningSummaryUsed, true);
});

test("PromptBuilder prompt text does NOT include raw private feedback text", () => {
  const builder = new PromptBuilder();
  const profile: AiProfileSettings = {
    userDisplayName: "Alice",
    updatedAt: "2026-04-26T12:00:00Z",
  };

  const result = builder.build({
    feature: "summary",
    profile,
    learningSummary: null,
    basePrompt: "Summarize the following email.",
  });

  // The prompt text should contain profile-derived preferences but NOT raw feedback text
  // (The prompt builder never has access to raw feedback text — it only sees
  // aggregated learning summaries.)
  const promptText = result.promptText;
  // Prompt text should not contain any of the forbidden raw feedback keys
  for (const key of LOG_FORBIDDEN_KEYS) {
    assert.ok(!promptText.toLowerCase().includes(key.toLowerCase()), `Prompt must not contain forbidden key: ${key}`);
  }
});

test("sanitizeForLog removes forbidden keys", () => {
  const obj = {
    feature: "tags",
    version: 1,
    bodyText: "SENSITIVE_BODY",
    rawResponse: "SENSITIVE_LLM_OUTPUT",
    feedbackText: "SENSITIVE_FEEDBACK",
    safe: "ok",
  };

  const sanitized = sanitizeForLog(obj);
  assert.equal((sanitized as any).bodyText, undefined);
  assert.equal((sanitized as any).rawResponse, undefined);
  assert.equal((sanitized as any).feedbackText, undefined);
  assert.equal((sanitized as any).feature, "tags");
  assert.equal((sanitized as any).safe, "ok");
});

test("sanitizeForLog removes nested forbidden keys", () => {
  const obj = {
    feature: "tags",
    nested: {
      bodyText: "NESTED_SENSITIVE",
      safe: "ok",
    },
  };

  const sanitized = sanitizeForLog(obj);
  const nested = (sanitized as any).nested as Record<string, unknown>;
  assert.equal(nested.bodyText, undefined);
  assert.equal(nested.safe, "ok");
});

test("PromptBuilder with no profile and no learning summary returns base prompt", () => {
  const builder = new PromptBuilder();

  const result = builder.build({
    feature: "summary",
    profile: null,
    learningSummary: null,
    basePrompt: "Summarize.",
  });

  assert.equal(result.promptText, "Summarize.");
  assert.equal(result.meta.profileFieldsUsed.length, 0);
  assert.equal(result.meta.learningSummaryUsed, false);
});

test("PromptBuilder logs only ids, feature, version, outcome", () => {
  const loggedEntries: Array<{ event: string; meta: Record<string, unknown> }> = [];
  const builder = new PromptBuilder({
    logger: (event, meta) => loggedEntries.push({ event, meta }),
  });

  const profile: AiProfileSettings = {
    userDisplayName: "Alice",
    defaultReplyTone: "casual",
    updatedAt: "2026-04-26T12:00:00Z",
  };

  builder.build({
    feature: "replyDraft",
    profile,
    learningSummary: null,
    basePrompt: "Draft a reply.",
  });

  assert.equal(loggedEntries.length, 1);
  const meta = loggedEntries[0]!.meta;
  // Log should contain only safe metadata fields
  assert.equal(meta.feature, "replyDraft");
  assert.equal(meta.version, 1);
  assert.ok(Array.isArray(meta.profileFieldsUsed));
  assert.equal(typeof meta.learningSummaryUsed, "boolean");
  // Log should NOT contain the prompt text or any sensitive content
  const serialized = JSON.stringify(meta);
  assert.ok(!serialized.includes("Draft a reply."), "Prompt text must not appear in log");
});
