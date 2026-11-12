import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import { createMailDatabase, openMailDatabase } from "./Database.js";
import { MailDatabaseQueryRepository } from "./MailDatabaseQueryRepository.js";
import { MailDatabaseWriter } from "./MailDatabaseWriter.js";
import { UserTagRepository } from "../intelligence/UserTagRepository.js";
import { EmailSmartTagRepository } from "../intelligence/EmailSmartTagRepository.js";
import { SmartTagBackfillRepository } from "../intelligence/SmartTagBackfillRepository.js";
import { insertCanonicalTestAccount, insertCanonicalTestMessage } from "./MailDatabase.test-support.js";
import { runMailDatabaseMigrations } from "./Migrations.js";

function message(bodyText = ""): MailMessage {
  return {
    id: "message-1",
    accountId: "account-1",
    folder: "INBOX",
    messageId: "<message-1@example.test>",
    from: { email: "sender@example.test", name: "Sender" },
    to: [{ email: "account-1@example.test" }],
    cc: [],
    bcc: [],
    subject: "Canonical intelligence",
    snippet: "Committed content creates downstream work",
    bodyText,
    bodyHtml: "",
    bodyCachedUntil: bodyText ? new Date().toISOString() : null,
    bodyVersion: bodyText ? 1 : 0,
    receivedAt: "2026-08-02T00:00:00.000Z",
    hasAttachments: false,
    attachments: [],
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: {
      uid: 1,
      uidValidity: 1,
      internalDate: "2026-08-02T00:00:00.000Z",
    },
  };
}

function configureTestAccount(writer: MailDatabaseWriter): void {
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
}

test("invoice subjects enter the category before AI runs and survive a negative AI result", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-invoice-subject-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    configureTestAccount(writer);
    const mail = { ...message("下载链接"), subject: "您收到金额94元的发票" };
    writer.persistMetadata({ accountId: "account-1", origin: "bootstrap", messages: [mail] });
    const queries = new MailDatabaseQueryRepository(db);
    const count = () => queries.listCategories("account-1").find((category) => category.id === "invoice")?.count;
    assert.equal(count(), 1, "no attachments or AI artifact required");
    writer.requestIntelligence({ emailId: mail.id, kinds: ["tags"] });
    const bodyJob = writer.claimJob({ owner: "body-worker", filter: { kinds: ["mail.body.ensure"] } })!;
    assert.ok(bodyJob);
    writer.persistBody({ message: mail, completedAt: new Date().toISOString(), jobId: bodyJob.id, jobOwner: "body-worker" });
    const job = writer.claimJob({ owner: "test-worker", filter: { kinds: ["ai.tags"] } })!;
    assert.ok(job);
    const payload = job.payload as { contentSha256: string; contentVersion: number };
    writer.completeAiArtifact({
      jobId: job.id, owner: "test-worker", accountId: "account-1", emailId: mail.id,
      artifactKind: "tags", sourceContentSha256: payload.contentSha256,
      sourceVersion: payload.contentVersion, processorVersion: "test", completedAt: new Date().toISOString(),
      result: { type: "tags", tags: [], system: {
        important: { matched: false }, actionRequired: { matched: false }, invoice: { matched: false },
      } },
    });
    assert.equal(count(), 1, "AI refresh must preserve subject classification");
    assert.equal(queries.listCategories("account-1").find((category) => category.id === "invoice")?.unreadCount, 1);
    writer.persistMetadata({ accountId: "account-1", origin: "bootstrap", messages: [mail] });
    assert.equal(count(), 1, "repeated sync must not duplicate membership or counters");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("mail counters follow inserts, moves, flags, deletes and rollback without account recounts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-count-deltas-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    configureTestAccount(writer);
    insertCanonicalTestAccount(db, { id: "other-account" });
    insertCanonicalTestMessage(db, { id: "other-message", accountId: "other-account" });
    const check = () => {
      for (const [target, keys, aggregate] of [
        ["mail_account_counts", "account_id", "SELECT account_id, COUNT(*) AS total_count, SUM(is_seen = 0) AS unread_count, SUM(is_flagged = 1) AS flagged_count FROM mail_messages WHERE deleted_at_ms IS NULL GROUP BY account_id"],
        ["mail_folder_counts", "folder_id", "SELECT folder_id, COUNT(*) AS total_count, SUM(is_seen = 0) AS unread_count FROM mail_folder_memberships GROUP BY folder_id"],
        ["mail_category_counts", "account_id, category_id", "SELECT account_id, category_id, COUNT(*) AS total_count, SUM(is_seen = 0) AS unread_count FROM mail_message_system_categories GROUP BY account_id, category_id"],
        ["mail_tag_counts", "account_id, tag_id", "SELECT account_id, tag_id, COUNT(*) AS total_count, SUM(is_seen = 0) AS unread_count FROM mail_message_user_tags GROUP BY account_id, tag_id"],
      ]) {
        const flagged = target === "mail_account_counts" ? ", flagged_count" : "";
        assert.deepEqual(db.prepare(`SELECT ${keys}, total_count, unread_count${flagged} FROM ${target} WHERE total_count > 0 ORDER BY ${keys}`).all(),
          db.prepare(`${aggregate} ORDER BY ${keys}`).all(), target);
        assert.equal(db.prepare(`SELECT COUNT(*) FROM ${target} WHERE total_count = 0 AND (unread_count != 0${flagged ? " OR flagged_count != 0" : ""})`).pluck().get(), 0n);
      }
    };
    writer.persistMetadata({ accountId: "account-1", origin: "bootstrap", messages: [message(), {
      ...message(), id: "message-2", messageId: "<message-2@example.test>", folder: "Archive",
      sync: { ...message().sync!, uid: 2 },
    }] });
    const tag = new UserTagRepository(db).upsert({ accountId: "account-1", name: "Test", prompt: "Test" });
    new EmailSmartTagRepository(db).upsert({ accountId: "account-1", emailId: "message-1", userTagId: tag.id, source: "user" });
    db.exec(`INSERT INTO mail_message_system_categories
      (account_id, category_id, message_id, received_at_ms, source, is_seen, is_flagged, has_attachments, row_version)
      SELECT account_id, (SELECT id FROM mail_system_categories LIMIT 1), id, received_at_ms, 'ai', is_seen, is_flagged, has_attachments, 1
      FROM mail_messages WHERE public_id = 'message-1'`);
    check();
    // Replaying the upgrade calibrates legacy values without changing the source rows.
    db.exec("UPDATE mail_account_counts SET total_count = 100, unread_count = 90; UPDATE db_meta SET value = '12' WHERE key = 'migration_version'");
    runMailDatabaseMigrations(db);
    check();
    assert.throws(() => db.transaction(() => {
      db.exec("UPDATE mail_messages SET is_seen = 1, is_flagged = 1; DELETE FROM mail_message_user_tags");
      throw new Error("rollback");
    })(), /rollback/);
    check();
    for (const [key, mutation] of [
      ["flags", { type: "flags", patch: { seen: true, flagged: true } }],
      ["same-flags", { type: "flags", patch: { seen: true, flagged: true } }],
      ["move", { type: "move", folder: "Archive" }],
      ["delete", { type: "delete" }],
      ["repeat-delete", { type: "delete" }],
    ] as const) {
      writer.mutate({ accountId: "account-1", emailId: "message-1", idempotencyKey: key, mutation });
      check();
    }
    db.exec("DELETE FROM mail_messages WHERE public_id = 'message-2'");
    check();
    db.exec("DELETE FROM mail_accounts");
    check();
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("content topics and suggestions commit atomically with the current tags artifact", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-topic-artifact-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    configureTestAccount(writer);
    const countEvidence = () => db.prepare("SELECT COUNT(*) FROM mail_smart_topic_evidence").pluck().get();
    for (let index = 1; index <= 5; index += 1) {
      const email: MailMessage = {
        ...message(), id: `topic-message-${index}`, messageId: `<topic-${index}@example.test>`,
        from: { email: `sender@domain-${index % 2}.test` },
        sync: { ...message().sync!, uid: index },
      };
      writer.persistMetadata({ accountId: email.accountId, origin: "bootstrap", messages: [email] });
      writer.enqueueJob({ kind: "mail.body.ensure", accountId: email.accountId,
        payload: { emailId: email.id }, priority: 0, idempotencyKey: `body:${email.id}` });
      const bodyJob = writer.claimJob({ owner: "body-worker",
        filter: { kinds: ["mail.body.ensure"], subjectPublicId: email.id } });
      assert.ok(bodyJob);
      writer.persistBody({ message: { ...email, bodyText: "Build report content" },
        completedAt: new Date().toISOString(), jobId: bodyJob.id, jobOwner: "body-worker" });
      const job = writer.claimJob({ owner: "ai-worker",
        filter: { kinds: ["ai.tags"], subjectPublicId: email.id } });
      assert.ok(job);
      const payload = job.payload as { contentSha256: string; contentVersion: number };
      const input = {
        jobId: job.id, owner: "ai-worker", accountId: email.accountId, emailId: email.id,
        artifactKind: "tags" as const, sourceContentSha256: payload.contentSha256,
        sourceVersion: payload.contentVersion, processorVersion: "test",
        result: { type: "tags", tags: [], contentTags: [
          { name: "构建日报", confidence: 0.9, source: "ai", tier: "auto" },
        ] }, completedAt: new Date().toISOString(),
      };
      assert.throws(() => writer.completeAiArtifact({ ...input, owner: "wrong-owner" }), /lease-not-owned/);
      assert.equal(countEvidence(), BigInt(index - 1));
      if (index === 5) {
        db.exec("CREATE TRIGGER reject_suggestion BEFORE INSERT ON application_messages BEGIN SELECT RAISE(ABORT, 'suggestion-failed'); END");
        assert.throws(() => writer.completeAiArtifact(input), /suggestion-failed/);
        assert.equal(countEvidence(), 4n);
        assert.equal(db.prepare("SELECT state FROM mail_jobs WHERE id = ?").pluck().get(job.id), "leased");
        db.exec("DROP TRIGGER reject_suggestion");
      }
      assert.equal(writer.completeAiArtifact(input).value.current, true);
      const result = new MailDatabaseQueryRepository(db).getIntelligenceState(email.id).tags.result;
      assert.ok(result?.contentTags?.[0].topicId);
    }
    assert.deepEqual(db.prepare("SELECT mail_count, sender_count, state FROM mail_smart_topics").get(),
      { mail_count: 5n, sender_count: 2n, state: "pending" });
    assert.equal(db.prepare("SELECT COUNT(*) FROM application_messages WHERE message_type = 'smart-tag-suggestion'").pluck().get(), 1n);
    writer.requestIntelligence({ emailId: "topic-message-5", kinds: ["tags"], revive: true });
    const retry = writer.claimJob({ owner: "ai-worker",
      filter: { kinds: ["ai.tags"], subjectPublicId: "topic-message-5" } });
    assert.ok(retry);
    const payload = retry.payload as { contentSha256: string; contentVersion: number };
    writer.completeAiArtifact({ jobId: retry.id, owner: "ai-worker", accountId: "account-1",
      emailId: "topic-message-5", artifactKind: "tags", sourceContentSha256: payload.contentSha256,
      sourceVersion: payload.contentVersion, processorVersion: "test", completedAt: new Date().toISOString(),
      result: { type: "tags", tags: [], contentTags: [
        { name: "构建日报", confidence: 0.9, source: "ai", tier: "auto" },
      ] } });
    assert.equal(countEvidence(), 5n);
    assert.equal(db.prepare("SELECT COUNT(*) FROM application_messages").pluck().get(), 1n);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("ready content creates idempotent content-bound AI jobs and current artifacts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-ai-artifact-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db, { replyDecisionEnabled: true });
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
    writer.persistMetadata({
      accountId: "account-1",
      origin: "bootstrap",
      messages: [message()],
    });
    writer.enqueueJob({
      kind: "mail.body.ensure",
      accountId: "account-1",
      payload: { emailId: "message-1" },
      priority: 0,
      idempotencyKey: "body:message-1",
    });
    const bodyJob = writer.claimJob({
      owner: "body-worker",
      filter: { kinds: ["mail.body.ensure"] },
    });
    assert.ok(bodyJob);
    writer.persistBody({
      message: message("The committed canonical body."),
      completedAt: now,
      jobId: bodyJob.id,
      jobOwner: "body-worker",
    });
    writer.reconcileAiJobs(10);

    const jobs = db.prepare(`
      SELECT job_kind, max_attempts, input_version
      FROM mail_jobs
      WHERE subject_public_id = 'message-1' AND job_kind LIKE 'ai.%'
      ORDER BY job_kind
    `).all();
    assert.deepEqual(jobs, [
      { job_kind: "ai.reply-decision", max_attempts: 3n, input_version: 1n },
      { job_kind: "ai.summary", max_attempts: 2n, input_version: 1n },
      { job_kind: "ai.tags", max_attempts: 2n, input_version: 1n },
      { job_kind: "ai.todo", max_attempts: 2n, input_version: 1n },
    ]);

    const summaryJob = writer.claimJob({
      owner: "ai-worker",
      filter: { kinds: ["ai.summary"] },
    });
    assert.ok(summaryJob);
    const payload = summaryJob.payload as {
      contentSha256: string;
      contentVersion: number;
    };
    writer.completeAiArtifact({
      jobId: summaryJob.id,
      owner: "ai-worker",
      accountId: "account-1",
      emailId: "message-1",
      artifactKind: "summary",
      sourceContentSha256: payload.contentSha256,
      sourceVersion: payload.contentVersion,
      processorVersion: "test-1",
      promptVersion: "test-prompt-1",
      modelId: "test-model",
      result: { type: "summary", bullets: ["Canonical summary"], actionItems: [] },
      textValue: "Canonical summary",
      completedAt: now,
    });
    const state = new MailDatabaseQueryRepository(db).getIntelligenceState("message-1");
    assert.equal(state.summary.status, "succeeded");
    assert.deepEqual(state.summary.result?.bullets, ["Canonical summary"]);

    const tagsJob = writer.claimJob({
      owner: "ai-worker",
      filter: { kinds: ["ai.tags"] },
    });
    assert.ok(tagsJob);
    const tagsPayload = tagsJob.payload as {
      contentSha256: string;
      contentVersion: number;
    };
    const userTags = new UserTagRepository(db);
    const manualTag = userTags.upsert({ accountId: "account-1", name: "项目 Alpha", prompt: "Alpha" });
    new EmailSmartTagRepository(db).upsert({
      accountId: "account-1", emailId: "message-1", userTagId: manualTag.id,
      source: "user", confidence: 1,
    });
    const deletedTag = userTags.upsert({ accountId: "account-1", name: "已删除标签", prompt: "deleted" });
    db.prepare("UPDATE mail_user_tags SET deleted_at_ms = ? WHERE public_id = ?").run(Date.now(), deletedTag.id);
    const backfills = new SmartTagBackfillRepository(db);
    const run = backfills.create({ accountId: "account-1", reason: "test" });
    backfills.addProgress({ id: run.id, queuedDelta: 1 });
    db.prepare("UPDATE mail_jobs SET payload_json = ? WHERE id = ?").run(
      JSON.stringify({ ...tagsJob.payload as object, smartTagBackfillRunId: run.id }), tagsJob.id,
    );
    writer.completeAiArtifact({
      jobId: tagsJob.id,
      owner: "ai-worker",
      accountId: "account-1",
      emailId: "message-1",
      artifactKind: "tags",
      sourceContentSha256: tagsPayload.contentSha256,
      sourceVersion: tagsPayload.contentVersion,
      processorVersion: "test-tags-1",
      promptVersion: "test-tags-prompt-1",
      modelId: "test-model",
      result: {
        type: "tags",
        tags: [
          { name: "项目 Alpha", confidence: 0.9, source: "ai", tier: "auto" },
          { name: "已删除标签", confidence: 0.9, source: "ai", tier: "auto" },
        ],
        system: {
          important: { matched: true, confidence: 0.95, reason: "material", source: "ai" },
          actionRequired: { matched: false, confidence: 0.1, reason: "none", source: "ai" },
          invoice: { matched: false, confidence: 0.1, reason: "none", source: "ai" },
        },
      },
      completedAt: now,
    });
    const queries = new MailDatabaseQueryRepository(db);
    assert.deepEqual(queries.listCategories("account-1")[0], {
      id: "important",
      label: "重要",
      count: 1,
      unreadCount: 1,
      system: true,
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mail_message_user_tags").pluck().get(), 1n);
    assert.equal(backfills.getById(run.id)?.processedCount, 1);
    const relation = new EmailSmartTagRepository(db).get("message-1", manualTag.id);
    assert.equal(relation?.source, "user");
    assert.equal(relation?.confidence, 1);
    assert.equal(db.prepare("SELECT deleted_at_ms IS NOT NULL FROM mail_user_tags WHERE public_id = ?").pluck().get(deletedTag.id), 1n);

    const todoJob = writer.claimJob({ owner: "ai-worker", filter: { kinds: ["ai.todo"] } })!;
    const todoInput = {
      jobId: todoJob.id, owner: "ai-worker", accountId: "account-1", emailId: "message-1",
      artifactKind: "todoExtraction" as const, sourceContentSha256: payload.contentSha256,
      sourceVersion: payload.contentVersion, processorVersion: "todo-test", completedAt: now,
      result: { type: "todoExtraction", todos: [{ title: "Review budget", confidence: 0.9, status: "suggested" }] },
    };
    assert.throws(() => writer.completeAiArtifact({ ...todoInput, owner: "wrong-owner" }), /lease-not-owned/);
    assert.equal(db.prepare("SELECT COUNT(*) FROM mail_todos").pluck().get(), 0n);
    const todoCompletion = writer.completeAiArtifact(todoInput);
    assert.equal(todoCompletion.value.current, true);
    const persistedTodo = db.prepare("SELECT public_id FROM mail_todos").pluck().get();
    const todoState = new MailDatabaseQueryRepository(db).getIntelligenceState("message-1");
    assert.equal(todoState.todoExtraction?.result?.todos[0]?.id, persistedTodo);
    writer.requestIntelligence({ emailId: "message-1", kinds: ["todo"], revive: true });
    const staleTodoJob = writer.claimJob({ owner: "ai-worker", filter: { kinds: ["ai.todo"] } })!;
    const staleTodo = writer.completeAiArtifact({
      ...todoInput, jobId: staleTodoJob.id, sourceContentSha256: "stale-content",
      result: { type: "todoExtraction", todos: [{ title: "Obsolete follow-up", confidence: 0.9, status: "suggested" }] },
    });
    assert.equal(staleTodo.value.current, false);
    assert.equal(db.prepare("SELECT COUNT(*) FROM mail_todos").pluck().get(), 1n);

    writer.mutate({
      accountId: "account-1",
      emailId: "message-1",
      mutation: { type: "flags", patch: { seen: true } },
      idempotencyKey: "read:message-1",
    });
    assert.equal(queries.listCategories("account-1")[0]?.unreadCount, 0);

    const retry = writer.requestIntelligence({
      emailId: "message-1",
      kinds: ["summary"],
      revive: true,
    });
    assert.equal(retry.value.jobIds.length, 1);
    assert.equal(retry.changes[0]?.entityType, "ai_job");
    assert.deepEqual(db.prepare(`
      SELECT state, priority, attempt_count
      FROM mail_jobs WHERE id = ?
    `).get(retry.value.jobIds[0]!), {
      state: "pending",
      priority: 1n,
      attempt_count: 0n,
    });
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("ready content skips ai.reply-decision when the reply-decision switch is off", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-ai-switch-off-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db, { replyDecisionEnabled: false });
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
    writer.persistMetadata({
      accountId: "account-1",
      origin: "bootstrap",
      messages: [message("The committed canonical body.")],
    });
    const bodyJob = writer.enqueueJob({
      kind: "mail.body.ensure",
      accountId: "account-1",
      payload: { emailId: "message-1" },
      priority: 0,
      idempotencyKey: "body:message-1",
    });
    const claimedBody = writer.claimJob({
      owner: "body-worker",
      filter: { kinds: ["mail.body.ensure"], subjectPublicId: "message-1" },
    });
    assert.equal(claimedBody?.id, bodyJob.id);
    writer.persistBody({
      message: message("The committed canonical body."),
      completedAt: now,
      jobId: bodyJob.id,
      jobOwner: "body-worker",
    });
    const kinds = db.prepare(`
      SELECT job_kind FROM mail_jobs
      WHERE subject_public_id = 'message-1' AND job_kind LIKE 'ai.%'
    `).all().map((row) => (row as { job_kind: string }).job_kind).sort();
    assert.deepEqual(kinds, ["ai.summary", "ai.tags", "ai.todo"]);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual intelligence hydration preserves the requested capability", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-ai-scoped-body-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    configureTestAccount(writer);
    writer.persistMetadata({
      accountId: "account-1",
      origin: "bootstrap",
      messages: [message()],
    });
    writer.requestIntelligence({
      emailId: "message-1",
      kinds: ["summary"],
      revive: true,
    });
    const bodyJob = writer.claimJob({
      owner: "body-worker",
      filter: { kinds: ["mail.body.ensure"], subjectPublicId: "message-1" },
    });
    assert.ok(bodyJob);
    writer.persistBody({
      message: message("The committed canonical body."),
      completedAt: new Date().toISOString(),
      jobId: bodyJob.id,
      jobOwner: "body-worker",
    });

    const jobs = db.prepare(`
      SELECT job_kind, priority FROM mail_jobs
      WHERE subject_public_id = 'message-1' AND job_kind LIKE 'ai.%'
    `).all();
    assert.deepEqual(jobs, [{ job_kind: "ai.summary", priority: 1n }]);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("natural mail intelligence uses the highest priority", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-ai-live-priority-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    configureTestAccount(writer);
    writer.persistMetadata({
      accountId: "account-1",
      origin: "live-idle",
      messages: [message()],
    });
    writer.enqueueJob({
      kind: "mail.body.ensure",
      accountId: "account-1",
      payload: { emailId: "message-1", aiPriority: 0 },
      priority: 1,
      idempotencyKey: "body:message-1",
    });
    const bodyJob = writer.claimJob({
      owner: "body-worker",
      filter: { kinds: ["mail.body.ensure"], subjectPublicId: "message-1" },
    });
    assert.ok(bodyJob);
    writer.persistBody({
      message: message("The committed canonical body."),
      completedAt: new Date().toISOString(),
      jobId: bodyJob.id,
      jobOwner: "body-worker",
    });

    const priorities = db.prepare(`
      SELECT DISTINCT priority FROM mail_jobs
      WHERE subject_public_id = 'message-1' AND job_kind LIKE 'ai.%'
    `).all();
    assert.deepEqual(priorities, [{ priority: 0n }]);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("account credential commits are idempotent and reject generation rollback", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-account-writer-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    const now = new Date().toISOString();
    const input = {
      account: {
        id: "account-1",
        emailAddress: "account-1@example.test",
        imap: { host: "imap.example.test", port: 993, secure: true, username: "account-1@example.test" },
        smtp: { host: "smtp.example.test", port: 465, secure: true, username: "account-1@example.test" },
        createdAt: now,
        updatedAt: now,
      },
      credentialRef: "safe-storage:mailbox:account-1",
      credentialGeneration: 2,
    };
    const first = writer.configureAccount(input);
    const repeated = writer.configureAccount(input);
    assert.equal(repeated.commitVersion, first.commitVersion);
    assert.deepEqual(repeated.changes, []);
    assert.throws(
      () => writer.configureAccount({ ...input, credentialGeneration: 1 }),
      /stale-credential-generation/,
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("monitoring summary surfaces the generate-chart scene action", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-scene-action-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
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
    writer.persistMetadata({
      accountId: "account-1",
      origin: "bootstrap",
      messages: [message()],
    });
    writer.enqueueJob({
      kind: "mail.body.ensure",
      accountId: "account-1",
      payload: { emailId: "message-1" },
      priority: 0,
      idempotencyKey: "body:message-1",
    });
    const bodyJob = writer.claimJob({
      owner: "body-worker",
      filter: { kinds: ["mail.body.ensure"] },
    });
    assert.ok(bodyJob);
    writer.persistBody({
      message: message("调用量 100，失败量 2，成功率 98%。"),
      completedAt: now,
      jobId: bodyJob.id,
      jobOwner: "body-worker",
    });
    writer.reconcileAiJobs(10);

    const summaryJob = writer.claimJob({
      owner: "ai-worker",
      filter: { kinds: ["ai.summary"] },
    });
    assert.ok(summaryJob);
    const payload = summaryJob.payload as { contentSha256: string; contentVersion: number };
    writer.completeAiArtifact({
      jobId: summaryJob.id,
      owner: "ai-worker",
      accountId: "account-1",
      emailId: "message-1",
      artifactKind: "summary",
      sourceContentSha256: payload.contentSha256,
      sourceVersion: payload.contentVersion,
      processorVersion: "test-1",
      promptVersion: "test-prompt-1",
      modelId: "test-model",
      result: {
        type: "summary",
        schemaVersion: 3,
        intent: "other",
        attention: "know",
        displayMode: "brief",
        headline: "失败量为 2。",
        details: [],
        actions: [],
        bullets: ["失败量为 2。"],
        actionItems: [],
        urgency: "low",
        dataInsight: {
          kind: "monitoring_report",
          metrics: [
            { label: "调用量", value: "100" },
            { label: "失败量", value: "2" },
          ],
          findings: [{ kind: "fact", text: "当前失败量为 2。" }],
          evidenceLevel: "snapshot",
          chartRecommended: true,
        },
      },
      textValue: "失败量为 2。",
      completedAt: now,
    });

    const state = new MailDatabaseQueryRepository(db).getIntelligenceState("message-1");
    assert.equal(state.summary.status, "succeeded");
    assert.equal(state.summary.result?.dataInsight?.kind, "monitoring_report");
    assert.deepEqual(
      (state.sceneActions ?? []).map((action) => action.id),
      ["monitoring.generate_chart"],
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("claimJob filter.order 'lifo' returns the newest pending ai.* job in a priority bucket", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-ai-lifo-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    configureTestAccount(writer);
    writer.enqueueJob({ kind: "ai.summary", accountId: "account-1", payload: { emailId: "m-older" }, priority: 1, idempotencyKey: "sum:m-older" });
    writer.enqueueJob({ kind: "ai.summary", accountId: "account-1", payload: { emailId: "m-newer" }, priority: 1, idempotencyKey: "sum:m-newer" });
    const claimed = writer.claimJob({
      owner: "ai-worker",
      filter: { kinds: ["ai.summary"], order: "lifo" },
    });
    assert.equal((claimed?.payload as { emailId?: string }).emailId, "m-newer");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("dispatch merges kinds by priority and recency, skipping future jobs and tracking late metadata", () => {
  const db = createMailDatabase(":memory:");
  try {
    const writer = new MailDatabaseWriter(db);
    configureTestAccount(writer);
    const enqueue = (kind: string, emailId: string, priority: number, availableAt?: string) =>
      writer.enqueueJob({ kind, accountId: "account-1", payload: { emailId }, priority, availableAt });
    const older = enqueue("ai.summary", "older", 1);
    const newer = enqueue("ai.tags", "newer", 1);
    insertCanonicalTestMessage(db, { id: "older", accountId: "account-1", receivedAtMs: 100 });
    insertCanonicalTestMessage(db, { id: "newer", accountId: "account-1", receivedAtMs: 200 });
    insertCanonicalTestMessage(db, { id: "future", accountId: "account-1", receivedAtMs: 300 });
    enqueue("ai.summary", "future", 1, new Date(Date.now() + 60_000).toISOString());
    const urgent = enqueue("ai.tags", "older", 0);
    const claim = () => writer.claimJob({
      owner: "dispatch-worker",
      filter: { kinds: ["ai.summary", "ai.tags"], priorities: [0, 1], order: "lifo" },
    });
    assert.equal(claim()?.id, urgent.id);
    db.prepare("UPDATE mail_messages SET received_at_ms = 400 WHERE public_id = 'older'").run();
    assert.equal(claim()?.id, older.id);
    assert.equal(claim()?.id, newer.id);
    db.pragma("query_only = ON");
    assert.equal(claim(), null);
    assert.equal(writer.recoverExpiredJobLeases(), 0);
  } finally {
    db.close();
  }
});

test("AI recency order uses message received time and initial coverage stays one-shot", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-ai-recency-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    configureTestAccount(writer);
    const older = {
      ...message(),
      id: "m-older",
      messageId: "<m-older@example.test>",
      receivedAt: "2026-08-01T00:00:00.000Z",
      sync: { uid: 1, uidValidity: 1, internalDate: "2026-08-01T00:00:00.000Z" },
    };
    const newer = {
      ...message(),
      id: "m-newer",
      messageId: "<m-newer@example.test>",
      receivedAt: "2026-08-02T00:00:00.000Z",
      sync: { uid: 2, uidValidity: 1, internalDate: "2026-08-02T00:00:00.000Z" },
    };
    writer.persistMetadata({
      accountId: "account-1",
      origin: "historical",
      messages: [older, newer],
      initialSyncCompleted: true,
    });

    for (const mail of [older, newer]) {
      const bodyJob = writer.enqueueJob({
        kind: "mail.body.ensure",
        accountId: "account-1",
        payload: { emailId: mail.id, aiPriority: 4 },
        priority: 10,
        idempotencyKey: `body:${mail.id}`,
      });
      const claimedBody = writer.claimJob({
        owner: `body-worker:${mail.id}`,
        filter: { kinds: ["mail.body.ensure"], subjectPublicId: mail.id },
      });
      assert.ok(claimedBody);
      assert.equal(claimedBody.id, bodyJob.id);
      writer.persistBody({
        message: {
          ...mail,
          bodyText: "Initial body",
          bodyCachedUntil: new Date().toISOString(),
          bodyVersion: 1,
        },
        completedAt: new Date().toISOString(),
        jobId: claimedBody.id,
        jobOwner: `body-worker:${mail.id}`,
      });
    }

    const claimedSummary = writer.claimJob({
      owner: "ai-worker",
      filter: { kinds: ["ai.summary"], order: "lifo" },
    });
    assert.equal(
      (claimedSummary?.payload as { emailId?: string }).emailId,
      "m-newer",
    );

    const future = {
      ...message(),
      id: "m-future",
      messageId: "<m-future@example.test>",
      receivedAt: "2026-08-03T00:00:00.000Z",
      sync: { uid: 3, uidValidity: 1, internalDate: "2026-08-03T00:00:00.000Z" },
    };
    writer.persistMetadata({
      accountId: "account-1",
      origin: "historical",
      messages: [future],
      initialSyncCompleted: true,
    });
    const scope = db.prepare(`
      SELECT ai_initial_summary_scope
      FROM mail_messages WHERE public_id = ?
    `).get("m-future") as { ai_initial_summary_scope: bigint };
    assert.equal(Number(scope.ai_initial_summary_scope), 0);
    const coverage = db.prepare(
      "SELECT COUNT(*) AS count FROM mail_ai_initial_coverage",
    ).get() as { count: bigint };
    assert.equal(Number(coverage.count), 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("claimJob default order is fifo (oldest pending ai.* job first)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-ai-fifo-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    configureTestAccount(writer);
    writer.enqueueJob({ kind: "ai.summary", accountId: "account-1", payload: { emailId: "m-older" }, priority: 1, idempotencyKey: "sum:m-older" });
    writer.enqueueJob({ kind: "ai.summary", accountId: "account-1", payload: { emailId: "m-newer" }, priority: 1, idempotencyKey: "sum:m-newer" });
    const claimed = writer.claimJob({
      owner: "ai-worker",
      filter: { kinds: ["ai.summary"] },
    });
    assert.equal((claimed?.payload as { emailId?: string }).emailId, "m-older");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("resetTerminalAiJobsForRetry revives transient terminal ai.* jobs but keeps deterministic ones", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-ai-reset-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    configureTestAccount(writer);
    const terminalize = (emailId: string, idempotencyKey: string, errorCode: string) => {
      writer.enqueueJob({ kind: "ai.summary", accountId: "account-1", payload: { emailId }, priority: 1, idempotencyKey });
      const job = writer.claimJob({
        owner: "ai-worker",
        filter: { kinds: ["ai.summary"], subjectPublicId: emailId },
      });
      assert.ok(job, `failed to claim ${emailId}`);
      writer.terminalJob(job.id, "ai-worker", errorCode);
    };
    terminalize("m-auth", "sum:m-auth", "auth_unavailable: no auth available (providers=codex, model=gpt-5.3-codex-spark)");
    terminalize("m-timeout", "sum:m-timeout", "request timed out");
    terminalize("m-body", "sum:m-body", "mail-body-not-available");
    terminalize("m-missing", "sum:m-missing", "mail-missing");

    const revived = writer.resetTerminalAiJobsForRetry();
    assert.equal(revived.count, 2);

    const rows = db
      .prepare(
        "SELECT subject_public_id, state, attempt_count, last_error_code " +
          "FROM mail_jobs WHERE job_kind='ai.summary' ORDER BY subject_public_id",
      )
      .all() as Array<{
        subject_public_id: string;
        state: string;
        attempt_count: number | bigint;
        last_error_code: string | null;
      }>;
    const byId = Object.fromEntries(rows.map((r) => [r.subject_public_id, r]));
    assert.equal(byId["m-auth"].state, "pending");
    assert.equal(Number(byId["m-auth"].attempt_count), 0);
    assert.equal(byId["m-auth"].last_error_code, null);
    assert.equal(byId["m-timeout"].state, "pending");
    assert.equal(byId["m-timeout"].last_error_code, null);
    assert.equal(byId["m-body"].state, "terminal");
    assert.equal(byId["m-body"].last_error_code, "mail-body-not-available");
    assert.equal(byId["m-missing"].state, "terminal");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal AI recovery advances through bounded ranges and ignores jobs beyond its starting boundary", () => {
  const db = createMailDatabase(":memory:");
  try {
    const writer = new MailDatabaseWriter(db);
    configureTestAccount(writer);
    db.transaction(() => {
      for (let index = 0; index < 305; index += 1) writer.enqueueJob({
        kind: index < 100 ? "mail.body.ensure" : "ai.summary", accountId: "account-1",
        payload: { emailId: `recovery-${index}` }, priority: 4, idempotencyKey: `recovery-${index}`,
      });
      db.exec("UPDATE mail_jobs SET state = 'terminal', last_error_code = 'timeout', attempt_count = 5");
      db.prepare("UPDATE mail_jobs SET last_error_code = 'mail-missing' WHERE id IN (SELECT id FROM mail_jobs ORDER BY id LIMIT 200)").run();
    })();
    const first = writer.resetTerminalAiJobsForRetry();
    assert.equal(first.count, 0);
    assert.equal(first.afterId, 100);
    assert.equal(first.throughId, 305);
    writer.enqueueJob({ kind: "ai.summary", accountId: "account-1", payload: { emailId: "late" },
      priority: 4, idempotencyKey: "late" });
    db.exec("UPDATE mail_jobs SET state = 'terminal', last_error_code = 'timeout' WHERE id = 306");
    const second = writer.resetTerminalAiJobsForRetry(first);
    assert.equal(second.count, 0);
    assert.equal(second.afterId, 200);
    const third = writer.resetTerminalAiJobsForRetry(second);
    assert.equal(third.count, 100);
    assert.equal(third.afterId, 300);
    const final = writer.resetTerminalAiJobsForRetry(third);
    assert.equal(final.count, 5);
    assert.equal(final.afterId, final.throughId);
    assert.equal(db.prepare("SELECT state FROM mail_jobs WHERE id = 306").pluck().get(), "terminal");
    assert.equal(db.prepare("SELECT COUNT(*) FROM mail_jobs WHERE state = 'pending'").pluck().get(), 105n);
  } finally { db.close(); }
});

test("an ineligible recovery page does not acquire the database write lock", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-ai-recovery-lock-"));
  const databasePath = path.join(directory, "wemail.sqlite");
  const db = createMailDatabase(databasePath);
  let competingWriter: ReturnType<typeof openMailDatabase> | undefined;
  try {
    const writer = new MailDatabaseWriter(db);
    configureTestAccount(writer);
    writer.enqueueJob({ kind: "mail.body.ensure", accountId: "account-1", priority: 4,
      idempotencyKey: "unrelated", payload: { emailId: "unrelated" } });
    competingWriter = openMailDatabase(databasePath);
    competingWriter.exec("BEGIN IMMEDIATE");
    db.pragma("busy_timeout = 1");
    const result = writer.resetTerminalAiJobsForRetry();
    assert.equal(result.count, 0);
    assert.equal(result.afterId, result.throughId);
  } finally {
    if (competingWriter?.inTransaction) competingWriter.exec("ROLLBACK");
    competingWriter?.close(); db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reconcileBodyHydration enqueues/revives/reprioritizes without BigInt mixing on a safeIntegers writer", () => {
  // createMailDatabase defaults to safeIntegers: true (Database.ts), matching the
  // writer connection. Integer columns therefore come back as BigInt, and the
  // reconcile used to crash on `now - receivedAtMs` (Number - BigInt) with
  // "Cannot mix BigInt and other types" — which starved background hydration.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-reconcile-bigint-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db);
    configureTestAccount(writer);

    const mk = (id: string, uid: number): MailMessage => ({
      ...message(),
      id,
      subject: `reconcile ${id}`,
      messageId: `<${id}@example.test>`,
      sync: { uid, uidValidity: 1, internalDate: "2026-08-02T00:00:00.000Z" },
    });
    // Empty bodies -> content state 'missing', eligible for hydration.
    writer.persistMetadata({
      accountId: "account-1",
      origin: "bootstrap",
      messages: [mk("m-enqueue", 1), mk("m-revive", 2), mk("m-legacy", 3)],
    });

    // m-revive: terminal body job -> revive path.
    const reviveJob = writer.enqueueJob({
      kind: "mail.body.ensure",
      accountId: "account-1",
      payload: { emailId: "m-revive" },
      priority: 1,
      idempotencyKey: "body.ensure:account-1:m-revive",
      terminalPolicy: "revive",
    });
    db.prepare("UPDATE mail_jobs SET state = 'terminal' WHERE id = ?").run(reviveJob.id);

    // m-legacy: pending body job at the legacy priority-4 tier -> reprioritize path.
    writer.enqueueJob({
      kind: "mail.body.ensure",
      accountId: "account-1",
      payload: { emailId: "m-legacy" },
      priority: 4,
      idempotencyKey: "body.ensure:account-1:m-legacy",
    });

    const result = writer.reconcileBodyHydration("account-1", { limit: 10 });
    assert.deepEqual(result, { reprioritized: 1, enqueued: 1, revived: 1, skippedPermanent: 0 });

    const jobs = db.prepare(`
      SELECT subject_public_id, state, priority, attempt_count FROM mail_jobs
      WHERE job_kind = 'mail.body.ensure'
      ORDER BY subject_public_id
    `).all() as Array<{
      subject_public_id: string;
      state: string;
      priority: number | bigint;
      attempt_count: number | bigint;
    }>;
    const byId = Object.fromEntries(jobs.map((row) => [row.subject_public_id, row]));
    assert.equal(byId["m-enqueue"].state, "pending");
    assert.equal(byId["m-revive"].state, "pending");
    assert.equal(Number(byId["m-revive"].attempt_count), 0);
    // m-legacy was reprioritized away from the legacy tier (priority is no longer 4).
    assert.equal(byId["m-legacy"].state, "pending");
    assert.notEqual(Number(byId["m-legacy"].priority), 4);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("completeAiArtifactBatch applies valid items and skips stale-lease items in one commit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-ai-batch-"));
  const db = createMailDatabase(path.join(directory, "wemail.sqlite"));
  try {
    const writer = new MailDatabaseWriter(db, { replyDecisionEnabled: true });
    configureTestAccount(writer);
    const now = new Date().toISOString();
    writer.persistMetadata({ accountId: "account-1", origin: "bootstrap", messages: [message()] });
    writer.enqueueJob({
      kind: "mail.body.ensure",
      accountId: "account-1",
      payload: { emailId: "message-1" },
      priority: 0,
      idempotencyKey: "body:message-1",
    });
    const bodyJob = writer.claimJob({ owner: "body-worker", filter: { kinds: ["mail.body.ensure"] } })!;
    writer.persistBody({
      message: message("The committed canonical body."),
      completedAt: now,
      jobId: bodyJob.id,
      jobOwner: "body-worker",
    });
    writer.reconcileAiJobs(10);

    const summaryJob = writer.claimJob({ owner: "ai-worker", filter: { kinds: ["ai.summary"] } })!;
    assert.ok(summaryJob);
    const payload = summaryJob.payload as { contentSha256: string; contentVersion: number };

    const baseItem = {
      owner: "ai-worker",
      accountId: "account-1",
      emailId: "message-1",
      artifactKind: "summary" as const,
      sourceContentSha256: payload.contentSha256,
      sourceVersion: payload.contentVersion,
      processorVersion: "batch-v1",
      promptVersion: "batch-prompt",
      modelId: "batch-model",
      result: { type: "summary", bullets: ["Batched summary"], actionItems: [] },
      textValue: "Batched summary",
      completedAt: now,
    };

    const result = writer.completeAiArtifactBatch({
      items: [
        { jobId: summaryJob.id, ...baseItem }, // valid: lease owned by ai-worker
        { jobId: summaryJob.id, ...baseItem, owner: "other-worker" }, // stale: wrong owner (and job already succeeded above)
        { jobId: 9_999_999, ...baseItem }, // stale: no such job
      ],
    });

    assert.equal(result.value.results[0]!.skipped, undefined, "first item applied");
    assert.equal(result.value.results[0]!.artifactId !== "", true, "applied item gets an artifact id");
    assert.equal(result.value.results[1]!.skipped, true, "wrong-owner item skipped");
    assert.equal(result.value.results[2]!.skipped, true, "missing-job item skipped");

    const state = new MailDatabaseQueryRepository(db).getIntelligenceState("message-1");
    assert.equal(state.summary.status, "succeeded");
    assert.deepEqual(state.summary.result?.bullets, ["Batched summary"]);

    // Exactly one db_commits row for the whole batch (one transaction).
    const commits = db.prepare(
      "SELECT COUNT(*) AS n FROM db_commits WHERE source = 'ai-artifact-batch'",
    ).get() as { n: number | bigint };
    assert.equal(Number(commits.n), 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
