import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { buildMailEventsRoutes } from "./mailEventsRoutes.js";

interface MailChangedEvent {
  accountId: string;
  origin: "live-idle" | "live-poll";
  insertedCount: number;
  inserted: Array<{
    id: string;
    subject: string;
    from: string;
  }>;
}

function makeHarness() {
  let listener: ((event: MailChangedEvent) => void) | null = null;
  let authListener:
    | ((event: {
        accountId: string;
        code: "MAIL_CREDENTIAL_INVALID";
        stage: "imap.login";
      }) => void)
    | null = null;
  let unsubscribeCalls = 0;

  const app = new Hono();
  app.route(
    "/api/mail",
    buildMailEventsRoutes({
      getCurrentAccountId: () => "acct-1",
      onMailChanged: (next) => {
        listener = next;
        return () => {
          unsubscribeCalls += 1;
          listener = null;
        };
      },
      onMailCredentialInvalid: (next) => {
        authListener = next;
        return () => {
          authListener = null;
        };
      },
      heartbeatIntervalMs: 60_000,
    }),
  );

  return {
    app,
    emit(event: MailChangedEvent) {
      listener?.(event);
    },
    emitAuthRequired(accountId = "acct-1") {
      authListener?.({
        accountId,
        code: "MAIL_CREDENTIAL_INVALID",
        stage: "imap.login",
      });
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
  };
}

async function readOneChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  assert.ok(reader, "expected response body");
  const result = await reader.read();
  const value = result.value ? new TextDecoder().decode(result.value) : "";
  await reader.cancel();
  return value;
}

test("GET /api/mail/events streams account-scoped mail-changed events as SSE", async () => {
  const harness = makeHarness();
  const response = await harness.app.request("/api/mail/events?accountId=acct-1");

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  harness.emit({
    accountId: "acct-1",
    origin: "live-idle",
    insertedCount: 1,
    inserted: [{ id: "m-1", from: "Alpha", subject: "Hello" }],
  });

  const chunk = await readOneChunk(response);
  assert.match(chunk, /event: mail-changed/);
  assert.match(chunk, /"accountId":"acct-1"/);
  assert.match(chunk, /"insertedCount":1/);
  assert.match(chunk, /"insertedIds":\["m-1"\]/);
});

test("GET /api/mail/events ignores mail-changed events for other accounts", async () => {
  const harness = makeHarness();
  const response = await harness.app.request("/api/mail/events?accountId=acct-1");

  harness.emit({
    accountId: "acct-2",
    origin: "live-poll",
    insertedCount: 1,
    inserted: [{ id: "m-2", from: "Beta", subject: "Hidden" }],
  });
  harness.emit({
    accountId: "acct-1",
    origin: "live-poll",
    insertedCount: 1,
    inserted: [{ id: "m-3", from: "Gamma", subject: "Visible" }],
  });

  const chunk = await readOneChunk(response);
  assert.ok(!chunk.includes("\"accountId\":\"acct-2\""));
  assert.match(chunk, /"insertedIds":\["m-3"\]/);
});

test("GET /api/mail/events streams safe credential-required events", async () => {
  const harness = makeHarness();
  const response = await harness.app.request("/api/mail/events?accountId=acct-1");

  harness.emitAuthRequired();

  const chunk = await readOneChunk(response);
  assert.match(chunk, /event: mail-auth-required/);
  assert.match(chunk, /"code":"MAIL_CREDENTIAL_INVALID"/);
  assert.match(chunk, /"stage":"imap.login"/);
  assert.ok(!chunk.includes("password error"));
});

test("GET /api/mail/events unsubscribes when the stream closes", async () => {
  const harness = makeHarness();
  const response = await harness.app.request("/api/mail/events?accountId=acct-1");
  const reader = response.body?.getReader();
  assert.ok(reader, "expected response body");

  await reader.cancel();

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.unsubscribeCalls, 1);
});
