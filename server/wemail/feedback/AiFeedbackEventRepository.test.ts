import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AiFeedbackEvent } from "../../../shared/wemail/intelligence.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import {
  AiFeedbackEventRepository,
  FORBIDDEN_PAYLOAD_KEYS,
  sanitizeFeedbackPayload,
} from "./AiFeedbackEventRepository.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-feedback-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1", email: "a@x.com" });
  return { db, dir };
}

test("AiFeedbackEventRepository saves and retrieves feedback events", () => {
  const { db, dir } = makeDb();
  const repo = new AiFeedbackEventRepository({ db, now: () => "2026-04-26T12:00:00.000Z" });

  repo.save({
    accountId: "acct-1",
    feature: "tags",
    eventType: "reject",
    emailId: "email-1",
    threadId: "thread-1",
    payload: { tagName: "通知", reason: "not applicable" },
  });

  const events = repo.findByAccount("acct-1");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.accountId, "acct-1");
  assert.equal(events[0]!.feature, "tags");
  assert.equal(events[0]!.eventType, "reject");
  assert.equal(events[0]!.emailId, "email-1");
  assert.equal(events[0]!.threadId, "thread-1");
  assert.deepEqual(events[0]!.payload, { tagName: "通知", reason: "not applicable" });
  assert.equal(events[0]!.createdAt, "2026-04-26T12:00:00.000Z");

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("AiFeedbackEventRepository filters by feature", () => {
  const { db, dir } = makeDb();
  const repo = new AiFeedbackEventRepository({ db, now: () => "2026-04-26T12:00:00.000Z" });

  repo.save({
    accountId: "acct-1",
    feature: "tags",
    eventType: "accept",
    payload: { tagName: "日报" },
  });
  repo.save({
    accountId: "acct-1",
    feature: "summary",
    eventType: "rate",
    payload: { rating: 4 },
  });

  const tagEvents = repo.findByAccount("acct-1", { feature: "tags" });
  assert.equal(tagEvents.length, 1);
  assert.equal(tagEvents[0]!.feature, "tags");

  const summaryEvents = repo.findByAccount("acct-1", { feature: "summary" });
  assert.equal(summaryEvents.length, 1);
  assert.equal(summaryEvents[0]!.feature, "summary");

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("AiFeedbackEventRepository filters by emailId", () => {
  const { db, dir } = makeDb();
  const repo = new AiFeedbackEventRepository({ db, now: () => "2026-04-26T12:00:00.000Z" });

  repo.save({
    accountId: "acct-1",
    feature: "tags",
    eventType: "reject",
    emailId: "email-1",
    payload: { tagName: "通知" },
  });
  repo.save({
    accountId: "acct-1",
    feature: "tags",
    eventType: "accept",
    emailId: "email-2",
    payload: { tagName: "日报" },
  });

  const events = repo.findByAccount("acct-1", { emailId: "email-1" });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.emailId, "email-1");

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sanitizeFeedbackPayload removes forbidden keys", () => {
  const payload = {
    tagName: "通知",
    bodyText: "SECRET_MAIL_BODY_SENTINEL",
    bodyHtml: "<p>SECRET_HTML_SENTINEL</p>",
    prompt: "SECRET_PROMPT_SENTINEL",
    rawResponse: "SECRET_RAW_LLM_SENTINEL",
    confidence: 0.9,
  };

  const sanitized = sanitizeFeedbackPayload(payload);
  assert.equal((sanitized as any).bodyText, undefined);
  assert.equal((sanitized as any).bodyHtml, undefined);
  assert.equal((sanitized as any).prompt, undefined);
  assert.equal((sanitized as any).rawResponse, undefined);
  assert.equal((sanitized as any).tagName, "通知");
  assert.equal((sanitized as any).confidence, 0.9);
});

test("sanitizeFeedbackPayload removes nested forbidden keys", () => {
  const payload = {
    tagName: "通知",
    nested: {
      bodyText: "NESTED_SECRET_BODY",
      safe: "ok",
    },
  };

  const sanitized = sanitizeFeedbackPayload(payload);
  const nested = (sanitized as any).nested as Record<string, unknown>;
  assert.equal(nested.bodyText, undefined);
  assert.equal(nested.safe, "ok");
});

test("sanitizeFeedbackPayload strips all FORBIDDEN_PAYLOAD_KEYS", () => {
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    const payload: Record<string, unknown> = { [key]: "should-be-removed", safe: "kept" };
    const sanitized = sanitizeFeedbackPayload(payload);
    assert.equal((sanitized as Record<string, unknown>)[key], undefined, `Expected ${key} to be removed`);
    assert.equal((sanitized as Record<string, unknown>).safe, "kept");
  }
});

test("AiFeedbackEventRepository save sanitizes payload automatically", () => {
  const { db, dir } = makeDb();
  const repo = new AiFeedbackEventRepository({ db, now: () => "2026-04-26T12:00:00.000Z" });

  repo.save({
    accountId: "acct-1",
    feature: "summary",
    eventType: "rate",
    emailId: "email-1",
    payload: {
      rating: 3,
      bodyText: "SECRET_MAIL_BODY_SENTINEL",
      bodyHtml: "<p>SECRET_HTML_SENTINEL</p>",
    },
  });

  const events = repo.findByAccount("acct-1");
  assert.equal(events.length, 1);
  assert.equal((events[0]!.payload as any).bodyText, undefined);
  assert.equal((events[0]!.payload as any).bodyHtml, undefined);
  assert.equal((events[0]!.payload as any).rating, 3);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("feedback events do not store body content — round-trip check", () => {
  const { db, dir } = makeDb();
  const repo = new AiFeedbackEventRepository({ db, now: () => "2026-04-26T12:00:00.000Z" });

  repo.save({
    accountId: "acct-1",
    feature: "tags",
    eventType: "reject",
    emailId: "email-1",
    payload: {
      tagName: "通知",
      bodyText: "SENSITIVE_MAIL_CONTENT",
      rawResponse: "SENSITIVE_LLM_OUTPUT",
    },
  });

  const events = repo.findByAccount("acct-1");
  const serialized = JSON.stringify(events);
  // The sentinel strings must NOT appear in the stored/persisted data
  assert.ok(!serialized.includes("SENSITIVE_MAIL_CONTENT"), "bodyText sentinel must not appear in stored events");
  assert.ok(!serialized.includes("SENSITIVE_LLM_OUTPUT"), "rawResponse sentinel must not appear in stored events");
  // But legitimate data should be preserved
  assert.ok(serialized.includes("通知"), "tagName should be preserved");

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
