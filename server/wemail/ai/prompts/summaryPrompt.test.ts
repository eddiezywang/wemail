import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  SUMMARY_JSON_SCHEMA,
  SUMMARY_SYSTEM_PROMPT,
  THREAD_SUMMARY_JSON_SCHEMA,
  THREAD_SUMMARY_SYSTEM_PROMPT,
  buildSummaryUserMessage,
  buildThreadSummaryUserMessage,
} from "./summaryPrompt.js";

test("SUMMARY_SYSTEM_PROMPT is a frozen non-empty string", () => {
  assert.equal(typeof SUMMARY_SYSTEM_PROMPT, "string");
  assert.ok(SUMMARY_SYSTEM_PROMPT.length > 50);
});

test("SUMMARY_JSON_SCHEMA requires bullets/actionItems/urgency", () => {
  const schema = SUMMARY_JSON_SCHEMA as {
    required: string[];
    properties: Record<string, any>;
  };
  assert.ok(schema.required.includes("bullets"));
  assert.ok(schema.required.includes("actionItems"));
  assert.ok(schema.required.includes("urgency"));
  assert.ok(schema.required.includes("ctas"));
  assert.ok(schema.properties.bullets);
  assert.ok(schema.properties.urgency);
  assert.equal(schema.properties.bullets.minItems, 1);
  assert.equal(schema.properties.bullets.maxItems, 4);
  assert.equal(schema.properties.actionItems.maxItems, 1);
  assert.equal(schema.properties.ctas.maxItems, 3);
  assert.deepEqual(schema.properties.ctas.items.required, ["i", "l", "c"]);
  assert.match(SUMMARY_SYSTEM_PROMPT, /Chinese|中文/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /320/);
});

test("SUMMARY_JSON_SCHEMA requires intent-aware v3 summary and data insight fields", () => {
  const schema = SUMMARY_JSON_SCHEMA as {
    required: string[];
    properties: Record<string, any>;
  };
  assert.ok(schema.required.includes("schemaVersion"));
  assert.ok(schema.required.includes("intent"));
  assert.ok(schema.required.includes("attention"));
  assert.ok(schema.required.includes("displayMode"));
  assert.ok(schema.required.includes("headline"));
  assert.ok(schema.required.includes("details"));
  assert.ok(schema.required.includes("actions"));
  assert.ok(schema.required.includes("actionObligation"));
  assert.ok(schema.required.includes("dataInsight"));
  assert.equal(schema.properties.schemaVersion.const, 3);
  assert.ok(schema.properties.dataInsight);
  assert.deepEqual(schema.properties.actionObligation.enum, [
    "none",
    "required",
    "recommended",
    "optional",
  ]);
  assert.deepEqual(schema.properties.displayMode.enum.sort(), [
    "actionable",
    "brief",
    "one_line",
    "thread",
  ]);
});

test("SUMMARY_SYSTEM_PROMPT includes low-attention summary policy", () => {
  assert.match(SUMMARY_SYSTEM_PROMPT, /attention/i);
  assert.match(SUMMARY_SYSTEM_PROMPT, /one_line/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /invoice/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /receipt/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /system_notice/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /can download/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /not actions/i);
});

test("SUMMARY_SYSTEM_PROMPT and schema enforce density-first summaries", () => {
  const schema = SUMMARY_JSON_SCHEMA as {
    properties: Record<string, any>;
  };
  assert.equal(schema.properties.details.maxItems, 1);
  assert.equal(schema.properties.actions.maxItems, 1);
  assert.equal(schema.properties.actionItems.maxItems, 1);
  assert.match(SUMMARY_SYSTEM_PROMPT, /decision cue/i);
  assert.match(SUMMARY_SYSTEM_PROMPT, /Default to one sentence/i);
  assert.match(SUMMARY_SYSTEM_PROMPT, /not a rewritten version/i);
  assert.match(SUMMARY_SYSTEM_PROMPT, /at most one detail/i);
  assert.match(SUMMARY_SYSTEM_PROMPT, /at most one action/i);
});

test("buildSummaryUserMessage includes subject, from, body; falls back when empty", () => {
  const msg = buildSummaryUserMessage({
    subject: "Q3",
    from: { email: "boss@x.com", name: "Boss" },
    bodyText: "plan the deck",
  });
  assert.ok(msg.includes("Subject: Q3"));
  assert.ok(msg.includes("From: Boss <boss@x.com>"));
  assert.ok(msg.includes("plan the deck"));

  const empty = buildSummaryUserMessage({ subject: "", from: undefined });
  assert.ok(empty.includes("(no subject)"));
  assert.ok(empty.includes("(unknown sender)"));
  assert.ok(empty.includes("(empty body)"));
});

test("buildSummaryUserMessage converts HTML to Markdown when only bodyHtml is present", () => {
  const msg = buildSummaryUserMessage({
    subject: "hi",
    from: "x@y.com",
    bodyHtml: "<div><p>hello <b>world</b></p><script>evil()</script></div>",
  });
  assert.ok(msg.includes("hello **world**"));
  assert.ok(!msg.includes("<p>"));
  assert.ok(!msg.includes("evil()"));
});

test("summaryPrompt module exposes no dynamic-override symbols", () => {
  // Asserts there is no per-user / runtime prompt setter. Keeps the
  // "one fixed summary prompt" constraint (Handoff §2) machine-checked.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "summaryPrompt.ts"), "utf8");
  assert.ok(!/set[A-Z]\w*Prompt/.test(source), "no setter for the prompt");
  assert.ok(!/overridePrompt|customPrompt|setSystemPrompt/i.test(source));
});

// ── Thread summary prompt tests ────────────────────────────────────

test("THREAD_SUMMARY_SYSTEM_PROMPT is a frozen non-empty string mentioning thread", () => {
  assert.equal(typeof THREAD_SUMMARY_SYSTEM_PROMPT, "string");
  assert.ok(THREAD_SUMMARY_SYSTEM_PROMPT.length > 50);
  assert.ok(THREAD_SUMMARY_SYSTEM_PROMPT.includes("thread"), "should mention thread");
  assert.ok(Object.isFrozen(THREAD_SUMMARY_SYSTEM_PROMPT));
});

test("THREAD_SUMMARY_JSON_SCHEMA requires bullets/actionItems/urgency/evidenceRefs", () => {
  const schema = THREAD_SUMMARY_JSON_SCHEMA as {
    required: string[];
    properties: Record<string, any>;
  };
  assert.deepEqual(
    [...schema.required].sort(),
    ["actionItems", "bullets", "evidenceRefs", "urgency"],
  );
  assert.ok(schema.properties.bullets);
  assert.ok(schema.properties.urgency);
  assert.ok(schema.properties.evidenceRefs);
  assert.ok(schema.properties.risks);
  assert.ok(schema.properties.openQuestions);
  assert.equal(schema.properties.bullets.minItems, 1);
  assert.equal(schema.properties.bullets.maxItems, 4);
  assert.equal(schema.properties.actionItems.maxItems, 3);
  assert.match(THREAD_SUMMARY_SYSTEM_PROMPT, /Chinese|中文/);
  assert.match(THREAD_SUMMARY_SYSTEM_PROMPT, /320/);
});

test("THREAD_SUMMARY_JSON_SCHEMA actionItems have text and evidenceRefs", () => {
  const schema = THREAD_SUMMARY_JSON_SCHEMA as {
    properties: Record<string, any>;
  };
  const actionItemsSchema = schema.properties.actionItems;
  assert.equal(actionItemsSchema.type, "array");
  const itemSchema = actionItemsSchema.items;
  assert.equal(itemSchema.type, "object");
  assert.ok(itemSchema.properties.text, "actionItem should have text");
  assert.ok(itemSchema.properties.evidenceRefs, "actionItem should have evidenceRefs");
  assert.deepEqual(
    [...itemSchema.required].sort(),
    ["evidenceRefs", "text"],
  );
});

test("buildThreadSummaryUserMessage orders messages as provided", () => {
  // Note: chronological ordering is the caller's responsibility
  // (done in SummaryProcessor.handleThread). The prompt builder
  // preserves the order it receives.
  const msg = buildThreadSummaryUserMessage([
    {
      emailId: "msg-older",
      subject: "Earlier",
      from: "b@x.com",
      bodyText: "Older content",
      receivedAt: "2026-04-24T10:00:00Z",
    },
    {
      emailId: "msg-newer",
      subject: "Later",
      from: "a@x.com",
      bodyText: "Newer content",
      receivedAt: "2026-04-24T12:00:00Z",
    },
  ]);

  // Messages appear in the order given
  const olderIdx = msg.indexOf("Earlier");
  const newerIdx = msg.indexOf("Later");
  assert.ok(olderIdx < newerIdx, "messages should appear in the order provided");
  assert.ok(msg.includes("[thread-msg-0]"), "should include section id");
  assert.ok(msg.includes("[thread-msg-1]"), "should include section id");
});

test("buildThreadSummaryUserMessage includes language hint when non-English", () => {
  const msg = buildThreadSummaryUserMessage(
    [{
      emailId: "msg-1",
      subject: "Test",
      from: "a@x.com",
      bodyText: "Content",
      receivedAt: "2026-04-24T10:00:00Z",
    }],
    "Chinese",
  );

  assert.ok(msg.includes("Produce the summary in Chinese"), "should include language hint");
});

test("buildThreadSummaryUserMessage does not add language hint for English", () => {
  const msg = buildThreadSummaryUserMessage(
    [{
      emailId: "msg-1",
      subject: "Test",
      from: "a@x.com",
      bodyText: "Content",
      receivedAt: "2026-04-24T10:00:00Z",
    }],
    "English",
  );

  assert.ok(!msg.includes("Produce the summary in"), "should not include language hint for English");
});

test("buildThreadSummaryUserMessage handles empty body", () => {
  const msg = buildThreadSummaryUserMessage([
    {
      emailId: "msg-1",
      subject: "FYI",
      from: "a@x.com",
      bodyText: "",
      receivedAt: "2026-04-24T10:00:00Z",
    },
  ]);

  assert.ok(msg.includes("(empty body)"), "should show empty body placeholder");
});

test("buildThreadSummaryUserMessage truncates long body", () => {
  const longBody = "A".repeat(5000);
  const msg = buildThreadSummaryUserMessage([
    {
      emailId: "msg-1",
      subject: "Long",
      from: "a@x.com",
      bodyText: longBody,
      receivedAt: "2026-04-24T10:00:00Z",
    },
  ]);

  assert.ok(msg.includes("[... truncated ...]"), "should indicate truncation");
  assert.ok(msg.length < longBody.length + 200, "should be shorter than full body");
});

// ── Workspace injection (Route C / WP J.3) ──────────────────────────

test("buildSummaryUserMessage: workspace section is omitted when undefined", () => {
  const baseline = buildSummaryUserMessage({
    subject: "Q3",
    from: "boss@x.com",
    bodyText: "plan the deck",
  });
  const withEmpty = buildSummaryUserMessage(
    { subject: "Q3", from: "boss@x.com", bodyText: "plan the deck" },
    undefined,
  );
  assert.equal(withEmpty, baseline);
});

test("buildSummaryUserMessage: workspace section is omitted when all sections empty", () => {
  const baseline = buildSummaryUserMessage({
    subject: "Q3",
    from: "boss@x.com",
    bodyText: "plan the deck",
  });
  const withEmpty = buildSummaryUserMessage(
    { subject: "Q3", from: "boss@x.com", bodyText: "plan the deck" },
    {
      sections: [{ path: "style/voice.md", content: "" }],
      totalTokenEstimate: 0,
      truncated: false,
    },
  );
  assert.equal(withEmpty, baseline);
});

test("buildSummaryUserMessage: workspace section included when non-empty", () => {
  const msg = buildSummaryUserMessage(
    { subject: "Q3", from: "boss@x.com", bodyText: "plan the deck" },
    {
      sections: [{ path: "style/voice.md", content: "tone: terse" }],
      totalTokenEstimate: 3,
      truncated: false,
    },
  );
  assert.ok(msg.includes("<<<STYLE_VOICE_MD>>>"));
  assert.ok(msg.includes("tone: terse"));
});

test("buildThreadSummaryUserMessage: workspace section omitted when empty", () => {
  const baseline = buildThreadSummaryUserMessage(
    [{
      emailId: "m1",
      subject: "T",
      from: "a@x.com",
      bodyText: "x",
      receivedAt: "2026-04-24T10:00:00Z",
    }],
    "Chinese",
  );
  const withEmpty = buildThreadSummaryUserMessage(
    [{
      emailId: "m1",
      subject: "T",
      from: "a@x.com",
      bodyText: "x",
      receivedAt: "2026-04-24T10:00:00Z",
    }],
    "Chinese",
    undefined,
  );
  assert.equal(withEmpty, baseline);
});

test("buildThreadSummaryUserMessage: workspace section included when non-empty", () => {
  const msg = buildThreadSummaryUserMessage(
    [{
      emailId: "m1",
      subject: "T",
      from: "a@x.com",
      bodyText: "x",
      receivedAt: "2026-04-24T10:00:00Z",
    }],
    "Chinese",
    {
      sections: [{ path: "style/voice.md", content: "preferred tone" }],
      totalTokenEstimate: 4,
      truncated: false,
    },
  );
  assert.ok(msg.includes("<<<STYLE_VOICE_MD>>>"));
  assert.ok(msg.includes("preferred tone"));
});

// ── Enterprise framework guidance (Route C / WP D) ──────────────────

test("SUMMARY_SYSTEM_PROMPT mentions enterprise correspondence framing", () => {
  assert.ok(
    SUMMARY_SYSTEM_PROMPT.includes("enterprise correspondence"),
    "should frame email as enterprise correspondence",
  );
});

test("THREAD_SUMMARY_SYSTEM_PROMPT mentions enterprise correspondence framing", () => {
  assert.ok(
    THREAD_SUMMARY_SYSTEM_PROMPT.includes("enterprise correspondence"),
    "thread prompt should frame thread as enterprise correspondence",
  );
});

test("Both summary prompts reference <<<INBOX_OVERVIEW_MD>>> workspace block", () => {
  assert.ok(SUMMARY_SYSTEM_PROMPT.includes("<<<INBOX_OVERVIEW_MD>>>"));
  assert.ok(THREAD_SUMMARY_SYSTEM_PROMPT.includes("<<<INBOX_OVERVIEW_MD>>>"));
});

test("Both summary prompts forbid paraphrasing numbers/dates (verbatim rule)", () => {
  assert.ok(SUMMARY_SYSTEM_PROMPT.includes("verbatim"));
  assert.ok(THREAD_SUMMARY_SYSTEM_PROMPT.includes("verbatim"));
});

test("Both summary prompts enumerate enterprise intent categories", () => {
  for (const prompt of [SUMMARY_SYSTEM_PROMPT, THREAD_SUMMARY_SYSTEM_PROMPT]) {
    assert.ok(prompt.includes("decision request"), "should include decision request");
    assert.ok(prompt.includes("action request"), "should include action request");
    assert.ok(prompt.includes("meeting"), "should include meeting/scheduling");
  }
});
