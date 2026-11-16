import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import type { MailSceneAction } from "../../../shared/wemail/intelligence.js";
import type { MailSceneActionInput } from "../intelligence/MailSceneActionResolver.js";
import { createMailDatabase } from "./Database.js";
import { MailDatabaseQueryRepository } from "./MailDatabaseQueryRepository.js";
import { MailDatabaseWriter } from "./MailDatabaseWriter.js";
import type { InvoiceStatusPort } from "../agent/allowancePort.js";
import { insertCanonicalTestAccount, insertCanonicalTestMessage } from "./MailDatabase.test-support.js";

test("mail snapshots retain platform status only through the injected edition store", () => {
  // P2.6: the invoice_attachment_statuses store is an edition module. The
  // open regression pins both sides of the seam: an injected port feeds the
  // snapshot read, and the module-less default collapses to null (the table
  // itself stays in the schema for DB compatibility).
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-invoice-snapshot-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    insertCanonicalTestAccount(db, { id: "account" });
    insertCanonicalTestMessage(db, { id: "invoice-mail", accountId: "account", subject: "电子发票" });
    const queried: Array<[string, string | undefined]> = [];
    const statuses: InvoiceStatusPort = {
      get: () => null,
      getMailStatus: (emailId, accountId) => {
        queried.push([emailId, accountId]);
        return {
          tag: "已处理发票",
          state: "uploaded",
          statuses: [{ accountId: "account", emailId, attachmentId: "a", status: "uploaded",
            invoiceNumber: "12345678", lastStdout: JSON.stringify([{ invoiceNumber: "12345678" }]),
            createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z" }],
        };
      },
      markUploaded: () => {},
      markFromUploadFailure: () => {},
      markDeletedByInvoiceIds: () => 0,
      reconcilePlatformOutput: () => 0,
      ensureNotStartedForInvoiceMessage: () => 0,
    };
    const queries = new MailDatabaseQueryRepository(db, { invoiceStatuses: statuses });
    assert.equal(queries.getSnapshot("invoice-mail").invoiceStatus?.state, "uploaded");
    assert.deepEqual(queried, [["invoice-mail", "account"]]);
    // Module-less default (the open build): invoiceStatus collapses to null.
    const bare = new MailDatabaseQueryRepository(db);
    assert.equal(bare.getSnapshot("invoice-mail").invoiceStatus, null);
    assert.equal(bare.getSnapshot("invoice-mail").invoiceDetected, true);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("mail search clamps page sizes to the 100-item guard while list honors larger pages", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-large-page-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    const now = new Date().toISOString();
    writer.configureAccount({
      account: {
        id: "account-1",
        emailAddress: "me@example.test",
        imap: { host: "imap.example.test", port: 993, secure: true, username: "me@example.test" },
        smtp: { host: "smtp.example.test", port: 465, secure: true, username: "me@example.test" },
        createdAt: now,
        updatedAt: now,
      },
      credentialRef: "credential:account-1",
      credentialGeneration: 1,
    });
    const messages = Array.from({ length: 250 }, (_, index): MailMessage => ({
      id: `message-${index}`,
      accountId: "account-1",
      folder: "INBOX",
      messageId: `<message-${index}@example.test>`,
      from: { email: "sender@example.test" },
      to: [{ email: "me@example.test" }],
      cc: [],
      bcc: [],
      subject: `Bulk pagination ${index}`,
      snippet: "Bulk pagination",
      receivedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
      hasAttachments: false,
      attachments: [],
      flags: { seen: false, flagged: false, answered: false, draft: false },
      sync: { uid: index + 1, uidValidity: 1, internalDate: now },
    }));
    writer.persistMetadata({ accountId: "account-1", origin: "bootstrap", messages });

    const queries = new MailDatabaseQueryRepository(db);
    // list() honors the full page size; search() clamps to the 100-item
    // memory guard (MailDatabaseQueryRepository search limit clamp).
    assert.equal(queries.list({ accountId: "account-1", allMail: true, limit: 250 }).messages.length, 250);
    assert.equal(queries.search({ accountId: "account-1", query: "pagination", limit: 250 }).messages.length, 100);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("mail search honors exact received timestamp bounds", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-search-time-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    const now = new Date().toISOString();
    writer.configureAccount({
      account: {
        id: "account-1",
        emailAddress: "me@example.test",
        imap: { host: "imap.example.test", port: 993, secure: true, username: "me@example.test" },
        smtp: { host: "smtp.example.test", port: 465, secure: true, username: "me@example.test" },
        createdAt: now,
        updatedAt: now,
      },
      credentialRef: "credential:account-1",
      credentialGeneration: 1,
    });
    const messages = ["2026-08-01T07:59:59.999Z", "2026-08-01T08:00:00.000Z", "2026-08-01T08:00:00.001Z"]
      .map((receivedAt, index): MailMessage => ({
        id: `message-${index}`,
        accountId: "account-1",
        folder: "INBOX",
        messageId: `<message-${index}@example.test>`,
        from: { email: "ops@example.test" },
        to: [{ email: "me@example.test" }],
        cc: [],
        bcc: [],
        subject: "Weekly ops report",
        snippet: "Weekly ops report",
        receivedAt,
        hasAttachments: false,
        attachments: [],
        flags: { seen: false, flagged: false, answered: false, draft: false },
        sync: { uid: index + 1, uidValidity: 1, internalDate: receivedAt },
      }));
    writer.persistMetadata({ accountId: "account-1", origin: "bootstrap", messages });

    const result = new MailDatabaseQueryRepository(db).search({
      accountId: "account-1",
      from: "ops@example.test",
      subject: "Weekly",
      receivedFromMs: Date.parse("2026-08-01T08:00:00.000Z"),
      receivedToMs: Date.parse("2026-08-01T08:00:00.000Z"),
    });

    assert.deepEqual(result.messages.map((message) => message.id), ["message-1"]);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("mail snapshots enrich recipient addresses with enterprise directory names", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-directory-address-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    const now = new Date().toISOString();
    writer.configureAccount({
      account: {
        id: "account-1",
        emailAddress: "me@example.test",
        imap: { host: "imap.example.test", port: 993, secure: true, username: "me@example.test" },
        smtp: { host: "smtp.example.test", port: 465, secure: true, username: "me@example.test" },
        createdAt: now,
        updatedAt: now,
      },
      credentialRef: "credential:account-1",
      credentialGeneration: 1,
    });
    db.prepare(`
      INSERT INTO directory_contacts (
        account_id, id, name, email, aliases_json, synced_at,
        pinyin_initials, pinyin_index_version
      ) VALUES (?, ?, ?, ?, '[]', ?, '', 0)
    `).run("account-1", "contact-1", "eddiewang(王振宇)", "me@example.test", now);
    const message: MailMessage = {
      id: "message-1",
      accountId: "account-1",
      folder: "INBOX",
      messageId: "<message-1@example.test>",
      from: { email: "sender@example.test", name: "Sender" },
      to: [{ email: "ME@example.test" }],
      cc: [],
      bcc: [],
      subject: "Directory recipient",
      snippet: "Recipient name should be restored at read time.",
      receivedAt: "2026-08-04T00:00:00.000Z",
      hasAttachments: false,
      attachments: [],
      flags: { seen: false, flagged: false, answered: false, draft: false },
      sync: { uid: 1, uidValidity: 1, internalDate: "2026-08-04T00:00:00.000Z" },
    };
    writer.persistMetadata({ accountId: "account-1", origin: "bootstrap", messages: [message] });

    const snapshot = new MailDatabaseQueryRepository(db).getSnapshot(message.id);

    assert.equal(snapshot.message?.to[0]?.email, "ME@example.test");
    assert.equal(snapshot.message?.to[0]?.directoryName, "eddiewang(王振宇)");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("default search matches AI summary text (Chinese substring + English FTS)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-search-summary-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    const now = new Date().toISOString();
    writer.configureAccount({
      account: {
        id: "account-1",
        emailAddress: "me@example.test",
        imap: { host: "imap.example.test", port: 993, secure: true, username: "me@example.test" },
        smtp: { host: "smtp.example.test", port: 465, secure: true, username: "me@example.test" },
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
      from: { email: "sender@example.test", name: "Sender" },
      to: [{ email: "me@example.test" }],
      cc: [],
      bcc: [],
      subject: "Meeting notes",
      snippet: "Snippet",
      receivedAt: "2026-08-04T00:00:00.000Z",
      hasAttachments: false,
      attachments: [],
      flags: { seen: false, flagged: false, answered: false, draft: false },
      sync: { uid: 1, uidValidity: 1, internalDate: "2026-08-04T00:00:00.000Z" },
    };
    writer.persistMetadata({ accountId: "account-1", origin: "bootstrap", messages: [message] });
    const row = db.prepare(
      "SELECT id FROM mail_messages WHERE public_id = ?",
    ).get(message.id) as { id: number };
    const accountIdRow = db
      .prepare("SELECT id FROM mail_accounts WHERE public_id = 'account-1'")
      .get() as { id: number };
    const artifactId = db.prepare(`
      INSERT INTO mail_ai_artifacts (
        public_id, account_id, scope_kind, message_id, artifact_kind,
        source_version, processor_version, state, text_value, json_value,
        created_at_ms, completed_at_ms, row_version
      ) VALUES (?, ?, 'message', ?, 'summary', 0, 'test', 'ready', ?, '{}', ?, ?, 1)
    `).run(
      "artifact-1",
      accountIdRow.id,
      row.id,
      "未规范使用开头语，正文应以上下文衔接；salutation-review 通过。",
      Date.now(),
      Date.now(),
    ).lastInsertRowid;
    db.prepare(`
      INSERT INTO mail_message_ai_current (message_id, artifact_kind, artifact_id, row_version)
      VALUES (?, 'summary', ?, 1)
    `).run(row.id, artifactId);
    // Re-persist to refresh the FTS index so summary_terms picks up the artifact.
    writer.persistMetadata({ accountId: "account-1", origin: "manual", messages: [message] });

    const queries = new MailDatabaseQueryRepository(db);
    const chinese = queries.search({ accountId: "account-1", query: "未规范使用开头语" });
    assert.equal(chinese.messages.length, 1);
    assert.equal(chinese.messages[0].id, "message-1");
    const english = queries.search({ accountId: "account-1", query: "salutation" });
    assert.equal(english.messages.length, 1);
    assert.equal(english.messages[0].id, "message-1");
    const multipleWords = queries.search({ accountId: "account-1", query: "salutation review" });
    assert.equal(multipleWords.messages.length, 1);
    assert.equal(multipleWords.messages[0].id, "message-1");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("search covers html-only bodies, smart-tag names, and scope presets", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-search-html-tag-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    const now = new Date().toISOString();
    writer.configureAccount({
      account: {
        id: "account-1",
        emailAddress: "me@example.test",
        imap: { host: "imap.example.test", port: 993, secure: true, username: "me@example.test" },
        smtp: { host: "smtp.example.test", port: 465, secure: true, username: "me@example.test" },
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
      from: { email: "sender@example.test", name: "Sender" },
      to: [{ email: "me@example.test" }],
      cc: [],
      bcc: [],
      subject: "DataAPI-智能辅助通话分析",
      snippet: "Snippet",
      receivedAt: "2026-08-04T00:00:00.000Z",
      hasAttachments: false,
      attachments: [],
      flags: { seen: false, flagged: false, answered: false, draft: false },
      sync: { uid: 1, uidValidity: 1, internalDate: "2026-08-04T00:00:00.000Z" },
    };
    writer.persistMetadata({ accountId: "account-1", origin: "bootstrap", messages: [message] });
    const row = db.prepare(
      "SELECT id FROM mail_messages WHERE public_id = ?",
    ).get(message.id) as { id: number };
    // HTML-only body: text_plain stays NULL, content lives in html_sanitized.
    db.prepare(`
      UPDATE mail_message_content SET
        state = 'ready',
        text_plain = NULL,
        html_sanitized = '<div>未规范使用开头语，正文应以上下文衔接。</div><p>salutation-review ok</p>',
        content_sha256 = 'test-html-only-sha256',
        content_version = 1,
        row_version = row_version + 1
      WHERE message_id = ?
    `).run(row.id);
    // Smart tag attached to the message.
    const tagId = db.prepare(`
      INSERT INTO mail_user_tags (
        public_id, account_id, name, name_norm, creation_source,
        created_at_ms, updated_at_ms
      ) SELECT 'tag-1', accounts.id, '项目进度', '项目进度', 'system', ?, ?
        FROM mail_accounts accounts WHERE accounts.public_id = 'account-1'
    `).run(Date.now(), Date.now()).lastInsertRowid;
    db.prepare(`
      INSERT INTO mail_message_user_tags (
        account_id, tag_id, message_id, received_at_ms, is_seen, is_flagged,
        has_attachments, source, row_version
      ) SELECT accounts.id, ?, messages.id, ?, 0, 0, 0, 'ai', 1
        FROM mail_accounts accounts, mail_messages messages
        WHERE accounts.public_id = 'account-1' AND messages.public_id = ?
    `).run(tagId, Date.parse(message.receivedAt), message.id);
    // Re-persist to refresh the FTS index so body_terms picks up the HTML.
    writer.persistMetadata({ accountId: "account-1", origin: "manual", messages: [message] });
    while (!writer.rebuildCjkSearchIndexBatch(10).complete) {
      // Drain the one-time historical index build used by the desktop writer lane.
    }

    const queries = new MailDatabaseQueryRepository(db);
    // HTML-only Chinese body matched through the CJK FTS index (default + body scope).
    const defaultHit = queries.search({ accountId: "account-1", query: "未规范使用开头语" });
    assert.equal(defaultHit.messages.length, 1);
    assert.equal(defaultHit.messages[0].id, "message-1");
    const bodyHit = queries.search({ accountId: "account-1", query: "未规范使用开头语", scope: "body" });
    assert.equal(bodyHit.messages.length, 1);
    // HTML-derived text reachable via FTS for non-CJK terms.
    const ftsHit = queries.search({ accountId: "account-1", query: "salutation-review" });
    assert.equal(ftsHit.messages.length, 1);
    // Smart-tag name hits in the default scope.
    const tagHit = queries.search({ accountId: "account-1", query: "项目进度" });
    assert.equal(tagHit.messages.length, 1);
    // Scope presets narrow the field: subject-only mode does not see a
    // body-only phrase, and the address scope ignores subject/body text.
    const subjectMiss = queries.search({ accountId: "account-1", query: "未规范使用开头语", scope: "subject" });
    assert.equal(subjectMiss.messages.length, 0);
    const subjectHit = queries.search({ accountId: "account-1", query: "智能辅助通话", scope: "subject" });
    assert.equal(subjectHit.messages.length, 1);
    const addressHit = queries.search({ accountId: "account-1", query: "sender@example.test", scope: "address" });
    assert.equal(addressHit.messages.length, 1);
    const addressMiss = queries.search({ accountId: "account-1", query: "未规范使用开头语", scope: "address" });
    assert.equal(addressMiss.messages.length, 0);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function insertReadySummary(
  db: ReturnType<typeof createMailDatabase>,
  accountId: string,
  emailId: string,
  result: Record<string, unknown>,
): void {
  const artifactId = `summary:${emailId}`;
  db.prepare(`
    INSERT INTO mail_ai_artifacts (
      public_id, account_id, scope_kind, message_id, artifact_kind,
      source_version, processor_version, state, json_value, created_at_ms, row_version
    ) SELECT
      @artifactId, accounts.id, 'message', messages.id, 'summary',
      0, 'test', 'ready', @json, 0, 1
    FROM mail_accounts accounts, mail_messages messages
    WHERE accounts.public_id = @accountId AND messages.public_id = @emailId
  `).run({ artifactId, accountId, emailId, json: JSON.stringify(result) });
  db.prepare(`
    INSERT INTO mail_message_ai_current (message_id, artifact_kind, artifact_id, row_version)
    SELECT messages.id, 'summary', artifacts.id, 1
    FROM mail_messages messages, mail_ai_artifacts artifacts
    WHERE messages.public_id = @emailId AND artifacts.public_id = @artifactId
  `).run({ artifactId, emailId });
}

function officeMailFixture(db: ReturnType<typeof createMailDatabase>): void {
  insertCanonicalTestAccount(db, { id: "office-account" });
  insertCanonicalTestMessage(db, {
    id: "office-mail",
    accountId: "office-account",
    subject: "服务台今日待办事项",
  });
  db.prepare("UPDATE mail_messages SET sender_preview = ? WHERE public_id = ?")
    .run("itsm@example.test", "office-mail");
  insertReadySummary(db, "office-account", "office-mail", {
    type: "summary",
    schemaVersion: 3,
    intent: "notification",
    attention: "know",
    displayMode: "brief",
    headline: "服务台 今日待办。",
    details: [],
    bullets: ["有 3 条待办。"],
    actions: [],
    actionItems: [],
    urgency: "low",
  });
}

test("non-invoice office mail reaches scene contributors through the DB query path", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-scene-envelope-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    officeMailFixture(db);
    const seen: MailSceneActionInput[] = [];
    const contributed: MailSceneAction = {
      id: "edition.office-todo_reminder",
      scene: "edition",
      label: "处理平台待办提醒",
      icon: "action",
      status: "available",
      agentPrompt: "先用 wecli_query 探索平台待办，再提出方案；涉及提交时等我确认。",
      risk: "none",
    };
    const queries = new MailDatabaseQueryRepository(db, {
      sceneActionContributors: [(input) => {
        seen.push(input);
        return input.message?.subject.includes("服务台") ? [contributed] : [];
      }],
    });
    const state = queries.getIntelligenceState("office-mail");
    assert.deepEqual(
      (state.sceneActions ?? []).map((action) => action.id),
      ["edition.office-todo_reminder"],
    );
    assert.equal(seen.length, 1);
    // The contributor gets the minimal envelope even though this is NOT an
    // invoice/receipt summary — the production chain used to pass undefined.
    assert.equal(seen[0]?.message?.subject, "服务台今日待办事项");
    assert.equal(seen[0]?.message?.from.email, "itsm@example.test");
    assert.equal(seen[0]?.invoiceIntent, false);
    assert.equal(seen[0]?.message?.bodyText, undefined);
    assert.deepEqual(seen[0]?.message?.attachments, []);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("open NO_OP registration produces no scene actions, and instances stay isolated", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-scene-isolation-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    officeMailFixture(db);
    const action = (id: MailSceneAction["id"]): MailSceneAction => ({
      id,
      scene: "edition",
      label: id,
      icon: "action",
      status: "available",
      agentPrompt: "wait for confirmation",
      risk: "none",
    });
    const first = new MailDatabaseQueryRepository(db, {
      sceneActionContributors: [() => [action("edition.first")]],
    });
    const second = new MailDatabaseQueryRepository(db, {
      sceneActionContributors: [() => [action("edition.second")]],
    });
    const disabled = new MailDatabaseQueryRepository(db, {
      sceneActionContributors: [],
    });
    // No modules: the default (build) registration is empty → NO_OP unchanged.
    const noop = new MailDatabaseQueryRepository(db);
    assert.deepEqual((noop.getIntelligenceState("office-mail").sceneActions ?? []), []);
    assert.deepEqual(
      (first.getIntelligenceState("office-mail").sceneActions ?? []).map((item) => item.id),
      ["edition.first"],
    );
    assert.deepEqual(
      (second.getIntelligenceState("office-mail").sceneActions ?? []).map((item) => item.id),
      ["edition.second"],
    );
    // Explicit empty array means off; it must not restore the registration.
    assert.deepEqual((disabled.getIntelligenceState("office-mail").sceneActions ?? []), []);
    // A second repository cannot change the first one's subsequent queries.
    assert.deepEqual(
      (first.getIntelligenceState("office-mail").sceneActions ?? []).map((item) => item.id),
      ["edition.first"],
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
