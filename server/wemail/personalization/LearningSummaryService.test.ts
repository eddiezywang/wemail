import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import { LearningSummaryService } from "./LearningSummaryService.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-learning-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "acct-1", email: "a@x.com" });
  return { db, dir };
}

test("LearningSummaryService saves and retrieves a learning summary", () => {
  const { db, dir } = makeDb();
  const service = new LearningSummaryService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  const saved = service.save({
    accountId: "acct-1",
    feature: "tags",
    signals: { suppressedTags: ["newsletter", "marketing"] },
  });

  assert.equal(saved.feature, "tags");
  assert.equal(saved.accountId, "acct-1");
  assert.deepEqual(saved.signals, { suppressedTags: ["newsletter", "marketing"] });
  assert.equal(saved.updatedAt, "2026-04-26T12:00:00.000Z");

  const retrieved = service.get("acct-1", "tags");
  assert.ok(retrieved);
  assert.deepEqual(retrieved.signals, { suppressedTags: ["newsletter", "marketing"] });

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LearningSummaryService upserts on save", () => {
  const { db, dir } = makeDb();
  const service = new LearningSummaryService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  service.save({
    accountId: "acct-1",
    feature: "tags",
    signals: { suppressedTags: ["newsletter"] },
  });

  const updated = service.save({
    accountId: "acct-1",
    feature: "tags",
    signals: { suppressedTags: ["newsletter", "marketing"] },
  });

  assert.deepEqual(updated.signals, { suppressedTags: ["newsletter", "marketing"] });

  const all = service.listByAccount("acct-1");
  assert.equal(all.length, 1);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LearningSummaryService lists all summaries for an account", () => {
  const { db, dir } = makeDb();
  const service = new LearningSummaryService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  service.save({ accountId: "acct-1", feature: "tags", signals: { suppressedTags: ["newsletter"] } });
  service.save({ accountId: "acct-1", feature: "summary", signals: { averageRating: 4.2 } });

  const all = service.listByAccount("acct-1");
  assert.equal(all.length, 2);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LearningSummaryService reset clears all summaries for an account", () => {
  const { db, dir } = makeDb();
  const service = new LearningSummaryService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  service.save({ accountId: "acct-1", feature: "tags", signals: { suppressedTags: ["newsletter"] } });
  service.save({ accountId: "acct-1", feature: "summary", signals: { averageRating: 4.2 } });

  service.reset("acct-1");

  const all = service.listByAccount("acct-1");
  assert.equal(all.length, 0);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LearningSummaryService resetFeature clears only one feature", () => {
  const { db, dir } = makeDb();
  const service = new LearningSummaryService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  service.save({ accountId: "acct-1", feature: "tags", signals: { suppressedTags: ["newsletter"] } });
  service.save({ accountId: "acct-1", feature: "summary", signals: { averageRating: 4.2 } });

  service.resetFeature("acct-1", "tags");

  assert.equal(service.get("acct-1", "tags"), null);
  assert.ok(service.get("acct-1", "summary"));

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LearningSummaryService computeFromFeedback aggregates tag reject events", () => {
  const { db, dir } = makeDb();
  const service = new LearningSummaryService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  const feedbackEvents = [
    { eventType: "reject", payload: { tagName: "newsletter" } },
    { eventType: "reject", payload: { tagName: "marketing" } },
    { eventType: "reject", payload: { tagName: "newsletter" } },
    { eventType: "accept", payload: { tagName: "important" } },
  ];

  const summary = service.computeFromFeedback("acct-1", "tags", feedbackEvents);

  assert.equal(summary.feature, "tags");
  assert.equal(summary.signals.totalEvents, 4);
  assert.deepEqual(summary.signals.eventCounts, { reject: 3, accept: 1 });
  assert.deepEqual(summary.signals.suppressedTags, ["newsletter", "marketing"]);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LearningSummaryService computeFromFeedback aggregates replyDraft edit events", () => {
  const { db, dir } = makeDb();
  const service = new LearningSummaryService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  const feedbackEvents = [
    { eventType: "edit", payload: {} },
    { eventType: "edit", payload: {} },
    { eventType: "accept", payload: {} },
  ];

  const summary = service.computeFromFeedback("acct-1", "replyDraft", feedbackEvents);

  assert.equal(summary.feature, "replyDraft");
  const wf = summary.signals.writingFeedback as { editCount: number; acceptCount: number; editRatio: number };
  assert.equal(wf.editCount, 2);
  assert.equal(wf.acceptCount, 1);
  assert.ok(wf.editRatio > 0);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LearningSummaryService computeFromFeedback aggregates summary rate events", () => {
  const { db, dir } = makeDb();
  const service = new LearningSummaryService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  const feedbackEvents = [
    { eventType: "rate", payload: { rating: 4 } },
    { eventType: "rate", payload: { rating: 5 } },
    { eventType: "rate", payload: { rating: 3 } },
  ];

  const summary = service.computeFromFeedback("acct-1", "summary", feedbackEvents);

  assert.equal(summary.feature, "summary");
  assert.equal(summary.signals.averageRating, 4);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LearningSummaryService reset makes learning summary empty for future prompt building", () => {
  const { db, dir } = makeDb();
  const service = new LearningSummaryService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  service.save({ accountId: "acct-1", feature: "tags", signals: { suppressedTags: ["newsletter"] } });

  // Before reset, summary exists
  assert.ok(service.get("acct-1", "tags"));

  service.reset("acct-1");

  // After reset, summary is null (empty for future prompt building)
  assert.equal(service.get("acct-1", "tags"), null);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
