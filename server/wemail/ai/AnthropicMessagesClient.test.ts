import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnthropicMessagesClient } from "./AnthropicMessagesClient.js";
import { LlmClientError } from "./LlmClient.js";

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  redirect?: RequestInit["redirect"];
}

function makeFakeFetch(
  response: { status?: number; json?: unknown; throwErr?: unknown },
  captured: CapturedCall[],
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    if (response.throwErr) throw response.throwErr;
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    captured.push({
      url: String(url),
      headers: (init?.headers as Record<string, string>) ?? {},
      redirect: init?.redirect,
      body: bodyStr ? JSON.parse(bodyStr) : {},
    });
    return new Response(JSON.stringify(response.json ?? {}), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function makeSequenceFetch(
  responses: Array<{ status?: number; json: unknown }>,
  captured: CapturedCall[],
): typeof fetch {
  let index = 0;
  return (async (url: string | URL, init?: RequestInit) => {
    const response = responses[index];
    index += 1;
    if (!response) throw new Error("unexpected fetch call");
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    captured.push({
      url: String(url),
      headers: (init?.headers as Record<string, string>) ?? {},
      redirect: init?.redirect,
      body: bodyStr ? JSON.parse(bodyStr) : {},
    });
    return new Response(JSON.stringify(response.json), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

test("Anthropic adapter times out while reading a stalled response body", async () => {
  const fetchImpl: typeof fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted"))); },
  }), { status: 200 });
  const client = createAnthropicMessagesClient({ apiKey: "sk", fetch: fetchImpl, timeoutMs: 25 });
  await assert.rejects(() => client.generate({ model: "model", messages: [{ role: "user", content: "q" }] }),
    (error: unknown) => error instanceof LlmClientError && error.code === "TIMEOUT");
});

test("Anthropic adapter lifts system messages to top-level system", async () => {
  const captured: CapturedCall[] = [];
  const client = createAnthropicMessagesClient({
    apiKey: "anthropic-test",
    fetch: makeFakeFetch(
      {
        json: {
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 4, output_tokens: 2 },
        },
      },
      captured,
    ),
  });

  const res = await client.generate({
    model: "claude-3-5-haiku-latest",
    system: "top-level",
    messages: [
      { role: "system", content: "also-system" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yes" },
      { role: "user", content: "again" },
    ],
  });

  assert.equal(res.text, "hello");
  assert.equal(res.finishReason, "stop");

  assert.equal(captured.length, 1);
  const [call] = captured;
  assert.equal(call.url, "https://api.anthropic.com/v1/messages");
  assert.equal(call.redirect, "error");
  assert.equal(call.headers["x-api-key"], "anthropic-test");
  assert.equal(call.headers["anthropic-version"], "2023-06-01");
  assert.equal(call.body.system, "top-level\n\nalso-system");

  const messages = call.body.messages as Array<{ role: string }>;
  assert.equal(messages.length, 3);
  for (const m of messages) assert.notEqual(m.role, "system");
});

test("Anthropic adapter implements jsonSchema via forced tool_use", async () => {
  const captured: CapturedCall[] = [];
  const client = createAnthropicMessagesClient({
    apiKey: "k",
    fetch: makeFakeFetch(
      {
        json: {
          content: [
            {
              type: "tool_use",
              name: "structured_output",
              input: { bullets: ["a", "b", "c"], actionItems: [], urgency: "low" },
            },
          ],
          stop_reason: "tool_use",
        },
      },
      captured,
    ),
  });

  const res = await client.generate({
    model: "claude-3-5-sonnet-latest",
    messages: [{ role: "user", content: "u" }],
    jsonSchema: { type: "object", properties: { urgency: { type: "string" } } },
  });

  assert.equal(res.finishReason, "tool-use");
  assert.equal(res.structuredOutputMode, "native");
  const parsed = JSON.parse(res.text);
  assert.equal(parsed.urgency, "low");
  assert.equal(parsed.bullets.length, 3);

  const body = captured[0].body as {
    tools: Array<{ name: string; input_schema: unknown }>;
    tool_choice: { type: string; name: string };
  };
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].name, "structured_output");
  assert.deepEqual(body.tools[0].input_schema, {
    type: "object",
    properties: { urgency: { type: "string" } },
  });
  assert.equal(body.tool_choice.name, "structured_output");
});

test("Anthropic adapter disables DeepSeek thinking for structured output", async () => {
  const captured: CapturedCall[] = [];
  const client = createAnthropicMessagesClient({
    baseUrl: "https://api.deepseek.com/anthropic",
    apiKey: "k",
    fetch: makeFakeFetch(
      {
        json: {
          content: [
            { type: "tool_use", name: "structured_output", input: { ok: true } },
          ],
          stop_reason: "tool_use",
        },
      },
      captured,
    ),
  });

  await client.generate({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "u" }],
    jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  });

  assert.deepEqual(captured[0].body.thinking, { type: "disabled" });
});

test("Anthropic adapter shares JSON-text fallback across structured-output callers for a model", async () => {
  const captured: CapturedCall[] = [];
  const structuredResponse = {
    content: [{
      type: "tool_use",
      name: "structured_output",
      input: { urgency: "low" },
    }],
    stop_reason: "tool_use",
  };
  const thinkingResponse = {
    content: [{ type: "text", text: '{"urgency":"low"}' }],
    stop_reason: "end_turn",
  };
  const otherFeatureResponse = {
    content: [{ type: "text", text: '{"description":"build report"}' }],
    stop_reason: "end_turn",
  };
  const client = createAnthropicMessagesClient({
    apiKey: "k",
    fetch: makeSequenceFetch([
      {
        status: 400,
        json: {
          error: {
            type: "invalid_request_error",
            message: "Thinking mode does not support this tool_choice",
          },
        },
      },
      { json: thinkingResponse },
      { json: otherFeatureResponse },
      { json: structuredResponse },
    ], captured),
  });
  const request = {
    messages: [{ role: "user" as const, content: "u" }],
    jsonSchema: { type: "object", properties: { urgency: { type: "string" } } },
  };

  const firstFeature = await client.generate({ ...request, model: "thinking-model" });
  const otherFeature = await client.generate({
    model: "thinking-model",
    messages: [{ role: "user", content: "create smart tag" }],
    jsonSchema: { type: "object", properties: { description: { type: "string" } } },
  });
  const differentModel = await client.generate({ ...request, model: "different-model" });

  assert.equal(firstFeature.structuredOutputMode, "json-text");
  assert.equal(otherFeature.structuredOutputMode, "json-text");
  assert.equal(differentModel.structuredOutputMode, "native");

  assert.equal(captured.length, 4);
  assert.deepEqual(captured[0].body.tool_choice, {
    type: "tool",
    name: "structured_output",
  });
  assert.equal(captured[1].body.tool_choice, undefined);
  assert.equal(captured[1].body.tools, undefined);
  assert.match(String(captured[1].body.system), /Return exactly one JSON value/);
  assert.match(String(captured[1].body.system), /"urgency"/);
  assert.equal(captured[2].body.tool_choice, undefined);
  assert.equal(captured[2].body.tools, undefined);
  assert.deepEqual(captured[3].body.tool_choice, {
    type: "tool",
    name: "structured_output",
  });

  // LlmRuntime.replace() constructs a new adapter on settings changes, so the
  // same model is probed again after the user saves an updated configuration.
  const freshCaptured: CapturedCall[] = [];
  const freshClient = createAnthropicMessagesClient({
    apiKey: "k",
    fetch: makeSequenceFetch([{ json: structuredResponse }], freshCaptured),
  });
  const freshResponse = await freshClient.generate({ ...request, model: "thinking-model" });
  assert.equal(freshResponse.structuredOutputMode, "native");
  assert.deepEqual(freshCaptured[0].body.tool_choice, {
    type: "tool",
    name: "structured_output",
  });
});

test("Anthropic adapter returns truncated structured text for feature-level recovery", async () => {
  const client = createAnthropicMessagesClient({
    apiKey: "k",
    fetch: makeSequenceFetch([
      {
        status: 400,
        json: { error: { type: "invalid_request_error", message: "tools are not supported" } },
      },
      {
        json: {
          content: [{ type: "text", text: '{"headline":"usable","actions":["unfinished' }],
          stop_reason: "max_tokens",
          usage: { input_tokens: 5, output_tokens: 100 },
        },
      },
    ], []),
  });

  const response = await client.generate({
    model: "thinking-model",
    messages: [{ role: "user", content: "u" }],
    jsonSchema: { type: "object", properties: { headline: { type: "string" } } },
  });

  assert.equal(response.finishReason, "length");
  assert.equal(response.text, '{"headline":"usable","actions":["unfinished');
  assert.deepEqual(response.usage, { inputTokens: 5, outputTokens: 100 });
});

test("Anthropic adapter accepts JSON text from thinking fallback", async () => {
  const captured: CapturedCall[] = [];
  const client = createAnthropicMessagesClient({
    apiKey: "k",
    fetch: makeSequenceFetch([
      {
        status: 400,
        json: {
          error: {
            type: "invalid_request_error",
            message: "Thinking mode does not support this tool_choice",
          },
        },
      },
      {
        json: {
          content: [{ type: "text", text: '{"urgency":"low"}' }],
          stop_reason: "end_turn",
        },
      },
    ], captured),
  });

  const response = await client.generate({
    model: "thinking-model",
    messages: [{ role: "user", content: "u" }],
    jsonSchema: { type: "object", properties: { urgency: { type: "string" } } },
  });

  assert.deepEqual(JSON.parse(response.text), { urgency: "low" });
  assert.equal(response.finishReason, "stop");
  assert.equal(response.structuredOutputMode, "json-text");
});

test("Anthropic adapter recognizes proxy string errors for thinking fallback", async () => {
  const captured: CapturedCall[] = [];
  const client = createAnthropicMessagesClient({
    apiKey: "k",
    fetch: makeSequenceFetch([
      {
        status: 400,
        json: {
          error: "Error from provider (Console Go): Upstream request failed: [invalid_request_error] Thinking mode does not support this tool-choice",
        },
      },
      {
        json: {
          content: [{ type: "text", text: '{"urgency":"low"}' }],
          stop_reason: "end_turn",
        },
      },
    ], captured),
  });

  const response = await client.generate({
    model: "thinking-model",
    messages: [{ role: "user", content: "u" }],
    jsonSchema: { type: "object", properties: { urgency: { type: "string" } } },
  });

  assert.deepEqual(JSON.parse(response.text), { urgency: "low" });
  assert.equal(response.structuredOutputMode, "json-text");
  assert.equal(captured[0].body.tool_choice !== undefined, true);
  assert.equal(captured[1].body.tool_choice, undefined);
});

test("Anthropic adapter falls back when a gateway requires string tool_choice", async () => {
  const captured: CapturedCall[] = [];
  const client = createAnthropicMessagesClient({
    apiKey: "k",
    fetch: makeSequenceFetch([
      {
        status: 400,
        json: {
          error: "Unmarshal chat params failed with error: json: cannot unmarshal object into Go struct field Request.tool_choice of type string",
        },
      },
      {
        json: {
          content: [{ type: "text", text: '```json\n{"urgency":"low"}\n```' }],
          stop_reason: "end_turn",
        },
      },
      {
        json: {
          content: [{ type: "text", text: '```\n{"description":"build report"}\n```' }],
          stop_reason: "end_turn",
        },
      },
    ], captured),
  });

  const response = await client.generate({
    model: "hy3",
    messages: [{ role: "user", content: "u" }],
    jsonSchema: { type: "object", properties: { urgency: { type: "string" } } },
  });
  const cachedResponse = await client.generate({
    model: "hy3",
    messages: [{ role: "user", content: "create smart tag" }],
    jsonSchema: { type: "object", properties: { description: { type: "string" } } },
  });

  assert.deepEqual(JSON.parse(response.text), { urgency: "low" });
  assert.deepEqual(JSON.parse(cachedResponse.text), { description: "build report" });
  assert.equal(response.text, '{"urgency":"low"}');
  assert.equal(cachedResponse.text, '{"description":"build report"}');
  assert.equal(response.structuredOutputMode, "json-text");
  assert.equal(cachedResponse.structuredOutputMode, "json-text");
  assert.equal(captured.length, 3);
  assert.equal(captured[0].body.tool_choice !== undefined, true);
  assert.equal(captured[1].body.tool_choice, undefined);
  assert.equal(captured[1].body.tools, undefined);
  assert.equal(captured[2].body.tool_choice, undefined);
  assert.equal(captured[2].body.tools, undefined);
});

test("Anthropic adapter repairs a schema-mismatched tool result with JSON text", async () => {
  const captured: CapturedCall[] = [];
  const client = createAnthropicMessagesClient({
    apiKey: "k",
    fetch: makeSequenceFetch([
      {
        json: {
          content: [{ type: "tool_use", name: "structured_output", input: { ok: "yes" } }],
          stop_reason: "tool_use",
        },
      },
      {
        json: {
          content: [{ type: "text", text: '```json\n{"ok":true}\n```' }],
          stop_reason: "end_turn",
        },
      },
    ], captured),
  });

  const response = await client.generate({
    model: "model",
    messages: [{ role: "user", content: "q" }],
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    },
  });

  assert.equal(response.text, '{"ok":true}');
  assert.equal(response.structuredOutputMode, "json-text");
  assert.equal(captured.length, 2);
  assert.equal(captured[0].body.tool_choice !== undefined, true);
  assert.equal(captured[1].body.tool_choice, undefined);
  assert.equal(captured[1].body.tools, undefined);
});

test("Anthropic adapter throws LlmClientError on non-2xx", async () => {
  const client = createAnthropicMessagesClient({
    apiKey: "k",
    fetch: makeFakeFetch(
      {
        status: 500,
        json: { error: { type: "api_error", message: "server broke" } },
      },
      [],
    ),
  });

  await assert.rejects(
    () =>
      client.generate({
        model: "claude-3-5-haiku-latest",
        messages: [{ role: "user", content: "x" }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal(err.status, 500);
      assert.equal(err.code, "api_error");
      return true;
    },
  );
});

test("Anthropic adapter honors custom baseUrl", async () => {
  const captured: CapturedCall[] = [];
  const client = createAnthropicMessagesClient({
    apiKey: "k",
    baseUrl: "https://proxy.example.com/",
    fetch: makeFakeFetch(
      {
        json: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
      },
      captured,
    ),
  });
  await client.generate({
    model: "claude-3-5-haiku-latest",
    messages: [{ role: "user", content: "q" }],
  });
  assert.equal(captured[0].url, "https://proxy.example.com/v1/messages");
});
