import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  MAIL_DATABASE_PROTOCOL_VERSION,
  type MailDatabaseRequest,
} from "../../shared/wemail/mailDatabaseProtocol.js";
import {
  MailDatabasePortBroker,
  type MailDatabaseBrokerPort,
} from "./mail-database-port-broker.js";

class FakePort extends EventEmitter implements MailDatabaseBrokerPort {
  readonly sent: unknown[] = [];
  started = false;
  closed = false;

  start(): void {
    this.started = true;
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  receive(message: unknown): void {
    this.emit("message", { data: message });
  }
}

test("broker preserves trusted workload across reconnects regardless of request fields", () => {
  const broker = new MailDatabasePortBroker();
  const foreground = new FakePort();
  const background = new FakePort();
  const workloads: string[] = [];
  const factory = (workload: string) => {
    workloads.push(workload);
    return new FakePort();
  };
  broker.registerClient(foreground);
  broker.registerClient(background, "background");
  broker.replaceUpstreamFactory(factory);
  background.receive({ ...request("background-read"), workload: "interactive" });
  broker.replaceUpstreamFactory(null);
  broker.replaceUpstreamFactory(factory);
  assert.deepEqual(workloads, ["interactive", "background", "interactive", "background"]);
  broker.close();
});

test("broker keeps the downstream port stable across DB Service replacement", () => {
  const broker = new MailDatabasePortBroker();
  const downstream = new FakePort();
  const upstreams: FakePort[] = [];
  broker.registerClient(downstream);

  const queued = request("queued");
  downstream.receive(queued);
  assert.equal(downstream.sent.length, 0);

  broker.replaceUpstreamFactory(() => {
    const upstream = new FakePort();
    upstreams.push(upstream);
    return upstream;
  });
  assert.deepEqual(upstreams[0]?.sent, [queued]);

  upstreams[0]?.receive({
    version: MAIL_DATABASE_PROTOCOL_VERSION,
    requestId: queued.requestId,
    ok: true,
    result: { state: "ready" },
    timing: { queueMs: 0, handlerMs: 1, totalMs: 1, lane: "gateway" },
  });
  assert.equal((downstream.sent[0] as { ok?: boolean }).ok, true);

  const interrupted = request("interrupted");
  downstream.receive(interrupted);
  broker.replaceUpstreamFactory(() => {
    const upstream = new FakePort();
    upstreams.push(upstream);
    return upstream;
  });
  assert.equal(downstream.closed, false);
  assert.equal(upstreams[0]?.closed, true);
  assert.deepEqual(downstream.sent[1], {
    version: MAIL_DATABASE_PROTOCOL_VERSION,
    requestId: interrupted.requestId,
    ok: false,
    error: {
      code: "DB_SERVICE_RESTARTED",
      message: "DB Service restarted while the request was in flight",
      retryable: true,
    },
  });

  const afterRestart = request("after-restart");
  downstream.receive(afterRestart);
  assert.deepEqual(upstreams[1]?.sent, [afterRestart]);
});

function request(requestId: string): MailDatabaseRequest {
  return {
    version: MAIL_DATABASE_PROTOCOL_VERSION,
    requestId,
    traceId: requestId,
    method: "database.health",
    params: {},
    deadlineMs: Date.now() + 30_000,
  };
}
