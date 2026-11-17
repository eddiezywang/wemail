import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AccountWorkerCommand, AccountWorkerEvent } from "../../server/wemail/mail-core/AccountWorkerProtocol.js";
import type { MailMetadataPage } from "../../server/wemail/mail/MailProvider.js";

class Port extends EventEmitter {
  postMessage = vi.fn<(event: AccountWorkerEvent) => void>();
  close() { this.removeAllListeners(); }
}
const state = vi.hoisted(() => ({
  port: null as unknown as Port,
  realtime: null as unknown as {
    syncIncrementalPages: () => AsyncGenerator<MailMetadataPage>;
    invalidateConnection: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    supportsPushWatch: () => boolean;
  },
  interactive: null as unknown as {
    sendDraft: ReturnType<typeof vi.fn>;
    invalidateConnection: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  },
}));
vi.mock("../../server/wemail/mail/ImapSmtpMailProvider.js", () => ({
  ImapSmtpMailProvider: class {
    constructor(options: { role: string }) { return options.role === "foreground-realtime" ? state.realtime : state.interactive; }
  },
  MailProviderCommandError: class extends Error {},
  MailProviderConnectError: class extends Error {},
}));

const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const send = (command: AccountWorkerCommand) => state.port.emit("message", command);
const sync = (jobId: number): AccountWorkerCommand => ({
  type: "account-worker.sync-metadata", jobId, origin: "manual", syncStates: {},
});
const page: MailMetadataPage = { folder: "INBOX", messages: [],
  continuation: { uid: 0, uidValidity: 17, internalDate: "2026-11-04T00:00:00Z", completed: false } };
let finishSend: (result: { messageId: string }) => void;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  state.port = new Port();
  vi.doMock("node:worker_threads", () => ({
    parentPort: state.port, threadId: 1,
    workerData: { accountId: "acct-1", dataDir: ".wemail", e2eMode: false,
      credential: { account: { id: "acct-1" }, imapPassword: "fixture" } },
  }));
  state.realtime = {
    syncIncrementalPages: async function* () { yield page; },
    invalidateConnection: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    supportsPushWatch: () => false,
  };
  state.interactive = {
    sendDraft: vi.fn(() => new Promise<{ messageId: string }>((resolve) => { finishSend = resolve; })),
    invalidateConnection: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
  };
});
afterEach(async () => {
  send({ type: "account-worker.shutdown" });
  await settle();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function startReceiptAndSend() {
  await import("./account-worker-entry.js");
  send({ type: "account-worker.send-draft", outboxId: 7, messageIdHeader: "<stable@example.test>",
    draft: { accountId: "acct-1", to: [{ email: "to@example.test" }], subject: "Fixture", bodyText: "", bodyHtml: "" } });
  send(sync(1));
  await settle();
}

async function assertSendSurvivesCancellation() {
  expect(state.realtime.invalidateConnection).toHaveBeenCalledOnce();
  expect(state.interactive.invalidateConnection).not.toHaveBeenCalled();
  expect(state.port.postMessage).toHaveBeenCalledWith({ type: "account-worker.metadata-cancelled", accountId: "acct-1", jobId: 1 });
  finishSend({ messageId: "sent" });
  await settle();
  expect(state.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "account-worker.send-result", ok: true, messageId: "sent" }));
  expect(state.interactive.sendDraft).toHaveBeenCalledOnce();
}

test("metadata cancellation interrupts a remote wait while preserving the SMTP provider", async () => {
  let cancelSearch!: (error: Error) => void;
  state.realtime.syncIncrementalPages = async function* () {
    await new Promise<void>((_resolve, reject) => { cancelSearch = reject; });
    yield page;
  };
  state.realtime.invalidateConnection.mockImplementation(async () => { cancelSearch(new Error("cancelled")); });
  await startReceiptAndSend();
  send({ type: "account-worker.cancel-metadata", jobId: 1 });
  await settle();
  expect(state.port.postMessage.mock.calls.some(([event]) => event.type === "account-worker.metadata-result")).toBe(false);
  await assertSendSurvivesCancellation();
});

test("metadata cancellation releases an ACK wait only after its page iterator has closed", async () => {
  let closed = 0;
  state.realtime.syncIncrementalPages = async function* () {
    try { yield page; } finally { closed++; }
  };
  await startReceiptAndSend();
  expect(state.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "account-worker.metadata-result", jobId: 1, ok: true }));
  send({ type: "account-worker.cancel-metadata", jobId: 1 });
  await settle();
  expect(closed).toBe(1);
  await assertSendSurvivesCancellation();
  send({ type: "account-worker.metadata-ack", jobId: 1, continue: true });
  send(sync(2));
  await settle();
  expect(state.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "account-worker.metadata-result", jobId: 2, ok: true }));
  send({ type: "account-worker.metadata-ack", jobId: 2, continue: false });
  await settle();
});
