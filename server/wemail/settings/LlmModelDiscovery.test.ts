import assert from "node:assert/strict";
import test from "node:test";
import {
  detectLocalGateway,
  LOCAL_GATEWAY_BASE_URL,
} from "./LlmModelDiscovery.js";

test("detectLocalGateway reports a reachable gateway with parsed models", async () => {
  const calls: Array<{ url: string; method: string; aborted: boolean }> = [];
  const result = await detectLocalGateway(async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      aborted: init?.signal?.aborted === true,
    });
    return Response.json({
      object: "list",
      data: [
        { id: "deepseek-v4-flash", owned_by: "sub2agent" },
        { id: "deepseek-v4-flash", owned_by: "sub2agent" },
        { id: "deepseek-v3.1", owned_by: "sub2agent" },
      ],
    });
  });

  assert.deepEqual(calls, [
    { url: `${LOCAL_GATEWAY_BASE_URL}/models`, method: "GET", aborted: false },
  ]);
  assert.equal(result.reachable, true);
  assert.equal(result.baseUrl, LOCAL_GATEWAY_BASE_URL);
  assert.equal(result.provider, "openai");
  assert.equal(result.requiresAuth, undefined);
  assert.deepEqual(result.models, [
    { id: "deepseek-v3.1", ownedBy: "sub2agent" },
    { id: "deepseek-v4-flash", ownedBy: "sub2agent" },
  ]);
});

test("detectLocalGateway marks an auth-challenged gateway as reachable", async () => {
  const result = await detectLocalGateway(async () =>
    new Response("Unauthorized", { status: 401 }),
  );

  assert.deepEqual(result, {
    reachable: true,
    baseUrl: LOCAL_GATEWAY_BASE_URL,
    requiresAuth: true,
    provider: "openai",
  });
});

test("detectLocalGateway reports unreachable on network errors and timeouts", async () => {
  const network = await detectLocalGateway(async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8989");
  });
  assert.deepEqual(network, { reachable: false });

  const timeout = await detectLocalGateway((_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        (error as Error & { name: string }).name = "AbortError";
        reject(error);
      });
    });
  });
  assert.deepEqual(timeout, { reachable: false });
});

test("detectLocalGateway tolerates non-JSON or unexpected model lists", async () => {
  const nonJson = await detectLocalGateway(async () =>
    new Response("html", { status: 200 }),
  );
  assert.equal(nonJson.reachable, true);
  assert.equal(nonJson.models, undefined);

  const badShape = await detectLocalGateway(async () =>
    Response.json({ not: "a model list" }),
  );
  assert.equal(badShape.reachable, true);
  assert.equal(badShape.models, undefined);
});
