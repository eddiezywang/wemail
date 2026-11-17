import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import { ChannelInboundRepository } from "./ChannelLedgerRepository.js";
import {
  BotChannelRuntime,
  BotChannelTransportError,
} from "./BotChannelRuntime.js";

test("BotChannelRuntime forwards the explicit delivery target type", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => new Date("2026-07-31T00:00:00.000Z");
  const runtime = new BotChannelRuntime(
    new ChannelInboundRepository(db, now),
    new ChannelConnectionRepository(db, now),
  );
  const calls: unknown[] = [];
  runtime.attachTransport({
    send: async (input) => {
      calls.push(input);
    },
    setReaction: async () => {},
    probe: async () => {},
  });

  await runtime.send({
    profileId: "profile-feishu",
    targetType: "person",
    targetId: "ou_owner_1",
    text: "test",
  });

  assert.deepEqual(calls, [
    {
      profileId: "profile-feishu",
      targetType: "person",
      targetId: "ou_owner_1",
      text: "test",
    },
  ]);
});

test("BotChannelRuntime forwards native reaction operations to Bot Core", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => new Date("2026-07-31T00:00:00.000Z");
  const runtime = new BotChannelRuntime(
    new ChannelInboundRepository(db, now),
    new ChannelConnectionRepository(db, now),
  );
  const calls: unknown[] = [];
  runtime.attachTransport({
    send: async () => {},
    setReaction: async (input) => {
      calls.push(input);
    },
    probe: async () => {},
  });

  await runtime.setReaction({
    profileId: "profile-feishu",
    messageId: "om_message",
    emojiType: "OnIt",
    action: "add",
  });

  assert.deepEqual(calls, [
    {
      profileId: "profile-feishu",
      messageId: "om_message",
      emojiType: "OnIt",
      action: "add",
    },
  ]);
});

test("BotChannelRuntime probe rejects with a timeout when the transport never responds", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => new Date("2026-07-31T00:00:00.000Z");
  const runtime = new BotChannelRuntime(
    new ChannelInboundRepository(db, now),
    new ChannelConnectionRepository(db, now),
    undefined,
    50, // probeTimeoutMs — tiny so this regression test stays fast
  );
  runtime.attachTransport({
    send: async () => {},
    setReaction: async () => {},
    probe: () => new Promise<void>(() => {}),
  });

  await assert.rejects(
    runtime.probe("profile-stuck"),
    (error) =>
      error instanceof BotChannelTransportError &&
      error.code === "channel-connection-timeout" &&
      error.retryable === true,
  );
});
