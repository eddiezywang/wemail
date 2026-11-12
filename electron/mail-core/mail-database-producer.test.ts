import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { MAIL_DATABASE_PROTOCOL_VERSION, MailDatabaseResetAiJobsParamsSchema, type MailDatabaseRequest } from "../../shared/wemail/mailDatabaseProtocol.js";
import { DirectoryWriteParamsSchema } from "../../shared/wemail/directoryDatabase.js";
import { MailDatabaseProducer } from "./mail-database-producer.js";

class FakePort extends EventEmitter {
  readonly requests: MailDatabaseRequest[] = [];
  failAppend = false;
  start() {}
  close() {}
  postMessage(request: MailDatabaseRequest) {
    this.requests.push(request);
    const params = DirectoryWriteParamsSchema.parse(request.params);
    const failed = this.failAppend && params.operation === "appendSnapshot";
    queueMicrotask(() => this.emit("message", { data: {
      version: MAIL_DATABASE_PROTOCOL_VERSION, requestId: request.requestId,
      ok: !failed, result: 0, ...(failed ? { error: { message: "writer failed" } } : {}),
    } }));
  }
}

test("directory snapshots cross the port in ordered bounded chunks before publication", async () => {
  const port = new FakePort();
  const producer = new MailDatabaseProducer(port as never);
  try {
    await producer.writeDirectory({ operation: "replaceSnapshot", accountId: "account",
      departments: [], contacts: Array.from({ length: 250 }, (_, index) => ({
        id: String(index), email: `${index}@example.com`, name: "Name", aliases: [],
      })) });
    const params = port.requests.map((request) => DirectoryWriteParamsSchema.parse(request.params));
    expect(params.map((input) => input.operation)).toEqual([
      "beginSnapshot", "appendSnapshot", "appendSnapshot", "appendSnapshot", "commitSnapshot", "cleanupSnapshots",
    ]);
    const chunks = params.filter((input) => input.operation === "appendSnapshot");
    expect(chunks.map((input) => [input.sequence, input.contacts.length])).toEqual([[0, 100], [1, 100], [2, 50]]);
    expect(new Set(params.filter((input) => "snapshotId" in input).map((input) => input.snapshotId)).size).toBe(1);
  } finally { producer.close(); }
});

test("directory read and write requests keep their dedicated DB service lanes", async () => {
  const port = new EventEmitter() as EventEmitter & {
    start(): void;
    close(): void;
    postMessage(request: MailDatabaseRequest): void;
  };
  const methods: string[] = [];
  port.start = () => {};
  port.close = () => {};
  port.postMessage = (request) => {
    methods.push(request.method);
    queueMicrotask(() => port.emit("message", { data: {
      version: MAIL_DATABASE_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result: 0,
    } }));
  };
  const producer = new MailDatabaseProducer(port as never);
  try {
    await producer.readDirectory({ operation: "getStatus", accountId: "account" });
    await producer.writeDirectory({ operation: "indexPinyinBatch", accountId: "account" });
    expect(methods).toEqual(["directory.read", "directory.write"]);
  } finally { producer.close(); }
});

test("a rejected snapshot chunk aborts staging and never publishes partial data", async () => {
  const port = new FakePort();
  port.failAppend = true;
  const producer = new MailDatabaseProducer(port as never);
  try {
    await expect(producer.writeDirectory({ operation: "replaceSnapshot", accountId: "account", departments: [],
      contacts: [{ id: "one", name: "Name", email: "one@example.com", aliases: [] }],
    })).rejects.toThrow("writer failed");
    expect(port.requests.map((request) => (request.params as { operation: string }).operation))
      .toEqual(["beginSnapshot", "appendSnapshot", "abortSnapshot", "cleanupSnapshots"]);
  } finally { producer.close(); }
});

test("AI recovery continues across empty batches using the original boundary", async () => {
  const port = new EventEmitter() as EventEmitter & { start(): void; close(): void; postMessage(request: MailDatabaseRequest): void };
  port.start = () => {};
  port.close = () => {};
  const requests: MailDatabaseRequest[] = [];
  port.postMessage = (request) => {
    requests.push(request);
    const afterId = requests.length === 1 ? 100 : 205;
    queueMicrotask(() => port.emit("message", { data: { version: MAIL_DATABASE_PROTOCOL_VERSION,
      requestId: request.requestId, ok: true, result: { count: requests.length === 1 ? 0 : 5, afterId, throughId: 205 },
    } }));
  };
  const producer = new MailDatabaseProducer(port as never);
  try {
    expect(await producer.resetTerminalAiJobsForRetry()).toBe(5);
    expect(requests.map((request) => request.params)).toEqual([
      { afterId: 0, throughId: undefined }, { afterId: 100, throughId: 205 },
    ]);
  } finally { producer.close(); }
});

test("AI recovery rejects invalid cursors at the writer boundary", () => {
  for (const params of [{ afterId: -1 }, { afterId: 2, throughId: 1 }, { throughId: Infinity }, { afterId: 0.5 }, { sql: "arbitrary" }]) {
    expect(MailDatabaseResetAiJobsParamsSchema.safeParse(params).success).toBe(false);
  }
  expect(MailDatabaseResetAiJobsParamsSchema.parse({})).toEqual({ afterId: 0 });
});

test("AI recovery reports a failed batch instead of claiming partial recovery succeeded", async () => {
  const port = new EventEmitter() as EventEmitter & { start(): void; close(): void; postMessage(request: MailDatabaseRequest): void };
  port.start = () => {};
  port.close = () => {};
  let requests = 0;
  port.postMessage = (request) => {
    requests += 1;
    queueMicrotask(() => port.emit("message", { data: { version: MAIL_DATABASE_PROTOCOL_VERSION,
      requestId: request.requestId, ok: requests === 1,
      result: { count: 100, afterId: 100, throughId: 205 }, error: { message: "writer unavailable" },
    } }));
  };
  const producer = new MailDatabaseProducer(port as never);
  try {
    await expect(producer.resetTerminalAiJobsForRetry()).rejects.toThrow("writer unavailable");
    expect(requests).toBe(2);
  } finally { producer.close(); }
});
