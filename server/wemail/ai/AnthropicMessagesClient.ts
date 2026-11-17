import {
  LlmClientError,
  readBoundedLlmResponse,
  parseRetryAfterMs,
  type AnthropicMessagesClientOptions,
  type LlmClient,
  type LlmFinishReason,
  type LlmRequest,
  type LlmResponse,
} from "./LlmClient.js";
import {
  normalizeStructuredJsonText,
  StructuredJsonTextError,
} from "./StructuredJsonText.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const STRUCTURED_TOOL_NAME = "structured_output";
const DEFAULT_TIMEOUT_MS = 30_000;
const ERROR_TEXT_MAX = 200;
const JSON_TEXT_SCHEMA_INSTRUCTION =
  "Return exactly one JSON value matching the supplied JSON schema. Do not use tools or wrap the JSON in Markdown fences.";
type JsonTextFallbackDisposition = "cache" | "request";

interface AnthropicMessageContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessagesResponse {
  content?: AnthropicMessageContentBlock[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { type?: string; message?: string } | string;
  message?: string;
}

function mapStopReason(reason: string | null | undefined): LlmFinishReason {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool-use";
    case "stop_sequence":
      return "stop";
    case "refusal":
      return "content-filter";
    default:
      return reason == null ? "stop" : "error";
  }
}

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

function isDeepSeekEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}

function jsonTextFallbackDisposition(
  error: unknown,
): JsonTextFallbackDisposition | undefined {
  if (!(error instanceof LlmClientError)) return undefined;
  if (![400, 422].includes(error.status ?? 0)) return undefined;
  const detail = `${error.code ?? ""} ${error.message}`;
  const rejectsThinkingToolChoice =
    /thinking/i.test(detail) && /tool[_ -]?choice/i.test(detail);
  const requiresStringToolChoice =
    /(?:cannot\s+)?unmarshal\s+object[\s\S]*tool[_ -]?choice[\s\S]*type\s+string/i.test(
      detail,
    );
  if (rejectsThinkingToolChoice || requiresStringToolChoice) return "cache";
  if (/(?:tools?|tool use).*(?:not supported|does not support|unsupported)|(?:not supported|does not support|unsupported).*(?:tools?|tool use)/i.test(detail)) {
    return "cache";
  }
  if (/(?:input[_ -]?schema|json schema|schema validation)/i.test(detail) &&
    /invalid|unsupported (?:schema )?keyword|not permitted/i.test(detail)) {
    return "request";
  }
  return undefined;
}

/**
 * Factory for Anthropic Messages API adapters. Maps the neutral
 * `LlmRequest` onto Anthropic's top-level `system` + `messages` shape.
 * `jsonSchema` is implemented via forced tool use when the model supports it.
 * Models and gateways that reject forced tool choice are detected from their
 * provider error and retried with a schema-constrained JSON text instruction
 * and no tools; the capability result is cached per model for the lifetime of
 * this client.
 */
export function createAnthropicMessagesClient(
  opts: AnthropicMessagesClientOptions,
): LlmClient {
  const fetchImpl: typeof fetch = opts.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new LlmClientError({
      message: "fetch-unavailable",
      code: "NO_FETCH",
    });
  }

  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/v1/messages`;
  const deepSeekEndpoint = isDeepSeekEndpoint(baseUrl);
  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Capability is model-specific: some thinking models reject forced tool
  // choice and some gateways reject tools entirely. Schema-specific failures
  // fall back only for the current request and never poison this cache. A
  // settings reload creates a new client, so updated models are probed again.
  const jsonTextStructuredOutputModels = new Set<string>();

  return {
    async generate(input: LlmRequest): Promise<LlmResponse> {
      const model = input.model || opts.defaultModel;
      if (!model) {
        throw new LlmClientError({ message: "missing-model", code: "NO_MODEL" });
      }
      const resolvedModel = model;
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
      const deadline = Date.now() + timeoutMs;

      // Anthropic disallows `system` role inside the messages array —
      // strip and fold into the top-level `system`.
      const systemParts: string[] = [];
      if (input.system) systemParts.push(input.system);
      const messages: Array<{ role: "user" | "assistant"; content: string }> =
        [];
      for (const m of input.messages) {
        if (m.role === "system") {
          systemParts.push(m.content);
          continue;
        }
        messages.push({ role: m.role, content: m.content });
      }

      function buildBody(useJsonTextFallback: boolean): Record<string, unknown> {
        const body: Record<string, unknown> = {
          model,
          messages,
          max_tokens: input.maxTokens ?? 1024,
        };
        const requestSystemParts = useJsonTextFallback && input.jsonSchema
          ? [
              ...systemParts,
              JSON_TEXT_SCHEMA_INSTRUCTION,
              `JSON schema:\n${JSON.stringify(input.jsonSchema)}`,
            ]
          : systemParts;
        if (requestSystemParts.length > 0) {
          body.system = requestSystemParts.join("\n\n");
        }
        if (input.temperature !== undefined) body.temperature = input.temperature;
        if (input.jsonSchema &&
          (deepSeekEndpoint || resolvedModel.toLowerCase().startsWith("deepseek")) &&
          !/(?:^|[-_.])(r1|reasoner|thinking)(?:[-_.]|$)/i.test(resolvedModel)) {
          body.thinking = { type: "disabled" };
        }

        if (input.jsonSchema && !useJsonTextFallback) {
          body.tools = [
            {
              name: STRUCTURED_TOOL_NAME,
              description: "Emit the structured response required by the caller.",
              input_schema: input.jsonSchema,
            },
          ];
          body.tool_choice = { type: "tool", name: STRUCTURED_TOOL_NAME };
        }
        return body;
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      };

      async function postOnce(body: Record<string, unknown>): Promise<Response> {
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
          const response = await fetchImpl(url, {
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
        let raw = "";
        try {
          raw = await res.text();
        } catch {
          // keep generic http-N message.
        }
        if (raw) {
          try {
            const errJson = JSON.parse(raw) as AnthropicMessagesResponse;
            if (typeof errJson.error === "string") {
              message = boundedProviderMessage(errJson.error, message);
            } else if (errJson.error) {
              if (errJson.error.type) code = errJson.error.type.slice(0, 80);
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

      let useJsonTextFallback = Boolean(
        input.jsonSchema && jsonTextStructuredOutputModels.has(model),
      );
      let json: AnthropicMessagesResponse | undefined;
      let text = "";
      let finishReason: LlmFinishReason = "stop";
      let sawUsage = false;
      let inputTokens = 0;
      let outputTokens = 0;
      while (true) {
        const res = await postOnce(buildBody(useJsonTextFallback));
        if (!res.ok) {
          const error = await errorFromResponse(res);
          const disposition = !useJsonTextFallback && input.jsonSchema
            ? jsonTextFallbackDisposition(error)
            : undefined;
          if (disposition) {
            if (disposition === "cache") {
              jsonTextStructuredOutputModels.add(model);
            }
            useJsonTextFallback = true;
            continue;
          }
          throw error;
        }

        try {
          json = (await res.json()) as AnthropicMessagesResponse;
        } catch (cause) {
          throw new LlmClientError({
            message: "invalid-json",
            code: "PARSE",
            cause,
          });
        }
        if (json.error) {
          const providerCode = typeof json.error === "object" && json.error.type
            ? json.error.type.slice(0, 80)
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
          sawUsage = true;
          inputTokens += json.usage.input_tokens ?? 0;
          outputTokens += json.usage.output_tokens ?? 0;
        }

        finishReason = mapStopReason(json.stop_reason);
        if (finishReason === "content-filter" ||
          json.content?.some((block) => block.type === "refusal")) {
          throw new LlmClientError({ message: "model-refusal", code: "REFUSAL" });
        }
        if (input.jsonSchema && finishReason === "error") {
          throw new LlmClientError({
            message: "unknown structured finish reason",
            code: "STRUCTURED_FINISH_REASON",
          });
        }

        if (!input.jsonSchema) {
          text = (json.content ?? [])
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text ?? "")
            .join("");
          if (!text.trim()) {
            throw new LlmClientError({ message: "missing-content", code: "NO_CONTENT" });
          }
          break;
        }

        const toolBlock = json.content?.find(
          (b) => b.type === "tool_use" && b.name === STRUCTURED_TOOL_NAME,
        );
        const rawText = toolBlock?.input !== undefined
          ? JSON.stringify(toolBlock.input)
          : useJsonTextFallback
            ? (json.content ?? [])
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text ?? "")
              .join("")
            : "";
        if (!rawText) {
          throw new LlmClientError({
            message: "missing-tool-use",
            code: "NO_TOOL_USE",
          });
        }
        if (finishReason === "length") {
          text = rawText;
          break;
        }
        try {
          text = normalizeStructuredJsonText(rawText, input.jsonSchema).text;
          break;
        } catch (error) {
          if (!(error instanceof StructuredJsonTextError)) throw error;
          if (!useJsonTextFallback) {
            useJsonTextFallback = true;
            continue;
          }
          throw new LlmClientError({ message: error.message, code: error.code, detail: error.detail, rawText: error.rawText, cause: error });
        }
      }

      const usage = sawUsage
        ? {
            inputTokens,
            outputTokens,
          }
        : undefined;

      return {
        text,
        finishReason,
        usage,
        ...(input.jsonSchema
          ? { structuredOutputMode: useJsonTextFallback ? "json-text" as const : "native" as const }
          : {}),
      };
    },
  };
}
