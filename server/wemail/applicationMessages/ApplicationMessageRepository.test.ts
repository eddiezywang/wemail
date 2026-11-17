import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { ApplicationMessageRepository } from "./ApplicationMessageRepository.js";
import { normalizeApplicationMessageContent } from "./ApplicationMessageContent.js";

test("application messages are account scoped, persistent, pageable, readable, and archivable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-app-messages-"));
  const db = openOrCreateMailDatabase(path.join(dir, "db.sqlite"));
  const repo = new ApplicationMessageRepository(db, () => "2026-07-23T02:00:00.000Z");
  try {
    const message = repo.create({ accountId: "acct-1", sourceType: "automation", sourceRuleId: "rule-1", sourceRunId: "run-1", type: "digest", severity: "info", title: "摘要", preview: "两封邮件", content: [{ type: "paragraph", text: "安全内容" }], references: [], interactions: [] });
    assert.equal(repo.get(message.id, "other"), null);
    assert.equal(repo.list("acct-1").unread, 1);
    assert.ok(repo.markRead(message.id, "acct-1", true)?.readAt);
    assert.ok(repo.archive(message.id, "acct-1", true)?.archivedAt);
    assert.equal(repo.list("acct-1").messages.length, 0);
  } finally { db.close(); }
});

test("structured content strips active HTML, scripts, tracking images, and unsafe links", () => {
  const blocks = normalizeApplicationMessageContent("# 摘要\n<script>alert(1)</script>正文 <img src=https://tracker.test/pixel> [点我](javascript:alert(1))");
  const serialized = JSON.stringify(blocks);
  assert.equal(serialized.includes("<script"), false);
  assert.equal(serialized.includes("tracker.test"), false);
  assert.equal(serialized.includes("javascript:"), false);
});

test("one local-profile automation result is visible once from every current account", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const repo = new ApplicationMessageRepository(
    db,
    () => "2026-07-30T02:00:00.000Z",
  );
  try {
    const message = repo.create({
      accountId: "acct-anchor",
      owner: { type: "localProfile", profileId: "default" },
      sourceType: "automation",
      sourceRuleId: "profile-rule",
      sourceRunId: "profile-run",
      type: "analysis",
      severity: "info",
      title: "邮箱速览",
      preview: "跨邮箱结果",
      content: [{ type: "paragraph", text: "跨邮箱结果" }],
      references: [],
      interactions: [],
    });
    assert.equal(repo.list("acct-a").messages.length, 1);
    assert.equal(repo.list("acct-b").messages.length, 1);
    assert.equal(repo.get(message.id, "acct-b")?.owner?.type, "localProfile");
    assert.ok(repo.markRead(message.id, "acct-b", true)?.readAt);
    assert.equal(repo.list("acct-a").unread, 0);
  } finally {
    db.close();
  }
});
