import assert from "node:assert/strict";
import test from "node:test";
import { ChannelAuditRepository } from "../../wemail/channels/ChannelAuditRepository.js";
import { ChannelConnectionRepository } from "../../wemail/channels/ChannelConnectionRepository.js";
import { ChannelInboundRepository } from "../../wemail/channels/ChannelLedgerRepository.js";
import { ChannelSenderRateLimiter } from "../../wemail/channels/ChannelSecurity.js";
import { LANGBOT_MAX_WEBHOOK_BYTES } from "../../wemail/channels/LangBotProtocol.js";
import { openOrCreateMailDatabase } from "../../wemail/database/Database.js";
import { createChannelWebhookApp } from "./channelWebhookRoutes.js";

function fixture(kind: "person" | "group" = "person") {
  return kind === "person"
    ? {
        uuid: "event-1",
        event_type: "bot.person_message",
        data: {
          bot_uuid: "bot-1",
          adapter_name: "lark",
          sender: { id: "owner-1", name: "Owner" },
          message: [{ type: "Plain", text: "hello" }],
          timestamp: 1767225600,
        },
      }
    : {
        uuid: "event-2",
        event_type: "bot.group_message",
        data: {
          bot_uuid: "bot-1",
          adapter_name: "lark",
          group: { id: "group-1", name: "Group" },
          sender: { id: "member-1", name: "Member" },
          message: [{ type: "Plain", text: "hello" }],
          timestamp: 1767225600,
        },
      };
}

function harness(limit = 20) {
  const db = openOrCreateMailDatabase(":memory:");
  const connections = new ChannelConnectionRepository(db);
  connections.createConnection({
    id: "connection-1",
    name: "Local",
    baseUrl: "http://127.0.0.1:5300",
    compatibilityProfile: "langbot-service-api-v4.9",
    apiSecretRef: "api-ref",
    webhookSecretRef: "webhook-ref",
    trustMode: "loopback",
  });
  connections.setConnectionCheck("connection-1", {
    compatible: true,
    enabled: true,
  });
  connections.saveProfile({
    id: "profile-1",
    connectionId: "connection-1",
    botUuid: "bot-1",
    platform: "feishu",
    displayName: "飞书助手",
    adapterName: "lark",
  });
  const app = createChannelWebhookApp({
    connections,
    inbound: new ChannelInboundRepository(db),
    webhookSecrets: {
      getWebhookSecret: () => "expected-secret",
    },
    audit: new ChannelAuditRepository(db),
    rateLimiter: new ChannelSenderRateLimiter(limit, 60_000, () => 0),
  });
  const request = (
    body: unknown,
    options: { secret?: string; raw?: string } = {},
  ) =>
    app.request("/langbot/connection-1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.secret
          ? { "x-wemail-webhook-secret": options.secret }
          : {}),
      },
      body: options.raw ?? JSON.stringify(body),
    });
  return { db, request };
}

test("accepts authenticated personal and group events and skips LangBot pipeline", async () => {
  const h = harness();
  for (const kind of ["person", "group"] as const) {
    const started = Date.now();
    const response = await h.request(fixture(kind), {
      secret: "expected-secret",
    });
    assert.equal(response.status, 200);
    assert.ok(Date.now() - started < 5_000);
    assert.deepEqual(await response.json(), {
      status: "ok",
      skip_pipeline: true,
      duplicate: false,
    });
  }
});

test("acknowledges duplicate UUID without creating duplicate work", async () => {
  const h = harness();
  await h.request(fixture(), { secret: "expected-secret" });
  const response = await h.request(fixture(), { secret: "expected-secret" });
  assert.deepEqual(await response.json(), {
    status: "ok",
    skip_pipeline: true,
    duplicate: true,
  });
  const count = h.db
    .prepare("SELECT COUNT(*) count FROM channel_inbound_events")
    .get() as { count: number };
  assert.equal(count.count, 1);
});

test("rejects missing or invalid credentials without persisting events", async () => {
  const h = harness();
  assert.equal((await h.request(fixture())).status, 401);
  assert.equal(
    (
      await h.request(fixture(), {
        secret: "wrong-secret",
      })
    ).status,
    401,
  );
  const count = h.db
    .prepare("SELECT COUNT(*) count FROM channel_inbound_events")
    .get() as { count: number };
  assert.equal(count.count, 0);
});

test("rejects malformed, unsupported, oversized, and rate-limited input", async () => {
  const h = harness(1);
  assert.equal(
    (
      await h.request(null, {
        secret: "expected-secret",
        raw: "{",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await h.request(
        { ...fixture(), event_type: "bot.other" },
        { secret: "expected-secret" },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await h.request(
        { oversized: "x".repeat(LANGBOT_MAX_WEBHOOK_BYTES) },
        { secret: "expected-secret" },
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await h.request(
        { ...fixture(), uuid: "limited-1" },
        { secret: "expected-secret" },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await h.request(
        { ...fixture(), uuid: "limited-2" },
        { secret: "expected-secret" },
      )
    ).status,
    429,
  );
});

test("rejects events for disabled connections", async () => {
  const h = harness();
  h.db
    .prepare("UPDATE langbot_connections SET enabled = 0 WHERE id = ?")
    .run("connection-1");
  assert.equal(
    (
      await h.request(fixture(), {
        secret: "expected-secret",
      })
    ).status,
    401,
  );
});
