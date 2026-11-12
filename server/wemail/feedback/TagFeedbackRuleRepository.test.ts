import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TagResult } from "../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import { BUILTIN_TAGS } from "../ai/prompts/tagPrompt.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import {
  SUBJECT_PREFIX_LENGTH,
  TagFeedbackRuleRepository,
  deriveSenderPattern,
  deriveSubjectPattern,
} from "./TagFeedbackRuleRepository.js";

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-tfr-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1", email: "a@x.com" });
  return { db, repo: new TagFeedbackRuleRepository(db) };
}

function makeMail(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "acct-1:INBOX:1:200",
    accountId: "acct-1",
    folder: "INBOX",
    messageId: "<m-200@x.com>",
    from: { email: "foo@example.com", name: "Foo" },
    to: [{ email: "me@x.com" }],
    cc: [],
    bcc: [],
    subject: "Daily build #12",
    snippet: "",
    receivedAt: "2026-04-24T10:00:00Z",
    hasAttachments: false,
    attachments: [],
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: { uid: 1, uidValidity: 1, internalDate: "2026-04-24T10:00:00Z" },
    ...overrides,
  };
}

test("deriveSenderPattern lowercases and trims", () => {
  assert.equal(
    deriveSenderPattern({ email: "  FOO@Example.com  ", name: "Foo" }),
    "foo@example.com",
  );
  assert.equal(deriveSenderPattern(undefined), undefined);
});

test("deriveSubjectPattern trims and caps at SUBJECT_PREFIX_LENGTH", () => {
  const long = "Daily build #12345".padEnd(100, "x");
  const p = deriveSubjectPattern(long);
  assert.ok(p.length <= SUBJECT_PREFIX_LENGTH);
  assert.equal(p, long.toLowerCase().slice(0, SUBJECT_PREFIX_LENGTH));
});

test("addRejection + listRules round-trips a rule", () => {
  const { repo } = makeRepo();
  const rule = repo.addRejection({
    accountId: "acct-1",
    tagName: "通知",
    senderPattern: "foo@example.com",
    subjectPattern: deriveSubjectPattern("Daily build #12"),
    reason: "noise",
  });
  assert.equal(rule.tag, "通知");
  assert.equal(rule.action, "reject");

  const rules = repo.listRules("acct-1");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].tag, "通知");
  assert.equal(rules[0].senderPattern, "foo@example.com");
});

test("addRejection is idempotent under UNIQUE conflict", () => {
  const { repo } = makeRepo();
  repo.addRejection({
    accountId: "acct-1",
    tagName: "通知",
    senderPattern: "foo@example.com",
    subjectPattern: "daily build",
  });
  repo.addRejection({
    accountId: "acct-1",
    tagName: "通知",
    senderPattern: "foo@example.com",
    subjectPattern: "daily build",
  });
  assert.equal(repo.listRules("acct-1").length, 1);
});

test("removeRejection deletes the matching rule", () => {
  const { repo } = makeRepo();
  repo.addRejection({
    accountId: "acct-1",
    tagName: "通知",
    senderPattern: "foo@example.com",
    subjectPattern: "daily build",
  });
  const removed = repo.removeRejection({
    accountId: "acct-1",
    tagName: "通知",
    senderPattern: "foo@example.com",
    subjectPattern: "daily build",
  });
  assert.equal(removed, 1);
  assert.equal(repo.listRules("acct-1").length, 0);
});

test("findRulesForMail matches by sender + subject prefix", () => {
  const { repo } = makeRepo();
  repo.addRejection({
    accountId: "acct-1",
    tagName: "通知",
    senderPattern: "foo@example.com",
    subjectPattern: deriveSubjectPattern("Daily build"),
  });
  // Different subject prefix — should not match.
  repo.addRejection({
    accountId: "acct-1",
    tagName: "告警",
    senderPattern: "foo@example.com",
    subjectPattern: deriveSubjectPattern("Incident"),
  });

  const mail = makeMail({ subject: "Daily build #13" });
  const matched = repo.findRulesForMail(mail);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].tag, "通知");
});

test("findRulesForMail does NOT match a different sender", () => {
  const { repo } = makeRepo();
  repo.addRejection({
    accountId: "acct-1",
    tagName: "通知",
    senderPattern: "foo@example.com",
    subjectPattern: deriveSubjectPattern("Daily build"),
  });
  const mail = makeMail({
    from: { email: "other@example.com" },
    subject: "Daily build #13",
  });
  assert.equal(repo.findRulesForMail(mail).length, 0);
});

test("applyRules drops rejected tags and preserves dynamic tags", () => {
  const { repo } = makeRepo();
  repo.addRejection({
    accountId: "acct-1",
    tagName: "通知",
    senderPattern: "foo@example.com",
    subjectPattern: deriveSubjectPattern("Daily build"),
  });

  const mail = makeMail({ subject: "Daily build #13" });
  const raw: TagResult = {
    type: "tags",
    tags: [
      { name: "通知", confidence: 0.9, source: "ai", tier: "suggested" },
      { name: "日报", confidence: 0.8, source: "ai", tier: "suggested" },
      { name: "not-a-real-tag", confidence: 0.5, source: "ai", tier: "suggested" },
    ],
  };

  const out = repo.applyRules(raw, mail, BUILTIN_TAGS);
  assert.equal(out.droppedByRules, 1);
  assert.equal(out.dynamicTags, 1);
  assert.equal(out.droppedOffVocab, 0);
  assert.deepEqual(
    out.result.tags.map((t) => t.name),
    ["日报", "not-a-real-tag"],
  );
});

// ── Workspace feedback sink wiring (Route C / WP J.4) ────────────────

test("addRejection emits 'tag-reject' through the workspace sink", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-tfr-sink-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1", email: "a@x.com" });
  const calls: Array<{ type: string; event: Record<string, unknown> }> = [];
  const repo = new TagFeedbackRuleRepository(
    db,
    () => "2026-04-27T00:00:00Z",
    {
      append: async (type, event) => {
        calls.push({ type, event });
      },
    },
  );
  repo.addRejection({
    accountId: "acct-1",
    tagName: "通知",
    senderPattern: "boss@x.com",
    subjectPattern: "weekly status",
  });
  // Sink call is fire-and-forget; let the microtask drain.
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.type, "tag-reject");
  assert.equal(calls[0]!.event.tagName, "通知");
  assert.equal(calls[0]!.event.senderPattern, "boss@x.com");
});

test("removeRejection emits 'tag-accept' only when a row was actually deleted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-tfr-sink-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1", email: "a@x.com" });
  const calls: Array<{ type: string; event: Record<string, unknown> }> = [];
  const repo = new TagFeedbackRuleRepository(
    db,
    () => "2026-04-27T00:00:00Z",
    {
      append: async (type, event) => {
        calls.push({ type, event });
      },
    },
  );
  // No-op delete should NOT emit an accept event.
  repo.removeRejection({
    accountId: "acct-1",
    tagName: "通知",
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(
    calls.filter((c) => c.type === "tag-accept").length,
    0,
  );

  // After we add then remove, we should see one accept event.
  repo.addRejection({ accountId: "acct-1", tagName: "通知" });
  repo.removeRejection({ accountId: "acct-1", tagName: "通知" });
  await new Promise((r) => setImmediate(r));
  const accepts = calls.filter((c) => c.type === "tag-accept");
  assert.equal(accepts.length, 1);
  assert.equal(accepts[0]!.event.tagName, "通知");
});

test("TagFeedbackRuleRepository works without a feedbackSink", () => {
  // Smoke: the no-sink constructor path is still exercised by every
  // other test in this file (`makeRepo`). Asserting one mutation here
  // for clarity.
  const { repo } = makeRepo();
  const rule = repo.addRejection({ accountId: "acct-1", tagName: "通知" });
  assert.equal(rule.tag, "通知");
  // No throw, no crash, no requirement of a sink.
});
