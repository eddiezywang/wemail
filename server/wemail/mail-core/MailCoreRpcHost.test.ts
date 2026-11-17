import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { MAIL_CORE_PROTOCOL_VERSION } from "../../../shared/wemail/mailCoreProtocol.js";
import { MailCoreRpcHost, type MailCoreServerPort } from "./MailCoreRpcHost.js";

class FakePort extends EventEmitter implements MailCoreServerPort {
  readonly sent: unknown[] = [];
  started = false;
  closed = false;

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  receive(data: unknown): void {
    this.emit("message", { data });
  }
}

test("MailCoreRpcHost serves a validated health request", async () => {
  const port = new FakePort();
  const host = new MailCoreRpcHost({
    pid: 42,
    now: () => new Date("2026-07-28T00:00:00.000Z"),
    monotonicNow: (() => {
      let value = 0;
      return () => value++;
    })(),
  });
  host.attach(port);
  port.receive({
    version: MAIL_CORE_PROTOCOL_VERSION,
    requestId: "req-1",
    traceId: "trace-1",
    method: "core.health",
    params: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.started, true);
  assert.deepEqual(port.sent[0], {
    version: MAIL_CORE_PROTOCOL_VERSION,
    requestId: "req-1",
    ok: true,
    result: {
      protocolVersion: MAIL_CORE_PROTOCOL_VERSION,
      state: "ready",
      pid: 42,
      startedAt: "2026-07-28T00:00:00.000Z",
      uptimeMs: 0,
    },
    timing: { queueMs: 1, handlerMs: 1, totalMs: 2 },
  });
});

test("MailCoreRpcHost returns a stable protocol error for invalid input", async () => {
  const port = new FakePort();
  new MailCoreRpcHost().attach(port);
  port.receive({ requestId: "bad", method: "unknown" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.sent[0], {
    version: MAIL_CORE_PROTOCOL_VERSION,
    requestId: "bad",
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "Mail Core request did not match the protocol schema",
      retryable: false,
    },
  });
});

test("MailCoreRpcHost queues a missing body without delaying the snapshot", async () => {
  const port = new FakePort();
  const ensured: Array<{ emailId: string; accountId: string }> = [];
  new MailCoreRpcHost({
    ensureBody: async (emailId, accountId) => {
      ensured.push({ emailId, accountId });
      return { status: "queued", jobId: 12 };
    },
  }).attach(port);
  port.receive({
    version: MAIL_CORE_PROTOCOL_VERSION,
    requestId: "req-body",
    traceId: "trace-body",
    method: "mail.ensureBody",
    params: { accountId: "acct-1", id: "mail-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ensured, [{ emailId: "mail-1", accountId: "acct-1" }]);
  assert.deepEqual((port.sent[0] as { result: unknown }).result, {
    status: "queued",
    jobId: 12,
  });
});

test("MailCoreRpcHost routes an explicit body retry separately", async () => {
  const port = new FakePort();
  const retried: string[] = [];
  new MailCoreRpcHost({
    retryBody: async (emailId) => {
      retried.push(emailId);
      return { status: "queued", jobId: 14 };
    },
  }).attach(port);
  port.receive({
    version: MAIL_CORE_PROTOCOL_VERSION,
    requestId: "req-retry",
    traceId: "trace-retry",
    method: "mail.retryBody",
    params: { accountId: "acct-1", id: "mail-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(retried, ["mail-1"]);
  assert.deepEqual((port.sent[0] as { result: unknown }).result, {
    status: "queued",
    jobId: 14,
  });
});

test("MailCoreRpcHost queues a canonical manual refresh", async () => {
  const port = new FakePort();
  const refreshed: Array<{ accountId: string; traceId: string }> = [];
  new MailCoreRpcHost({
    refreshMail: async (accountId, traceId) => {
      refreshed.push({ accountId, traceId });
      return { status: "queued", accountId, jobId: 21 };
    },
  }).attach(port);
  port.receive({
    version: MAIL_CORE_PROTOCOL_VERSION,
    requestId: "req-refresh",
    traceId: "trace-refresh",
    method: "mail.refresh",
    params: { accountId: "acct-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(refreshed, [{ accountId: "acct-1", traceId: "trace-refresh" }]);
  assert.deepEqual((port.sent[0] as { result: unknown }).result, {
    status: "queued",
    accountId: "acct-1",
    jobId: 21,
  });
});

test("manual refresh preserves the credential failure code across the RPC boundary", async () => {
  const port = new FakePort();
  new MailCoreRpcHost({
    refreshMail: async () => {
      const error = new Error("mail-credential-required");
      error.name = "MAIL_CREDENTIAL_INVALID";
      throw error;
    },
  }).attach(port);
  port.receive({
    version: MAIL_CORE_PROTOCOL_VERSION, requestId: "refresh-auth", traceId: "refresh-auth",
    method: "mail.refresh", params: { accountId: "acct-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((port.sent[0] as { error: unknown }).error, {
    code: "MAIL_CREDENTIAL_INVALID", message: "mail-credential-required", retryable: false,
  });
});
