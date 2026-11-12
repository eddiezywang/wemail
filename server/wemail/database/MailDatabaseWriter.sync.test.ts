import assert from "node:assert/strict";
import test from "node:test";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import type { MailSyncCheckpoint } from "../../../shared/wemail/mailSync.js";
import { MailDatabasePersistMetadataParamsSchema } from "../../../shared/wemail/mailDatabaseProtocol.js";
import { createMailDatabase } from "./Database.js";
import { MailDatabaseWriter } from "./MailDatabaseWriter.js";
import { MailDatabaseQueryRepository } from "./MailDatabaseQueryRepository.js";
import { insertCanonicalTestAccount } from "./MailDatabase.test-support.js";
import { AccountService } from "../account/AccountService.js";
import { createAccountServiceTestClient, createMutableSecretStore } from "../account/AccountService.test-support.js";
import { imapPasswordKey } from "../account/AccountTypes.js";
import { ImapSmtpMailProvider, type ImapLikeClient } from "../mail/ImapSmtpMailProvider.js";
import type { MailMetadataPage } from "../mail/MailProvider.js";

const timestamp = "2026-11-04T00:00:00.000Z";
function message(uid: number): MailMessage {
  return {
    id: `acct-1:INBOX:17:${uid}`, accountId: "acct-1", folder: "INBOX", messageId: `<${uid}@example.test>`,
    from: { email: "sender@example.test" }, to: [{ email: "acct-1@example.test" }], cc: [], bcc: [],
    subject: `Mail ${uid}`, snippet: "", bodyText: "", receivedAt: timestamp,
    hasAttachments: false, attachments: [],
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: { uid, uidValidity: 17, internalDate: timestamp },
  };
}

test("metadata checkpoint and page are atomic and require the current job owner", () => {
  const db = createMailDatabase(":memory:");
  try {
    insertCanonicalTestAccount(db, { id: "acct-1" });
    const writer = new MailDatabaseWriter(db);
    const queries = new MailDatabaseQueryRepository(db);
    writer.enqueueJob({ kind: "mail.metadata.sync", accountId: "acct-1", priority: 2, payload: { origin: "manual" } });
    const leased = writer.claimJob({ owner: "generation-1", filter: { kinds: ["mail.metadata.sync"] } })!;
    const checkpoint: MailSyncCheckpoint = {
      folder: "INBOX", previous: null,
      next: { uid: 1, uidValidity: 17, internalDate: timestamp }, mode: "incremental",
    };
    const input = {
      accountId: "acct-1", origin: "manual" as const, messages: [message(1)], checkpoint,
      lease: { id: leased.id, owner: "generation-1" },
    };
    db.exec(`CREATE TRIGGER fail_sync_page BEFORE INSERT ON mail_messages
      BEGIN SELECT RAISE(ABORT, 'page-write-failed'); END;`);
    assert.throws(() => writer.persistMetadata(input), /page-write-failed/);
    assert.deepEqual(queries.getSyncStates("acct-1"), Object.create(null));
    db.exec("DROP TRIGGER fail_sync_page");
    db.exec(`CREATE TRIGGER fail_body_queue BEFORE INSERT ON mail_jobs
      WHEN NEW.job_kind = 'mail.body.ensure'
      BEGIN SELECT RAISE(ABORT, 'body-queue-failed'); END;`);
    assert.throws(() => writer.persistMetadata(input), /body-queue-failed/);
    assert.deepEqual(queries.getSyncStates("acct-1"), Object.create(null));
    assert.equal(db.prepare("SELECT COUNT(*) FROM mail_messages").pluck().get(), 0n);
    db.exec("DROP TRIGGER fail_body_queue");
    const first = writer.persistMetadata(input);
    assert.equal(first.value.insertedCount, 1);
    const bodies = db.prepare("SELECT subject_public_id, priority FROM mail_jobs WHERE job_kind = 'mail.body.ensure'")
      .all() as Array<{ subject_public_id: string; priority: bigint }>;
    assert.deepEqual(bodies, [{ subject_public_id: first.value.insertedIds[0], priority: 1n }]);
    assert.deepEqual(queries.getSyncStates("acct-1").INBOX, checkpoint.next);
    assert.throws(() => writer.persistMetadata(input), /checkpoint-conflict/);
    assert.equal(db.prepare("SELECT COUNT(*) FROM mail_messages").pluck().get(), 1n);
    const replayed = writer.persistMetadata({ ...input, checkpoint: {
      ...checkpoint, previous: checkpoint.next,
    } });
    assert.equal(replayed.value.insertedCount, 0, "reloading committed progress after a lost ACK must not rediscover mail");
    assert.ok(!replayed.changes.some((change) => change.entityType === "message" && change.operation === "insert"),
      "a replay must not publish another insertion to notification or automation consumers");
    assert.equal(db.prepare("SELECT COUNT(*) FROM mail_jobs WHERE job_kind = 'mail.body.ensure'").pluck().get(), 1n);
    writer.failJob(leased.id, "generation-1", "worker-exit");
    assert.throws(() => writer.persistMetadata({
      ...input, messages: [message(2)],
      checkpoint: { ...checkpoint, previous: checkpoint.next, next: { ...checkpoint.next, uid: 2 } },
    }), /lease-not-owned/);
    assert.equal(queries.getSyncStates("acct-1").INBOX.uid, 1);
  } finally { db.close(); }
});

test("6000 sparse messages persist through provider pages and resume after a lost page ACK", async () => {
  const db = createMailDatabase(":memory:");
  const account = {
    id: "acct-1", emailAddress: "acct-1@example.test",
    imap: { host: "imap.example.test", port: 993, secure: true, username: "acct-1@example.test" },
    smtp: { host: "smtp.example.test", port: 465, secure: true, username: "acct-1@example.test" },
    createdAt: timestamp, updatedAt: timestamp,
  };
  const accounts = createAccountServiceTestClient([{
    account, credentialRef: "fixture", credentialGeneration: 1, state: "active",
  }]);
  const secrets = createMutableSecretStore();
  secrets.saveSecret(imapPasswordKey(account.id), "fixture-password");
  const accountService = new AccountService({ mailDatabase: accounts.client, secrets, initialAccounts: accounts.records() });
  const uids = Array.from({ length: 6000 }, (_, index) => 3 + index * 2);
  let activeSessions = 0;
  let maxSessions = 0;
  let maxFetch = 0;
  const createProvider = () => new ImapSmtpMailProvider({ accountService, secrets, imapFactory: () => ({
    async connect() { maxSessions = Math.max(maxSessions, ++activeSessions); },
    async logout() { activeSessions--; },
    async mailboxOpen() { return { uidValidity: 17, uidNext: uids.at(-1)! + 1 }; },
    async search(query) {
      const [from, to] = String(query.uid).split(":").map(Number);
      assert.ok(to - from < 512, "UID discovery remains bounded across the entire backlog");
      return uids.filter((uid) => uid >= from && uid <= to);
    },
    async *fetch(range) {
      assert.ok(Array.isArray(range));
      maxFetch = Math.max(maxFetch, range.length);
      for (const uid of range) yield {
        uid, internalDate: uid % 4 === 1 ? "2025-01-01T00:00:00Z" : timestamp,
        envelope: { messageId: `<pipeline-${uid}@example.test>`, subject: `Mail ${uid}`,
          from: [{ address: "sender@example.test" }], to: [{ address: account.emailAddress }] },
      };
    },
  } satisfies ImapLikeClient) });
  let provider = createProvider();
  try {
    insertCanonicalTestAccount(db, { id: account.id });
    const writer = new MailDatabaseWriter(db);
    const queries = new MailDatabaseQueryRepository(db);
    writer.persistMetadata({ accountId: account.id, origin: "bootstrap", messages: [message(1)] });
    const queued = writer.enqueueJob({ kind: "mail.metadata.sync", accountId: account.id, priority: 1, payload: { origin: "manual" } });
    let lease = writer.claimJob({ owner: "worker-1", filter: { kinds: ["mail.metadata.sync"] } })!;
    const scan = () => provider.syncIncrementalPages({ states: queries.getSyncStates(account.id), since: new Date("2026-05-01T00:00:00Z") });
    const commit = (page: MailMetadataPage) => {
      assert.ok(page.messages.length <= 50);
      return writer.persistMetadata({ accountId: account.id, origin: "manual", messages: page.messages,
        checkpoint: page.checkpoint, lease: { id: lease.id, owner: lease.leaseOwner! } });
    };
    const interrupted = scan();
    for (let page = 0; page < 3; page++) {
      const step = await interrupted.next();
      assert.ok(!step.done);
      commit(step.value);
    }
    // The third commit is durable but its ACK never reaches the old generator.
    await interrupted.return();
    await provider.disconnect();
    assert.equal(writer.failJob(queued.id, "worker-1", "worker-exit", 0), true);
    lease = writer.claimJob({ owner: "worker-2", filter: { kinds: ["mail.metadata.sync"] } })!;
    provider = createProvider();
    for await (const page of scan()) commit(page);
    assert.deepEqual(db.prepare("SELECT remote_uid FROM mail_message_instances ORDER BY remote_uid").pluck().all(),
      [1, ...uids].map(BigInt));
    assert.equal(db.prepare("SELECT COUNT(*) FROM mail_messages").pluck().get(), 6001n);
    assert.equal(db.prepare("SELECT COUNT(*) FROM mail_jobs WHERE job_kind = 'mail.body.ensure'").pluck().get(), 6000n);
    assert.equal(queries.getSyncStates(account.id).INBOX.uid, uids.at(-1));
    for await (const page of scan()) {
      const replay = commit(page);
      assert.equal(replay.value.insertedCount, 0);
      assert.ok(!replay.changes.some((change) => change.entityType === "message" && change.operation === "insert"));
    }
    assert.equal(maxFetch, 50);
    assert.equal(maxSessions, 1);
  } finally {
    await provider.disconnect();
    db.close();
  }
});

test("coverage progress commits without regressing the realtime cursor and survives empty pages", () => {
  const db = createMailDatabase(":memory:");
  try {
    insertCanonicalTestAccount(db, { id: "acct-1" });
    const writer = new MailDatabaseWriter(db);
    const queries = new MailDatabaseQueryRepository(db);
    writer.persistMetadata({ accountId: "acct-1", origin: "bootstrap", messages: [message(6000)] });
    writer.enqueueJob({ kind: "mail.metadata.sync", accountId: "acct-1", priority: 4, payload: { origin: "historical" } });
    const lease = writer.claimJob({ owner: "repair", filter: { kinds: ["mail.metadata.sync"] } })!;
    const previous = queries.getSyncStates("acct-1").INBOX;
    const next = { ...previous, repair: { version: 1 as const, since: timestamp, uid: 512, completed: false } };
    writer.persistMetadata({
      accountId: "acct-1", origin: "historical", messages: [message(1)], lease: { id: lease.id, owner: "repair" },
      checkpoint: { folder: "INBOX", previous, next, mode: "repair" },
    });
    assert.equal(queries.getSyncCursor("acct-1")?.uid, 6000);
    assert.equal(db.prepare("SELECT COUNT(*) FROM mail_messages").pluck().get(), 2n, "repair restores a gap below the realtime high water");
    assert.deepEqual(queries.getSyncStates("acct-1").INBOX.repair, next.repair);
    assert.throws(() => writer.persistMetadata({
      accountId: "acct-1", origin: "historical", messages: [], lease: { id: lease.id, owner: "repair" },
      checkpoint: { folder: "INBOX", previous: next, next: { ...next, uid: 7000 }, mode: "repair" },
    }), /repair-changed-realtime-cursor/);
    assert.throws(() => writer.persistMetadata({
      accountId: "acct-1", origin: "manual", messages: [], lease: { id: lease.id, owner: "repair" },
      checkpoint: { folder: "INBOX", previous: next, next: { ...next, uid: 1 }, mode: "incremental" },
    }), /checkpoint-regressed/);
    writer.persistMetadata({
      accountId: "acct-1", origin: "historical", messages: [], lease: { id: lease.id, owner: "repair" },
      checkpoint: { folder: "INBOX", previous: next,
        next: { ...next, repair: { ...next.repair, uid: 1024 } }, mode: "repair" },
    });
    assert.equal(queries.getSyncStates("acct-1").INBOX.repair?.uid, 1024);
    assert.equal(queries.getSyncCursor("acct-1")?.uid, 6000);
  } finally { db.close(); }
});

test("the metadata trust boundary rejects an unowned or mixed-folder checkpoint page", () => {
  const checkpoint: MailSyncCheckpoint = {
    folder: "INBOX", previous: null,
    next: { uid: 1, uidValidity: 17, internalDate: timestamp }, mode: "incremental",
  };
  assert.equal(MailDatabasePersistMetadataParamsSchema.safeParse({
    accountId: "acct-1", origin: "manual", messages: [], checkpoint,
  }).success, false);
  assert.equal(MailDatabasePersistMetadataParamsSchema.safeParse({
    accountId: "acct-1", origin: "manual", messages: [message(2)],
    checkpoint, lease: { id: 1, owner: "worker" },
  }).success, false, "a page cannot persist messages beyond its claimed scan boundary");
  assert.equal(MailDatabasePersistMetadataParamsSchema.safeParse({
    accountId: "acct-1", origin: "manual", messages: [{ ...message(1), folder: "Sent" }],
    checkpoint, lease: { id: 1, owner: "worker" },
  }).success, false);
});
