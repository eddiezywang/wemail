import {
  MAIL_DATABASE_PROTOCOL_VERSION,
  type MailDatabaseWorkload,
  type MailDatabaseCancelRequest,
  type MailDatabaseRequest,
  type MailDatabaseResponse,
} from "../../shared/wemail/mailDatabaseProtocol.js";

export interface MailDatabaseBrokerPort {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  once(event: "close", listener: () => void): unknown;
  start(): void;
  postMessage(message: unknown): void;
  close(): void;
}

interface QueuedRequest {
  request: MailDatabaseRequest;
  timer: NodeJS.Timeout;
}

interface BrokerClient {
  workload: MailDatabaseWorkload;
  downstream: MailDatabaseBrokerPort;
  upstream: MailDatabaseBrokerPort | null;
  upstreamGeneration: number;
  queued: Map<string, QueuedRequest>;
  inFlight: Map<string, MailDatabaseRequest["version"]>;
  closed: boolean;
}

const MAX_QUEUED_REQUESTS_PER_CLIENT = 200;

/**
 * Keeps consumer-facing MessagePorts stable while DB Service processes restart.
 * Only the broker's upstream port is replaced. In-flight requests fail fast so
 * callers can retry without permanently closing their producer.
 */
export class MailDatabasePortBroker {
  private readonly clients = new Set<BrokerClient>();
  private upstreamFactory: ((workload: MailDatabaseWorkload) => MailDatabaseBrokerPort) | null = null;

  registerClient(downstream: MailDatabaseBrokerPort, workload: MailDatabaseWorkload = "interactive"): void {
    const client: BrokerClient = {
      downstream,
      workload,
      upstream: null,
      upstreamGeneration: 0,
      queued: new Map(),
      inFlight: new Map(),
      closed: false,
    };
    this.clients.add(client);
    downstream.on("message", (event) => this.handleDownstream(client, event.data));
    downstream.once("close", () => this.closeClient(client));
    downstream.start();
    this.connectClient(client);
  }

  replaceUpstreamFactory(factory: ((workload: MailDatabaseWorkload) => MailDatabaseBrokerPort) | null): void {
    this.upstreamFactory = factory;
    for (const client of this.clients) {
      this.disconnectUpstream(client, "DB_SERVICE_RESTARTED");
      this.connectClient(client);
    }
  }

  failUnavailable(code: string, message: string): void {
    for (const client of this.clients) {
      this.disconnectUpstream(client, code);
      for (const queued of client.queued.values()) {
        clearTimeout(queued.timer);
        this.respondFailure(client, queued.request, code, message, true);
      }
      client.queued.clear();
    }
  }

  close(): void {
    this.upstreamFactory = null;
    for (const client of [...this.clients]) {
      this.closeClient(client);
      client.downstream.close();
    }
  }

  private handleDownstream(client: BrokerClient, input: unknown): void {
    if (client.closed) return;
    const cancellation = parseCancellation(input);
    if (cancellation) {
      const queued = client.queued.get(cancellation.requestId);
      if (queued) {
        clearTimeout(queued.timer);
        client.queued.delete(cancellation.requestId);
      }
      client.inFlight.delete(cancellation.requestId);
      client.upstream?.postMessage(cancellation);
      return;
    }
    const request = parseRequest(input);
    if (!request) return;
    if (request.deadlineMs <= Date.now()) {
      this.respondFailure(
        client,
        request,
        "DEADLINE_EXPIRED",
        "DB Service request deadline expired",
        true,
      );
      return;
    }
    if (client.upstream) {
      client.inFlight.set(request.requestId, request.version);
      client.upstream.postMessage(request);
      return;
    }
    if (client.queued.size >= MAX_QUEUED_REQUESTS_PER_CLIENT) {
      this.respondFailure(
        client,
        request,
        "DB_SERVICE_UNAVAILABLE",
        "DB Service is restarting",
        true,
      );
      return;
    }
    const timer = setTimeout(() => {
      if (!client.queued.delete(request.requestId)) return;
      this.respondFailure(
        client,
        request,
        "DEADLINE_EXPIRED",
        "DB Service request deadline expired while waiting for restart",
        true,
      );
    }, Math.max(1, request.deadlineMs - Date.now()));
    timer.unref();
    client.queued.set(request.requestId, { request, timer });
  }

  private connectClient(client: BrokerClient): void {
    if (client.closed || client.upstream || !this.upstreamFactory) return;
    let upstream: MailDatabaseBrokerPort;
    try {
      upstream = this.upstreamFactory(client.workload);
    } catch {
      return;
    }
    const generation = client.upstreamGeneration + 1;
    client.upstreamGeneration = generation;
    client.upstream = upstream;
    upstream.on("message", (event) => {
      if (
        client.closed ||
        client.upstream !== upstream ||
        client.upstreamGeneration !== generation
      ) {
        return;
      }
      const requestId = responseRequestId(event.data);
      if (requestId) client.inFlight.delete(requestId);
      client.downstream.postMessage(event.data);
    });
    upstream.once("close", () => {
      if (
        client.upstream !== upstream ||
        client.upstreamGeneration !== generation
      ) {
        return;
      }
      client.upstream = null;
      this.failInFlight(client, "DB_SERVICE_RESTARTED");
    });
    upstream.start();
    for (const [requestId, queued] of client.queued) {
      clearTimeout(queued.timer);
      client.queued.delete(requestId);
      if (queued.request.deadlineMs <= Date.now()) {
        this.respondFailure(
          client,
          queued.request,
          "DEADLINE_EXPIRED",
          "DB Service request deadline expired while waiting for restart",
          true,
        );
        continue;
      }
      client.inFlight.set(requestId, queued.request.version);
      upstream.postMessage(queued.request);
    }
  }

  private disconnectUpstream(client: BrokerClient, code: string): void {
    const upstream = client.upstream;
    client.upstream = null;
    client.upstreamGeneration += 1;
    upstream?.close();
    this.failInFlight(client, code);
  }

  private failInFlight(client: BrokerClient, code: string): void {
    for (const [requestId, version] of client.inFlight) {
      client.downstream.postMessage({
        version,
        requestId,
        ok: false,
        error: {
          code,
          message: "DB Service restarted while the request was in flight",
          retryable: true,
        },
      } satisfies MailDatabaseResponse);
    }
    client.inFlight.clear();
  }

  private respondFailure(
    client: BrokerClient,
    request: MailDatabaseRequest,
    code: string,
    message: string,
    retryable: boolean,
  ): void {
    client.downstream.postMessage({
      version: request.version,
      requestId: request.requestId,
      ok: false,
      error: { code, message, retryable },
    } satisfies MailDatabaseResponse);
  }

  private closeClient(client: BrokerClient): void {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client);
    for (const queued of client.queued.values()) clearTimeout(queued.timer);
    client.queued.clear();
    client.inFlight.clear();
    client.upstream?.close();
    client.upstream = null;
  }
}

function parseRequest(input: unknown): MailDatabaseRequest | null {
  if (!input || typeof input !== "object") return null;
  const request = input as Partial<MailDatabaseRequest>;
  return request.version === MAIL_DATABASE_PROTOCOL_VERSION &&
    typeof request.requestId === "string" &&
    typeof request.traceId === "string" &&
    typeof request.method === "string" &&
    typeof request.deadlineMs === "number"
    ? (input as MailDatabaseRequest)
    : null;
}

function parseCancellation(input: unknown): MailDatabaseCancelRequest | null {
  if (!input || typeof input !== "object") return null;
  const cancellation = input as Partial<MailDatabaseCancelRequest>;
  return cancellation.version === MAIL_DATABASE_PROTOCOL_VERSION &&
    cancellation.type === "mail-database.cancel" &&
    typeof cancellation.requestId === "string"
    ? (input as MailDatabaseCancelRequest)
    : null;
}

function responseRequestId(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const requestId = (input as Partial<MailDatabaseResponse>).requestId;
  return typeof requestId === "string" ? requestId : undefined;
}
