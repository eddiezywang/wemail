import assert from "node:assert/strict";
import test from "node:test";
import type { SessionTarget } from "@qwen-code/channel-base";
import {
  deliverFeishuMessage,
  FeishuReactionManager,
  type FeishuReactionApi,
  WecomDuplicateKickPolicy,
} from "./channels.js";

test("Feishu delivery routes people by open_id and groups by chat_id", async () => {
  const calls: Array<{ target: SessionTarget; text: string }> = [];
  const deliver = async (target: SessionTarget, text: string) => {
    calls.push({ target, text });
  };

  await deliverFeishuMessage(
    deliver,
    "wemail-feishu-profile-1",
    "person",
    "ou_owner_1",
    "person message",
  );
  await deliverFeishuMessage(
    deliver,
    "wemail-feishu-profile-1",
    "group",
    "oc_group_1",
    "group message",
  );

  assert.deepEqual(calls, [
    {
      target: {
        channelName: "wemail-feishu-profile-1",
        senderId: "ou_owner_1",
        chatId: "ou_owner_1",
        isGroup: false,
      },
      text: "person message",
    },
    {
      target: {
        channelName: "wemail-feishu-profile-1",
        senderId: "oc_group_1",
        chatId: "oc_group_1",
        isGroup: true,
      },
      text: "group message",
    },
  ]);
});

test("Feishu delivery propagates platform rejection", async () => {
  await assert.rejects(
    () =>
      deliverFeishuMessage(
        async () => {
          throw new Error("platform rejected delivery");
        },
        "wemail-feishu-profile-1",
        "person",
        "ou_owner_1",
        "test",
      ),
    /platform rejected delivery/,
  );
});

test("FeishuReactionManager adds and removes the bot's native reaction", async () => {
  const calls: Array<{ operation: "create" | "delete"; input: unknown }> = [];
  const api: FeishuReactionApi = {
    create: async (input) => {
      calls.push({ operation: "create", input });
      return { code: 0, data: { reaction_id: "reaction-1" } };
    },
    delete: async (input) => {
      calls.push({ operation: "delete", input });
      return { code: 0 };
    },
  };
  const reactions = new FeishuReactionManager(api);

  await reactions.setReaction("om-message-1", "OnIt", "add");
  await reactions.setReaction("om-message-1", "OnIt", "add");
  await reactions.setReaction("om-message-1", "OnIt", "remove");

  assert.deepEqual(calls, [
    {
      operation: "create",
      input: {
        path: { message_id: "om-message-1" },
        data: { reaction_type: { emoji_type: "OnIt" } },
      },
    },
    {
      operation: "delete",
      input: {
        path: {
          message_id: "om-message-1",
          reaction_id: "reaction-1",
        },
      },
    },
  ]);
});

test("FeishuReactionManager reports platform failures", async () => {
  const api: FeishuReactionApi = {
    create: async () => ({ code: 230001 }),
    delete: async () => ({ code: 0 }),
  };

  await assert.rejects(
    () =>
      new FeishuReactionManager(api).setReaction(
        "om-message-1",
        "OnIt",
        "add",
      ),
    /feishu-reaction-add-failed:230001/,
  );
});

test("WecomDuplicateKickPolicy only fails once kicks exceed the limit inside the window", () => {
  let now = 1_000;
  const policy = new WecomDuplicateKickPolicy(4, 90_000, () => now);

  // Up to the limit (4) inside the window stays tolerant — transient blips
  // and a couple of reconnect-after-kick cycles must not trip a failure.
  for (let i = 0; i < 4; i += 1) {
    assert.equal(policy.registerServerKick().fail, false);
  }
  // The next kick inside the same window crosses the line -> failure.
  assert.equal(policy.registerServerKick().fail, true);
});

test("WecomDuplicateKickPolicy resets the streak once the window elapses", () => {
  let now = 1_000;
  const policy = new WecomDuplicateKickPolicy(4, 90_000, () => now);

  for (let i = 0; i < 4; i += 1) {
    assert.equal(policy.registerServerKick().fail, false);
  }
  // Enough time passes that a fresh burst is treated as a new incident.
  now += 91_000;
  for (let i = 0; i < 4; i += 1) {
    assert.equal(policy.registerServerKick().fail, false);
  }
  assert.equal(policy.registerServerKick().fail, true);
});
