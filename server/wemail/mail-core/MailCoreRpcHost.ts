import { performance } from "node:perf_hooks";
import {
  CoreRequestSchema,
  MAIL_CORE_PROTOCOL_VERSION,
  type CoreResponse,
  type MailFocusResult,
  type MailEnsureBodyResult,
  type MailRefreshResult,
} from "../../../shared/wemail/mailCoreProtocol.js";

export interface MailCoreServerPort {
  on(event: "message", listener: (event: { data: unknown }) => void): this;
  start(): void;
  close(): void;
  postMessage(message: unknown): void;
}

export interface MailCoreRpcHostOptions {
  now?: () => Date;
  monotonicNow?: () => number;
  pid?: number;
  getRuntimeHealth?: () => Record<string, unknown>;
  onInteractiveRequest?: (method: string, traceId: string) => void;
  ensureBody?: (emailId: string, accountId: string, traceId: string, onDemand?: boolean) => Promise<MailEnsureBodyResult>;
  retryBody?: (emailId: string, accountId: string, traceId: string, onDemand?: boolean) => Promise<MailEnsureBodyResult>;
  focusMessage?: (emailId: string, accountId: string, traceId: string) => Promise<MailFocusResult>;
  blurMessage?: (emailId: string, accountId: string, traceId: string) => Promise<MailFocusResult>;
  refreshMail?: (accountId: string, traceId: string) => Promise<MailRefreshResult>;
}

export class MailCoreRpcHost {
  private readonly startedAt: Date;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly pid: number;
  private readonly ports = new Set<MailCoreServerPort>();
  private readonly getRuntimeHealth?: () => Record<string, unknown>;
  private readonly onInteractiveRequest?: (method: string, traceId: string) => void;
  private readonly ensureBody?: (emailId: string, accountId: string, traceId: string, onDemand?: boolean) => Promise<MailEnsureBodyResult>;
  private readonly retryBody?: (emailId: string, accountId: string, traceId: string, onDemand?: boolean) => Promise<MailEnsureBodyResult>;
  private readonly focusMessage?: (emailId: string, accountId: string, traceId: string) => Promise<MailFocusResult>;
  private readonly blurMessage?: (emailId: string, accountId: string, traceId: string) => Promise<MailFocusResult>;
  private readonly refreshMail?: (accountId: string, traceId: string) => Promise<MailRefreshResult>;

  constructor(options: MailCoreRpcHostOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.pid = options.pid ?? process.pid;
    this.startedAt = this.now();
    this.getRuntimeHealth = options.getRuntimeHealth;
    this.onInteractiveRequest = options.onInteractiveRequest;
    this.ensureBody = options.ensureBody;
    this.retryBody = options.retryBody;
    this.focusMessage = options.focusMessage;
    this.blurMessage = options.blurMessage;
    this.refreshMail = options.refreshMail;
  }

  attach(port: MailCoreServerPort): () => void {
    this.ports.add(port);
    port.on("message", (event) => {
      void this.handleMessage(port, event.data);
    });
    port.start();
    return () => {
      this.ports.delete(port);
      port.close();
    };
  }

  close(): void {
    for (const port of this.ports) port.close();
    this.ports.clear();
  }

  private async handleMessage(port: MailCoreServerPort, input: unknown): Promise<void> {
    const receivedAt = this.monotonicNow();
    const parsed = CoreRequestSchema.safeParse(input);
    if (!parsed.success) {
      const requestId = getRequestId(input);
      port.postMessage(failureResponse(
        requestId,
        "INVALID_REQUEST",
        "Mail Core request did not match the protocol schema",
      ));
      return;
    }

    const request = parsed.data;
    if (request.method !== "core.health") {
      this.onInteractiveRequest?.(request.method, request.traceId);
    }
    const handlerStartedAt = this.monotonicNow();
    try {
      const result = request.method === "core.health"
        ? {
            protocolVersion: MAIL_CORE_PROTOCOL_VERSION,
            state: "ready" as const,
            pid: this.pid,
            startedAt: this.startedAt.toISOString(),
            uptimeMs: Math.max(0, this.now().getTime() - this.startedAt.getTime()),
            ...this.getRuntimeHealth?.(),
          }
        : await this.handleMailRequest(
            request.method,
            request.params,
            request.idempotencyKey ?? request.requestId,
            request.traceId,
          );
      const finishedAt = this.monotonicNow();
      port.postMessage({
        version: MAIL_CORE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result,
        timing: {
          queueMs: Math.max(0, handlerStartedAt - receivedAt),
          handlerMs: Math.max(0, finishedAt - handlerStartedAt),
          totalMs: Math.max(0, finishedAt - receivedAt),
        },
      } satisfies CoreResponse);
    } catch (error) {
      const credentialRequired = error instanceof Error && error.name === "MAIL_CREDENTIAL_INVALID";
      port.postMessage(failureResponse(
        request.requestId,
        credentialRequired ? "MAIL_CREDENTIAL_INVALID" : "INTERNAL_ERROR",
        error instanceof Error ? error.message : "Mail Core request failed",
        !credentialRequired,
      ));
    }
  }

  private async handleMailRequest(
    method: "mail.ensureBody" | "mail.retryBody" | "mail.focus" | "mail.blur" | "mail.refresh",
    params: unknown,
    _idempotencyKey: string,
    traceId: string,
  ): Promise<unknown> {
    if (typeof params !== "object" || !params) {
      throw new Error(`${method} requires params`);
    }
    const accountId = "accountId" in params
      ? (params as { accountId?: unknown }).accountId
      : undefined;
    if (typeof accountId !== "string" || !accountId) {
      throw new Error(`${method} requires an accountId`);
    }
    if (method === "mail.refresh") {
      if (!this.refreshMail) {
        return { status: "account-unavailable" } satisfies MailRefreshResult;
      }
      return this.refreshMail(accountId, traceId);
    }
    if (!("id" in params)) throw new Error(`${method} requires an id`);
    const id = (params as { id?: unknown }).id;
    if (typeof id !== "string" || !id) throw new Error(`${method} requires an id`);
    const onDemand = (params as { onDemand?: unknown }).onDemand === true;
    if (method === "mail.focus" || method === "mail.blur") {
      const handler = method === "mail.focus" ? this.focusMessage : this.blurMessage;
      if (!handler) return { status: "account-unavailable" } satisfies MailFocusResult;
      return handler(id, accountId, traceId);
    }
    const handler = method === "mail.retryBody" ? this.retryBody : this.ensureBody;
    if (!handler) return { status: "account-unavailable" } satisfies MailEnsureBodyResult;
    return handler(id, accountId, traceId, onDemand);
  }
}

function getRequestId(input: unknown): string {
  if (typeof input === "object" && input && "requestId" in input) {
    const requestId = (input as { requestId?: unknown }).requestId;
    if (typeof requestId === "string" && requestId) return requestId;
  }
  return "invalid-request";
}

function failureResponse(
  requestId: string,
  code: string,
  message: string,
  retryable = false,
): CoreResponse {
  return {
    version: MAIL_CORE_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message, retryable },
  };
}
