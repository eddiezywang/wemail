/**
 * Wave 0 locked LLM adapter surface (consumed by Packages E/F/G).
 *
 * Package E provides concrete implementations via:
 *   - `createOpenAiCompatibleClient` (re-exported from OpenAiCompatibleClient.ts)
 *   - `createAnthropicMessagesClient` (re-exported from AnthropicMessagesClient.ts)
 */

export type LlmMessageRole = "user" | "assistant" | "system";

export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
}

export interface LlmRequest {
  model: string;
  system?: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Optional JSON schema the model MUST conform to. Shape is
   * provider-neutral — adapters translate to their native
   * response-format / tool-use / structured-output mechanisms.
   */
  jsonSchema?: Record<string, unknown>;
  /**
   * Per-request timeout override in milliseconds. Falls back to the
   * adapter-level default (30_000ms) when omitted.
   */
  timeoutMs?: number;
  /** Optional caller-supplied AbortSignal merged with the internal timeout controller. */
  signal?: AbortSignal;
}

export type LlmFinishReason =
  | "stop"
  | "length"
  | "tool-use"
  | "content-filter"
  | "error";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

export type LlmStructuredOutputMode = "native" | "json-text";

export interface LlmResponse {
  text: string;
  finishReason: LlmFinishReason;
  usage?: LlmUsage;
  /**
   * How a requested JSON schema was enforced. Adapters set this for every
   * structured-output response so all callers can observe provider fallback
   * without implementing feature-specific capability detection.
   */
  structuredOutputMode?: LlmStructuredOutputMode;
}

export interface LlmClient {
  generate(input: LlmRequest): Promise<LlmResponse>;
}

export interface OpenAiCompatibleClientOptions {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  organization?: string;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Default per-request timeout (ms). Defaults to 30_000. */
  timeoutMs?: number;
  /** Override the model-family default reasoning_effort request field. */
  reasoningEffort?: import("../../../shared/wemail/settings.js").LlmReasoningEffort;
}

export interface AnthropicMessagesClientOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Default per-request timeout (ms). Defaults to 30_000. */
  timeoutMs?: number;
}

/**
 * Structured error emitted by every adapter when the upstream API
 * returns a non-2xx response (or fails to produce a valid body).
 * Body-free by construction — `message` is a short code, never a
 * prompt echo.
 *
 * `retryable` classifies whether the caller (QueueRunner) should
 * consume another attempt or short-circuit to terminal failure:
 *   - 408 / 429 / 5xx / NETWORK / TIMEOUT → retryable = true
 *   - 400 / 401 / 403 / 404 / other 4xx / PARSE / ABORTED / structured-output contract errors → retryable = false
 */
export interface LlmClientErrorOptions {
  status?: number;
  code?: string;
  message: string;
  /** Optional bounded diagnostics (e.g. a JSON shape summary) surfaced via LlmRuntime health. */
  detail?: string;
  /** Raw model output that failed schema validation; callers may salvage it leniently. */
  rawText?: string;
  cause?: unknown;
  retryAfterMs?: number;
  retryable?: boolean;
}

export class LlmClientError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly detail?: string;
  readonly rawText?: string;
  readonly cause?: unknown;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;

  constructor(opts: LlmClientErrorOptions) {
    super(opts.message);
    this.name = "LlmClientError";
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.rawText = opts.rawText;
    this.cause = opts.cause;
    this.retryAfterMs = opts.retryAfterMs;
    this.retryable =
      opts.retryable ?? classifyRetryable(opts.status, opts.code);
  }
}

/** Parse the standard Retry-After header without retaining provider payloads. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

/**
 * Default retryable classification. Pure function so adapters and
 * tests can call it directly.
 */
export function classifyRetryable(
  status: number | undefined,
  code: string | undefined,
): boolean {
  if (code === "NETWORK" || code === "TIMEOUT") return true;
  if (code === "PARSE" || code === "ABORTED" || code === "NO_MODEL" ||
    code === "NO_FETCH" || code === "NO_TOOL_USE" ||
    code === "NO_CONTENT" || code === "REFUSAL" ||
    code === "CONTENT_FILTERED" || code === "TRUNCATED_STRUCTURED_OUTPUT" ||
    code === "STRUCTURED_FINISH_REASON" || code === "EMPTY_STRUCTURED_OUTPUT" ||
    code === "INVALID_STRUCTURED_JSON" || code === "STRUCTURED_OUTPUT_SCHEMA_MISMATCH") {
    return false;
  }
  if (status === undefined) return false;
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (status >= 400 && status < 500) return false;
  return false;
}

export { createOpenAiCompatibleClient } from "./OpenAiCompatibleClient.js";
export { createAnthropicMessagesClient } from "./AnthropicMessagesClient.js";
