import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  REPLY_DRAFT_JSON_SCHEMA,
  REPLY_DRAFT_SYSTEM_PROMPT,
  buildReplyDraftUserMessage,
} from "./replyDraftPrompt.js";

test("REPLY_DRAFT_SYSTEM_PROMPT is a non-empty string", () => {
  assert.equal(typeof REPLY_DRAFT_SYSTEM_PROMPT, "string");
  assert.ok(REPLY_DRAFT_SYSTEM_PROMPT.length > 50);
});

test("REPLY_DRAFT_SYSTEM_PROMPT encodes all three rules explicitly", () => {
  // Rule 1 — concise draft.
  assert.ok(
    /concise/i.test(REPLY_DRAFT_SYSTEM_PROMPT),
    "rule 1 must mention concise",
  );
  // Rule 2 — never auto-send / drafts only.
  assert.ok(
    /never auto-send|draft/i.test(REPLY_DRAFT_SYSTEM_PROMPT),
    "rule 2 must encode draft-only behavior",
  );
  // Rule 3 — no subject lines, headers, signatures, or send instructions.
  assert.ok(
    /subject lines|headers|signatures|send instructions/i.test(REPLY_DRAFT_SYSTEM_PROMPT),
    "rule 3 must prohibit subject lines, headers, signatures, or send instructions",
  );
});

test("REPLY_DRAFT_SYSTEM_PROMPT is frozen", () => {
  assert.ok(Object.isFrozen(REPLY_DRAFT_SYSTEM_PROMPT));
});

// ── Route C / WP E: workspace voice + do-dont rules ─────────────────

test("REPLY_DRAFT_SYSTEM_PROMPT encodes Rule 5 referencing <<<STYLE_VOICE_MD>>>", () => {
  assert.ok(
    /Rule 5/.test(REPLY_DRAFT_SYSTEM_PROMPT),
    "rule 5 must be present",
  );
  assert.ok(
    REPLY_DRAFT_SYSTEM_PROMPT.includes("<<<STYLE_VOICE_MD>>>"),
    "rule 5 must reference the <<<STYLE_VOICE_MD>>> block label",
  );
});

test("REPLY_DRAFT_SYSTEM_PROMPT encodes Rule 6 referencing <<<STYLE_DO_DONT_MD>>>", () => {
  assert.ok(
    /Rule 6/.test(REPLY_DRAFT_SYSTEM_PROMPT),
    "rule 6 must be present",
  );
  assert.ok(
    REPLY_DRAFT_SYSTEM_PROMPT.includes("<<<STYLE_DO_DONT_MD>>>"),
    "rule 6 must reference the <<<STYLE_DO_DONT_MD>>> block label",
  );
});

test("REPLY_DRAFT_SYSTEM_PROMPT requires do-not rules to be obeyed", () => {
  assert.ok(
    /do-not rules/i.test(REPLY_DRAFT_SYSTEM_PROMPT),
    "rule 6 must mention do-not rules guidance",
  );
});

test("REPLY_DRAFT_JSON_SCHEMA `required` array is unchanged regression guard", () => {
  const schema = REPLY_DRAFT_JSON_SCHEMA as { required: string[] };
  assert.deepEqual(schema.required, ["draftMarkdown", "variants"]);
});

test("REPLY_DRAFT_JSON_SCHEMA requires draftMarkdown and variants", () => {
  // The writing-suite (WP E precursor) made `variants` a required field
  // so the LLM must always produce 1–3 tone/length variants alongside
  // the canonical `draftMarkdown`. UI uses the variants for quick-reply
  // chips; `draftMarkdown` defaults to the neutral variant.
  const schema = REPLY_DRAFT_JSON_SCHEMA as {
    required: string[];
    properties: Record<string, { type: string }>;
  };
  assert.deepEqual([...schema.required].sort(), ["draftMarkdown", "variants"]);
  assert.equal(schema.properties.draftMarkdown!.type, "string");
  assert.equal(schema.properties.variants!.type, "array");
  assert.ok(Object.isFrozen(REPLY_DRAFT_JSON_SCHEMA));
});

test("buildReplyDraftUserMessage includes subject, from, recipient count", () => {
  const msg = buildReplyDraftUserMessage({
    subject: "Q3 sync",
    from: { email: "boss@x.com", name: "Boss" },
    to: [{ email: "me@x.com" }, { email: "peer@x.com" }],
    cc: [{ email: "c@x.com" }],
    bodyText: "Can you confirm the Q3 kickoff date?",
  });
  assert.ok(msg.includes("Subject: Q3 sync"));
  assert.ok(msg.includes("From: Boss <boss@x.com>"));
  assert.ok(msg.includes("Recipient count: 3"));
  assert.ok(msg.includes("Q3 kickoff"));
});

test("buildReplyDraftUserMessage converts HTML to Markdown when only bodyHtml is present", () => {
  const msg = buildReplyDraftUserMessage({
    subject: "hi",
    from: "x@y.com",
    bodyHtml: "<p>please <b>reply</b></p><script>evil()</script>",
  });
  assert.ok(msg.includes("please **reply**"));
  assert.ok(!msg.includes("<p>"));
  assert.ok(!msg.includes("evil()"));
});

test("buildReplyDraftUserMessage degrades gracefully on empty inputs", () => {
  const msg = buildReplyDraftUserMessage({});
  assert.ok(msg.includes("(no subject)"));
  assert.ok(msg.includes("(unknown sender)"));
  assert.ok(msg.includes("(empty body)"));
});

test("replyDraftPrompt module exposes no dynamic-override symbols", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "replyDraftPrompt.ts"), "utf8");
  assert.ok(!/set[A-Z]\w*Prompt/.test(source), "no setter for the prompt");
  assert.ok(!/overridePrompt|customPrompt|setSystemPrompt/i.test(source));
});

// ── Workspace injection (Route C / WP J.3) ──────────────────────────

test("buildReplyDraftUserMessage: workspace section omitted when undefined", () => {
  const baseline = buildReplyDraftUserMessage({
    subject: "Q3 sync",
    from: "boss@x.com",
    bodyText: "ping?",
  });
  const withEmpty = buildReplyDraftUserMessage(
    { subject: "Q3 sync", from: "boss@x.com", bodyText: "ping?" },
    undefined,
  );
  assert.equal(withEmpty, baseline);
});

test("buildReplyDraftUserMessage: workspace section omitted when sections empty", () => {
  const baseline = buildReplyDraftUserMessage({
    subject: "Q3 sync",
    from: "boss@x.com",
    bodyText: "ping?",
  });
  const withEmpty = buildReplyDraftUserMessage(
    { subject: "Q3 sync", from: "boss@x.com", bodyText: "ping?" },
    {
      sections: [
        { path: "style/voice.md", content: "" },
        { path: "style/do-dont.md", content: "" },
      ],
      totalTokenEstimate: 0,
      truncated: false,
    },
  );
  assert.equal(withEmpty, baseline);
});

test("buildReplyDraftUserMessage: workspace section included when non-empty", () => {
  const msg = buildReplyDraftUserMessage(
    { subject: "Q3 sync", from: "boss@x.com", bodyText: "ping?" },
    {
      sections: [
        { path: "style/voice.md", content: "tone: terse" },
        { path: "style/do-dont.md", content: "do: ack quickly" },
      ],
      totalTokenEstimate: 6,
      truncated: false,
    },
  );
  assert.ok(msg.includes("<<<STYLE_VOICE_MD>>>"));
  assert.ok(msg.includes("tone: terse"));
  assert.ok(msg.includes("<<<STYLE_DO_DONT_MD>>>"));
  assert.ok(msg.includes("do: ack quickly"));
});
