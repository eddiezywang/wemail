import assert from "node:assert/strict";
import test from "node:test";
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
} from "../ai/LlmClient.js";
import {
  buildChannelAgentSystemPrompt,
  CHANNEL_AGENT_SYSTEM_PROMPT,
  CHANNEL_DIRECT_OWNER_SEND_POLICY,
  CHANNEL_GROUP_SYSTEM_PROMPT,
} from "./ChannelAgentPolicy.js";
import { createDefaultPlanner } from "./PiAgentRuntime.js";

test("channel policy is added only for supported bot channel contexts", () => {
  assert.equal(buildChannelAgentSystemPrompt(undefined), undefined);
  assert.equal(
    buildChannelAgentSystemPrompt({ channel: { platform: "slack" } }),
    undefined,
  );
  assert.equal(
    buildChannelAgentSystemPrompt({
      channel: { platform: "feishu", chatKind: "person" },
    }),
    CHANNEL_AGENT_SYSTEM_PROMPT,
  );
});

test("group channel policy adds a strict mailbox privacy boundary", () => {
  const prompt = buildChannelAgentSystemPrompt({
    channel: { platform: "wecom", chatKind: "group" },
  });
  assert.ok(prompt);
  assert.match(prompt, /recentConversation/);
  assert.match(prompt, /direct chat/);
  assert.match(prompt, /Do not disclose email bodies/);
  assert.match(prompt, new RegExp(CHANNEL_GROUP_SYSTEM_PROMPT.split("\n")[0]!));
});

test("verified WeCom owner direct chat preauthorizes send without app confirmation", () => {
  const prompt = buildChannelAgentSystemPrompt({
    channel: {
      platform: "wecom",
      chatKind: "person",
      directOwnerSendAuthorized: true,
    },
  });
  assert.ok(prompt);
  assert.match(
    prompt,
    new RegExp(CHANNEL_DIRECT_OWNER_SEND_POLICY.split("\n")[0]!),
  );
  assert.match(prompt, /save_mail_draft/);
  assert.match(prompt, /two separate chat turns/);
  assert.match(prompt, /Never ask the owner to confirm in the WeMail application/);
  assert.doesNotMatch(
    buildChannelAgentSystemPrompt({
      channel: {
        platform: "wecom",
        chatKind: "group",
        directOwnerSendAuthorized: true,
      },
    })!,
    /DIRECT WECOM OWNER SEND AUTHORIZATION/,
  );
});

test("default planner appends the channel policy to the actual system prompt", async () => {
  let capturedSystem = "";
  const llm: LlmClient = {
    async generate(input: LlmRequest): Promise<LlmResponse> {
      capturedSystem = input.system ?? "";
      return { text: '{"final":"done"}', finishReason: "stop" };
    },
  };
  const planner = createDefaultPlanner({ llm, model: "test" });
  await planner.step({
    userText: "继续",
    context: { channel: { platform: "wecom", chatKind: "group" } },
    tools: [],
    history: [],
  });
  assert.match(capturedSystem, /CHANNEL CHAT POLICY/);
  assert.match(capturedSystem, /GROUP CHAT PRIVACY/);
});
