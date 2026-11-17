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
    message: "模型服务请求受限，请检查额度或稍后重试。",
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

test("LlmRuntime health excludes untrusted provider error details", () => {
  const runtime = new LlmRuntime({ initialSettings: settings(), buildClient: () => client("configured") });
  const health = runtime.recordFailure(Object.assign(new Error("secret-key and private mail"), {
    code: "secret-key", detail: "private mail", status: 503,
  }));
  assert.equal(health.lastError?.code, "HTTP_503");
  assert.doesNotMatch(JSON.stringify(health), /secret-key|private mail/);
});

test("LlmRuntime health preserves safe timeout and response size codes", () => {
  const runtime = new LlmRuntime({ initialSettings: settings(), buildClient: () => client("configured") });
  assert.equal(runtime.recordFailure({ code: "TIMEOUT", message: "private response" }).lastError?.code, "TIMEOUT");
  const tooLarge = runtime.recordFailure({ code: "RESPONSE_TOO_LARGE", message: "private response" });
  assert.equal(tooLarge.lastError?.code, "RESPONSE_TOO_LARGE");
  assert.match(tooLarge.lastError?.message ?? "", /响应过大/);
  assert.doesNotMatch(JSON.stringify(tooLarge), /private response/);
});
