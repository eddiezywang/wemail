import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_TAGS, TAG_SYSTEM_CATEGORY_IDS } from "../ai/prompts/tagPrompt.js";
import {
  ALL_CATEGORIES,
  ALL_SAMPLES,
  getAllSamples,
  getSampleByCategory,
  mailSamples,
  type SampleCategory,
} from "./mailSamples.js";

test("mailSamples covers every phase-one category at least once", () => {
  const covered = new Set<SampleCategory>(mailSamples.map((s) => s.category));
  for (const cat of ALL_CATEGORIES) {
    assert.ok(covered.has(cat), `missing sample for category "${cat}"`);
  }
  assert.equal(covered.size, ALL_CATEGORIES.length);
});

test("mailSamples entries respect basic invariants", () => {
  for (const entry of mailSamples) {
    const { mail } = entry;
    assert.ok(mail.from.email.length > 0, `${entry.id}: from email must be non-empty`);
    assert.ok(mail.subject.length <= 998, `${entry.id}: subject exceeds RFC 5322 998-char limit`);
    assert.equal(typeof mail.flags, "object");
    assert.equal(typeof mail.flags.seen, "boolean");
    assert.equal(typeof mail.flags.flagged, "boolean");
    assert.equal(typeof mail.flags.answered, "boolean");
    assert.equal(typeof mail.flags.draft, "boolean");
    // Triple CRLF would indicate an unparsed header leak from a raw RFC822 blob.
    if (mail.bodyText) {
      assert.ok(!mail.bodyText.includes("\r\n\r\n\r\n"), `${entry.id}: bodyText contains header leak`);
    }
    if (mail.bodyHtml) {
      assert.ok(!mail.bodyHtml.includes("\r\n\r\n\r\n"), `${entry.id}: bodyHtml contains header leak`);
    }
    // hasAttachments must match attachments array length.
    assert.equal(mail.hasAttachments, mail.attachments.length > 0, `${entry.id}: hasAttachments mismatch`);
  }
});

test("mailSamples bodies are under 2 KB each (repo-lean invariant)", () => {
  for (const entry of mailSamples) {
    const size = Buffer.byteLength(entry.mail.bodyText ?? "", "utf8");
    assert.ok(size <= 2048, `${entry.id}: bodyText is ${size} bytes (>2KB)`);
  }
});

test("prompt-injection sample carries override directives in subject and body", () => {
  const mail = getSampleByCategory("prompt_injection");
  const subjectLc = mail.subject.toLowerCase();
  const bodyLc = (mail.bodyText ?? "").toLowerCase();
  assert.match(subjectLc, /ignore previous instructions/);
  assert.match(bodyLc, /ignore all previous instructions/);
});

test("getAllSamples returns one MailMessage per registered sample", () => {
  const all = getAllSamples();
  assert.equal(all.length, mailSamples.length);
  assert.equal(all.length, ALL_SAMPLES.length);
});

test("getSampleByCategory throws for an unknown category", () => {
  assert.throws(
    () => getSampleByCategory("does-not-exist" as SampleCategory),
    /No sample registered/,
  );
});

test("mailSamples roster has at least 30 entries", () => {
  assert.ok(
    mailSamples.length >= 30,
    `expected ≥30 mail samples, got ${mailSamples.length}`,
  );
});

test("mailSamples sample ids are unique", () => {
  const ids = mailSamples.map((s) => s.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, "duplicate sample id detected");
});

test("mailSamples sync UIDs are unique", () => {
  const uids = mailSamples.map((s) => s.mail.sync.uid);
  const unique = new Set(uids);
  assert.equal(unique.size, uids.length, "duplicate sync.uid detected");
});

test("mailSamples expected.primaryTag values are in BUILTIN_TAGS", () => {
  const allowed = new Set(BUILTIN_TAGS);
  for (const entry of mailSamples) {
    const tag = entry.expected?.primaryTag;
    if (tag === undefined) continue;
    assert.ok(
      allowed.has(tag),
      `${entry.id}: expected.primaryTag "${tag}" is not in BUILTIN_TAGS`,
    );
  }
});

test("mailSamples expected.categoryId values are in TAG_SYSTEM_CATEGORY_IDS", () => {
  const allowed = new Set(TAG_SYSTEM_CATEGORY_IDS);
  for (const entry of mailSamples) {
    const cat = entry.expected?.categoryId;
    if (cat === undefined) continue;
    assert.ok(
      allowed.has(cat),
      `${entry.id}: expected.categoryId "${cat}" is not in TAG_SYSTEM_CATEGORY_IDS`,
    );
  }
});

test("mailSamples expected.urgency values are low|medium|high", () => {
  const allowed = new Set(["low", "medium", "high"]);
  for (const entry of mailSamples) {
    const urgency = entry.expected?.urgency;
    if (urgency === undefined) continue;
    assert.ok(
      allowed.has(urgency),
      `${entry.id}: expected.urgency "${urgency}" is not low|medium|high`,
    );
  }
});

test("mailSamples expected bullet bounds are coherent when both set", () => {
  for (const entry of mailSamples) {
    const min = entry.expected?.minSummaryBullets;
    const max = entry.expected?.maxSummaryBullets;
    if (typeof min === "number") {
      assert.ok(min >= 0, `${entry.id}: minSummaryBullets must be ≥0`);
    }
    if (typeof max === "number") {
      assert.ok(max >= 0, `${entry.id}: maxSummaryBullets must be ≥0`);
    }
    if (typeof min === "number" && typeof max === "number") {
      assert.ok(
        min <= max,
        `${entry.id}: minSummaryBullets (${min}) > maxSummaryBullets (${max})`,
      );
    }
  }
});

test("mailSamples expected.todoCount is a non-negative integer when present", () => {
  for (const entry of mailSamples) {
    const count = entry.expected?.todoCount;
    if (count === undefined) continue;
    assert.equal(typeof count, "number");
    assert.ok(Number.isInteger(count), `${entry.id}: todoCount must be integer`);
    assert.ok(count >= 0, `${entry.id}: todoCount must be ≥0`);
  }
});
