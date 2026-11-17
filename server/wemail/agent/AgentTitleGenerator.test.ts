import assert from "node:assert/strict";
import { test } from "node:test";
import { LlmRuntime } from "../ai/LlmRuntime.js";
import { AgentTitleGenerator } from "./AgentTitleGenerator.js";

test("AgentTitleGenerator reads the model configured after construction", async () => {
  const requestedModels: string[] = [];
  const runtime = new LlmRuntime({
    initialSettings: null,
    buildClient: () => ({
      async generate(input) {
        requestedModels.push(input.model);
        return { text: "Project update", finishReason: "stop" };
      },
    }),
  });
  const titles: string[] = [];
  const generator = new AgentTitleGenerator({
    conversations: {
      get: () => ({ id: "conversation-1", title: "A long placeholder title that must be replaced..." }),
      listMessages: () => [
        { role: "user", body: { text: "Please summarize the project update" } },
        { role: "assistant", body: { text: "I can help with that." } },
      ],
      setTitle: (_id: string, title: string) => titles.push(title),
    } as never,
    llmRuntime: runtime,
  });

  runtime.replace({
    provider: "openai",
    apiKey: "test-key",
    defaultModel: "title-model",
  });

  await generator.maybeGenerate("conversation-1");

  assert.deepEqual(requestedModels, ["title-model"]);
  assert.deepEqual(titles, ["Project update"]);
});
