import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import {
  WEMAIL_MCP_DEFAULT_PORT,
  WEMAIL_MCP_PROTOCOL_VERSIONS,
  WEMAIL_MCP_SERVER_NAME,
  WEMAIL_MCP_SERVER_VERSION,
  type WemailMcpProtocolVersion,
} from "../../../shared/wemail/mcp.js";
import type { McpAccessTokenMetadata } from "./McpAccessTokenService.js";
import type { McpAuthenticator } from "./McpAuthenticator.js";
import type { McpPublicRegistry } from "./McpPublicRegistry.js";
import type { McpSessionManager } from "./McpSessionManager.js";
import type { McpAuditRepository } from "./McpAuditRepository.js";
import { createHash } from "node:crypto";
import { closeNodeHttpServer } from "../../api/close-node-http-server.js";

type JsonRpcId = string | number;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

const JSON_HEADERS = { "content-type": "application/json" };
export const MCP_DEFAULT_MAX_REQUEST_BYTES = 40 * 1024 * 1024;
const LOOPBACK_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

class McpRequestTooLargeError extends Error {}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function error(id: JsonRpcId | null, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

function transportError(code: string, message: string, status: number, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message, retryable: false } }, status, headers);
}

function isAllowedOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  if (origin === "null") return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return LOOPBACK_ORIGIN_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

async function readBoundedRequestBody(request: Request, maximum: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) {
    throw new McpRequestTooLargeError();
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new McpRequestTooLargeError();
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === "2.0" && typeof candidate.method === "string" &&
    (candidate.id === undefined || typeof candidate.id === "string" || typeof candidate.id === "number") &&
    (candidate.params === undefined || (typeof candidate.params === "object" && candidate.params !== null && !Array.isArray(candidate.params)));
}

export interface McpHttpTransportOptions {
  authenticator: Pick<McpAuthenticator, "authenticate">;
  sessions: McpSessionManager;
  registry: McpPublicRegistry;
  audit?: McpAuditRepository;
  limits?: {
    tokenRequestsPerMinute?: number;
    sessionRequestsPerMinute?: number;
    toolRequestsPerMinute?: number;
    expensiveToolRequestsPerMinute?: number;
    maxRequestBytes?: number;
    toolTimeoutMs?: number;
  };
}

export class McpHttpTransport {
  private readonly rates = new Map<string, { window: number; count: number }>();
  constructor(private readonly options: McpHttpTransportOptions) {}

  fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });
    if (!isAllowedOrigin(request.headers.get("origin"))) {
      return transportError("origin_forbidden", "The request Origin is not allowed.", 403);
    }

    const authenticated = this.options.authenticator.authenticate(request.headers.get("authorization") ?? undefined);
    if (!authenticated.ok) {
      return transportError("authentication_required", "MCP authentication is required.", 401, { "www-authenticate": "Bearer" });
    }
    if (request.method === "DELETE") return this.deleteSession(request, authenticated.token);
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });

    let payload: unknown;
    try {
      const body = await readBoundedRequestBody(request, this.options.limits?.maxRequestBytes ?? MCP_DEFAULT_MAX_REQUEST_BYTES);
      payload = JSON.parse(body);
    } catch (failure) {
      if (failure instanceof McpRequestTooLargeError) {
        return transportError("request_too_large", "The MCP request body is too large.", 413);
      }
      return error(null, -32700, "Parse error");
    }
    if (!isRequest(payload)) return error(null, -32600, "Invalid Request");
    return this.dispatch(payload, request, authenticated.token);
  };

  private async dispatch(
    rpc: JsonRpcRequest,
    request: Request,
    token: McpAccessTokenMetadata,
  ): Promise<Response> {
    if (rpc.method === "initialize") return this.initialize(rpc, token);

    const sessionId = request.headers.get("mcp-session-id");
    if (!sessionId) return error(rpc.id ?? null, -32600, "MCP session is required");
    const session = this.options.sessions.get(sessionId, token.id);
    if (!session) return error(rpc.id ?? null, -32600, "MCP session is invalid or expired");

    if (rpc.method === "notifications/initialized") {
      if (rpc.id !== undefined) return error(rpc.id, -32600, "Invalid Request");
      this.options.sessions.markInitialized(sessionId, token.id);
      return new Response(null, { status: 202 });
    }
    if (!session.initialized) return error(rpc.id ?? null, -32600, "MCP session is not initialized");
    if (rpc.method === "notifications/cancelled") {
      if (rpc.id !== undefined) return error(rpc.id, -32600, "Invalid Request");
      const requestId = rpc.params?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        this.options.sessions.cancelCall(sessionId, token.id, String(requestId));
      }
      return new Response(null, { status: 202 });
    }
    if (rpc.id === undefined) return new Response(null, { status: 202 });

    if (rpc.method === "tools/list") {
      return json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          tools: this.options.registry.list().map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations,
          })),
        },
      });
    }
    if (rpc.method === "tools/call") return this.callTool(rpc, token, sessionId, session.sessionHash, request.signal);
    return error(rpc.id, -32601, "Method not found");
  }

  private initialize(rpc: JsonRpcRequest, token: McpAccessTokenMetadata): Response {
    if (rpc.id === undefined) return error(null, -32600, "Invalid Request");
    const requested = rpc.params?.protocolVersion;
    if (typeof requested !== "string" || !WEMAIL_MCP_PROTOCOL_VERSIONS.includes(requested as WemailMcpProtocolVersion)) {
      return error(rpc.id, -32602, "Unsupported protocol version");
    }
    const session = this.options.sessions.create(token.id, requested as WemailMcpProtocolVersion);
    return json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: WEMAIL_MCP_SERVER_NAME, version: WEMAIL_MCP_SERVER_VERSION },
      },
    }, 200, { "mcp-session-id": session.id });
  }

  private async callTool(
    rpc: JsonRpcRequest,
    token: McpAccessTokenMetadata,
    sessionId: string,
    sessionHash: string,
    requestSignal: AbortSignal,
  ): Promise<Response> {
    const name = rpc.params?.name;
    const args = rpc.params?.arguments ?? {};
    if (typeof name !== "string" || typeof args !== "object" || args === null || Array.isArray(args)) {
      return error(rpc.id!, -32602, "Invalid tool arguments");
    }
    if (!this.takeRate(`token:${token.id}`, this.options.limits?.tokenRequestsPerMinute ?? 120) ||
        !this.takeRate(`session:${sessionHash}`, this.options.limits?.sessionRequestsPerMinute ?? 60) ||
        !this.takeRate(`tool:${token.id}:${name}`, isExpensiveTool(name) ? this.options.limits?.expensiveToolRequestsPerMinute ?? 10 : this.options.limits?.toolRequestsPerMinute ?? 60)) {
      const result = toolError("rate_limited", "The request limit was exceeded.", true);
      this.appendAudit({ name, args: args as Record<string, unknown>, token, sessionHash, durationMs: 0, result, responseBytes: Buffer.byteLength(JSON.stringify(result)) });
      return json({ jsonrpc: "2.0", id: rpc.id, result });
    }
    let call: ReturnType<McpSessionManager["beginCall"]>;
    try {
      call = this.options.sessions.beginCall(sessionId, token.id, String(rpc.id));
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : "";
      const result = code === "mcp-session-concurrency-limit"
        ? toolError("rate_limited", "The concurrent request limit was exceeded.", true)
        : toolError("invalid_request", "The request could not be started.", false);
      return json({ jsonrpc: "2.0", id: rpc.id, result });
    }
    const started = performance.now();
    const timeout = setTimeout(
      () => this.options.sessions.cancelCall(sessionId, token.id, String(rpc.id), "tool-timeout"),
      this.options.limits?.toolTimeoutMs ?? 30_000,
    );
    const abortFromRequest = () => this.options.sessions.cancelCall(sessionId, token.id, String(rpc.id), "http-disconnected");
    requestSignal.addEventListener("abort", abortFromRequest, { once: true });
    try {
      // Abort events are not replayed to listeners registered after abort.
      // Do not invoke a handler when the client has already disconnected.
      if (requestSignal.aborted) {
        abortFromRequest();
        this.appendAudit({ name, args: args as Record<string, unknown>, token, sessionHash, durationMs: performance.now() - started, outcomeCode: "cancelled_before_execution", responseBytes: 0 });
        return error(rpc.id!, -32600, "Request cancelled before execution");
      }
      const result = await this.options.registry.call(name, args, {
        accountId: token.accountId,
        tokenId: token.id,
        sessionHash,
        signal: call.signal,
      });
      const body = { jsonrpc: "2.0", id: rpc.id, result };
      this.appendAudit({ name, args: args as Record<string, unknown>, token, sessionHash, durationMs: performance.now() - started, result, responseBytes: Buffer.byteLength(JSON.stringify(body)) });
      return json(body);
    } catch {
      this.appendAudit({ name, args: args as Record<string, unknown>, token, sessionHash, durationMs: performance.now() - started, outcomeCode: "internal_error", responseBytes: 0 });
      return error(rpc.id!, -32603, "Internal error");
    } finally {
      clearTimeout(timeout);
      requestSignal.removeEventListener("abort", abortFromRequest);
      this.options.sessions.endCall(sessionId, String(rpc.id));
    }
  }

  private takeRate(key: string, maximum: number): boolean {
    const window = Math.floor(Date.now() / 60_000);
    const current = this.rates.get(key);
    if (!current || current.window !== window) {
      this.rates.set(key, { window, count: 1 });
      return true;
    }
    if (current.count >= maximum) return false;
    current.count += 1;
    return true;
  }

  private appendAudit(input: {
    name: string;
    args: Record<string, unknown>;
    token: McpAccessTokenMetadata;
    sessionHash: string;
    durationMs: number;
    result?: { structuredContent: Record<string, unknown>; isError?: boolean };
    outcomeCode?: string;
    responseBytes: number;
  }): void {
    const definition = this.options.registry.definition(input.name);
    if (!this.options.audit || !definition) return;
    const errorValue = input.result?.structuredContent.error;
    const outcomeCode = input.outcomeCode ?? (
      errorValue && typeof errorValue === "object" && "code" in errorValue
        ? String((errorValue as { code: unknown }).code)
        : "ok"
    );
    const operationValue = input.result?.structuredContent.operation;
    const operationId = operationValue && typeof operationValue === "object" && "id" in operationValue
      ? String((operationValue as { id: unknown }).id)
      : typeof input.args.operationId === "string" ? input.args.operationId : undefined;
    try {
      this.options.audit.append({
        tokenFingerprint: input.token.fingerprint,
        sessionHash: input.sessionHash,
        toolName: input.name,
        accountId: input.token.accountId,
        riskClass: definition.risk,
        argumentShape: shapeArguments(input.args),
        durationMs: input.durationMs,
        outcomeCode,
        responseBytes: input.responseBytes,
        ...(operationId ? { operationId } : {}),
        ...(typeof input.args.idempotencyKey === "string" ? { idempotencyKeyHash: createHash("sha256").update(input.args.idempotencyKey).digest("hex") } : {}),
      });
    } catch {
      // Telemetry must never change the tool outcome.
    }
  }

  private deleteSession(request: Request, token: McpAccessTokenMetadata): Response {
    const sessionId = request.headers.get("mcp-session-id");
    if (!sessionId || !this.options.sessions.get(sessionId, token.id)) {
      return json({ error: { code: "invalid_request", message: "MCP session is invalid or expired.", retryable: false } }, 404);
    }
    this.options.sessions.terminate(sessionId, "client-delete");
    return json({ ok: true });
  }
}

function toolError(code: string, message: string, retryable: boolean) {
  return { isError: true, structuredContent: { error: { code, message, retryable } }, content: [{ type: "text", text: `${code}: ${message}` }] };
}

function isExpensiveTool(name: string): boolean {
  return name === "sync_mail_account" || name === "get_mail_attachment" || name === "upload_mail_attachment" || name.startsWith("prepare_") || name === "commit_mail_operation";
}

function shapeArguments(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => {
    if (Array.isArray(value)) return [key, { type: "array", count: value.length }];
    if (value === null) return [key, { type: "null" }];
    if (typeof value === "string") return [key, { type: "string", length: value.length }];
    if (typeof value === "object") return [key, { type: "object", keys: Object.keys(value as object).sort() }];
    return [key, { type: typeof value }];
  }));
}

export interface McpHttpServer {
  host: "127.0.0.1" | "::1";
  port: number;
  close(): Promise<void>;
}

export async function startMcpHttpServer(options: {
  transport: McpHttpTransport;
  port?: number;
  host?: string;
}): Promise<McpHttpServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("mcp-loopback-binding-required");
  const port = options.port ?? WEMAIL_MCP_DEFAULT_PORT;
  const server: ServerType = serve({ fetch: options.transport.fetch, port, hostname: host });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    host,
    port: boundPort,
    close: () => closeNodeHttpServer(server),
  };
}
