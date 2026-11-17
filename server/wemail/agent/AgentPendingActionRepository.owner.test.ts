import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { AgentPendingActionRepository } from "./AgentPendingActionRepository.js";

test("pending actions support account and local-profile ownership without cross-profile leakage", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wemail-pending-owner-"),
  );
  const db = openOrCreateMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const repository = new AgentPendingActionRepository({
      db,
      now: () => "2026-07-30T12:00:00.000Z",
    });
    repository.insert({
      id: "account-action",
      accountId: "acct-1",
      owner: { type: "account", accountId: "acct-1" },
      actionType: "archive",
      description: "归档邮件",
      inputJson: "{}",
      riskReason: "测试",
    });
    repository.insert({
      id: "profile-action",
      accountId: "acct-1",
      owner: { type: "localProfile", profileId: "default" },
      actionType: "unsubscribe",
      description: "退订",
      inputJson: "{}",
      riskReason: "测试",
    });

    assert.deepEqual(repository.getOwnerFor("account-action"), {
      type: "account",
      accountId: "acct-1",
    });
    assert.deepEqual(repository.getOwnerFor("profile-action"), {
      type: "localProfile",
      profileId: "default",
    });
    assert.deepEqual(
      repository.getPendingByAccount("acct-2").map((row) => row.id),
      ["profile-action"],
    );
    db.exec(`INSERT INTO agent_conversations (id, account_id, created_at, updated_at)
      VALUES ('conversation-1', 'acct-1', '2026-07-30', '2026-07-30');
      UPDATE agent_pending_actions SET conversation_id = 'conversation-1'
      WHERE id = 'account-action';`);
    db.pragma("query_only = ON");
    assert.deepEqual(repository.listForAccount("acct-2", "conversation-1"), []);
    assert.deepEqual(repository.listForAccount("acct-1", "missing"), []);
    assert.deepEqual(
      repository.listForAccount("acct-1", "conversation-1").map((action) => action.id),
      ["account-action"],
    );
    assert.deepEqual(
      repository.listForAccount("acct-2").map((action) => action.id),
      ["profile-action"],
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
