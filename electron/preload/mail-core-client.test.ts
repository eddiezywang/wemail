import { describe, expect, it, vi } from "vitest";
import { MAIL_CORE_PROTOCOL_VERSION } from "../../shared/wemail/mailCoreProtocol.js";
import { MailCoreClient, type MailCoreClientPort } from "./mail-core-client.js";

class FakePort implements MailCoreClientPort {
  listener: ((event: MessageEvent<unknown>) => void) | null = null;
  sent: unknown[] = [];
  closed = false;

  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listener = listener;
  }
  removeEventListener(): void {
    this.listener = null;
  }
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  start(): void {}
  close(): void {
    this.closed = true;
  }
  receive(data: unknown): void {
    this.listener?.({ data } as MessageEvent<unknown>);
  }
}

describe("MailCoreClient", () => {
  it("correlates a health response", async () => {
    const port = new FakePort();
    const client = new MailCoreClient();
    client.replacePort(port);
    const promise = client.health();
    const request = port.sent[0] as { requestId: string };
    port.receive({
      version: MAIL_CORE_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result: {
        protocolVersion: MAIL_CORE_PROTOCOL_VERSION,
        state: "ready",
        pid: 42,
        startedAt: "2026-07-28T00:00:00.000Z",
        uptimeMs: 10,
      },
      timing: { queueMs: 0, handlerMs: 1, totalMs: 1 },
    });
    await expect(promise).resolves.toMatchObject({ state: "ready", pid: 42 });
  });

  it("rejects pending work when the port is replaced", async () => {
    const first = new FakePort();
    const client = new MailCoreClient();
    client.replacePort(first);
    const promise = client.health();
    client.replacePort(new FakePort());
    await expect(promise).rejects.toThrow("connection was replaced");
    expect(first.closed).toBe(true);
  });

  it("sends and validates a manual refresh request", async () => {
    const port = new FakePort();
    const client = new MailCoreClient();
    client.replacePort(port);
    const promise = client.refreshMail("acct-1", 2_000, "trace-refresh");
    const request = port.sent[0] as {
      requestId: string;
      traceId: string;
      method: string;
      params: unknown;
    };
    expect(request).toMatchObject({
      traceId: "trace-refresh",
      method: "mail.refresh",
      params: { accountId: "acct-1" },
    });
    port.receive({
      version: MAIL_CORE_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result: { status: "queued", accountId: "acct-1", jobId: 21 },
      timing: { queueMs: 0, handlerMs: 1, totalMs: 1 },
    });
    await expect(promise).resolves.toEqual({
      status: "queued",
      accountId: "acct-1",
      jobId: 21,
    });
  });

  it("times out unanswered work", async () => {
    vi.useFakeTimers();
    const client = new MailCoreClient();
    client.replacePort(new FakePort());
    const promise = client.health(20);
    const expectation = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
    vi.useRealTimers();
  });

});
