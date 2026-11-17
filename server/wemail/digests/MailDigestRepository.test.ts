import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MailDigestResult } from "../../../shared/wemail/digests.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { MailDigestRepository } from "./MailDigestRepository.js";

type SaveDigestInput = Parameters<MailDigestRepository["saveDigest"]>[0];

function makeRepo() {
  const db = openOrCreateMailDatabase(":memory:");
  insertCanonicalTestAccount(db, { id: "acct-1", email: "a@example.com" });
  return {
    db,
    repo: new MailDigestRepository({
      db,
      now: () => "2026-06-22T10:00:00.000Z",
    }),
  };
}

test("MailDigestRepository returns default settings and persists updates", () => {
  const { repo } = makeRepo();
  assert.deepEqual(repo.getSettings(), {
    manualEnabled: true,
    manualWindowHours: 8,
    inactivityEnabled: true,
    inactivityHours: 8,
    dailyEnabled: false,
    dailyTime: "18:00",
    dailyWindowMode: "day-start-to-now",
    lastOpenedAt: null,
    lastDailyDigestDate: null,
  });

  repo.saveSettings({
    manualEnabled: false,
    manualWindowHours: 4,
    inactivityEnabled: true,
    inactivityHours: 12,
    dailyEnabled: true,
    dailyTime: "09:30",
    dailyWindowMode: "previous-daily-time",
    lastOpenedAt: "2026-06-22T08:00:00.000Z",
    lastDailyDigestDate: "2026-06-22",
  });

  assert.equal(repo.getSettings().dailyEnabled, true);
  assert.equal(repo.getSettings().dailyTime, "09:30");
  assert.equal(repo.getSettings().dailyWindowMode, "previous-daily-time");
  assert.equal(repo.getSettings().lastDailyDigestDate, "2026-06-22");
});

test("MailDigestRepository keeps account runtime fields separate from global config", () => {
  const { db, repo } = makeRepo();
  insertCanonicalTestAccount(db, { id: "acct-2", email: "b@example.com" });
  repo.saveSettings({
    ...repo.getSettings(),
    manualWindowHours: 4,
    dailyEnabled: true,
    lastOpenedAt: "2026-06-20T08:00:00.000Z",
    lastDailyDigestDate: "2026-06-20",
  });

  repo.saveAccountRuntimeState("acct-1", {
    lastOpenedAt: "2026-06-22T08:00:00.000Z",
    lastDailyDigestDate: "2026-06-22",
  });

  assert.equal(repo.getSettingsForAccount("acct-1").manualWindowHours, 4);
  assert.equal(repo.getSettingsForAccount("acct-1").dailyEnabled, true);
  assert.equal(repo.getSettingsForAccount("acct-1").lastOpenedAt, "2026-06-22T08:00:00.000Z");
  assert.equal(repo.getSettingsForAccount("acct-1").lastDailyDigestDate, "2026-06-22");
  assert.equal(repo.getSettingsForAccount("acct-2").lastOpenedAt, null);
  assert.equal(repo.getSettingsForAccount("acct-2").lastDailyDigestDate, null);
  assert.equal(repo.getSettings().lastOpenedAt, "2026-06-20T08:00:00.000Z");
});

test("MailDigestRepository saves and reuses digest windows", () => {
  const { db, repo } = makeRepo();
  const result: MailDigestResult = {
    type: "mailDigest",
    overview: ["Two notable updates."],
    themes: [],
    actionItems: [],
    stats: { totalEmails: 2, includedEmails: 2, truncated: false },
  };
  const digestInput: SaveDigestInput = {
    accountId: "acct-1",
    kind: "manual",
    windowStart: "2026-06-22T02:00:00.000Z",
    windowEnd: "2026-06-22T10:00:00.000Z",
    emailCount: 2,
    result,
    model: "test-model",
  };
  const saved = repo.saveDigest(digestInput);
  const reused = repo.saveDigest(digestInput);

  const cached = repo.findByWindow({
    accountId: "acct-1",
    kind: "manual",
    windowStart: "2026-06-22T02:00:00.000Z",
    windowEnd: "2026-06-22T10:00:00.000Z",
  });
  const matchingRows = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM mail_digests digests
       JOIN mail_accounts accounts ON accounts.id = digests.account_id
       WHERE accounts.public_id = @accountId AND digests.digest_kind = @kind
         AND digests.window_start_ms = @windowStartMs
         AND digests.window_end_ms = @windowEndMs`,
    )
    .get({
      accountId: "acct-1",
      kind: "manual",
      windowStartMs: Date.parse("2026-06-22T02:00:00.000Z"),
      windowEndMs: Date.parse("2026-06-22T10:00:00.000Z"),
    }) as { count: number };
  const later = repo.saveDigest({
    ...digestInput,
    windowStart: "2026-06-22T10:00:00.000Z",
    windowEnd: "2026-06-22T11:00:00.000Z",
  });

  assert.equal(reused.id, saved.id);
  assert.equal(matchingRows.count, 1);
  assert.equal(cached?.id, saved.id);
  assert.equal(repo.latest("acct-1")?.id, later.id);
});

test("MailDigestRepository saves and reads scoped digest records", () => {
  const { repo } = makeRepo();
  const result: MailDigestResult = {
    type: "mailDigest",
    overview: ["Archive update."],
    themes: [],
    actionItems: [],
    stats: { totalEmails: 1, includedEmails: 1, truncated: false },
  };
  const saved = repo.saveDigest({
    accountId: "acct-1",
    kind: "manual",
    scopeKind: "folder",
    scopeKey: "Archive",
    windowStart: "2026-06-22T02:00:00.000Z",
    windowEnd: "2026-06-22T10:00:00.000Z",
    emailCount: 1,
    result,
    model: "test-model",
  });

  assert.equal(saved.scopeKind, "folder");
  assert.equal(saved.scopeKey, "Archive");

  const latestArchive = repo.latest("acct-1", {
    scopeKind: "folder",
    scopeKey: "Archive",
  });
  const latestInbox = repo.latest("acct-1", {
    scopeKind: "folder",
    scopeKey: "INBOX",
  });

  assert.equal(latestArchive?.id, saved.id);
  assert.equal(latestInbox, null);
});

test("MailDigestRepository caches duplicate scoped windows independently", () => {
  const { repo } = makeRepo();
  const result: MailDigestResult = {
    type: "mailDigest",
    overview: ["Scoped update."],
    themes: [],
    actionItems: [],
    stats: { totalEmails: 1, includedEmails: 1, truncated: false },
  };
  const digestInput: SaveDigestInput = {
    accountId: "acct-1",
    kind: "manual",
    windowStart: "2026-06-22T02:00:00.000Z",
    windowEnd: "2026-06-22T10:00:00.000Z",
    emailCount: 1,
    result,
    model: "test-model",
  };

  const inbox = repo.saveDigest({
    ...digestInput,
    scopeKind: "folder",
    scopeKey: "INBOX",
  });
  const archive = repo.saveDigest({
    ...digestInput,
    scopeKind: "folder",
    scopeKey: "Archive",
  });

  assert.notEqual(inbox.id, archive.id);
  assert.equal(repo.findByWindow({
    accountId: "acct-1",
    kind: "manual",
    scopeKind: "folder",
    scopeKey: "INBOX",
    windowStart: digestInput.windowStart,
    windowEnd: digestInput.windowEnd,
  })?.id, inbox.id);
});

test("MailDigestRepository lists scoped digests by kind with a limit", () => {
  const { repo } = makeRepo();
  const result: MailDigestResult = {
    type: "mailDigest",
    overview: ["Daily update."],
    themes: [],
    actionItems: [],
    stats: { totalEmails: 1, includedEmails: 1, truncated: false },
  };

  for (let day = 1; day <= 9; day += 1) {
    repo.saveDigest({
      accountId: "acct-1",
      kind: "daily",
      scopeKind: "folder",
      scopeKey: "INBOX",
      windowStart: `2026-06-${String(day).padStart(2, "0")}T00:00:00.000Z`,
      windowEnd: `2026-06-${String(day).padStart(2, "0")}T08:00:00.000Z`,
      emailCount: 1,
      result,
      model: "test-model",
    });
  }
  repo.saveDigest({
    accountId: "acct-1",
    kind: "daily",
    scopeKind: "folder",
    scopeKey: "Archive",
    windowStart: "2026-06-10T00:00:00.000Z",
    windowEnd: "2026-06-10T08:00:00.000Z",
    emailCount: 1,
    result,
    model: "test-model",
  });
  repo.saveDigest({
    accountId: "acct-1",
    kind: "manual",
    scopeKind: "folder",
    scopeKey: "INBOX",
    windowStart: "2026-06-10T00:00:00.000Z",
    windowEnd: "2026-06-10T08:00:00.000Z",
    emailCount: 1,
    result,
    model: "test-model",
  });

  const digests = repo.list({
    accountId: "acct-1",
    scope: {
      scopeKind: "folder",
      scopeKey: "INBOX",
    },
    kind: "daily",
    limit: 7,
  });

  assert.equal(digests.length, 7);
  assert.deepEqual(
    digests.map((digest) => digest.windowStart),
    [
      "2026-06-09T00:00:00.000Z",
      "2026-06-08T00:00:00.000Z",
      "2026-06-07T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      "2026-06-05T00:00:00.000Z",
      "2026-06-04T00:00:00.000Z",
      "2026-06-03T00:00:00.000Z",
    ],
  );
});
