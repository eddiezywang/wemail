import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MailSyncErrorLog } from "./MailSyncErrorLog.js";

test("MailSyncErrorLog appends sync failures to a fixed file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-sync-error-log-"));
  const log = new MailSyncErrorLog({
    baseDir: dir,
    now: () => new Date("2026-04-26T12:00:00.000Z"),
  });

  log.record({
    errorId: "err-sync-1",
    stage: "mail.sync",
    message: "Command failed",
    detail: "BAD SEARCH invalid date criteria",
    name: "MailProviderCommandError",
    stack: "stack line",
  });

  const file = path.join(dir, "mail-sync-errors.log");
  assert.equal(log.filePath, file);
  const [line] = fs.readFileSync(file, "utf8").trim().split("\n");
  const entry = JSON.parse(line!) as Record<string, unknown>;
  assert.equal(entry.ts, "2026-04-26T12:00:00.000Z");
  assert.equal(entry.errorId, "err-sync-1");
  assert.equal(entry.stage, "mail.sync");
  assert.equal(entry.message, "Command failed");
  assert.equal(entry.detail, "BAD SEARCH invalid date criteria");
  assert.equal(entry.name, "MailProviderCommandError");
  assert.equal(entry.stack, "stack line");
});

test("MailSyncErrorLog redacts secret-like fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-sync-error-log-"));
  const log = new MailSyncErrorLog({ baseDir: dir });

  log.record({
    errorId: "err-sync-2",
    stage: "mail.sync",
    message: "failed",
    detail: "failed",
    name: "Error",
    context: { password: "secret", bodyText: "mail body", host: "imap.example.com" },
  });

  const raw = fs.readFileSync(log.filePath, "utf8");
  assert.ok(!raw.includes("secret"));
  assert.ok(!raw.includes("mail body"));
  assert.ok(raw.includes("imap.example.com"));
});
