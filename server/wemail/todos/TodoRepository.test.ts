import assert from "node:assert/strict";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { TodoRepository } from "./TodoRepository.js";

test("completing an already completed todo is idempotent", () => {
  const db = openOrCreateMailDatabase(":memory:");
  let now = "2026-08-11T01:00:00.000Z";
  try {
    db.prepare(`INSERT INTO mail_accounts (
      public_id, email_address, provider_kind,
      imap_host, imap_port, imap_secure, imap_username,
      smtp_host, smtp_port, smtp_secure, smtp_username,
      credential_ref, credential_generation, state,
      created_at_ms, updated_at_ms, row_version
    ) VALUES (
      'acct-1', 'user@example.com', 'imap',
      'imap.example.com', 993, 1, 'user@example.com',
      'smtp.example.com', 465, 1, 'user@example.com',
      'credential-1', 1, 'active', 1, 1, 1
    )`).run();
    const repo = new TodoRepository(db, () => now);
    const todo = repo.createManual({ accountId: "acct-1", title: "Reply" });

    now = "2026-08-11T02:00:00.000Z";
    const first = repo.complete(todo.id);
    const firstVersion = db.prepare(
      "SELECT row_version FROM mail_todos WHERE public_id = ?",
    ).pluck().get(todo.id);

    now = "2026-08-11T03:00:00.000Z";
    const second = repo.complete(todo.id);
    const secondVersion = db.prepare(
      "SELECT row_version FROM mail_todos WHERE public_id = ?",
    ).pluck().get(todo.id);

    assert.equal(second?.doneDate, first?.doneDate);
    assert.equal(secondVersion, firstVersion);
  } finally {
    db.close();
  }
});
