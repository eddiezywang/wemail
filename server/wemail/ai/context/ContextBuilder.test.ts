import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextBuilderInput } from "../../../../shared/wemail/intelligence.js";
import {
  ContextBuilder,
  estimateTokens,
  htmlToAiMarkdown,
  resolveAiBodyText,
  stripHtml,
  DEFAULT_BODY_CHAR_BUDGET,
} from "./ContextBuilder.js";

test("ContextBuilder produces sections with ids and token estimates", () => {
  const builder = new ContextBuilder({ feature: "summary" });
  const result = builder.build({
    subject: "Q3 plans",
    from: "Boss <boss@x.com>",
    bodyText: "Please prepare the Q3 deck by Friday.",
  });

  assert.ok(result.promptText.length > 0);
  assert.ok(result.sections.length >= 1);
  assert.ok(result.contextRefs.length >= 1);
  assert.ok(result.totalTokenEstimate > 0);
  // Each section should have an id and token estimate
  for (const section of result.sections) {
    assert.ok(section.id.length > 0);
    assert.ok(section.tokenEstimate >= 0);
  }
});

test("ContextBuilder includes header section with subject and from", () => {
  const builder = new ContextBuilder({ feature: "summary" });
  const result = builder.build({
    subject: "Meeting tomorrow",
    from: "alice@example.com",
  });

  const headerSection = result.sections.find((s) => s.id === "header");
  assert.ok(headerSection, "should have a header section");
  assert.ok(result.contextRefs.includes("header"));
});

test("ContextBuilder includes body-text section when bodyText provided", () => {
  const builder = new ContextBuilder({ feature: "summary" });
  const result = builder.build({
    subject: "Test",
    bodyText: "Hello world",
  });

  const bodySection = result.sections.find((s) => s.id === "body-text");
  assert.ok(bodySection, "should have a body-text section");
  assert.ok(result.contextRefs.includes("body-text"));
});

test("ContextBuilder falls back to Markdown when no bodyText", () => {
  const builder = new ContextBuilder({ feature: "summary" });
  const result = builder.build({
    subject: "Test",
    bodyHtml: "<p>Hello <b>world</b></p>",
  });

  const htmlSection = result.sections.find((s) => s.id === "body-html-stripped");
  assert.ok(htmlSection, "should have a body-html-stripped section");
  assert.ok(result.contextRefs.includes("body-html-stripped"));
  // Keep the stable section id while the body becomes structured Markdown.
  assert.ok(!result.promptText.includes("<p>"));
  assert.ok(result.promptText.includes("Hello **world**"));
});

test("ContextBuilder falls back to snippet when no body", () => {
  const builder = new ContextBuilder({ feature: "tags" });
  const result = builder.build({
    subject: "Test",
    snippet: "Brief preview of the email",
  });

  const snippetSection = result.sections.find((s) => s.id === "snippet");
  assert.ok(snippetSection, "should have a snippet section");
  assert.ok(result.contextRefs.includes("snippet"));
});

test("ContextBuilder truncates long body text", () => {
  const longBody = "A".repeat(DEFAULT_BODY_CHAR_BUDGET + 1000);
  const builder = new ContextBuilder({ feature: "summary" });
  const result = builder.build({
    subject: "Long email",
    bodyText: longBody,
  });

  assert.equal(result.truncated, true);
  // The prompt should not contain the full un-truncated body
  assert.ok(result.promptText.length < longBody.length);
});

test("ContextBuilder marks not-truncated for short input", () => {
  const builder = new ContextBuilder({ feature: "summary" });
  const result = builder.build({
    subject: "Short",
    bodyText: "Hello",
  });
  assert.equal(result.truncated, false);
});

test("ContextBuilder respects custom bodyCharBudget", () => {
  const body = "B".repeat(200);
  const builder = new ContextBuilder({ feature: "summary", bodyCharBudget: 100 });
  const result = builder.build({
    subject: "Test",
    bodyText: body,
  });
  assert.equal(result.truncated, true);
});

test("estimateTokens returns reasonable estimate", () => {
  // Rough rule: ~4 chars per token
  const text = "Hello world this is a test";
  const tokens = estimateTokens(text);
  assert.ok(tokens > 0);
  assert.ok(tokens < text.length); // tokens should be fewer than chars
});

test("estimateTokens handles empty string", () => {
  assert.equal(estimateTokens(""), 0);
});

test("estimateTokens counts CJK chars closer to one token each", () => {
  // CJK chars are ~1 token/char in real tokenizers; the estimator must
  // not under-count them at the old 4-chars-per-token rate.
  const cjk = "这是一封中文邮件正文内容示例";
  const cjkTokens = estimateTokens(cjk);
  assert.ok(cjkTokens >= cjk.length * 0.9, `CJK under-counted: ${cjkTokens}`);
  // Latin text estimates far fewer tokens per character (~4 chars/token
  // vs ~1 token/char). Compare per-char rates: absolute totals can tie on
  // boundary lengths (e.g. 54 latin chars also estimate to 14 tokens).
  const latin = "This is a plain English paragraph for comparison only";
  const latinPerChar = estimateTokens(latin) / latin.length;
  const cjkPerChar = cjkTokens / cjk.length;
  assert.ok(
    latinPerChar < cjkPerChar,
    `Latin per-char rate not lower: ${latinPerChar} vs ${cjkPerChar}`,
  );
});

test("htmlToAiMarkdown removes non-content and preserves mail structure", () => {
  const html = '<p>Hello <img src="cid:tracking-pixel" alt="banner"> <b>world</b> &amp; <a href="x">link</a></p><svg><text>noise</text></svg>';
  const markdown = htmlToAiMarkdown(html);
  assert.ok(!markdown.includes("<p>"));
  assert.ok(!markdown.includes("tracking-pixel"));
  assert.ok(!markdown.includes("noise"));
  assert.ok(markdown.includes("Hello **world** & [link](x)"));
  assert.equal(stripHtml(html), markdown);
});

test("htmlToAiMarkdown removes hidden content and emits compact tab-separated data tables", () => {
  const markdown = htmlToAiMarkdown([
    "<!DOCTYPE html>",
    '<div hidden>hidden preview</div>',
    '<div style="mso-hide:all">marketing preview</div>',
    '<v:rect><v:textbox>VML noise</v:textbox></v:rect>',
    '<table role="presentation"><tr><td><h2>Monthly report</h2></td></tr></table>',
    "<!doctype HTML>",
    '<table><tr><th>Metric</th><th>Value</th></tr><tr><td>Rule</td><td>$timestamp<=$end_time</td></tr></table>',
  ].join(""));

  assert.ok(!markdown.includes("hidden preview"));
  assert.ok(!markdown.includes("marketing preview"));
  assert.ok(!markdown.includes("VML noise"));
  assert.ok(!markdown.toLowerCase().includes("doctype"));
  assert.ok(markdown.includes("## Monthly report"));
  assert.ok(markdown.includes("Metric\tValue\nRule\t$timestamp<=$end\\_time"));
  assert.ok(!markdown.includes("|---"));
});

test("resolveAiBodyText prefers text and converts image-only HTML to empty text", () => {
  assert.equal(
    resolveAiBodyText({ bodyText: "Plain body", bodyHtml: "<p>HTML body</p>" }).text,
    "Plain body",
  );
  assert.equal(
    resolveAiBodyText({ bodyHtml: '<img src="cid:banner" alt="promotion">' }).text,
    "",
  );
});

test("ContextBuilder log metadata does not contain prompt body or mail body", () => {
  const builder = new ContextBuilder({ feature: "summary" });
  const result = builder.build({
    subject: "Test subject",
    from: "sender@example.com",
    bodyText: "SENSITIVE_MAIL_BODY_SENTINEL",
    bodyHtml: "<p>SENSITIVE_HTML_SENTINEL</p>",
  });

  // The sections/contextRefs are safe for logging — they only contain ids and counts
  const loggableMeta = {
    sections: result.sections,
    contextRefs: result.contextRefs,
    totalTokenEstimate: result.totalTokenEstimate,
    truncated: result.truncated,
  };
  const serialized = JSON.stringify(loggableMeta);
  assert.ok(!serialized.includes("SENSITIVE_MAIL_BODY_SENTINEL"), "log metadata must not contain mail body");
  assert.ok(!serialized.includes("SENSITIVE_HTML_SENTINEL"), "log metadata must not contain html body");
  assert.ok(!serialized.includes("Test subject"), "log metadata must not contain subject");
  assert.ok(!serialized.includes("sender@example.com"), "log metadata must not contain sender");
});

test("ContextBuilder feature-specific context for tags includes snippet", () => {
  const builder = new ContextBuilder({ feature: "tags" });
  const result = builder.build({
    subject: "Build #12",
    from: "ci@example.com",
    snippet: "Build passed",
    bodyText: "Build number 12 passed all checks.",
  });

  // Tags feature should include both snippet and body sections
  assert.ok(result.contextRefs.includes("snippet"));
  assert.ok(result.contextRefs.includes("body-text"));
});

test("ContextBuilder feature-specific context for summary does not require snippet", () => {
  const builder = new ContextBuilder({ feature: "summary" });
  const result = builder.build({
    subject: "Hello",
    bodyText: "World",
  });

  // Summary does not need snippet section
  assert.ok(!result.contextRefs.includes("snippet"));
});
