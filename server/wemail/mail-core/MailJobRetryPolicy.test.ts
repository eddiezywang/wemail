import test from "node:test";
import assert from "node:assert/strict";
import {
  isPermanentBodyError,
  maxAttemptsForMailJob,
  shouldSkipPeriodicBodyRevive,
} from "./MailJobRetryPolicy.js";

test("defines a bounded retry budget for every canonical durable job kind", () => {
  const expected = new Map<string, number>([
    ["mail.body.ensure", 5],
    ["mail.metadata.sync", 6],
    ["mail.remote.mutation", 8],
    ["mail.send", 3],
    ["ai.summary", 2],
    ["ai.tags", 2],
    ["ai.reply-decision", 3],
    ["mail.attachment.fetch", 3],
    ["search.index", 3],
    ["search.index.history", 3],
    ["automation.run", 3],
    ["notification.deliver", 3],
    ["maintenance.retention", 1],
  ]);
  for (const [kind, attempts] of expected) {
    assert.equal(maxAttemptsForMailJob(kind), attempts, kind);
  }
});

test("rejects a durable job kind without an explicit retry policy", () => {
  assert.throws(
    () => maxAttemptsForMailJob("unknown.job"),
    /mail-job-retry-policy-missing/,
  );
});

test("classifies permanent and credential body failures for periodic reconcile", () => {
  assert.equal(isPermanentBodyError("mail-body-too-large"), true);
  assert.equal(isPermanentBodyError("mail-body-item-missing"), true);
  assert.equal(isPermanentBodyError("mail-body-uid-invalid"), true);
  assert.equal(isPermanentBodyError("mail-body-fetch-failed"), false);
  assert.equal(shouldSkipPeriodicBodyRevive("mail-body-credential"), true);
  assert.equal(shouldSkipPeriodicBodyRevive("mail-body-fetch-failed"), false);
  assert.equal(shouldSkipPeriodicBodyRevive(null), false);
});
