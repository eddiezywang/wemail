import {
  LlmClientError,
  readBoundedLlmResponse,
  parseRetryAfterMs,
  type LlmClient,
  type LlmFinishReason,
  type LlmRequest,
  type LlmResponse,
  type OpenAiCompatibleClientOptions,
} from "./LlmClient.js";
import {
  normalizeStructuredJsonText,
  StructuredJsonTextError,
} from "./StructuredJsonText.js";

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: { content?: unknown; refusal?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { code?: string; message?: string } | string;
  message?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const ERROR_TEXT_MAX = 200;
type StructuredOutputMode = "json_schema" | "json_object" | "prompt_only";
type StructuredFallbackDisposition = "cache" | "request";

function isDeepSeekEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}

function structuredThinkingControls(
  model: string,
  deepSeekEndpoint: boolean,
  includeFamilyControls: boolean,
  reasoningEffort: OpenAiCompatibleClientOptions["reasoningEffort"],
): Record<string, unknown> {
  const normalized = model.toLowerCase();
  const thinkingOnly = /(?:^|[-_.])(r1|reasoner|thinking)(?:[-_.]|$)/.test(normalized) ||
    /^kimi(?:\/kimi)?-k(?:3|2\.7-code)(?:[-_.]|$)/.test(normalized);
  if (thinkingOnly) return manualReasoningEffort({}, reasoningEffort);
  // DeepSeek reasoning burns the token budget on every call type, so disable
  // it by default. reasoning_effort is the only switch some gateways (e.g.
  // sub2api) forward upstream; thinking is honored by DeepSeek and other
  // openai-compatible endpoints directly. Send both so either path works.
  if (deepSeekEndpoint || normalized.startsWith("deepseek")) {
    return manualReasoningEffort({
      thinking: { type: "disabled" },
      reasoning_effort: "none",
    }, reasoningEffort);
  }
  if (!includeFamilyControls) return manualReasoningEffort({}, reasoningEffort);
  if (normalized.startsWith("glm-") || normalized.startsWith("minimax")) {
    return manualReasoningEffort({ thinking: { type: "disabled" } }, reasoningEffort);
  }
  if (normalized.startsWith("qwen") || normalized.startsWith("kimi")) {
    return manualReasoningEffort({ enable_thinking: false }, reasoningEffort);
  }
  if (/^gpt-5\.(?:[1-9]\d*)(?:[.-]|$)/.test(normalized) ||
    /^gemini-2\.5-(?:flash|flash-lite)(?:[-_.]|$)/.test(normalized)) {
    return manualReasoningEffort({ reasoning_effort: "none" }, reasoningEffort);
  }
  if (/^gpt-5(?:[.-]|$)/.test(normalized) && !normalized.includes("pro")) {
    return manualReasoningEffort({ reasoning_effort: "minimal" }, reasoningEffort);
  }
  return manualReasoningEffort({}, reasoningEffort);
}

function manualReasoningEffort(
  controls: Record<string, unknown>,
  reasoningEffort: OpenAiCompatibleClientOptions["reasoningEffort"],
): Record<string, unknown> {
  if (!reasoningEffort || reasoningEffort === "auto") return controls;
  const next = { ...controls };
  if (reasoningEffort === "omit") {
    delete next.reasoning_effort;
  } else {
    next.reasoning_effort = reasoningEffort;
  }
  return next;
}

function mapFinishReason(reason: string | null | undefined): LlmFinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool-use";
    case "content_filter":
      return "content-filter";
    default:
      return reason == null ? "stop" : "error";
  }
}

/** Merge an optional caller signal with the internal timeout controller. */
function linkSignal(
  controller: AbortController,
  external: AbortSignal | undefined,
): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    controller.abort(external.reason);
    return () => undefined;
  }
  const abort = () => controller.abort(external.reason);
  external.addEventListener("abort", abort, { once: true });
  return () => external.removeEventListener("abort", abort);
}

function boundedProviderMessage(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, ERROR_TEXT_MAX);
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const record = part as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (record.text && typeof record.text === "object" &&
      typeof (record.text as Record<string, unknown>).value === "string") {
      return (record.text as { value: string }).value;
    }
    return "";
  }).join("");
}

function nextStructuredOutputMode(
  mode: StructuredOutputMode,
  schema: Record<string, unknown>,
): StructuredOutputMode | undefined {
  if (mode === "json_schema") {
    return schema.type === "object" || schema.type === undefined
      ? "json_object"
      : "prompt_only";
  }
  if (mode === "json_object") return "prompt_only";
  return undefined;
}

/**
 * Factory for OpenAI-compatible chat completion adapters (OpenAI,
 * Azure OpenAI, OpenRouter, local LM Studio/Ollama-openai, etc.).
 */
export function createOpenAiCompatibleClient(
  opts: OpenAiCompatibleClientOptions,
): LlmClient {
  const fetchImpl: typeof fetch = opts.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new LlmClientError({
      message: "fetch-unavailable",
      code: "NO_FETCH",
    });
  }

  const inputBaseUrl = opts.baseUrl.replace(/\/+$/, "");
  const baseUrl = inputBaseUrl.replace(/\/v1$/i, "");
  const urls = /\/chat\/completions$/i.test(inputBaseUrl)
    ? [inputBaseUrl]
    : [
        `${baseUrl}/v1/chat/completions`,
        `${baseUrl}/chat/completions`,
      ].filter((value, index, all) => all.indexOf(value) === index);
  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deepSeekEndpoint = isDeepSeekEndpoint(inputBaseUrl);
  // Explicit unsupported-format errors are provider capability signals, not
  // feature failures. Share the strongest known compatible mode across every
  // caller using the same model for this adapter's lifetime. Invalid model
  // output is repaired per request and deliberately does not poison the cache.
  const structuredOutputModes = new Map<string, StructuredOutputMode>();
  // Some compatible gateways reject the otherwise-valid `none` value but
  // explicitly advertise `low` as their minimum. Remember that capability
  // for this adapter/model after the first bounded compatibility retry.
  const reasoningEffortLowFallback = new Set<string>();

  return {
    async generate(input: LlmRequest): Promise<LlmResponse> {
      const requestedModel = input.model || opts.defaultModel;
      if (!requestedModel) {
        throw new LlmClientError({ message: "missing-model", code: "NO_MODEL" });
      }
      // Preserve the guard's narrowing inside the nested request helpers.
      const model: string = requestedModel;

      // Structured extraction needs the token budget for the JSON response,
      // not a hidden reasoning trace. Use each model family's supported switch.
      // DeepSeek thinking is disabled on every call type by default.
      const thinkingControls = structuredThinkingControls(
        model,
        deepSeekEndpoint,
        input.jsonSchema != null,
        opts.reasoningEffort,
      );
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
      const deadline = Date.now() + timeoutMs;

      const messages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }> = [];
      if (input.system) messages.push({ role: "system", content: input.system });
      for (const m of input.messages) {
        messages.push({ role: m.role, content: m.content });
      }

      function buildBody(mode: StructuredOutputMode): Record<string, unknown> {
        let requestMessages = messages;
        const body: Record<string, unknown> = { model, messages: requestMessages };
        if (input.temperature !== undefined) body.temperature = input.temperature;
        if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
        Object.assign(
          body,
          reasoningEffortLowFallback.has(model) &&
            thinkingControls.reasoning_effort === "none"
            ? { ...thinkingControls, reasoning_effort: "low" }
            : thinkingControls,
        );
        if (input.jsonSchema && mode === "json_schema") {
          body.response_format = {
            type: "json_schema",
            json_schema: {
              name: "structured_output",
              schema: input.jsonSchema,
              strict: true,
            },
          };
        } else if (input.jsonSchema && (mode === "json_object" || mode === "prompt_only")) {
          const schemaInstruction = [
            "Return JSON only; do not wrap it in Markdown fences.",
            "The JSON value must follow this schema exactly:",
            JSON.stringify(input.jsonSchema),
          ].join("\n");
          const systemIndex = messages.findIndex((message) => message.role === "system");
          requestMessages = systemIndex >= 0
            ? messages.map((message, index) => index === systemIndex
              ? { ...message, content: `${message.content}\n\n${schemaInstruction}` }
              : message)
            : [{ role: "system", content: schemaInstruction }, ...messages];
          body.messages = requestMessages;
          if (mode === "json_object") {
            body.response_format = { type: "json_object" };
          }
        }
        return body;
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
      };
      if (opts.organization) headers["openai-organization"] = opts.organization;

      async function postOnce(
        targetUrl: string,
        body: Record<string, unknown>,
      ): Promise<Response> {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new LlmClientError({
            message: "request timed out",
            code: "TIMEOUT",
            status: 0,
          });
        }
        const controller = new AbortController();
        const unlinkSignal = linkSignal(controller, input.signal);
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, remainingMs);
        try {
          const response = await fetchImpl(targetUrl, {
            method: "POST",
            redirect: "error",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          // fetch resolves at headers; keep the deadline active while the
          // provider sends the body as well.
          return await readBoundedLlmResponse(response);
        } catch (cause) {
          if (timedOut) {
            throw new LlmClientError({
              message: "request timed out",
              code: "TIMEOUT",
              status: 0,
              cause,
            });
          }
          if (input.signal?.aborted) {
            throw new LlmClientError({
              message: "request aborted",
              code: "ABORTED",
              cause,
            });
          }
          if (cause instanceof LlmClientError) throw cause;
          throw new LlmClientError({
            message: "network-error",
            code: "NETWORK",
            cause,
          });
        } finally {
          clearTimeout(timer);
          unlinkSignal();
        }
      }

      async function errorFromResponse(res: Response): Promise<LlmClientError> {
        let code: string | undefined;
        let message = `http-${res.status}`;
        // Read the body once as text, then try to JSON-parse it. If
        // parsing fails, fall back to the bounded raw text for diagnostics.
        let raw = "";
        try {
          raw = await res.text();
        } catch {
          // keep generic http-N message.
        }
        if (raw) {
          try {
            const errJson = JSON.parse(raw) as OpenAiChatCompletionResponse;
            if (typeof errJson.error === "string") {
              message = boundedProviderMessage(errJson.error, message);
            } else if (errJson.error) {
              if (errJson.error.code) code = errJson.error.code.slice(0, 80);
              if (errJson.error.message) {
                message = boundedProviderMessage(errJson.error.message, message);
              }
            } else if (errJson.message) {
              message = boundedProviderMessage(errJson.message, message);
            }
          } catch {
            message = raw.slice(0, ERROR_TEXT_MAX);
          }
        }
        return new LlmClientError({
          status: res.status,
          code,
          message,
          retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
        });
      }

      async function requestCompletion(body: Record<string, unknown>): Promise<Response> {
        let res: Response | undefined;
        let lastError: LlmClientError | undefined;
        for (let index = 0; index < urls.length; index += 1) {
          res = await postOnce(urls[index], body);
          if (res.ok) break;
          lastError = await errorFromResponse(res);
          if (![404, 405].includes(res.status) || index === urls.length - 1) {
            throw lastError;
          }
        }
        if (!res?.ok) {
          throw lastError ?? new LlmClientError({ message: "request failed" });
        }
        return res;
      }

      function structuredModeFallbackDisposition(
        error: unknown,
        mode: StructuredOutputMode,
      ): StructuredFallbackDisposition | undefined {
        if (!input.jsonSchema || !(error instanceof LlmClientError)) return undefined;
        if (![400, 422].includes(error.status ?? 0)) return undefined;
        if (mode === "prompt_only") return undefined;
        const detail = `${error.code ?? ""} ${error.message}`;
        if (mode === "json_schema" &&
          /invalid (?:json )?schema|schema (?:is )?invalid|unsupported (?:schema )?keyword|schema validation|strict schema/i.test(detail)) {
          return "request";
        }
        const unsupported = /not supported|does not support|unsupported|unavailable|not available|unknown (?:field|parameter|argument)|unrecognized (?:field|parameter|argument)|unexpected (?:field|parameter|keyword|argument)|not allowed|not a valid parameter|extra inputs? (?:are )?not permitted/i.test(
          detail,
        );
        if (!unsupported) return undefined;
        const relevant = mode === "json_schema"
          ? /json[_ -]?schema|response[_ -]?format|structured[_ -]?output|strict/i.test(detail)
          : /json[_ -]?object|response[_ -]?format/i.test(detail);
        return relevant ? "cache" : undefined;
      }

      function shouldFallbackReasoningEffort(error: unknown): boolean {
        if (!(error instanceof LlmClientError) || error.status !== 400) return false;
        if (reasoningEffortLowFallback.has(model)) return false;
        if (thinkingControls.reasoning_effort !== "none") return false;
        const detail = `${error.code ?? ""} ${error.message}`;
        return /reasoning[_ -]?effort/i.test(detail) &&
          /(?:must be one of|invalid(?:_request| value)?|not (?:allowed|supported)|unsupported)/i.test(detail) &&
          /\blow\b/i.test(detail);
      }

      let structuredOutputMode: StructuredOutputMode = input.jsonSchema
        ? structuredOutputModes.get(model) ?? "json_schema"
        : "json_schema";
      if (input.jsonSchema && structuredOutputMode === "json_object" &&
        input.jsonSchema.type !== undefined && input.jsonSchema.type !== "object") {
        structuredOutputMode = "prompt_only";
      }

      let json: OpenAiChatCompletionResponse | undefined;
      let text = "";
      let finishReason: LlmFinishReason = "stop";
      let sawUsage = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      while (true) {
        let res: Response;
        try {
          res = await requestCompletion(buildBody(structuredOutputMode));
        } catch (error) {
          if (shouldFallbackReasoningEffort(error)) {
            reasoningEffortLowFallback.add(model);
            continue;
          }
          const nextMode = input.jsonSchema
            ? nextStructuredOutputMode(structuredOutputMode, input.jsonSchema)
            : undefined;
          const disposition = structuredModeFallbackDisposition(error, structuredOutputMode);
          if (!nextMode || !disposition) {
            throw error;
          }
          if (disposition === "cache") {
            structuredOutputModes.set(model, nextMode);
          }
          structuredOutputMode = nextMode;
          continue;
        }

        try {
          json = (await res.json()) as OpenAiChatCompletionResponse;
        } catch (cause) {
          throw new LlmClientError({
            message: "invalid-json",
            code: "PARSE",
            cause,
          });
        }
        if (json.error) {
          const providerCode = typeof json.error === "object" && json.error.code
            ? json.error.code.slice(0, 80)
            : "UPSTREAM_ERROR";
          const providerMessage = typeof json.error === "string"
            ? json.error
            : json.error.message;
          throw new LlmClientError({
            message: boundedProviderMessage(providerMessage, "upstream-error"),
            code: providerCode,
          });
        }
        if (json.usage) {
          const attemptInput = json.usage.prompt_tokens ?? 0;
          const attemptOutput = json.usage.completion_tokens ?? 0;
          sawUsage = true;
          inputTokens += attemptInput;
          outputTokens += attemptOutput;
          totalTokens += json.usage.total_tokens ?? attemptInput + attemptOutput;
        }

        const choice = json.choices?.[0];
        if (!choice?.message) {
          throw new LlmClientError({ message: "missing-content", code: "NO_CONTENT" });
        }
        if (choice.message.refusal?.trim()) {
          throw new LlmClientError({ message: "model-refusal", code: "REFUSAL" });
        }
        finishReason = mapFinishReason(choice.finish_reason);
        if (finishReason === "content-filter") {
          throw new LlmClientError({ message: "content-filtered", code: "CONTENT_FILTERED" });
        }
        if (input.jsonSchema && finishReason === "error") {
          throw new LlmClientError({
            message: "unknown structured finish reason",
            code: "STRUCTURED_FINISH_REASON",
          });
        }

        const rawText = extractTextContent(choice.message.content);
        if (!rawText.trim()) {
          throw new LlmClientError({ message: "missing-content", code: "NO_CONTENT" });
        }
        if (input.jsonSchema && finishReason === "length") {
          // Preserve the useful prefix. Feature processors can recover complete
          // fields from partial JSON without treating a token cap as provider
          // unavailability or making a second model call.
          text = rawText;
          break;
        }
        if (!input.jsonSchema) {
          text = rawText;
          break;
        }
        try {
          text = normalizeStructuredJsonText(rawText, input.jsonSchema).text;
          break;
        } catch (error) {
          if (!(error instanceof StructuredJsonTextError)) throw error;
          const nextMode = nextStructuredOutputMode(structuredOutputMode, input.jsonSchema);
          if (!nextMode) {
            throw new LlmClientError({ message: error.message, code: error.code, detail: error.detail, rawText: error.rawText, cause: error });
          }
          structuredOutputMode = nextMode;
        }
      }

      const usage = sawUsage
        ? {
            inputTokens,
            outputTokens,
            totalTokens,
          }
        : undefined;

      return {
        text,
        finishReason,
        usage,
        ...(input.jsonSchema
          ? { structuredOutputMode: structuredOutputMode === "json_schema" ? "native" as const : "json-text" as const }
          : {}),
      };
    },
  };
}
