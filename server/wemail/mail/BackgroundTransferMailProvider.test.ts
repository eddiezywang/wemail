import assert from "node:assert/strict";
import { test } from "node:test";
import type { WemailDraftInput } from "../../../shared/wemail/mail.js";
import type { MailProvider, MailIncrementalPageStream, MailMetadataPageResume } from "./MailProvider.js";
import { BackgroundTransferMailProvider } from "./BackgroundTransferMailProvider.js";

test("background transfer provider admits interactive work before the next background operation", async () => {
  const calls: string[] = [];
  let releasePage!: () => void;
  const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
  const provider: MailProvider = {
    connect: async () => {},
    disconnect: async () => {},
    syncRecent: async () => [],
    syncSince: async () => {
      calls.push("background:window");
      return [];
    },
    syncMetadataPages: async function* () {
      calls.push("background:page");
      await pageGate;
      return;
    },
    getMessage: async () => {
      calls.push("interactive:body");
      return null;
    },
    sendDraft: async (_input: WemailDraftInput) => ({ messageId: "unused" }),
  };
  const coordinated = new BackgroundTransferMailProvider(provider);
  const page = coordinated.syncMetadataPages!({
    since: new Date("2026-07-27T00:00:00.000Z"),
    pageSize: 100,
  })[Symbol.asyncIterator]().next();
  const background = coordinated.syncSince(new Date());
  const interactive = coordinated.getMessage("message-1");

  releasePage();
  await Promise.all([page, background, interactive]);

  assert.deepEqual(calls, [
    "background:page",
    "interactive:body",
    "background:window",
  ]);
  assert.equal(coordinated.role, "background-transfer");
});

test("background transfer provider rejects queued work from an invalidated session generation", async () => {
  const calls: string[] = [];
  let releasePage!: () => void;
  const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
  const provider: MailProvider = {
    connect: async () => {},
    disconnect: async () => { calls.push("disconnect"); },
    syncRecent: async () => [],
    syncSince: async () => {
      calls.push("stale:window");
      return [];
    },
    syncMetadataPages: async function* () {
      calls.push("background:page");
      await pageGate;
      return;
    },
    getMessage: async () => null,
    sendDraft: async (_input: WemailDraftInput) => ({ messageId: "unused" }),
  };
  const coordinated = new BackgroundTransferMailProvider(provider);
  const page = coordinated.syncMetadataPages!({
    since: new Date("2026-07-27T00:00:00.000Z"),
    pageSize: 100,
  })[Symbol.asyncIterator]().next();
  const staleWindow = coordinated.syncSince(new Date());
  const invalidate = coordinated.invalidateConnection();

  releasePage();
  await page;
  await invalidate;
  await assert.rejects(staleWindow, {
    code: "NoConnection",
    name: "BackgroundSessionInvalidatedError",
  });
  assert.deepEqual(calls, ["background:page", "disconnect"]);
});

test("paged transfer forwards durable resume state and closes an abandoned iterator", async () => {
  let resumed: MailMetadataPageResume | undefined;
  let releases = 0;
  const provider: MailProvider = {
    connect: async () => {}, disconnect: async () => {},
    syncRecent: async () => [], syncSince: async () => [],
    getMessage: async () => null, sendDraft: async () => ({ messageId: "unused" }),
    syncIncrementalPages: async function* (): MailIncrementalPageStream {
      const page = {
        folder: "INBOX", messages: [],
        continuation: { uid: 0, uidValidity: 17, internalDate: "2026-11-04T00:00:00Z", completed: false },
      };
      try {
        resumed = yield page;
        yield page;
      } finally { releases++; }
    },
  };
  const coordinated = new BackgroundTransferMailProvider(provider);
  const iterator = coordinated.syncIncrementalPages!({ states: {}, since: new Date() });
  await iterator.next();
  const resume = { states: {}, recheckInbox: true };
  await iterator.next(resume);
  assert.deepEqual(resumed, resume);
  await iterator.return();
  assert.equal(releases, 1);
});
