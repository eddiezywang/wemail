import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmClient } from "./LlmClient.js";
import { LlmRuntime } from "./LlmRuntime.js";

function settings(overrides: Partial<{
  provider: "openai" | "anthropic";
  defaultModel: string;
  draftModel: string;
  summaryModel: string;
  agentModel: string;
}> = {}) {
  return {
    provider: "openai" as const,
    apiKey: "test-key",
    defaultModel: "model-default",
    ...overrides,
  };
}

function client(name: string): LlmClient {
  return {
    async generate() {
      return { text: name, finishReason: "stop" as const };
    },
  };
}

test("LlmRuntime exposes configuration and resolves each lane", () => {
  const configuredClient = client("configured");
  const runtime = new LlmRuntime({
    initialSettings: settings({
      draftModel: "model-draft",
      summaryModel: "model-summary",
      agentModel: "model-agent",
    }),
    buildClient: () => configuredClient,
  });

  const snapshot = runtime.snapshot();

  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.client, configuredClient);
  assert.equal(snapshot.provider, "openai");
  assert.equal(snapshot.modelFor("default"), "model-default");
  assert.equal(snapshot.modelFor("draft"), "model-draft");
  assert.equal(snapshot.modelFor("summary"), "model-summary");
  assert.equal(snapshot.modelFor("agent"), "model-agent");
});

test("LlmRuntime preserves an acquired snapshot across replacement", () => {
  const clientA = client("A");
  const clientB = client("B");
  const runtime = new LlmRuntime({
    initialSettings: settings({ defaultModel: "model-A" }),
    buildClient: (config) => config.defaultModel === "model-A" ? clientA : clientB,
  });

  const before = runtime.snapshot();
  const after = runtime.replace(settings({ defaultModel: "model-B" }));

  assert.equal(before.client, clientA);
  assert.equal(before.modelFor("draft"), "model-A");
  assert.equal(after.client, clientB);
  assert.equal(after.modelFor("draft"), "model-B");
  assert.equal(runtime.snapshot(), after);
  assert.ok(after.generation > before.generation);
});

test("LlmRuntime publishes an unavailable snapshot when client construction fails", () => {
  const clientA = client("A");
  const runtime = new LlmRuntime({
    initialSettings: settings({ defaultModel: "model-A" }),
    buildClient: (config) => {
      if (config.defaultModel === "model-B") {
        throw new Error("invalid credentials");
      }
      return clientA;
    },
  });
  const before = runtime.snapshot();

  const after = runtime.replace(settings({ defaultModel: "model-B" }));

  assert.equal(before.configured, true);
  assert.equal(before.client, clientA);
  assert.equal(after.configured, false);
  assert.equal(after.client, undefined);
  assert.equal(after.modelFor("default"), undefined);
  assert.equal(runtime.snapshot(), after);
});

test("LlmRuntime records the latest model transport error and clears it on replacement", () => {
  const runtime = new LlmRuntime({
    initialSettings: settings(),
    buildClient: () => client("configured"),
  });

  const health = runtime.recordFailure(Object.assign(new Error("rate limited"), {
    code: "rate_limited",
    status: 429,
  }));
  assert.equal(health.availability, "unreachable");
  assert.deepEqual(health.lastError, {
    code: "rate_limited",
    status: 429,
    message: "rate limited",
    occurredAt: health.lastError?.occurredAt,
  });

  runtime.recordSuccess();
  assert.equal(runtime.health().availability, "available");
  assert.equal(runtime.health().lastError?.status, 429);

  runtime.replace(settings({ defaultModel: "new-model" }));
  assert.deepEqual(runtime.health(), {
    availability: "unknown",
    lastError: null,
    lastSuccessAt: null,
  });
});
