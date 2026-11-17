import {
  CoreHealthResultSchema,
  CoreResponseSchema,
  MAIL_CORE_PROTOCOL_VERSION,
  MailEnsureBodyResultSchema,
  MailFocusResultSchema,
  MailRefreshResultSchema,
  type CoreHealthResult,
  type CoreMethod,
  type CoreResponse,
  type MailEnsureBodyResult,
  type MailFocusResult,
  type MailRefreshResult,
} from "../../shared/wemail/mailCoreProtocol.js";

export interface MailCoreClientPort {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class MailCoreClient {
  private port: MailCoreClientPort | null = null;
  private sequence = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly onMessage = (event: MessageEvent<unknown>) => {
    this.handleResponse(event.data);
  };

  replacePort(port: MailCoreClientPort): void {
    this.disconnect(new Error("Mail Core connection was replaced"));
    this.port = port;
    port.addEventListener("message", this.onMessage);
    port.start();
  }

  disconnect(reason = new Error("Mail Core is unavailable")): void {
    const port = this.port;
    this.port = null;
    if (port) {
      port.removeEventListener("message", this.onMessage);
      port.close();
    }
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(reason);
    }
    this.pending.clear();
  }

  isConnected(): boolean {
    return this.port !== null;
  }

  async health(timeoutMs = 2_000): Promise<CoreHealthResult> {
    const result = await this.call("core.health", {}, timeoutMs);
    return CoreHealthResultSchema.parse(result);
  }

  async ensureMailBody(accountId: string, id: string, timeoutMs = 2_000, traceId?: string): Promise<MailEnsureBodyResult> {
    const result = await this.call("mail.ensureBody", { accountId, id }, timeoutMs, undefined, traceId);
    return MailEnsureBodyResultSchema.parse(result);
  }

  async retryMailBody(accountId: string, id: string, timeoutMs = 2_000, traceId?: string, onDemand?: boolean): Promise<MailEnsureBodyResult> {
    const result = await this.call("mail.retryBody", { accountId, id, ...(onDemand ? { onDemand: true } : {}) }, timeoutMs, undefined, traceId);
    return MailEnsureBodyResultSchema.parse(result);
  }

  async focusMail(accountId: string, id: string, timeoutMs = 2_000, traceId?: string): Promise<MailFocusResult> {
    const result = await this.call("mail.focus", { accountId, id }, timeoutMs, undefined, traceId);
    return MailFocusResultSchema.parse(result);
  }

  async blurMail(accountId: string, id: string, timeoutMs = 2_000, traceId?: string): Promise<MailFocusResult> {
    const result = await this.call("mail.blur", { accountId, id }, timeoutMs, undefined, traceId);
    return MailFocusResultSchema.parse(result);
  }

  async refreshMail(accountId: string, timeoutMs = 2_000, traceId?: string): Promise<MailRefreshResult> {
    const result = await this.call("mail.refresh", { accountId }, timeoutMs, undefined, traceId);
    return MailRefreshResultSchema.parse(result);
  }

  private call(
    method: CoreMethod,
    params: unknown,
    timeoutMs: number,
    idempotencyKey?: string,
    traceId?: string,
  ): Promise<unknown> {
    const port = this.port;
    if (!port) return Promise.reject(new Error("Mail Core is unavailable"));

    const requestId = `${Date.now().toString(36)}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Mail Core request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      port.postMessage({
        version: MAIL_CORE_PROTOCOL_VERSION,
        requestId,
        traceId: traceId ?? requestId,
        method,
        params,
        deadlineMs: Date.now() + timeoutMs,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    });
  }

  private handleResponse(input: unknown): void {
    const parsed = CoreResponseSchema.safeParse(input);
    if (!parsed.success) return;
    this.settle(parsed.data);
  }

  private settle(response: CoreResponse): void {
    const request = this.pending.get(response.requestId);
    if (!request) return;
    this.pending.delete(response.requestId);
    clearTimeout(request.timeout);
    if (response.ok) {
      request.resolve(response.result);
      return;
    }
    const error = new Error(response.error.message);
    error.name = response.error.code;
    request.reject(error);
  }
}
