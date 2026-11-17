import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  BUILTIN_TAGS,
  TAG_JSON_SCHEMA,
  TAG_SYSTEM_PROMPT,
  buildTagUserMessage,
} from "./tagPrompt.js";

test("BUILTIN_TAGS contains the eight phase-one tags", () => {
  assert.deepEqual(
    [...BUILTIN_TAGS],
    ["通知", "待回复", "发布", "告警", "日报", "需求", "会议", "审批"],
  );
});

test("BUILTIN_TAGS is frozen", () => {
  assert.ok(Object.isFrozen(BUILTIN_TAGS));
});

test("TAG_SYSTEM_PROMPT defines the three independent enterprise signals", () => {
  assert.equal(typeof TAG_SYSTEM_PROMPT, "string");
  assert.ok(TAG_SYSTEM_PROMPT.length > 50);
  for (const signal of ["important", "actionRequired", "invoice"]) assert.ok(TAG_SYSTEM_PROMPT.includes(signal));
  assert.match(TAG_SYSTEM_PROMPT, /zero to three contentTags/);
  assert.match(TAG_SYSTEM_PROMPT, /Exclude payment receipts/);
});

test("TAG_JSON_SCHEMA requires system signals, content topics, and user tags", () => {
  const schema = TAG_JSON_SCHEMA as {
    required: string[];
    properties: {
      system: {
        properties: {
          important: { required: string[] };
          actionRequired: { required: string[] };
          invoice: { required: string[] };
        };
        required: string[];
      };
    };
  };
  assert.deepEqual([...schema.required].sort(), ["contentTags", "system", "tags"]);
  assert.deepEqual([...schema.properties.system.required].sort(), ["actionRequired", "important", "invoice"]);
});

test("TAG_JSON_SCHEMA leaves base user-tag enum empty until runtime augmentation", () => {
  const schema = TAG_JSON_SCHEMA as {
    properties: { tags: { items: { properties: { name: { enum: string[] } } } } };
  };
  const nameEnum = schema.properties.tags.items.properties.name.enum;
  assert.deepEqual(nameEnum, []);
});

test("buildTagUserMessage includes subject, from, and snippet fallback", () => {
  const msg = buildTagUserMessage({
    subject: "日报 2026-04-24",
    from: { email: "ops@x.com", name: "Ops" },
    snippet: "今日构建 10 次",
  });
  assert.ok(msg.includes("Subject: 日报 2026-04-24"));
  assert.ok(msg.includes("From: Ops <ops@x.com>"));
  assert.ok(msg.includes("今日构建 10 次"));

  const empty = buildTagUserMessage({ subject: "", from: undefined });
  assert.ok(empty.includes("(no subject)"));
  assert.ok(empty.includes("(unknown sender)"));
  assert.ok(empty.includes("(empty body)"));
});

test("buildTagUserMessage converts HTML to Markdown when only bodyHtml is present", () => {
  const msg = buildTagUserMessage({
    subject: "hi",
    from: "x@y.com",
    bodyHtml: "<div><p>hello <b>world</b></p><script>evil()</script></div>",
  });
  assert.ok(msg.includes("hello **world**"));
  assert.ok(!msg.includes("<p>"));
  assert.ok(!msg.includes("evil()"));
});

test("tagPrompt module exposes no dynamic-override symbols", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "tagPrompt.ts"), "utf8");
  assert.ok(!/set[A-Z]\w*Prompt/.test(source), "no setter for the prompt");
  assert.ok(!/overridePrompt|customPrompt|setSystemPrompt/i.test(source));
});

// ── Workspace injection (Route C / WP J.3) ──────────────────────────

test("buildTagUserMessage: workspace section omitted when undefined", () => {
  const baseline = buildTagUserMessage({
    subject: "日报 2026-04-24",
    from: "ops@x.com",
    snippet: "今日构建 10 次",
  });
  const withEmpty = buildTagUserMessage(
    { subject: "日报 2026-04-24", from: "ops@x.com", snippet: "今日构建 10 次" },
    undefined,
  );
  assert.equal(withEmpty, baseline);
});

test("buildTagUserMessage: workspace section omitted when sections empty", () => {
  const baseline = buildTagUserMessage({
    subject: "日报 2026-04-24",
    from: "ops@x.com",
    snippet: "今日构建 10 次",
  });
  const withEmpty = buildTagUserMessage(
    { subject: "日报 2026-04-24", from: "ops@x.com", snippet: "今日构建 10 次" },
    {
      sections: [{ path: "categories/custom.md", content: "" }],
      totalTokenEstimate: 0,
      truncated: false,
    },
  );
  assert.equal(withEmpty, baseline);
});

test("buildTagUserMessage: workspace section included when non-empty", () => {
  const msg = buildTagUserMessage(
    { subject: "X", from: "y@z.com", snippet: "hi" },
    {
      sections: [{ path: "categories/custom.md", content: "招聘 — recruitment" }],
      totalTokenEstimate: 4,
      truncated: false,
    },
  );
  assert.ok(msg.includes("<<<CATEGORIES_CUSTOM_MD>>>"));
  assert.ok(msg.includes("招聘 — recruitment"));
});
