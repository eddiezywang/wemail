import assert from "node:assert/strict";
import { test } from "node:test";
import { LlmClientError } from "./LlmClient.js";
import { createOpenAiCompatibleClient } from "./OpenAiCompatibleClient.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function makeFakeFetch(
  response: {
    status?: number;
    json?: unknown;
    throwErr?: unknown;
  },
  captured: CapturedCall[],
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    if (response.throwErr) throw response.throwErr;
    const bodyStr =
      typeof init?.body === "string" ? init.body : "";
    captured.push({
      url: String(url),
      init: init ?? {},
      body: bodyStr ? JSON.parse(bodyStr) : {},
    });
    const status = response.status ?? 200;
    return new Response(JSON.stringify(response.json ?? {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

test("OpenAI adapter posts to /v1/chat/completions with system+messages", async () => {
  const captured: CapturedCall[] = [];
  const client = createOpenAiCompatibleClient({
    baseUrl: "https://api.example.com/",
    apiKey: "sk-test",
    fetch: makeFakeFetch(
      {
        json: {
          choices: [
            { message: { content: "hi" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        },
      },
      captured,
    ),
  });

  const res = await client.generate({
    model: "gpt-4o-mini",
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0.5,
    maxTokens: 100,
  });

  assert.equal(res.text, "hi");
  assert.equal(res.finishReason, "stop");
  assert.deepEqual(res.usage, { inputTokens: 5, outputTokens: 3, totalTokens: 8 });

  assert.equal(captured.length, 1);
  const [call] = captured;
  assert.equal(call.url, "https://api.example.com/v1/chat/completions");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], "Bearer sk-test");
  assert.equal(call.body.model, "gpt-4o-mini");
  assert.equal(call.body.temperature, 0.5);
  assert.equal(call.body.max_tokens, 100);
  const messages = call.body.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ]);
});

test("OpenAI adapter accepts baseUrl values that already end with /v1", async () => {
  const captured: CapturedCall[] = [];
  const client = createOpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:8989/v1/",
    apiKey: "sk-test",
    fetch: makeFakeFetch(
      {
        json: {
          choices: [
            { message: { content: "ok" }, finish_reason: "stop" },
          ],
        },
      },
      captured,
    ),
  });

  await client.generate({
    model: "glm-5.1",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(
    captured[0].url,
    "http://127.0.0.1:8989/v1/chat/completions",
  );
});

test("OpenAI adapter falls back to root /chat/completions when /v1 is not exposed", async () => {
  const captured: CapturedCall[] = [];
  const client = createOpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:8317",
    apiKey: "sk-test",
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "";
      captured.push({
        url: String(url),
        init: init ?? {},
        body: bodyStr ? JSON.parse(bodyStr) : {},
      });
      if (String(url).endsWith("/v1/chat/completions")) {
        return new Response(JSON.stringify({ error: { message: "not found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });

  const res = await client.generate({
    model: "gpt-5.3-codex-spark",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(res.text, "OK");
  assert.deepEqual(
    captured.map((call) => call.url),
    [
      "http://127.0.0.1:8317/v1/chat/completions",
      "http://127.0.0.1:8317/chat/completions",
    ],
  );
});

test("OpenAI adapter encodes jsonSchema via response_format.json_schema", async () => {
  const captured: CapturedCall[] = [];
  const client = createOpenAiCompatibleClient({
    baseUrl: "https://api.example.com",
    apiKey: "sk",
    fetch: makeFakeFetch(
      {
        json: {
          choices: [
            { message: { content: "```json\n{\"ok\":true}\n```" }, finish_reason: "stop" },
          ],
        },
      },
      captured,
    ),
  });

  const response = await client.generate({
    model: "gpt-4o",
    messages: [{ role: "user", content: "q" }],
    jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  });

  const rf = captured[0].body.response_format as {
    type: string;
    json_schema: { schema: Record<string, unknown> };
  };
  assert.equal(rf.type, "json_schema");
  assert.equal(response.text, "{\"ok\":true}");
  assert.equal(response.structuredOutputMode, "native");
  assert.deepEqual(rf.json_schema.schema, {
    type: "object",
    properties: { ok: { type: "boolean" } },
  });
});

test("OpenAI adapter falls back to json_object when DeepSeek rejects json_schema", async () => {
  const captured: CapturedCall[] = [];
  const fetchImpl: typeof fetch = (async (url: string | URL, init?: RequestInit) => {
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    captured.push({
      url: String(url),
      init: init ?? {},
      body: bodyStr ? JSON.parse(bodyStr) : {},
    });
    if (captured.length === 1) {
      return Response.json(
        { error: { code: "invalid_request_error", message: "json_schema is not supported" } },
        { status: 400 },
      );
    }
    const content = captured.length >= 3
      ? '```json\n{"description":"build report"}\n```'
      : '```json\n{"ok":true}\n```';
    return Response.json({
      choices: [{ message: { content }, finish_reason: "stop" }],
    });
  }) as unknown as typeof fetch;

  const client = createOpenAiCompatibleClient({
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk",
    fetch: fetchImpl,
  });
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };

  const response = await client.generate({
    model: "deepseek-v4-flash",
    system: "Classify this message.",
    messages: [{ role: "user", content: "hello" }],
    jsonSchema: schema,
  });

  assert.equal(response.text, "{\"ok\":true}");
  assert.equal(response.structuredOutputMode, "json-text");
  assert.equal(captured.length, 2);
  assert.equal((captured[0].body.response_format as { type: string }).type, "json_schema");
  assert.equal((captured[1].body.response_format as { type: string }).type, "json_object");
  assert.deepEqual(captured[1].body.thinking, { type: "disabled" });
  const messages = captured[1].body.messages as Array<{ role: string; content: string }>;
  assert.match(messages[0].content, /Return JSON only/);
  assert.match(messages[0].content, /"properties"/);

  const otherFeatureResponse = await client.generate({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "create smart tag" }],
    jsonSchema: { type: "object", properties: { description: { type: "string" } } },
  });
  assert.equal(otherFeatureResponse.structuredOutputMode, "json-text");
  assert.equal(captured.length, 3);
  assert.equal((captured[2].body.response_format as { type: string }).type, "json_object");
});

test("OpenAI adapter falls back to prompt-only JSON when response_format is unsupported", async () => {
  const captured: CapturedCall[] = [];
  const fetchImpl: typeof fetch = (async (url: string | URL, init?: RequestInit) => {
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    captured.push({
      url: String(url),
      init: init ?? {},
      body: bodyStr ? JSON.parse(bodyStr) : {},
    });
    if (captured.length === 1) {
      return Response.json(
        { error: { message: "json_schema is not supported" } },
        { status: 400 },
      );
    }
    if (captured.length === 2) {
      return Response.json(
        { error: { message: "response_format is not supported" } },
        { status: 400 },
      );
    }
    return Response.json({
      choices: [{
        message: { content: [{ type: "text", text: '```json\n{"ok":true}\n```' }] },
        finish_reason: "stop",
      }],
    });
  }) as unknown as typeof fetch;
  const client = createOpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:8989/v1",
    apiKey: "sk",
    fetch: fetchImpl,
  });

  const response = await client.generate({
    model: "compat-model",
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
  assert.equal((captured[0].body.response_format as { type: string }).type, "json_schema");
  assert.equal((captured[1].body.response_format as { type: string }).type, "json_object");
  assert.equal(captured[2].body.response_format, undefined);
  assert.match(
    String((captured[2].body.messages as Array<{ content: string }>)[0].content),
    /follow this schema exactly/,
  );
});

test("OpenAI adapter retries a schema-mismatched 200 response without caching the downgrade", async () => {
  const captured: CapturedCall[] = [];
  const responses = [
    '{"ok":"yes"}',
    '{"ok":true}',
    '{"ok":false}',
  ];
  const client = createOpenAiCompatibleClient({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk",
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "";
      captured.push({ url: String(url), init: init ?? {}, body: JSON.parse(bodyStr) });
      return Response.json({
        choices: [{ message: { content: responses.shift() }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
    }) as unknown as typeof fetch,
  });
  const request = {
    model: "model",
    messages: [{ role: "user" as const, content: "q" }],
    jsonSchema: {
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    },
  };

  const repaired = await client.generate(request);
  const next = await client.generate(request);

  assert.equal(repaired.text, '{"ok":true}');
  assert.equal(repaired.structuredOutputMode, "json-text");
  assert.deepEqual(repaired.usage, { inputTokens: 2, outputTokens: 4, totalTokens: 6 });
  assert.equal(next.text, '{"ok":false}');
  assert.equal(next.structuredOutputMode, "native");
  assert.deepEqual(next.usage, { inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  assert.equal((captured[0].body.response_format as { type: string }).type, "json_schema");
  assert.equal((captured[1].body.response_format as { type: string }).type, "json_object");
  assert.equal((captured[2].body.response_format as { type: string }).type, "json_schema");
});

test("OpenAI adapter does not cache a request-specific schema rejection", async () => {
  const captured: CapturedCall[] = [];
  const client = createOpenAiCompatibleClient({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk",
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "";
      captured.push({ url: String(url), init: init ?? {}, body: JSON.parse(bodyStr) });
      if (captured.length === 1) {
        return Response.json(
          { error: { message: "invalid json schema: unsupported schema keyword" } },
          { status: 400 },
        );
      }
      return Response.json({
        choices: [{
          message: { content: captured.length === 2 ? '{"ok":true}' : '{"ok":false}' },
          finish_reason: "stop",
        }],
      });
    }) as unknown as typeof fetch,
  });
  const request = {
    model: "model",
    messages: [{ role: "user" as const, content: "q" }],
    jsonSchema: {
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    },
  };

  const first = await client.generate(request);
  const second = await client.generate(request);

  assert.equal(first.structuredOutputMode, "json-text");
  assert.equal(second.structuredOutputMode, "native");
  assert.equal((captured[0].body.response_format as { type: string }).type, "json_schema");
  assert.equal((captured[1].body.response_format as { type: string }).type, "json_object");
  assert.equal((captured[2].body.response_format as { type: string }).type, "json_schema");
});

test("OpenAI adapter disables thinking for deepseek-prefixed models on any endpoint", async () => {
  const captured: CapturedCall[] = [];
  const client = createOpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:8989/v1",
    apiKey: "sk",
    fetch: makeFakeFetch(
      {
        json: {
          choices: [
            { message: { content: "{\"ok\":true}" }, finish_reason: "stop" },
          ],
        },
      },
      captured,
    ),
  });

  await client.generate({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "q" }],
    jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  });

  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].body.thinking, { type: "disabled" });
  assert.equal(captured[0].body.reasoning_effort, "none");
  assert.equal(
    (captured[0].body.response_format as { type: string }).type,
    "json_schema",
  );
});

test("OpenAI adapter disables deepseek thinking on plain chat too", async () => {
  const captured: CapturedCall[] = [];
  const client = createOpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:8989/v1",
    apiKey: "sk",
    fetch: makeFakeFetch(
      {
        json: {
          choices: [
            { message: { content: "ok" }, finish_reason: "stop" },
          ],
        },
      },
      captured,
    ),
  });

  await client.generate({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "q" }],
  });

  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].body.thinking, { type: "disabled" });
  assert.equal(captured[0].body.reasoning_effort, "none");
});

test("OpenAI adapter allows reasoning_effort to be overridden or omitted", async () => {
  const lowCalls: CapturedCall[] = [];
  const lowClient = createOpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:8989/v1",
    apiKey: "sk",
    reasoningEffort: "low",
    fetch: makeFakeFetch(
      { json: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] } },
      lowCalls,
    ),
  });
  await lowClient.generate({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "q" }],
  });
  assert.equal(lowCalls[0].body.reasoning_effort, "low");
  assert.deepEqual(lowCalls[0].body.thinking, { type: "disabled" });

  const omittedCalls: CapturedCall[] = [];
  const omittedClient = createOpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:8989/v1",
    apiKey: "sk",
    reasoningEffort: "omit",
    fetch: makeFakeFetch(
      { json: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] } },
      omittedCalls,
    ),
  });
  await omittedClient.generate({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "q" }],
  });
  assert.equal(omittedCalls[0].body.reasoning_effort, undefined);
  assert.deepEqual(omittedCalls[0].body.thinking, { type: "disabled" });
});

test("OpenAI adapter falls back from unsupported reasoning_effort none to low", async () => {
  const captured: CapturedCall[] = [];
  let requestCount = 0;
  const client = createOpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:8989/v1",
    apiKey: "sk",
    reasoningEffort: "none",
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>;
      captured.push({ url: String(url), init: init ?? {}, body });
      requestCount += 1;
      if (requestCount === 1) {
        return Response.json({
          error: {
            code: "invalid_value",
            message: "reasoning_effort must be one of: low, medium, high, xhigh, max",
          },
        }, { status: 400 });
      }
      return Response.json({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      });
    }) as typeof fetch,
  });

  await client.generate({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "q" }],
  });
  await client.generate({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "q2" }],
  });

  assert.deepEqual(
    captured.map((call) => call.body.reasoning_effort),
    ["none", "low", "low"],
  );
});

test("OpenAI adapter does not send thinking controls for non-reasoning models", async () => {
  const captured: CapturedCall[] = [];
  const client = createOpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:8989/v1",
    apiKey: "sk",
    fetch: makeFakeFetch(
      {
        json: {
          choices: [
            { message: { content: "{\"ok\":true}" }, finish_reason: "stop" },
          ],
        },
      },
      captured,
    ),
  });

  await client.generate({
    model: "llama-3.3",
    messages: [{ role: "user", content: "q" }],
    jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.thinking, undefined);
});

test("OpenAI adapter minimizes reasoning for GPT-5 structured output", async () => {
  const captured: CapturedCall[] = [];
  const client = createOpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:8989/v1",
    apiKey: "sk",
    fetch: makeFakeFetch(
      {
        json: {
          choices: [
            { message: { content: "{\"ok\":true}" }, finish_reason: "stop" },
          ],
        },
      },
      captured,
    ),
  });

  await client.generate({
    model: "gpt-5.3-codex-spark",
    messages: [{ role: "user", content: "q" }],
    jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  });

  assert.equal(captured[0].body.reasoning_effort, "none");
});

test("OpenAI adapter disables thinking with each model family's supported control", async () => {
  const captured: CapturedCall[] = [];
  const client = createOpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:8989/v1",
    apiKey: "sk",
    fetch: makeFakeFetch(
      {
        json: {
          choices: [
            { message: { content: "{\"ok\":true}" }, finish_reason: "stop" },
          ],
        },
      },
      captured,
    ),
  });
  const request = {
    messages: [{ role: "user" as const, content: "q" }],
    jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  };

  for (const model of ["qwen3.6-plus", "glm-5.2", "minimax-m3", "gemini-2.5-flash"]) {
    await client.generate({ ...request, model });
  }

  assert.equal(captured[0].body.enable_thinking, false);
  assert.deepEqual(captured[1].body.thinking, { type: "disabled" });
  assert.deepEqual(captured[2].body.thinking, { type: "disabled" });
  assert.equal(captured[3].body.reasoning_effort, "none");
});

test("OpenAI adapter does not force thinking off for thinking-only models", async () => {
  const captured: CapturedCall[] = [];
  const client = createOpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:8989/v1",
    apiKey: "sk",
    fetch: makeFakeFetch(
      {
        json: {
          choices: [
            { message: { content: "{\"ok\":true}" }, finish_reason: "stop" },
          ],
        },
      },
      captured,
    ),
  });

  await client.generate({
    model: "deepseek-r1",
    messages: [{ role: "user", content: "q" }],
    jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  });

  assert.equal(captured[0].body.thinking, undefined);
  assert.equal(captured[0].body.enable_thinking, undefined);
  assert.equal(captured[0].body.reasoning_effort, undefined);
});

test("OpenAI adapter throws LlmClientError on non-2xx with upstream code/message", async () => {
  const client = createOpenAiCompatibleClient({
    baseUrl: "https://api.example.com",
    apiKey: "sk",
    fetch: makeFakeFetch(
      {
        status: 429,
        json: { error: { code: "rate_limited", message: "slow down" } },
      },
      [],
    ),
  });

  await assert.rejects(
    () =>
      client.generate({
        model: "gpt-4o",
        messages: [{ role: "user", content: "q" }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal(err.status, 429);
      assert.equal(err.code, "rate_limited");
      assert.equal(err.message, "slow down");
      return true;
    },
  );
});

test("OpenAI adapter aborts on timeout and throws TIMEOUT LlmClientError", async () => {
  // Fake fetch that hangs until the supplied AbortSignal fires.
  const hangingFetch: typeof fetch = (async (
    _url: string | URL,
    init?: RequestInit,
  ) => {
    await new Promise<void>((_, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        (err as Error & { name: string }).name = "AbortError";
        reject(err);
      });
    });
    throw new Error("unreachable");
  }) as unknown as typeof fetch;

  const client = createOpenAiCompatibleClient({
    baseUrl: "https://api.example.com",
    apiKey: "sk",
    fetch: hangingFetch,
    timeoutMs: 25,
  });

  const start = Date.now();
  await assert.rejects(
    () =>
      client.generate({
        model: "gpt-4o",
        messages: [{ role: "user", content: "q" }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal(err.code, "TIMEOUT");
      assert.equal(err.status, 0);
      assert.equal(err.message, "request timed out");
      assert.equal(err.retryable, true);
      return true;
    },
  );
  // Fired within a reasonable window around the 25ms timeout.
  assert.ok(Date.now() - start < 2_000);
});

test("OpenAI adapter classifies 401 as non-retryable, 503 as retryable", async () => {
  const c401 = createOpenAiCompatibleClient({
    baseUrl: "https://x.test",
    apiKey: "sk",
    fetch: makeFakeFetch(
      { status: 401, json: { error: { message: "bad key" } } },
      [],
    ),
  });
  await assert.rejects(
    () => c401.generate({ model: "m", messages: [{ role: "user", content: "q" }] }),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal(err.status, 401);
      assert.equal(err.retryable, false);
      return true;
    },
  );

  const c503 = createOpenAiCompatibleClient({
    baseUrl: "https://x.test",
    apiKey: "sk",
    fetch: makeFakeFetch(
      { status: 503, json: { error: { message: "down" } } },
      [],
    ),
  });
  await assert.rejects(
    () => c503.generate({ model: "m", messages: [{ role: "user", content: "q" }] }),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal(err.status, 503);
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test("OpenAI adapter returns truncated structured text for feature-level recovery", async () => {
  const client = createOpenAiCompatibleClient({
    baseUrl: "https://api.example.com",
    apiKey: "sk",
    fetch: makeFakeFetch(
      {
        json: {
          choices: [{
            message: { content: '{"headline":"usable","actions":["unfinished' },
            finish_reason: "length",
          }],
          usage: { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105 },
        },
      },
      [],
    ),
  });

  const response = await client.generate({
    model: "model",
    messages: [{ role: "user", content: "q" }],
    jsonSchema: { type: "object", properties: { headline: { type: "string" } } },
  });

  assert.equal(response.finishReason, "length");
  assert.equal(response.text, '{"headline":"usable","actions":["unfinished');
  assert.deepEqual(response.usage, { inputTokens: 5, outputTokens: 100, totalTokens: 105 });
});

test("OpenAI adapter falls back to bounded res.text() when error body is not JSON", async () => {
  const textFetch: typeof fetch = (async () =>
    new Response("upstream-plaintext-error-" + "x".repeat(500), {
      status: 500,
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof fetch;

  const client = createOpenAiCompatibleClient({
    baseUrl: "https://x.test",
    apiKey: "sk",
    fetch: textFetch,
  });
  await assert.rejects(
    () => client.generate({ model: "m", messages: [{ role: "user", content: "q" }] }),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal(err.status, 500);
      assert.ok(err.message.startsWith("upstream-plaintext-error-"));
      assert.ok(err.message.length <= 200);
      return true;
    },
  );
});

test("OpenAI adapter wraps network failures as LlmClientError", async () => {
  const client = createOpenAiCompatibleClient({
    baseUrl: "https://api.example.com",
    apiKey: "sk",
    fetch: makeFakeFetch({ throwErr: new Error("econn") }, []),
  });

  await assert.rejects(
    () =>
      client.generate({
        model: "gpt-4o",
        messages: [{ role: "user", content: "q" }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal(err.code, "NETWORK");
      return true;
    },
  );
});
