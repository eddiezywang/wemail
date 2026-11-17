import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LangBotClient,
  LangBotClientError,
} from "./LangBotClient.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8")) as unknown;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("fixture contract lists typed bots and verifies compatibility", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new LangBotClient({
    baseUrl: "http://127.0.0.1:5300",
    apiKey: "lbk_fixture_secret",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return response(fixture("bots-list.v4.9.7.json"));
    },
    now: () => new Date("2026-07-29T00:00:00.000Z"),
  });
  const result = await client.checkCompatibility();
  assert.equal(result.profile, "langbot-service-api-v4.9");
  assert.equal(result.botCount, 2);
  assert.equal(requests[0]?.init?.headers instanceof Headers, false);
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)["X-API-Key"],
    "lbk_fixture_secret",
  );
});

test("fixture contract gets one bot and sends plain text", async () => {
  const bodies: string[] = [];
  const client = new LangBotClient({
    baseUrl: "http://127.0.0.1:5300/",
    apiKey: "key",
    fetch: async (url, init) => {
      if (String(url).endsWith("/send_message")) {
        bodies.push(String(init?.body));
        return response(fixture("send-success.v4.9.7.json"));
      }
      return response(fixture("bot-detail.v4.9.7.json"));
    },
  });
  const bot = await client.getBot("bot-1");
  assert.equal(bot.platform, "feishu");
  assert.equal(bot.enabled, true);
  assert.deepEqual(
    await client.sendMessage({
      botUuid: "bot-1",
      targetType: "person",
      targetId: "owner-1",
      text: "测试消息",
    }),
    { sent: true },
  );
  assert.deepEqual(JSON.parse(bodies[0]!), {
    target_type: "person",
    target_id: "owner-1",
    message_chain: [{ type: "Plain", text: "测试消息" }],
  });
});

test("sanitizes bot logs", async () => {
  const client = new LangBotClient({
    baseUrl: "http://127.0.0.1:5300",
    apiKey: "key",
    fetch: async () =>
      response({
        code: 0,
        msg: "ok",
        data: { logs: [{ token: "lbk_should_not_leak", status: "ok" }] },
      }),
  });
  const logs = await client.getBotLogs("bot-1");
  assert.doesNotMatch(logs[0]!, /lbk_should_not_leak/);
});

test("classifies authentication, retryable server, and incompatible errors", async () => {
  for (const [status, code, retryable] of [
    [401, "langbot-unauthorized", false],
    [503, "langbot-server-error", true],
  ] as const) {
    const client = new LangBotClient({
      baseUrl: "http://127.0.0.1:5300",
      apiKey: "secret",
      fetch: async () => response({}, status),
    });
    await assert.rejects(
      client.listBots(),
      (error) =>
        error instanceof LangBotClientError &&
        error.code === code &&
        error.retryable === retryable,
    );
  }

  const incompatible = new LangBotClient({
    baseUrl: "http://127.0.0.1:5300",
    apiKey: "secret",
    fetch: async () => response({ code: 0, data: { unexpected: true } }),
  });
  await assert.rejects(
    incompatible.listBots(),
    (error) =>
      error instanceof LangBotClientError &&
      error.code === "langbot-incompatible",
  );
});
