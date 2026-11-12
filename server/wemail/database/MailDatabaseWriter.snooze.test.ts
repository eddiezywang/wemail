import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import { createMailDatabase } from "./Database.js";
import { MailDatabaseQueryRepository } from "./MailDatabaseQueryRepository.js";
import { MailDatabaseWriter } from "./MailDatabaseWriter.js";

test("snooze visibility expires in reads without polling or a cleanup write", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-snooze-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    const queries = new MailDatabaseQueryRepository(db);
    const now = new Date().toISOString();
    writer.configureAccount({
      account: {
        id: "account-1",
        emailAddress: "account-1@example.test",
        imap: { host: "imap.example.test", port: 993, secure: true, username: "account-1@example.test" },
        smtp: { host: "smtp.example.test", port: 465, secure: true, username: "account-1@example.test" },
        createdAt: now,
        updatedAt: now,
      },
      credentialRef: "credential:account-1",
      credentialGeneration: 1,
    });
    const message: MailMessage = {
      id: "message-1",
      accountId: "account-1",
      folder: "INBOX",
      messageId: "<message-1@example.test>",
      from: { email: "sender@example.test" },
      to: [{ email: "account-1@example.test" }],
      cc: [],
      bcc: [],
      subject: "Snooze without polling",
      snippet: "Canonical visibility is derived from time.",
      receivedAt: "2026-08-02T00:00:00.000Z",
      hasAttachments: false,
      attachments: [],
      flags: { seen: false, flagged: false, answered: false, draft: false },
      sync: { uid: 1, uidValidity: 1, internalDate: "2026-08-02T00:00:00.000Z" },
    };
    writer.persistMetadata({ accountId: "account-1", origin: "bootstrap", messages: [message] });

    const future = new Date(Date.now() + 60_000).toISOString();
    const snoozed = writer.setSnooze({ accountId: "account-1", emailId: message.id, until: future });
    assert.equal(snoozed.value?.snoozedUntil, future);
    assert.equal(queries.list({ accountId: "account-1", folder: "INBOX" }).totalCount, 0);
    assert.deepEqual(queries.listSnoozed("account-1").map((item) => item.id), [message.id]);

    db.prepare("UPDATE mail_messages SET snoozed_until_ms = ? WHERE public_id = ?")
      .run(Date.now() - 1, message.id);
    assert.equal(queries.list({ accountId: "account-1", folder: "INBOX" }).totalCount, 1);
    assert.deepEqual(queries.listSnoozed("account-1"), []);

    const cleared = writer.setSnooze({ accountId: "account-1", emailId: message.id });
    assert.equal(cleared.value?.snoozedUntil, undefined);
    assert.throws(
      () => writer.setSnooze({ accountId: "account-1", emailId: message.id, until: "invalid" }),
      /invalid-snooze-until/u,
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
