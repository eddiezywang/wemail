import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { test } from "node:test";
import nodemailer from "nodemailer";
import { AccountService } from "../account/AccountService.js";
import {
  createAccountServiceTestClient,
  createMutableSecretStore,
} from "../account/AccountService.test-support.js";
import { imapPasswordKey, smtpPasswordKey } from "../account/AccountTypes.js";
import type { WemailDraftInput } from "../../../shared/wemail/mail.js";
import {
  ImapSmtpMailProvider,
  MailProviderCommandError,
  MailProviderConnectError,
  type ImapClientConfig,
  type ImapLikeClient,
  type MailTransport,
  type RawFetchLike,
} from "./ImapSmtpMailProvider.js";

function rfc822Source(subject: string, body: string): string {
  return [
    `Subject: ${subject}`,
    `Content-Type: text/plain`,
    ``,
    body,
  ].join("\r\n");
}

function setupAccount() {
  const account = {
    id: "acct-1",
    emailAddress: "me@example.com",
    imap: { host: "imap.example.com", port: 993, secure: true, username: "me@example.com" },
    smtp: { host: "smtp.example.com", port: 587, secure: true, username: "me@example.com" },
    createdAt: "2026-04-23T00:00:00Z",
    updatedAt: "2026-04-23T00:00:00Z",
  };
  const database = createAccountServiceTestClient([{
    account,
    credentialRef: "safe-storage:mailbox:acct-1",
    credentialGeneration: 1,
    state: "active",
  }]);
  const secrets = createMutableSecretStore();
  secrets.saveSecret(imapPasswordKey(account.id), "imap-pw");
  secrets.saveSecret(smtpPasswordKey(account.id), "smtp-pw");
  const accountService = new AccountService({
    mailDatabase: database.client,
    secrets,
    initialAccounts: database.records(),
  });
  return { secrets, accountService };
}

class FakeImap extends EventEmitter implements ImapLikeClient {
  capabilities = new Map<string, boolean>([["IDLE", true]]);
  connectCalls = 0;
  loggedOut = false;
  searches: Array<{ query: unknown; options: unknown }> = [];
  fetches: Array<{ range: unknown; query: Record<string, unknown> }> = [];
  openedFolders: string[] = [];
  moved: Array<{ range: string | number[]; destination: string; options?: Record<string, unknown> }> = [];
  deleted: Array<{ range: string | number[]; options?: Record<string, unknown> }> = [];
  lockReleases = 0;
  constructor(
    protected readonly messages: RawFetchLike[],
    private readonly failUntilAttempt = 0,
    public uidValidityValue = 17,
  ) {
    super();
  }
  async connect(): Promise<void> {
    this.connectCalls++;
    if (this.connectCalls <= this.failUntilAttempt) {
      throw new Error("simulated connect failure");
    }
  }
  async logout(): Promise<void> {
    this.loggedOut = true;
  }
  async mailboxOpen(path: string): Promise<{ uidValidity: number; uidNext?: number }> {
    this.openedFolders.push(path);
    return { uidValidity: this.uidValidityValue, uidNext: Math.max(0, ...this.messages.map((message) => message.uid)) + 1 };
  }
  async status() {
    return {
      path: "INBOX",
      uidValidity: this.uidValidityValue,
      uidNext: 42,
      highestModseq: 123n,
    };
  }
  async getMailboxLock() {
    return {
      release: () => { this.lockReleases += 1; },
    };
  }
  async search(query: unknown, options: unknown): Promise<number[]> {
    this.searches.push({ query, options });
    const uidQuery = (query as { uid?: unknown })?.uid;
    if (typeof uidQuery === "string") {
      const match = /^(\d+):(\d+|\*)$/.exec(uidQuery);
      if (match) {
        const minUid = Number(match[1]);
        const maxUid = match[2] === "*" ? Infinity : Number(match[2]);
        return this.messages.filter((m) => m.uid >= minUid && m.uid <= maxUid).map((m) => m.uid);
      }
      const wanted = new Set(uidQuery.split(",").map(Number));
      return this.messages.filter((message) => wanted.has(message.uid)).map((message) => message.uid);
    }
    return this.messages.map((m) => m.uid);
  }
  async *fetch(range: unknown, query: Record<string, unknown>): AsyncIterable<RawFetchLike> {
    this.fetches.push({ range, query });
    const wanted = Array.isArray(range) ? new Set(range) : null;
    for (const m of this.messages) {
      if (!wanted || wanted.has(m.uid)) yield m;
    }
  }
  async messageMove(
    range: string | number[],
    destination: string,
    options?: Record<string, unknown>,
  ): Promise<{ uidValidity: bigint; uidMap: Map<number, number> }> {
    this.moved.push({ range, destination, options });
    const sourceUid = Array.isArray(range) ? Number(range[0]) : Number(range);
    return { uidValidity: 23n, uidMap: new Map([[sourceUid, sourceUid + 100]]) };
  }
  async messageDelete(
    range: string | number[],
    options?: Record<string, unknown>,
  ): Promise<boolean> {
    this.deleted.push({ range, options });
    return true;
  }
}

test("ImapSmtpMailProvider.syncRecent fetches, normalizes, and tags with uidValidity", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([
    {
      uid: 1,
      flags: new Set(["\\Seen", "\\Flagged"]),
      envelope: {
        date: "2026-04-23T10:00:00Z",
        subject: "hello",
        messageId: "<m1@x.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      bodyStructure: { type: "text", subtype: "plain" },
      source: rfc822Source("hello", "first"),
    },
    {
      uid: 2,
      envelope: {
        date: "2026-04-23T11:00:00Z",
        subject: "second",
        messageId: "<m2@x.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      bodyStructure: { type: "text", subtype: "plain" },
      source: rfc822Source("second", "body"),
    },
  ]);
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });
  await provider.connect();
  const msgs = await provider.syncRecent(50);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.sync.uidValidity, 17);
  assert.equal(msgs[0]!.accountId, "acct-1");
  assert.equal(msgs[0]!.flags.seen, true);
  assert.equal(msgs[0]!.flags.flagged, true);
  assert.equal(msgs[1]!.subject, "second");
  assert.equal(fake.fetches[0]!.query.flags, true);
  await provider.disconnect();
  assert.equal(fake.loggedOut, true);
});

test("ImapSmtpMailProvider.syncSince searches by received date and fetches matching UIDs", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([
    {
      uid: 5,
      envelope: {
        date: "2026-04-01T10:00:00Z",
        subject: "within window",
        messageId: "<m5@x.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      source: rfc822Source("within window", "body"),
      internalDate: "2026-04-01T10:00:00Z",
    },
    {
      uid: 6,
      envelope: {
        date: "2026-04-01T11:00:00Z",
        subject: "within window 2",
        messageId: "<m6@x.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      source: rfc822Source("within window 2", "body"),
      internalDate: "2026-04-01T11:00:00Z",
    },
  ]);
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const since = new Date("2026-03-27T00:00:00.000Z");
  const msgs = await provider.syncSince(since);

  assert.equal(msgs.length, 2);
  assert.deepEqual(fake.searches, [
    { query: { since }, options: { uid: true } },
  ]);
  assert.deepEqual(fake.fetches.map((fetch) => fetch.range), [[5, 6]]);
  assert.equal(fake.fetches[0]!.query.source, undefined);
  assert.equal(fake.fetches[0]!.query.flags, true);
  assert.equal(msgs[0]!.bodyCachedUntil, null);
  assert.equal(msgs[0]!.sync.uid, 5);
});

test("ImapSmtpMailProvider.syncMetadataPages reselects its folder before every page", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([
    {
      uid: 1,
      envelope: {
        date: "2026-04-01T10:00:00Z",
        subject: "first",
        messageId: "<page-1@x.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      internalDate: "2026-04-01T10:00:00Z",
    },
    {
      uid: 2,
      envelope: {
        date: "2026-04-01T11:00:00Z",
        subject: "second",
        messageId: "<page-2@x.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      internalDate: "2026-04-01T11:00:00Z",
    },
  ]);
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });
  const iterator = provider.syncMetadataPages({
    since: new Date("2026-03-27T00:00:00.000Z"),
    pageSize: 1,
  })[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.value?.messages[0]?.sync.uid, 2);
  await fake.mailboxOpen("Sent");
  const second = await iterator.next();

  assert.equal(second.value?.messages[0]?.sync.uid, 1);
  assert.deepEqual(fake.openedFolders.slice(-2), ["Sent", "INBOX"]);
  await iterator.return?.();
});

test("ImapSmtpMailProvider.syncIncrementalPages derives the upper bound when the server omits UIDNEXT", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new class extends FakeImap {
    override async mailboxOpen(path: string): Promise<{ uidValidity: number }> {
      this.openedFolders.push(path);
      // Coremail-style response: no uidNext at all.
      return { uidValidity: this.uidValidityValue };
    }
    override async search(query: unknown, options: unknown): Promise<number[]> {
      if ((query as { uid?: unknown })?.uid === "*") {
        this.searches.push({ query, options });
        const maxUid = Math.max(0, ...this.messages.map((message) => message.uid));
        return maxUid > 0 ? [maxUid] : [];
      }
      return super.search(query, options);
    }
  }([
    {
      uid: 7,
      envelope: {
        date: "2026-04-02T10:00:00Z",
        subject: "no uidnext server",
        messageId: "<no-uidnext@x.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      internalDate: "2026-04-02T10:00:00Z",
    },
  ]);
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
  });
  const seen: number[] = [];
  for await (const page of provider.syncIncrementalPages({
    states: {},
    since: new Date("2026-05-01T00:00:00Z"),
  })) {
    seen.push(...page.messages.map((message) => message.sync.uid));
  }
  assert.deepEqual(seen, [7]);
  assert.ok(fake.searches.some((entry) => (entry.query as { uid?: unknown })?.uid === "*"));
  await provider.disconnect();
});

test("ImapSmtpMailProvider.syncSince fetches all matching UIDs in a 30-day window", async () => {
  const { secrets, accountService } = setupAccount();
  const messages: RawFetchLike[] = Array.from({ length: 30 }, (_, index) => {
    const uid = index + 1;
    return {
      uid,
      envelope: {
        date: `2026-04-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
        subject: `message ${uid}`,
        messageId: `<m-${uid}@x.com>`,
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      source: rfc822Source(`message ${uid}`, "body"),
      internalDate: `2026-04-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
    };
  });
  const fake = new FakeImap(messages);
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const msgs = await provider.syncSince(new Date("2026-03-27T00:00:00.000Z"));

  assert.equal(msgs.length, 30);
  assert.deepEqual(
    fake.fetches.map((fetch) => fetch.range),
    [Array.from({ length: 30 }, (_, index) => index + 1)],
  );
  assert.equal(msgs[0]!.sync.uid, 1);
  assert.equal(msgs.at(-1)!.sync.uid, 30);
});

test("ImapSmtpMailProvider.syncSince also fetches custom mail-rule folders", async () => {
  const { secrets, accountService } = setupAccount();
  class MultiFolderImap extends FakeImap {
    currentFolder = "INBOX";
    readonly byFolder: Record<string, RawFetchLike[]>;
    constructor() {
      super([]);
      this.byFolder = {
        INBOX: [
          {
            uid: 1,
            envelope: {
              date: "2026-04-01T10:00:00Z",
              subject: "inbox",
              messageId: "<inbox@x.com>",
              from: [{ address: "a@x.com" }],
              to: [{ address: "me@example.com" }],
            },
            source: rfc822Source("inbox", "body"),
            internalDate: "2026-04-01T10:00:00Z",
          },
        ],
        "通话分析助手": [
          {
            uid: 2,
            envelope: {
              date: "2026-04-01T11:00:00Z",
              subject: "custom folder",
              messageId: "<custom@x.com>",
              from: [{ address: "a@x.com" }],
              to: [{ address: "me@example.com" }],
            },
            source: rfc822Source("custom folder", "body"),
            internalDate: "2026-04-01T11:00:00Z",
          },
        ],
        Drafts: [],
      };
    }
    async list() {
      return [
        { path: "INBOX" },
        { path: "通话分析助手" },
        { path: "Drafts", specialUse: "\\Drafts" },
      ];
    }
    override async mailboxOpen(path: string): Promise<{ uidValidity: number }> {
      this.currentFolder = path;
      this.openedFolders.push(path);
      return { uidValidity: path === "通话分析助手" ? 99 : 17 };
    }
    override async search(query: unknown, options: unknown): Promise<number[]> {
      this.searches.push({ query, options });
      return (this.byFolder[this.currentFolder] ?? []).map((m) => m.uid);
    }
    override async *fetch(
      range: unknown,
      query: Record<string, unknown>,
    ): AsyncIterable<RawFetchLike> {
      this.fetches.push({ range, query });
      const wanted = Array.isArray(range) ? new Set(range) : null;
      for (const m of this.byFolder[this.currentFolder] ?? []) {
        if (!wanted || wanted.has(m.uid)) yield m;
      }
    }
  }
  const fake = new MultiFolderImap();
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const msgs = await provider.syncSince(new Date("2026-03-27T00:00:00.000Z"));

  assert.deepEqual(
    msgs.map((m) => [m.folder, m.subject, m.sync.uidValidity]),
    [
      ["INBOX", "inbox", 17],
      ["通话分析助手", "custom folder", 99],
    ],
  );
  assert.ok(fake.openedFolders.includes("通话分析助手"));
  assert.ok(!fake.openedFolders.includes("Drafts"));
  assert.equal(fake.openedFolders.at(-1), "INBOX");
});

test("ImapSmtpMailProvider.syncAfterCursor searches only UIDs above the cursor", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([
    {
      uid: 5,
      envelope: {
        date: "2026-04-01T10:00:00Z",
        subject: "already synced",
        messageId: "<m5@x.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      source: rfc822Source("already synced", "body"),
      internalDate: "2026-04-01T10:00:00Z",
    },
    {
      uid: 6,
      envelope: {
        date: "2026-04-01T11:00:00Z",
        subject: "newer",
        messageId: "<m6@x.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      source: rfc822Source("newer", "body"),
      internalDate: "2026-04-01T11:00:00Z",
    },
    {
      uid: 7,
      envelope: {
        date: "2026-04-01T12:00:00Z",
        subject: "newest",
        messageId: "<m7@x.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      source: rfc822Source("newest", "body"),
      internalDate: "2026-04-01T12:00:00Z",
    },
  ]);
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const msgs = await provider.syncAfterCursor({
    uid: 5,
    uidValidity: 17,
    internalDate: "2026-04-01T10:00:00.000Z",
  });

  assert.deepEqual(fake.searches, [
    { query: { uid: "6:*" }, options: { uid: true } },
  ]);
  assert.deepEqual(
    fake.fetches.map((fetch) => fetch.range),
    [[6, 7]],
  );
  assert.deepEqual(msgs?.map((m) => m.sync.uid), [6, 7]);
});

test("incremental pages retain all 6000 messages in UID order with bounded searches and payloads", async () => {
  const { secrets, accountService } = setupAccount();
  const raw = Array.from({ length: 6000 }, (_, index): RawFetchLike => ({
    uid: index + 1,
    internalDate: "2026-11-04T00:00:00Z",
    envelope: {
      date: index % 2 ? "2026-11-03T00:00:00Z" : "2026-11-04T00:00:00Z",
      subject: `message ${index}`, messageId: `<${index}@example.test>`,
      from: [{ address: "a@example.test" }], to: [{ address: "me@example.com" }],
    },
  }));
  const fake = new FakeImap(raw);
  const provider = new ImapSmtpMailProvider({ accountService, secrets, imapFactory: () => fake });
  const seen: number[] = [];
  let cursor = 0;
  for await (const page of provider.syncIncrementalPages({
    states: { INBOX: { uid: 0, uidValidity: 17, internalDate: "2026-11-01T00:00:00Z" } },
    since: new Date("2026-05-01T00:00:00Z"),
  })) {
    assert.ok(page.messages.length <= 50);
    assert.equal(page.checkpoint?.previous?.uid, cursor);
    cursor = page.checkpoint!.next.uid;
    seen.push(...page.messages.map((message) => message.sync.uid));
  }
  assert.deepEqual(seen, raw.map((message) => message.uid));
  assert.equal(cursor, 6000);
  for (const { query } of fake.searches) {
    const range = (query as { uid: string }).uid.split(":").map(Number);
    assert.ok(range[1] - range[0] < 512);
    assert.ok(!("since" in (query as object)), "incremental discovery does not reuse another folder's date");
  }
  await provider.disconnect();
});

test("sparse numeric UID windows retain messages whose dates precede the history range", async () => {
  const { secrets, accountService } = setupAccount();
  const uids = [1, 513, 4097, 8193];
  const raw = uids.map((uid, index) => ({ uid,
    internalDate: index % 2 ? "2025-01-01T00:00:00Z" : "2026-11-04T00:00:00Z",
  }));
  const fake = new FakeImap(raw);
  const provider = new ImapSmtpMailProvider({ accountService, secrets, imapFactory: () => fake });
  const seen: number[] = [];
  let cursor = 0;
  try {
    for await (const page of provider.syncIncrementalPages({
      states: { INBOX: { uid: 0, uidValidity: 17, internalDate: "2026-11-01T00:00:00Z" } },
      since: new Date("2026-05-01T00:00:00Z"),
    })) {
      assert.equal(page.checkpoint!.previous!.uid, cursor);
      assert.ok(page.messages.length <= 50);
      cursor = page.checkpoint!.next.uid;
      seen.push(...page.messages.map((message) => message.sync.uid));
    }
    assert.deepEqual(seen, uids);
    assert.equal(cursor, 8193);
    assert.ok(fake.searches.length > uids.length, "empty numeric windows must advance without skipping later mail");
    for (const { query } of fake.searches) {
      const [from, to] = (query as { uid: string }).uid.split(":").map(Number);
      assert.ok(to - from < 512);
      assert.ok(!("since" in (query as object)));
    }
  } finally { await provider.disconnect(); }
});

test("completed realtime passes re-fetch a trailing flag window; repair passes do not", async () => {
  const { secrets, accountService } = setupAccount();
  const raw = Array.from({ length: 120 }, (_, index): RawFetchLike => ({
    uid: index + 1,
    internalDate: "2026-11-04T00:00:00Z",
    envelope: {
      subject: `message ${index}`, messageId: `<${index}@example.test>`,
      from: [{ address: "a@example.test" }], to: [{ address: "me@example.com" }],
    },
    flags: new Set(["\\Seen"]),
  }));
  const fake = new FakeImap(raw);
  const provider = new ImapSmtpMailProvider({
    accountService, secrets, imapFactory: () => fake, flagRefreshWindowUids: 10,
  });
  const firstSeen: number[] = [];
  for await (const page of provider.syncIncrementalPages({
    states: { INBOX: { uid: 0, uidValidity: 17, internalDate: "2026-11-01T00:00:00Z" } },
    since: new Date("2026-05-01T00:00:00Z"),
  })) {
    assert.ok(page.messages.length <= 50, "scan pages stay bounded by the scan page size");
    firstSeen.push(...page.messages.map((message) => message.sync.uid));
  }
  assert.deepEqual(firstSeen, raw.map((message) => message.uid));
  assert.equal(fake.fetches.length, 3, "a completed pass must not re-emit UIDs it already scanned");

  // Live poll with no new mail: the trailing window is the only fetch and
  // never advances the cursor.
  const fetchesBeforePoll = fake.fetches.length;
  let polled = 0;
  for await (const page of provider.syncIncrementalPages({
    states: { INBOX: { uid: 120, uidValidity: 17, internalDate: "2026-11-01T00:00:00Z" } },
    since: new Date("2026-05-01T00:00:00Z"),
  })) {
    polled += 1;
    assert.deepEqual(page.messages.map((message) => message.sync.uid), [111, 112, 113, 114, 115, 116, 117, 118, 119, 120]);
    assert.equal(page.messages[0]!.flags.seen, true, "flag refresh arrives authoritative");
    assert.equal(page.checkpoint!.next.uid, 120, "flag refresh must not advance the realtime cursor");
  }
  assert.equal(polled, 1);
  const pollFetches = fake.fetches.slice(fetchesBeforePoll);
  assert.deepEqual(pollFetches.map((fetch) => fetch.range), [[111, 112, 113, 114, 115, 116, 117, 118, 119, 120]]);
  assert.equal(pollFetches[0]!.query.flags, true);

  // Repair passes fetch coverage only — no trailing flag window.
  const fetchesBeforeRepair = fake.fetches.length;
  let repairSeen = 0;
  for await (const page of provider.syncIncrementalPages({
    states: { INBOX: { uid: 120, uidValidity: 17, internalDate: "2026-11-01T00:00:00Z" } },
    since: new Date("2026-05-01T00:00:00Z"),
    repair: true,
  })) {
    repairSeen += page.messages.length;
  }
  assert.equal(repairSeen, 120);
  assert.equal(fake.fetches.length - fetchesBeforeRepair, 3, "repair pass performs no extra flag-refresh fetch");
  await provider.disconnect();
});

test("incremental pages retry an unresolved FETCH gap instead of advancing its checkpoint", async () => {
  const { secrets, accountService } = setupAccount();
  const raw: RawFetchLike = { uid: 2, internalDate: "2026-11-04T00:00:00Z" };
  const fake = new FakeImap([raw]);
  fake.fetch = async function* () { /* A server may return no result despite SEARCH finding the UID. */ };
  const provider = new ImapSmtpMailProvider({ accountService, secrets, imapFactory: () => fake });
  const iterator = provider.syncIncrementalPages({
    states: { INBOX: { uid: 1, uidValidity: 17, internalDate: "2026-11-01T00:00:00Z" } },
    since: new Date("2026-05-01T00:00:00Z"),
  })[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), /metadata-fetch-incomplete/);
  await provider.disconnect();
});

test("a metadata deadline closes a hung socket even if socket cleanup throws", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { secrets, accountService } = setupAccount();
  let closes = 0;
  class HungImap extends FakeImap {
    override connect(): Promise<void> { return new Promise(() => undefined); }
    close(): void {
      closes++;
      throw new Error("socket already closing");
    }
  }
  const provider = new ImapSmtpMailProvider({
    accountService, secrets, imapFactory: () => new HungImap([]), maxConnectAttempts: 1,
  });
  const rejected = assert.rejects(provider.connect(), /metadata-timeout/);
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(closes, 1);
});

test("metadata invalidation closes a hung search and permits a fresh session without waiting for its deadline", async () => {
  const { secrets, accountService } = setupAccount();
  const old = new FakeImap([{ uid: 1, internalDate: "2026-11-04T00:00:00Z" }]);
  let closed = 0;
  let searching = false;
  const oldClient = Object.assign(old, { close: () => { closed++; } });
  old.search = async () => { searching = true; return new Promise<number[]>(() => undefined); };
  const fresh = new FakeImap([{ uid: 1, internalDate: "2026-11-04T00:00:00Z" }]);
  let connections = 0;
  const provider = new ImapSmtpMailProvider({ accountService, secrets, imapFactory: () => ++connections === 1 ? oldClient : fresh });
  const options = { states: { INBOX: { uid: 0, uidValidity: 17, internalDate: "2026-11-01T00:00:00Z" } }, since: new Date("2026-05-01T00:00:00Z") };
  const iterator = provider.syncIncrementalPages(options);
  try {
    const pending = iterator.next();
    const rejected = assert.rejects(pending, /metadata-cancelled/);
    for (let i = 0; i < 60; i++) await Promise.resolve();
    assert.equal(searching, true);
    await provider.invalidateConnection();
    await rejected;
    assert.ok(closed > 0);
    const resumed = provider.syncIncrementalPages(options);
    const page = await resumed.next();
    assert.ok(!page.done);
    assert.deepEqual(page.value.messages.map((message) => message.sync.uid), [1]);
    assert.equal(connections, 2);
    await resumed.return();
  } finally { await provider.disconnect(); }
});

test("a confirmed deleted FETCH gap permits checkpoint progress across sparse UIDs", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([{ uid: 512, internalDate: "2026-11-04T00:00:00Z" }]);
  fake.fetch = async function* () {};
  const search = fake.search.bind(fake);
  fake.search = async (query, options) =>
    (query as { uid: string }).uid.includes(":") ? search(query, options) : [];
  const provider = new ImapSmtpMailProvider({ accountService, secrets, imapFactory: () => fake });
  const iterator = provider.syncIncrementalPages({
    states: { INBOX: { uid: 0, uidValidity: 17, internalDate: "2026-11-01T00:00:00Z" } },
    since: new Date("2026-05-01T00:00:00Z"),
  });
  try {
    const step = await iterator.next();
    assert.ok(!step.done);
    assert.equal(step.value.checkpoint!.next.uid, 512);
    assert.deepEqual(step.value.messages, []);
  } finally {
    await iterator.return();
    await provider.disconnect();
  }
});

test("pending reconciliation refreshes INBOX at a page boundary while other folders still progress", async () => {
  const { secrets, accountService } = setupAccount();
  const raw: RawFetchLike[] = [{ uid: 1, internalDate: "2026-11-04T00:00:00Z" }];
  class FolderImap extends FakeImap {
    async list() { return [{ path: "INBOX" }, { path: "Rules" }]; }
  }
  const fake = new FolderImap(raw);
  const provider = new ImapSmtpMailProvider({ accountService, secrets, imapFactory: () => fake });
  const states = {
    INBOX: { uid: 0, uidValidity: 17, internalDate: "2026-11-01T00:00:00Z" },
    Rules: { uid: 0, uidValidity: 17, internalDate: "2026-11-01T00:00:00Z" },
  };
  const iterator = provider.syncIncrementalPages({ states, since: new Date("2026-05-01T00:00:00Z") });
  try {
    const first = await iterator.next();
    assert.ok(!first.done);
    states.INBOX = first.value.checkpoint!.next;
    raw.push({ uid: 2, internalDate: "2026-11-04T00:00:01Z" });
    const recheck = await iterator.next({ states, recheckInbox: true });
    assert.ok(!recheck.done);
    assert.equal(recheck.value.folder, "INBOX");
    assert.deepEqual(recheck.value.messages.map((message) => message.sync.uid), [2]);
    states.INBOX = recheck.value.checkpoint!.next;
    const fairPage = await iterator.next({ states, recheckInbox: true });
    assert.ok(!fairPage.done);
    assert.equal(fairPage.value.folder, "Rules", "continuous INBOX demand must not starve other folders");
  } finally {
    await iterator.return();
    await provider.disconnect();
  }
});

test("paged reconciliation uses newer durable repair state when resuming a live scan", async () => {
  const { secrets, accountService } = setupAccount();
  const raw = Array.from({ length: 60 }, (_, index) => ({ uid: index + 1, internalDate: "2026-11-04T00:00:00Z" }));
  const provider = new ImapSmtpMailProvider({ accountService, secrets, imapFactory: () => new FakeImap(raw) });
  const iterator = provider.syncIncrementalPages({
    states: { INBOX: { uid: 0, uidValidity: 17, internalDate: "2026-11-01T00:00:00Z" } },
    since: new Date("2026-05-01T00:00:00Z"),
  });
  try {
    const first = await iterator.next();
    assert.ok(!first.done);
    const committed = {
      ...first.value.checkpoint!.next,
      repair: { version: 1 as const, since: "2026-05-01T00:00:00.000Z", uid: 30, completed: false },
    };
    const next = await iterator.next({ states: { INBOX: committed }, recheckInbox: false });
    assert.ok(!next.done);
    assert.deepEqual(next.value.checkpoint!.previous, committed);
    assert.deepEqual(next.value.checkpoint!.next.repair, committed.repair);
    assert.deepEqual(next.value.messages.map((message) => message.sync.uid), raw.slice(50).map((message) => message.uid));
  } finally {
    await iterator.return();
    await provider.disconnect();
  }
});

test("coverage repair resumes below the realtime cursor and preserves its committed high water", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([{ uid: 1, internalDate: "2026-11-04T00:00:00Z" }, { uid: 80, internalDate: "2026-11-04T00:00:00Z" }]);
  const provider = new ImapSmtpMailProvider({ accountService, secrets, imapFactory: () => fake });
  const since = "2026-05-01T00:00:00.000Z";
  const iterator = provider.syncIncrementalPages({
    states: { INBOX: { uid: 80, uidValidity: 17, internalDate: since, repair: { version: 1, since, uid: 1, completed: false } } },
    since: new Date("2026-10-01T00:00:00Z"), repair: true,
  })[Symbol.asyncIterator]();
  const step = await iterator.next();
  assert.ok(!step.done);
  assert.deepEqual(step.value.messages.map((message) => message.sync.uid), [80]);
  assert.equal(step.value.checkpoint!.next.uid, 80);
  assert.deepEqual(step.value.checkpoint!.next.repair, { version: 1, since, uid: 80, completed: true });
  assert.ok((fake.searches[0].query as { since: Date }).since.toISOString() === since);
  await iterator.return?.();
  await provider.disconnect();
});

test("UIDVALIDITY replacement starts a new realtime baseline without inheriting completed repair coverage", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([{ uid: 2, internalDate: "2026-11-04T00:00:00Z" }], 0, 18);
  const provider = new ImapSmtpMailProvider({ accountService, secrets, imapFactory: () => fake });
  const iterator = provider.syncIncrementalPages({
    states: { INBOX: {
      uid: 6000, uidValidity: 17, internalDate: "2026-11-01T00:00:00Z",
      repair: { version: 1, since: "2026-05-01T00:00:00.000Z", uid: 6000, completed: true },
    } },
    since: new Date("2026-05-01T00:00:00Z"),
  });
  try {
    const step = await iterator.next();
    assert.ok(!step.done);
    assert.equal(step.value.checkpoint!.next.uidValidity, 18);
    assert.equal(step.value.checkpoint!.next.uid, 2);
    assert.equal(step.value.checkpoint!.next.repair, undefined);
    assert.deepEqual(step.value.messages.map((message) => message.sync.uid), [2]);
  } finally { await iterator.return(); await provider.disconnect(); }
});

test("ImapSmtpMailProvider.syncAfterCursor also scans other syncable folders by date", async () => {
  const { secrets, accountService } = setupAccount();
  class IncrementalFoldersImap extends FakeImap {
    currentFolder = "INBOX";
    readonly byFolder: Record<string, RawFetchLike[]> = {
      INBOX: [{
        uid: 6,
        envelope: { date: "2026-04-24T10:00:00Z", subject: "inbox", messageId: "<i@x>", from: [{ address: "a@x.com" }], to: [{ address: "me@example.com" }] },
        internalDate: "2026-04-24T10:00:00Z",
      }],
      "规则邮件": [{
        uid: 3,
        envelope: { date: "2026-04-24T11:00:00Z", subject: "custom", messageId: "<c@x>", from: [{ address: "a@x.com" }], to: [{ address: "me@example.com" }] },
        internalDate: "2026-04-24T11:00:00Z",
      }],
    };
    constructor() { super([]); }
    async list() {
      return [{ path: "INBOX" }, { path: "规则邮件" }];
    }
    override async mailboxOpen(path: string): Promise<{ uidValidity: number }> {
      this.currentFolder = path;
      this.openedFolders.push(path);
      return { uidValidity: path === "INBOX" ? 17 : 23 };
    }
    override async search(query: unknown, options: unknown): Promise<number[]> {
      this.searches.push({ query, options });
      return this.byFolder[this.currentFolder]!.map((message) => message.uid);
    }
    override async *fetch(range: unknown, query: Record<string, unknown>): AsyncIterable<RawFetchLike> {
      this.fetches.push({ range, query });
      const wanted = new Set(range as number[]);
      for (const message of this.byFolder[this.currentFolder]!) {
        if (wanted.has(message.uid)) yield message;
      }
    }
  }
  const fake = new IncrementalFoldersImap();
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const messages = await provider.syncAfterCursor({
    uid: 5,
    uidValidity: 17,
    internalDate: "2026-04-23T10:00:00.000Z",
  });

  assert.deepEqual(messages?.map((message) => [message.folder, message.sync.uid]), [
    ["INBOX", 6],
    ["规则邮件", 3],
  ]);
  assert.ok(fake.searches.some(({ query }) => "since" in (query as object)));
  assert.equal(fake.openedFolders.at(-1), "INBOX");
});

test("ImapSmtpMailProvider.syncAfterCursor returns null when UIDVALIDITY changed", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([], 0, 18);
  const logs: string[] = [];
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
    logger: (m) => logs.push(m),
  });

  const result = await provider.syncAfterCursor({
    uid: 5,
    uidValidity: 17,
    internalDate: "2026-04-01T10:00:00.000Z",
  });

  assert.equal(result, null);
  assert.equal(fake.searches.length, 0);
  assert.ok(logs.some((entry) => entry.includes("incremental cursor invalid")));
});

test("ImapSmtpMailProvider.syncAfterCursor ignores the current highest UID returned for an empty range", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([
    {
      uid: 6,
      envelope: {
        date: "2026-07-15T10:00:00Z",
        subject: "server latest after uid regression",
        messageId: "<regressed@x.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      source: rfc822Source("server latest after uid regression", "body"),
      internalDate: "2026-07-15T10:00:00Z",
    },
  ]);
  fake.search = async (query, options) => {
    fake.searches.push({ query, options });
    return [6];
  };
  const logs: string[] = [];
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
    logger: (message) => logs.push(message),
  });

  const result = await provider.syncAfterCursor({
    uid: 10,
    uidValidity: 17,
    internalDate: "2026-07-09T10:00:00.000Z",
  });

  assert.deepEqual(result, []);
  assert.deepEqual(fake.searches, [
    { query: { uid: "11:*" }, options: { uid: true } },
  ]);
  assert.equal(fake.fetches.length, 0);
  assert.ok(logs.every((entry) => !entry.includes("incremental cursor regressed")));
  assert.ok(logs.every((entry) => !entry.includes("server latest")));
});

test("ImapSmtpMailProvider.syncSince expands IMAP command failure details", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([]);
  fake.search = async () => {
    const error = new Error("Command failed") as Error & {
      responseStatus?: string;
      responseText?: string;
      code?: string;
    };
    error.responseStatus = "BAD";
    error.responseText = "SEARCH invalid date criteria";
    error.code = "InvalidSearch";
    throw error;
  };
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  await assert.rejects(
    () => provider.syncSince(new Date("2026-03-27T00:00:00.000Z")),
    (err: unknown) => {
      assert.ok(err instanceof MailProviderCommandError);
      assert.equal((err as MailProviderCommandError).phase, "imap.search");
      assert.match((err as Error).message, /Command failed/);
      assert.match((err as Error).message, /BAD/);
      assert.match((err as Error).message, /SEARCH invalid date criteria/);
      assert.match((err as Error).message, /InvalidSearch/);
      return true;
    },
  );
});

test("ImapSmtpMailProvider.connect expands IMAP login command failure details", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([]);
  fake.connect = async () => {
    const error = new Error("Command failed") as Error & {
      responseStatus?: string;
      responseText?: string;
      executedCommand?: string;
    };
    error.responseStatus = "NO";
    error.responseText = "LOGIN user in black list";
    error.executedCommand = '3 LOGIN "me@example.com" "(* value hidden *)"';
    throw error;
  };
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
    maxConnectAttempts: 1,
  });

  await assert.rejects(
    () => provider.connect(),
    (err: unknown) => {
      assert.ok(err instanceof MailProviderCommandError);
      assert.equal((err as MailProviderCommandError).phase, "imap.login");
      assert.match((err as Error).message, /Command failed/);
      assert.match((err as Error).message, /NO/);
      assert.match((err as Error).message, /LOGIN user in black list/);
      assert.match((err as Error).message, /LOGIN/);
      assert.ok(!(err as Error).message.includes("imap-pw"));
      return true;
    },
  );
});

test("ImapSmtpMailProvider.connect retries and eventually succeeds", async () => {
  const { secrets, accountService } = setupAccount();
  const attempts: FakeImap[] = [];
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => {
      const fake = new FakeImap([], attempts.length === 0 ? 1 : 0);
      attempts.push(fake);
      return fake;
    },
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
    maxConnectAttempts: 3,
  });
  await provider.connect();
  assert.equal(attempts.length >= 2, true, "expected at least one retry");
});

test("ImapSmtpMailProvider passes default IMAP ID client info to the client factory", async () => {
  const { secrets, accountService } = setupAccount();
  let captured: ImapClientConfig | null = null;
  const fake = new FakeImap([]);
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: (config) => {
      captured = config;
      return fake;
    },
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  await provider.connect();

  assert.ok(captured);
  const config = captured as ImapClientConfig;
  assert.deepEqual(config.clientInfo, {
    name: "WeMail",
    version: "1.0.0",
    vendor: "WeMail",
  });
  assert.equal(config.maxIdleTime, 240_000);
  assert.equal(config.missingIdleCommand, "STATUS");
});

test("ImapSmtpMailProvider keeps process alive on imap error events and reconnects", async () => {
  const { secrets, accountService } = setupAccount();
  const logs: string[] = [];
  const first = new FakeImap([
    {
      uid: 1,
      envelope: {
        date: "2026-04-23T10:00:00Z",
        subject: "hello",
        messageId: "<m1@x.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      source: rfc822Source("hello", "first"),
    },
  ]);
  const second = new FakeImap([
    {
      uid: 2,
      envelope: {
        date: "2026-04-23T11:00:00Z",
        subject: "after reconnect",
        messageId: "<m2@x.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "me@example.com" }],
      },
      source: rfc822Source("after reconnect", "second"),
    },
  ]);
  const created: FakeImap[] = [];
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => {
      const fake = created.length === 0 ? first : second;
      created.push(fake);
      return fake;
    },
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
    logger: (message) => logs.push(message),
  });

  const firstBatch = await provider.syncRecent(50);
  assert.equal(firstBatch.length, 1);

  first.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));

  const secondBatch = await provider.syncRecent(50);
  assert.equal(secondBatch.length, 1);
  assert.equal(created.length, 2, "expected a fresh client after connection loss");
  assert.ok(logs.some((entry) => entry.includes("imap client error")));
});

test("supportsPushWatch reflects the connected server IDLE capability", async () => {
  const { secrets, accountService } = setupAccount();
  const fakeClient = new FakeImap([]);
  const fakeSmtp = { sendMail: async () => ({ messageId: "x" }) };
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fakeClient,
    smtpFactory: () => fakeSmtp,
  });

  assert.equal(provider.supportsPushWatch?.(), false);
  await provider.connect();
  assert.equal(provider.supportsPushWatch?.(), true);

  await provider.disconnect();
  fakeClient.capabilities.clear();
  await provider.connect();
  assert.equal(provider.supportsPushWatch?.(), false);
});

test("getMailboxStatus delegates status and locking to ImapFlow capabilities", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([]);
  fake.capabilities.set("CONDSTORE", true);
  fake.capabilities.set("QRESYNC", true);
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    role: "foreground-realtime",
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const status = await provider.getMailboxStatus();

  assert.deepEqual(status, {
    path: "INBOX",
    uidValidity: 17,
    uidNext: 42,
    highestModseq: "123",
    supportsIdle: true,
    supportsCondstore: true,
    supportsQresync: true,
  });
  assert.equal(fake.lockReleases, 1);
  assert.equal(provider.role, "foreground-realtime");
});

test("waitForMailboxChange resolves on exists without manually invoking IDLE", async () => {
  const { secrets, accountService } = setupAccount();
  let idleCalls = 0;
  class FakeIdleClient extends FakeImap {
    async idle() {
      idleCalls += 1;
      throw new Error("manual idle must not be called");
    }
  }
  const fakeClient = new FakeIdleClient([]);
  const fakeSmtp = { sendMail: async () => ({ messageId: "x" }) };

  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fakeClient as unknown as ImapLikeClient,
    smtpFactory: () => fakeSmtp,
  });

  await provider.connect();
  const waiting = provider.waitForMailboxChange?.();
  assert.ok(waiting);
  await Promise.resolve();
  fakeClient.emit("exists", { path: "INBOX", count: 42, prevCount: 41 });

  await waiting;
  assert.equal(idleCalls, 0);
  assert.equal(fakeClient.listenerCount("exists"), 0);
  assert.equal(fakeClient.listenerCount("close"), 1);
  assert.equal(fakeClient.listenerCount("error"), 1);
});

test("waitForMailboxChange rejects on connection close and cleans watch listeners", async () => {
  const { secrets, accountService } = setupAccount();
  const fakeClient = new FakeImap([]);
  const fakeSmtp = { sendMail: async () => ({ messageId: "x" }) };
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fakeClient,
    smtpFactory: () => fakeSmtp,
  });

  await provider.connect();
  const waiting = provider.waitForMailboxChange?.();
  assert.ok(waiting);
  await Promise.resolve();
  fakeClient.emit("close");

  await assert.rejects(waiting, /imap connection closed/);
  assert.equal(fakeClient.listenerCount("exists"), 0);
  assert.equal(fakeClient.listenerCount("close"), 1);
  assert.equal(fakeClient.listenerCount("error"), 1);
});

test("waitForMailboxChange rejects on connection error and cleans watch listeners", async () => {
  const { secrets, accountService } = setupAccount();
  const fakeClient = new FakeImap([]);
  const fakeSmtp = { sendMail: async () => ({ messageId: "x" }) };
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fakeClient,
    smtpFactory: () => fakeSmtp,
  });

  await provider.connect();
  const waiting = provider.waitForMailboxChange?.();
  assert.ok(waiting);
  await Promise.resolve();
  fakeClient.emit("error", new Error("socket reset"));

  await assert.rejects(waiting, /socket reset/);
  assert.equal(fakeClient.listenerCount("exists"), 0);
  assert.equal(fakeClient.listenerCount("close"), 1);
  assert.equal(fakeClient.listenerCount("error"), 1);
});

test("waitForMailboxChange removes all watch listeners when aborted", async () => {
  const { secrets, accountService } = setupAccount();
  let idleCalls = 0;
  class FakeIdleClient extends FakeImap {
    async idle() {
      idleCalls += 1;
      throw new Error("manual idle must not be called");
    }
  }
  const fakeClient = new FakeIdleClient([]);
  const fakeSmtp = { sendMail: async () => ({ messageId: "x" }) };
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fakeClient as unknown as ImapLikeClient,
    smtpFactory: () => fakeSmtp,
  });
  const controller = new AbortController();

  await provider.connect();
  const waiting = provider.waitForMailboxChange?.(controller.signal);
  assert.ok(waiting);
  await Promise.resolve();
  assert.equal(fakeClient.listenerCount("exists"), 1);
  controller.abort();

  await assert.rejects(waiting, /mail watch aborted/);
  assert.equal(fakeClient.listenerCount("exists"), 0);
  assert.equal(fakeClient.listenerCount("close"), 1);
  assert.equal(fakeClient.listenerCount("error"), 1);
  assert.equal(idleCalls, 0);
});

test("waitForMailboxChange throws when the client does not support exists events", async () => {
  const { secrets, accountService } = setupAccount();
  const fakeClient = {
    connect: async () => {},
    logout: async () => {},
    mailboxOpen: async () => ({ uidValidity: 123 }),
    search: async () => [],
    fetch: async function* () {},
  };
  const fakeSmtp = { sendMail: async () => ({ messageId: "x" }) };

  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fakeClient as unknown as ImapLikeClient,
    smtpFactory: () => fakeSmtp,
  });

  await provider.connect();
  await assert.rejects(
    () => provider.waitForMailboxChange?.(),
    /imap exists events not supported by client/,
  );
});

test("ImapSmtpMailProvider.sendDraft uses SMTP transport and returns provider message id", async () => {
  const { secrets, accountService } = setupAccount();
  await accountService.updateAccount({ displayName: "WeMail Sender" });
  let sent: any = null;
  const transport: MailTransport = {
    async sendMail(options) {
      sent = options;
      return {
        messageId: "<smtp-42@example.com>",
        accepted: ["bob@example.com", "copy@example.com"],
        rejected: [],
      };
    },
  };
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => new FakeImap([]),
    smtpFactory: () => transport,
  });
  const result = await provider.sendDraft({
    accountId: "acct-1",
    to: [{ name: "Bob", email: "bob@example.com" }],
    cc: [{ email: "copy@example.com" }],
    subject: "greetings",
    bodyText: "hi bob",
    bodyHtml: "<p>hi bob</p>",
  });
  assert.equal(result.messageId, "<smtp-42@example.com>");
  assert.equal(sent.to, "Bob <bob@example.com>");
  assert.equal(sent.cc, "copy@example.com");
  assert.equal(sent.from, "WeMail Sender <me@example.com>");
  assert.equal(sent.subject, "greetings");
  assert.deepEqual(result.delivery, {
    status: "sent",
    accepted: ["bob@example.com", "copy@example.com"],
    rejected: [],
  });
});

test("ImapSmtpMailProvider quotes SMTP display names containing delimiters", async () => {
  const { secrets, accountService } = setupAccount();
  let recipient = "";
  const provider = new ImapSmtpMailProvider({
    accountService, secrets, imapFactory: () => new FakeImap([]),
    smtpFactory: () => ({ sendMail: async (options) => { recipient = options.to; return { messageId: "sent" }; } }),
  });
  await provider.sendDraft({ accountId: "acct-1", to: [{ name: 'Doe, "Jane"', email: "jane@example.test" }], subject: "Subject", bodyText: "Body", bodyHtml: "" });
  assert.equal(recipient, '"Doe, \\"Jane\\"" <jane@example.test>');
});

test("ImapSmtpMailProvider passes frozen reply headers to SMTP", async () => {
  const { secrets, accountService } = setupAccount();
  let sent = {} as Parameters<MailTransport["sendMail"]>[0];
  const provider = new ImapSmtpMailProvider({ accountService, secrets, imapFactory: () => new FakeImap([]),
    smtpFactory: () => ({ sendMail: async (options) => { sent = options; return { messageId: "sent" }; } }) });
  await provider.sendDraft({ accountId: "acct-1", to: [{ email: "to@example.test" }], subject: "Reply", bodyText: "Body", bodyHtml: "",
    smtpInReplyTo: "<source@example.test>", smtpReferences: ["<old@example.test>", "<source@example.test>"] });
  assert.equal(sent.inReplyTo, "<source@example.test>");
  assert.deepEqual(sent.references, ["<old@example.test>", "<source@example.test>"]);
});

test("ImapSmtpMailProvider.sendDraft records a rejected CC as partial delivery", async () => {
  const { secrets, accountService } = setupAccount();
  const logs: string[] = [];
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => new FakeImap([]),
    smtpFactory: () => ({
      sendMail: async () => ({
        messageId: "<partial@example.com>",
        accepted: ["bob@example.com"],
        rejected: ["fangfangliu@corp.example"],
        rejectedErrors: [{
          recipient: "fangfangliu@corp.example",
          response: "550 mailbox unavailable",
          responseCode: 550,
        }],
      }),
    }),
    logger: (message) => logs.push(message),
  });

  const result = await provider.sendDraft({
    accountId: "acct-1",
    to: [{ email: "bob@example.com" }],
    cc: [{ email: "fangfangliu@corp.example" }],
    subject: "partial",
    bodyText: "body",
    bodyHtml: "<p>body</p>",
  });

  assert.deepEqual(result.delivery, {
    status: "partial",
    accepted: ["bob@example.com"],
    rejected: ["fangfangliu@corp.example"],
    rejectedDetails: [{
      recipient: "fangfangliu@corp.example",
      response: "550 mailbox unavailable",
      responseCode: 550,
    }],
  });
  assert.match(logs.at(-1) ?? "", /status=partial/);
  assert.match(logs.at(-1) ?? "", /fangfangliu@corp.example/);
});

test("ImapSmtpMailProvider.sendDraft fails when every recipient is rejected", async () => {
  const { secrets, accountService } = setupAccount();
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => new FakeImap([]),
    smtpFactory: () => ({
      sendMail: async () => ({
        messageId: "<rejected@example.com>",
        accepted: [],
        rejected: ["bob@example.com", "fangfangliu@corp.example"],
      }),
    }),
  });

  await assert.rejects(
    () => provider.sendDraft({
      accountId: "acct-1",
      to: [{ email: "bob@example.com" }],
      cc: [{ email: "fangfangliu@corp.example" }],
      subject: "rejected",
      bodyText: "body",
      bodyHtml: "<p>body</p>",
    }),
    /SMTP rejected all recipients/,
  );
});

test("ImapSmtpMailProvider.sendDraft marks uploaded files as MIME attachments", async () => {
  const { secrets, accountService } = setupAccount();
  let rawMessage = "";
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
  });
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => new FakeImap([]),
    smtpFactory: () => ({
      sendMail: async (options) => {
        const result = await transport.sendMail(options);
        rawMessage = result.message.toString();
        return { messageId: result.messageId };
      },
    }),
  });

  await provider.sendDraft({
    accountId: "acct-1",
    to: [{ email: "bob@example.com" }],
    subject: "with attachment",
    bodyText: "see file",
    bodyHtml: "<p>see file</p>",
    attachments: [
      {
        id: "att-1",
        filename: "hello.txt",
        mimetype: "text/plain",
        size: 5,
        dataBase64: "aGVsbG8=",
      },
    ],
  } as WemailDraftInput);

  assert.match(rawMessage, /Content-Type: multipart\/mixed;/i);
  assert.match(rawMessage, /Content-Disposition: attachment;\s*filename=hello\.txt/i);
  assert.match(rawMessage, /Content-Transfer-Encoding: base64/i);
  assert.match(rawMessage, /aGVsbG8=/i);
});

test("ImapSmtpMailProvider.fetchAttachment downloads MIME parts with larger first chunks", async () => {
  const { secrets, accountService } = setupAccount();
  const downloads: Array<{ range: string | number; part: string; options?: Record<string, unknown> }> = [];
  const fakeClient = new FakeImap([]) as FakeImap & {
    download: ImapLikeClient["download"];
  };
  fakeClient.download = async (range, part, options) => {
    downloads.push({ range, part, options });
    return {
      meta: { contentType: "application/pdf" },
      content: Readable.from([Buffer.from("PDFDATA")]),
    };
  };
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fakeClient as unknown as ImapLikeClient,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const result = await provider.fetchAttachment("acct-1:INBOX:17:42", "2");

  assert.equal(result?.bytes.toString("utf8"), "PDFDATA");
  assert.equal(result?.mimetype, "application/pdf");
  assert.deepEqual(downloads, [
    { range: 42, part: "2", options: { uid: true, chunkSize: 64 * 1024 } },
  ]);
});

test("ImapSmtpMailProvider.fetchAttachment retries smaller chunks for IMAP fetch volume limits", async () => {
  const { secrets, accountService } = setupAccount();
  const chunkSizes: unknown[] = [];
  const fakeClient = new FakeImap([]) as FakeImap & {
    download: ImapLikeClient["download"];
  };
  fakeClient.download = async (_range, _part, options) => {
    chunkSizes.push(options?.chunkSize);
    if (options?.chunkSize === 64 * 1024) {
      const err = new Error("Command failed") as Error & {
        responseStatus?: string;
        responseText?: string;
      };
      err.responseStatus = "NO";
      err.responseText = "FETCH Fetch volume limit exceed";
      throw err;
    }
    return {
      meta: { contentType: "application/pdf" },
      content: Readable.from([Buffer.from("PDFDATA")]),
    };
  };
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fakeClient as unknown as ImapLikeClient,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const result = await provider.fetchAttachment("acct-1:INBOX:17:42", "2");

  assert.equal(result?.bytes.toString("utf8"), "PDFDATA");
  assert.deepEqual(chunkSizes, [64 * 1024, 8 * 1024]);
});

test("ImapSmtpMailProvider.fetchAttachment reconnects when IMAP download resolves without a content stream", async () => {
  const { secrets, accountService } = setupAccount();
  const staleClient = new FakeImap([]) as FakeImap & {
    download: ImapLikeClient["download"];
  };
  staleClient.download = async () => ({});
  const freshClient = new FakeImap([]) as FakeImap & {
    download: ImapLikeClient["download"];
  };
  freshClient.download = async () => ({
    meta: { contentType: "application/pdf" },
    content: Readable.from([Buffer.from("PDFDATA")]),
  });
  let factoryCalls = 0;
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => {
      factoryCalls++;
      return (factoryCalls === 1 ? staleClient : freshClient) as unknown as ImapLikeClient;
    },
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const result = await provider.fetchAttachment("acct-1:INBOX:17:42", "2");

  assert.equal(result?.bytes.toString("utf8"), "PDFDATA");
  assert.equal(staleClient.loggedOut, true);
  assert.equal(factoryCalls, 2);
});

test("ImapSmtpMailProvider.fetchAttachment throws when IMAP download repeatedly omits the content stream", async () => {
  const { secrets, accountService } = setupAccount();
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => {
      const client = new FakeImap([]) as FakeImap & {
        download: ImapLikeClient["download"];
      };
      client.download = async () => ({});
      return client as unknown as ImapLikeClient;
    },
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  await assert.rejects(
    provider.fetchAttachment("acct-1:INBOX:17:42", "2"),
    (error: unknown) =>
      error instanceof MailProviderCommandError &&
      /attachment content unavailable/i.test(error.message),
  );
});

test("ImapSmtpMailProvider.fetchAttachment throws when the email id cannot be parsed", async () => {
  const { secrets, accountService } = setupAccount();
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => new FakeImap([]),
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  await assert.rejects(
    provider.fetchAttachment("bad-id", "2"),
    /invalid attachment email id/,
  );
});

test("ImapSmtpMailProvider.fetchAttachment throws when the IMAP client does not support download", async () => {
  const { secrets, accountService } = setupAccount();
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () =>
      ({
        connect: async () => {},
        logout: async () => {},
        mailboxOpen: async () => ({ uidValidity: 17 }),
        search: async () => [],
        fetch: async function* () {},
      }) as unknown as ImapLikeClient,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  await assert.rejects(
    provider.fetchAttachment("acct-1:INBOX:17:42", "2"),
    /attachment download is not supported by the IMAP client/,
  );
});

test("ImapSmtpMailProvider.fetchAttachment reconnects after NoConnection download failure", async () => {
  const { secrets, accountService } = setupAccount();
  const staleClient = new FakeImap([]) as FakeImap & {
    download: ImapLikeClient["download"];
  };
  staleClient.download = async () => {
    const err = new Error("Connection not available") as Error & { code?: string };
    err.code = "NoConnection";
    throw err;
  };
  const freshClient = new FakeImap([]) as FakeImap & {
    download: ImapLikeClient["download"];
  };
  freshClient.download = async () => ({
    meta: { contentType: "application/pdf" },
    content: Readable.from([Buffer.from("PDFDATA")]),
  });
  let factoryCalls = 0;
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => {
      factoryCalls++;
      return (factoryCalls === 1 ? staleClient : freshClient) as unknown as ImapLikeClient;
    },
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const result = await provider.fetchAttachment("acct-1:INBOX:17:42", "2");

  assert.equal(result?.bytes.toString("utf8"), "PDFDATA");
  assert.equal(staleClient.loggedOut, true);
  assert.equal(factoryCalls, 2);
});

test("ImapSmtpMailProvider.sendDraft throws MailProviderConnectError when smtp secret is missing (no fallback to imap password)", async () => {
  const { secrets, accountService } = setupAccount();
  // Remove ONLY the smtp secret — the imap password stays. The silent
  // fallback used to reuse the imap password here; we now fail loud.
  secrets.deleteSecret("wemail:account:acct-1:smtp-password");
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => new FakeImap([]),
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });
  await assert.rejects(
    () =>
      provider.sendDraft({
        accountId: "acct-1",
        to: [{ email: "bob@example.com" }],
        subject: "hi",
        bodyText: "hi",
        bodyHtml: "<p>hi</p>",
      }),
    (err: unknown) => {
      assert.ok(err instanceof MailProviderConnectError);
      assert.equal((err as MailProviderConnectError).phase, "smtp");
      assert.match((err as Error).message, /SMTP credentials not configured/);
      return true;
    },
  );
});

test("ImapSmtpMailProvider.getMessage fetches and normalizes one full message", async () => {
  const { secrets, accountService } = setupAccount();
  const timings: Array<{
    coldConnection: boolean;
    outcome: string;
    sourceBytes: number;
    connectMs: number;
    selectMs: number;
    fetchMs: number;
    parseMs: number;
    restoreMs: number;
    totalMs: number;
  }> = [];
  const fake = new FakeImap([{
    uid: 1,
    flags: new Set(["\\Seen"]),
    envelope: {
      date: "2026-04-23T10:00:00Z",
      subject: "detail",
      messageId: "<detail@x.com>",
      from: [{ address: "a@x.com" }],
      to: [{ address: "me@example.com" }],
    },
    source: rfc822Source("detail", "full body"),
    internalDate: "2026-04-23T10:00:00Z",
  }], 0, 1);
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
    onOperationTiming: (timing) => timings.push(timing),
  });
  const message = await provider.getMessage("acct-1:INBOX:1:1");
  assert.equal(message?.bodyText, "full body");
  assert.ok(message?.bodyCachedUntil);
  assert.equal(message?.flags.seen, true);
  assert.equal(fake.fetches.at(-1)?.query.source, true);
  assert.equal(fake.fetches.at(-1)?.query.flags, true);
  assert.equal(timings.length, 1);
  assert.equal(timings[0]?.coldConnection, true);
  assert.equal(timings[0]?.outcome, "success");
  assert.equal(timings[0]?.sourceBytes, Buffer.byteLength(rfc822Source("detail", "full body")));
  assert.ok((timings[0]?.connectMs ?? 0) >= 0);
  assert.ok((timings[0]?.selectMs ?? 0) >= 0);
  assert.ok((timings[0]?.fetchMs ?? 0) >= 0);
  assert.ok((timings[0]?.parseMs ?? 0) >= 0);
  assert.ok((timings[0]?.restoreMs ?? 0) >= 0);
  assert.ok((timings[0]?.totalMs ?? 0) >= 0);
  assert.deepEqual(fake.openedFolders, ["INBOX", "INBOX"]);
});

test("ImapSmtpMailProvider.getMessage refuses oversized background work and explicitly loads only body parts", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([{
    uid: 9,
    size: 40 * 1024 * 1024,
    envelope: {
      date: "2026-04-23T10:00:00Z",
      subject: "large attachment",
      messageId: "<large@x.com>",
      from: [{ address: "a@x.com" }],
      to: [{ address: "me@example.com" }],
    },
    bodyStructure: {
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "text/plain", size: 12 },
        {
          part: "2",
          type: "application/octet-stream",
          size: 30 * 1024 * 1024,
          disposition: "attachment",
          dispositionParameters: { filename: "large.zip" },
        },
      ],
    },
    bodyParts: new Map([
      ["1.mime", Buffer.from("Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit")],
      ["1", Buffer.from("正文可正常读取")],
    ]),
    internalDate: "2026-04-23T10:00:00Z",
  }], 0, 1);
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  await assert.rejects(provider.getMessage("acct-1:INBOX:1:9"), /mail-provider-message-too-large/);
  assert.equal(fake.fetches.some(({ query }) => query.source === true || Array.isArray(query.bodyParts)), false);
  const message = await provider.getMessage("acct-1:INBOX:1:9", { onDemand: true });

  assert.equal(message?.bodyText, "正文可正常读取");
  assert.equal(message?.attachments[0]?.filename, "large.zip");
  assert.equal(fake.fetches.some(({ query }) => query.source === true), false);
  assert.equal(fake.fetches.some(({ query }) => Array.isArray(query.bodyParts)), true);
});

test("ImapSmtpMailProvider.refreshFlags refetches existing message metadata by locator", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([{
    uid: 7,
    flags: new Set(["\\Seen", "\\Answered"]),
    envelope: {
      date: "2026-04-23T10:00:00Z",
      subject: "existing",
      messageId: "<existing@x.com>",
      from: [{ address: "a@x.com" }],
      to: [{ address: "me@example.com" }],
    },
    internalDate: "2026-04-23T10:00:00Z",
  }], 0, 17);
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const messages = await provider.refreshFlags(["acct-1:INBOX:17:7"]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.flags.seen, true);
  assert.equal(messages[0]!.flags.answered, true);
  assert.equal(messages[0]!.sync.flagsAuthoritative, true);
  assert.deepEqual(fake.fetches.at(-1)?.range, [7]);
  assert.equal(fake.fetches.at(-1)?.query.flags, true);
  assert.equal(fake.fetches.at(-1)?.query.source, undefined);
});

test("ImapSmtpMailProvider moves and deletes by normalized UID locator", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([], 0, 17);
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const moved = await provider.moveMessage("acct-1:INBOX:17:7", "Archive");
  await provider.deleteMessage("acct-1:INBOX:17:8");

  assert.deepEqual(fake.moved, [{ range: [7], destination: "Archive", options: { uid: true } }]);
  assert.deepEqual(moved, { folder: "Archive", uid: 107, uidValidity: 23 });
  assert.deepEqual(fake.deleted, [{ range: [8], options: { uid: true } }]);
});

test("ImapSmtpMailProvider resolves a moved message by Message-ID in the destination folder", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new FakeImap([{
    uid: 107,
    envelope: {
      messageId: "<message-42@example.com>",
      subject: "moved",
    },
  }], 0, 23);
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const locator = await provider.resolveMessageLocator("Archive", "<message-42@example.com>");

  assert.deepEqual(locator, { uid: 107, uidValidity: 23 });
  assert.deepEqual(fake.searches.at(-1), {
    query: { header: { "message-id": "<message-42@example.com>" } },
    options: { uid: true },
  });
  assert.deepEqual(fake.openedFolders.slice(-2), ["Archive", "INBOX"]);
});

test("ImapSmtpMailProvider.connect throws when current account credentials are missing", async () => {
  const { secrets, accountService } = setupAccount();
  secrets.deleteSecret("wemail:account:acct-1:imap-password");
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => new FakeImap([]),
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });
  await assert.rejects(() => provider.connect(), /no account configured/);
});
