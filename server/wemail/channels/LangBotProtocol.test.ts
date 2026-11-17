import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LangBotPayloadError,
  parseLangBotWebhook,
  stableChannelPeerKey,
} from "./LangBotProtocol.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8")) as unknown;

test("normalizes a personal message with a stable peer key", () => {
  const event = parseLangBotWebhook(
    readFixture("person-message.v4.9.7.json"),
    "connection-1",
  );
  assert.equal(event.platform, "feishu");
  assert.equal(event.chatKind, "person");
  assert.equal(event.chatId, "ou_owner_1");
  assert.equal(event.text, "查看今天的重要邮件");
  assert.equal(
    event.peerKey,
    stableChannelPeerKey({
      connectionId: "connection-1",
      botUuid: event.botUuid,
      platform: "feishu",
      chatKind: "person",
      chatId: "ou_owner_1",
      senderId: "ou_owner_1",
    }),
  );
});

test("normalizes group sender scope and mention metadata", () => {
  const event = parseLangBotWebhook(
    readFixture("group-message.v4.9.7.json"),
    "connection-1",
  );
  assert.equal(event.platform, "wecom");
  assert.equal(event.chatKind, "group");
  assert.equal(event.chatId, "wr_group_1");
  assert.equal(event.senderId, "wm_user_1");
  assert.equal(event.mentionedBot, true);
});

test("represents unsupported elements without downloading them", () => {
  const fixture = readFixture("person-message.v4.9.7.json") as {
    data: { message: unknown[] };
  };
  fixture.data.message.push({ type: "Image", url: "https://invalid.example/file" });
  const event = parseLangBotWebhook(fixture, "connection-1");
  assert.deepEqual(event.message.at(-1), {
    type: "unsupported",
    sourceType: "Image",
    text: "[不支持的消息元素：Image]",
  });
});

test("rejects unsupported events, adapters, and invalid payloads", () => {
  assert.throws(
    () => parseLangBotWebhook({ uuid: "x", event_type: "other", data: {} }, "c"),
    (error) =>
      error instanceof LangBotPayloadError && error.code === "unsupported-event",
  );
  const fixture = readFixture("person-message.v4.9.7.json") as {
    data: { adapter_name: string };
  };
  fixture.data.adapter_name = "telegram";
  assert.throws(
    () => parseLangBotWebhook(fixture, "c"),
    (error) =>
      error instanceof LangBotPayloadError && error.code === "unsupported-adapter",
  );
  assert.throws(() => parseLangBotWebhook(null, "c"), LangBotPayloadError);
});
