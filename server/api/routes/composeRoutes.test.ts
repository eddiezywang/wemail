import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { ComposeMailResult } from "../../../shared/wemail/intelligence.js";
import { buildComposeRoutes } from "./composeRoutes.js";

const draft: ComposeMailResult = {
  type: "composeMail",
  operationType: "NEW",
  status: "draft",
  to: [],
  subject: "Status update",
  draftMarkdown: "Done.",
};

test("POST /api/compose/draft derives account ownership from the active session", async () => {
  const calls: unknown[] = [];
  const app = new Hono();
  app.route("/api/compose", buildComposeRoutes({
    getActiveAccountId: () => "acct-active",
    service: {
      composeMail: async (input, caller) => {
        calls.push({ input, caller });
        return draft;
      },
    },
  }));

  const response = await app.request("/api/compose/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationType: "NEW",
      intent: "  write an update  ",
      accountId: "acct-attacker",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    input: {
      operationType: "NEW",
      intent: "write an update",
      accountId: "acct-active",
      emailId: undefined,
      to: undefined,
      currentTo: undefined,
      currentCc: undefined,
      currentBcc: undefined,
      targetLanguage: undefined,
      styleId: undefined,
      currentBody: undefined,
      currentSubject: undefined,
      clientNow: undefined,
      clientTimeZone: undefined,
    },
    caller: { source: "user" },
  }]);
});

test("POST /api/compose/draft rejects reply composition without a source message", async () => {
  const app = new Hono();
  app.route("/api/compose", buildComposeRoutes({
    getActiveAccountId: () => "acct-active",
    service: { composeMail: async () => draft },
  }));
  const response = await app.request("/api/compose/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationType: "REPLY", intent: "reply politely" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, code: "SOURCE_MESSAGE_REQUIRED" });
});

test("POST /api/compose/draft returns a stable public code when AI is unavailable", async () => {
  const app = new Hono();
  app.route("/api/compose", buildComposeRoutes({
    getActiveAccountId: () => "acct-active",
    service: {
      composeMail: async () => {
        throw new Error("AI compose is not configured");
      },
    },
  }));
  const response = await app.request("/api/compose/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationType: "NEW", intent: "write an update" }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: "AI_NOT_CONFIGURED" });
});
