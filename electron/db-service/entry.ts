import type { MessagePortMain } from "electron";
import { fileURLToPath } from "node:url";
import {
  MAIL_DATABASE_PROTOCOL_VERSION,
  MailDatabaseMethodSchema,
  type MailDatabaseWorkload,
  type MailDatabaseCancelRequest,
  type MailDatabaseControlMessage,
  type MailDatabaseChangeEvent,
  type MailDatabaseHealthResult,
  type MailDatabaseRequest,
  type MailDatabaseResponse,
} from "../../shared/wemail/mailDatabaseProtocol.js";
import { DbServiceWorkerLane } from "./worker-lane.js";
import { describeError } from "./describe-error.js";
import { MAIL_DATABASE_SCHEMA_VERSION } from "../../server/wemail/database/Schema.generated.js";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("DB Service must run as an Electron Utility Process");

let controlPort: MessagePortMain | null = null;
let heartbeat: NodeJS.Timeout | null = null;
let startedAt = Date.now();
let activeSchemaVersion = 0;
const clients = new Set<MessagePortMain>();
let lanes: DbServiceWorkerLane[] = [];
const MAX_REQUEST_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_PAYLOAD_NODES = 20_000;
const MAX_RESPONSE_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_PAYLOAD_NODES = 50_000;
const MAX_REQUEST_DEADLINE_MS = 60_000;
const cancelledRequestIds = new Set<string>();

parentPort.once("message", (event) => {
  void bootstrap(event).catch(async (error) => {
    const message = describeError(error);
    controlPort?.postMessage({
      type: "mail-database.bootstrap-failed",
      code: message.includes("incompatible-mail-database")
        ? "INCOMPATIBLE_SCHEMA"
        : "BOOTSTRAP_FAILED",
      message,
    } satisfies MailDatabaseControlMessage);
    await Promise.allSettled(lanes.map((lane) => lane.stop()));
    lanes = [];
    controlPort?.close();
    controlPort = null;
    process.exitCode = 1;
  });
});

async function bootstrap(event: {
  data: unknown;
  ports: MessagePortMain[];
}): Promise<void> {
  const input = event.data as {
    type?: string;
    protocolVersion?: number;
    databasePath?: string;
  };
  const [port] = event.ports;
  if (
    input.type !== "mail-database.bootstrap" ||
    input.protocolVersion !== MAIL_DATABASE_PROTOCOL_VERSION ||
    typeof input.databasePath !== "string" ||
    !port
  ) {
    throw new Error("DB Service bootstrap protocol mismatch");
  }
  controlPort = port;
  activeSchemaVersion = MAIL_DATABASE_SCHEMA_VERSION;
  controlPort.on("message", (messageEvent) => {
    handleControl(messageEvent.data as MailDatabaseControlMessage, messageEvent.ports);
  });
  controlPort.start();
  const readerEntry = fileURLToPath(new URL("./reader-entry.js", import.meta.url));
  const writerEntry = fileURLToPath(new URL("./writer-entry.js", import.meta.url));
  const makeLane = (
    label: ConstructorParameters<typeof DbServiceWorkerLane>[0]["label"],
    mode: "reader" | "writer",
  ) => new DbServiceWorkerLane({
    entryPath: mode === "reader" ? readerEntry : writerEntry,
    databasePath: input.databasePath!,
    label,
    mode,
    // The request deadline remains authoritative. This is only the worker
    // guard used when a caller has not supplied a shorter deadline. Writer
    // maintenance scans (notably reconcileAiJobs) can legitimately exceed
    // the interactive reader budget during cold startup.
    requestTimeoutMs: label === "maintenance" ? 60_000 : label === "writer"
      ? 15_000
      : label === "search"
        ? 5_000
        : 2_000,
    idleTimeoutMs: label === "maintenance" ? 60_000 : label === "search" ? 5 * 60_000 : undefined,
    log: (phase, extra) => console.info(JSON.stringify({ phase, ...extra })),
  });
  const writer = makeLane("writer", "writer");
  await writer.start();
  lanes = [
    writer,
    makeLane("detail", "reader"),
    makeLane("background", "reader"),
    makeLane("list-a", "reader"),
    makeLane("aggregate", "reader"),
    makeLane("search", "reader"),
    makeLane("maintenance", "reader"),
  ];
  // Prewarm every interactive lane before declaring DB Service ready. This
  // moves worker startup outside click/category/search latency. The maintenance
  // reader starts on demand and never shares an interactive or AI reader. Search remains
  // idle-reapable after five minutes; detail/list stay resident because they
  // are the primary desktop interaction path and use bounded SQLite caches.
  await Promise.all(lanes.slice(1).filter((lane) => lane.health().label !== "maintenance").map((lane) => lane.start()));
  controlPort.postMessage({
    type: "mail-database.ready",
    protocolVersion: MAIL_DATABASE_PROTOCOL_VERSION,
    pid: process.pid,
    schemaVersion: activeSchemaVersion,
  } satisfies MailDatabaseControlMessage);
  heartbeat = setInterval(() => {
    controlPort?.postMessage({
      type: "mail-database.heartbeat",
      at: Date.now(),
      pid: process.pid,
    } satisfies MailDatabaseControlMessage);
  }, 5_000);
  heartbeat.unref();
}

function handleControl(
  message: MailDatabaseControlMessage,
  ports: MessagePortMain[],
): void {
  if (message.type === "mail-database.ping") {
    controlPort?.postMessage({
      type: "mail-database.pong",
      probeId: message.probeId,
      at: Date.now(),
      pid: process.pid,
    } satisfies MailDatabaseControlMessage);
    return;
  }
  if (message.type === "mail-database.attach-client") {
    const [client] = ports;
    if (client) attachClient(client, message.workload === "background" ? "background" : "interactive");
    return;
  }
  if (message.type === "mail-database.shutdown") {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    for (const client of clients) client.close();
    clients.clear();
    void Promise.all(lanes.map((lane) => lane.stop())).finally(() => {
      lanes = [];
      controlPort?.postMessage({
        type: "mail-database.shutdown-complete",
      } satisfies MailDatabaseControlMessage);
      controlPort?.close();
      controlPort = null;
    });
  }
}

function attachClient(client: MessagePortMain, workload: MailDatabaseWorkload): void {
  clients.add(client);
  client.on("message", (event) => {
    void handleClientRequest(client, event.data, workload);
  });
  client.once("close", () => clients.delete(client));
  client.start();
}

async function handleClientRequest(
  client: MessagePortMain,
  input: unknown,
  workload: MailDatabaseWorkload,
): Promise<void> {
  const receivedAt = Date.now();
  const cancellation = parseCancellation(input);
  if (cancellation) {
    cancelledRequestIds.add(cancellation.requestId);
    for (const lane of lanes) {
      if (lane.cancel(cancellation.requestId)) break;
    }
    const expiry = setTimeout(() => {
      cancelledRequestIds.delete(cancellation.requestId);
    }, MAX_REQUEST_DEADLINE_MS);
    expiry.unref();
    return;
  }
  const request = parseRequest(input);
  if (!request) return;
  if (request.deadlineMs <= receivedAt) {
    respondFailure(client, request.requestId, "DEADLINE_EXPIRED", "Request deadline expired");
    traceRequest(request, receivedAt, {
      outcome: "deadline-expired",
      errorCode: "DEADLINE_EXPIRED",
    });
    return;
  }
  if (request.method === "database.health") {
    const health: MailDatabaseHealthResult = {
      protocolVersion: MAIL_DATABASE_PROTOCOL_VERSION,
      state: "ready",
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      schemaVersion: activeSchemaVersion,
      commitVersion: writerCommitVersion(),
      lanes: lanes.map((lane) => lane.health()),
    };
    respondSuccess(client, request, health, 0, 0, "gateway", receivedAt);
    return;
  }
  const lane = route(request.method, workload);
  try {
    if (lane.health().threadId === null) await lane.start();
    if (cancelledRequestIds.has(request.requestId)) {
      throw new Error("request-cancelled");
    }
    const response = await lane.call(request);
    if (cancelledRequestIds.has(request.requestId)) return;
    if (!payloadWithinBounds(
      response.result,
      MAX_RESPONSE_PAYLOAD_BYTES,
      MAX_RESPONSE_PAYLOAD_NODES,
    )) {
      throw new Error("response-payload-too-large");
    }
    publishWriteResult(response.result);
    respondSuccess(
      client,
      request,
      response.result,
      response.queueMs,
      response.handlerMs,
      lane.health().label,
      receivedAt,
    );
    traceRequest(request, receivedAt, {
      outcome: "success",
      queueMs: response.queueMs,
      handlerMs: response.handlerMs,
      lane: lane.health().label,
      ...(request.method === "mail.getSnapshot"
        ? snapshotTrace(response.result)
        : {}),
    });
  } catch (error) {
    if (cancelledRequestIds.has(request.requestId)) return;
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = message.includes("response-payload-too-large")
      ? "RESPONSE_TOO_LARGE"
      : message.includes("timeout")
      ? "QUERY_TIMEOUT"
      : request.method === "agent.writeActionExecution" || request.method === "directory.write" || request.method === "channels.leaseNext" ||
          request.method === "settings.saveBusinessPreferences" ||
          request.method === "maintenance.runRetentionBatch" ||
          request.method === "mail.configureAccount" ||
          request.method === "mail.mutate" ||
          request.method === "mail.persistMetadata" ||
          request.method === "mail.persistBody" ||
          request.method === "mail.failBody" ||
          request.method === "mail.resetBodyFailure" ||
          request.method === "mail.saveDraft" ||
          request.method === "mail.enqueueSend" ||
          request.method === "mail.deleteDraft" ||
          request.method === "mail.setSnooze" ||
          request.method === "mail.cancelScheduled" ||
          request.method === "mail.deleteScheduled" ||
          request.method.startsWith("queue.")
        ? "WRITE_FAILED"
        : "QUERY_FAILED";
    respondFailure(
      client,
      request.requestId,
      errorCode,
      message,
    );
    traceRequest(request, receivedAt, {
      outcome: "failure",
      lane: lane.health().label,
      errorCode,
    });
  } finally {
    cancelledRequestIds.delete(request.requestId);
  }
}

function traceRequest(
  request: MailDatabaseRequest,
  receivedAt: number,
  details: Omit<
    Extract<MailDatabaseControlMessage, { type: "mail-database.request-trace" }>,
    "type" | "method" | "requestId" | "traceId" | "totalMs"
  >,
): void {
  // Request traces deliberately contain timing/state only. Never send message
  // identifiers, subjects, recipients, or body content to the boot log.
  controlPort?.postMessage({
    type: "mail-database.request-trace",
    method: request.method,
    requestId: request.requestId,
    traceId: request.traceId,
    totalMs: Math.max(0, Date.now() - receivedAt),
    ...details,
  } satisfies MailDatabaseControlMessage);
}

function snapshotTrace(result: unknown): {
  found: boolean;
  bodyState?: "ready" | "missing" | "fetching" | "failed";
} {
  if (!result || typeof result !== "object") return { found: false };
  const snapshot = result as { message?: unknown; bodyState?: unknown };
  const bodyState = snapshot.bodyState;
  return {
    found: !!snapshot.message,
    ...(bodyState === "ready" ||
    bodyState === "missing" ||
    bodyState === "fetching" ||
    bodyState === "failed"
      ? { bodyState }
      : {}),
  };
}

function parseRequest(input: unknown): MailDatabaseRequest | null {
  if (!input || typeof input !== "object") return null;
  const request = input as Partial<MailDatabaseRequest>;
  if (
    request.version !== MAIL_DATABASE_PROTOCOL_VERSION ||
    typeof request.requestId !== "string" ||
    request.requestId.length > 200 ||
    typeof request.traceId !== "string" ||
    request.traceId.length > 200 ||
    typeof request.deadlineMs !== "number" ||
    request.deadlineMs > Date.now() + MAX_REQUEST_DEADLINE_MS ||
    !payloadWithinBounds(
      request.params,
      MAX_REQUEST_PAYLOAD_BYTES,
      MAX_REQUEST_PAYLOAD_NODES,
    ) ||
    !MailDatabaseMethodSchema.safeParse(request.method).success
  ) {
    return null;
  }
  return request as MailDatabaseRequest;
}

function parseCancellation(input: unknown): MailDatabaseCancelRequest | null {
  if (!input || typeof input !== "object") return null;
  const cancellation = input as Partial<MailDatabaseCancelRequest>;
  if (
    cancellation.version !== MAIL_DATABASE_PROTOCOL_VERSION
    || cancellation.type !== "mail-database.cancel"
    || typeof cancellation.requestId !== "string"
    || cancellation.requestId.length === 0
    || cancellation.requestId.length > 200
  ) {
    return null;
  }
  return cancellation as MailDatabaseCancelRequest;
}

function payloadWithinBounds(
  value: unknown,
  maxBytes: number,
  maxNodes: number,
): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > maxNodes) return false;
    if (typeof current === "string") {
      bytes += current.length * 2;
    } else if (typeof current === "number" || typeof current === "bigint") {
      bytes += 16;
    } else if (typeof current === "boolean") {
      bytes += 4;
    } else if (current && typeof current === "object") {
      if (seen.has(current)) return false;
      seen.add(current);
      if (Array.isArray(current)) {
        if (current.length + nodes > maxNodes) return false;
        for (const nested of current) pending.push(nested);
      } else {
        for (const [key, nested] of Object.entries(current)) {
          bytes += key.length * 2;
          pending.push(nested);
        }
      }
    }
    if (bytes > maxBytes) return false;
  }
  return true;
}

function route(method: MailDatabaseRequest["method"], workload: MailDatabaseWorkload): DbServiceWorkerLane {
  const byLabel = (label: string) => {
    const lane = lanes.find((candidate) => candidate.health().label === label);
    if (!lane) throw new Error(`missing-db-lane:${label}`);
    return lane;
  };
  if (method === "database.checkIntegrity") return byLabel("maintenance");
  if (
    method === "agent.writeActionExecution" || method === "directory.write" || method === "channels.leaseNext" ||
    method === "mail.mutate" ||
    method === "settings.saveBusinessPreferences" ||
    method === "intelligence.recordUsage" ||
    method === "mail.configureAccount" ||
    method === "mail.persistMetadata" ||
    method === "mail.persistBody" ||
    method === "mail.failBody" ||
    method === "mail.resetBodyFailure" ||
    method === "mail.requestIntelligence" ||
    method === "mail.saveDraft" ||
    method === "mail.enqueueSend" ||
    method === "mail.deleteDraft" ||
    method === "mail.setSnooze" ||
    method === "mail.cancelScheduled" ||
    method === "mail.deleteScheduled" ||
    method === "maintenance.startCjkSearchIndexBuild" ||
    method === "maintenance.runRetentionBatch" ||
    method.startsWith("queue.")
  ) return byLabel("writer");
  if (workload === "background" || method === "agent.getActionExecution" || method === "directory.read" || method === "agent.listPendingActions" || method.startsWith("intelligence.") || method.startsWith("settings.")) return byLabel("background");
  if (
    method === "mail.getSnapshot" ||
    method === "mail.getDraft" ||
    method === "mail.getIntelligence" ||
    method === "mail.getSyncCursor" ||
    method === "mail.getSyncStates" ||
    method === "mail.listAccounts"
  ) {
    return byLabel("detail");
  }
  if (method === "mail.search") return byLabel("search");
  if (method === "database.changesSince") return byLabel("aggregate");
  if (method === "mail.listFolders" || method === "mail.listCategories") {
    return byLabel("aggregate");
  }
  return byLabel("list-a");
}

function writerCommitVersion(): number {
  return lanes.find((lane) => lane.health().label === "writer")
    ?.health().commitVersion ?? 0;
}

function publishWriteResult(result: unknown): void {
  if (!result || typeof result !== "object") return;
  const candidate = result as { commitVersion?: unknown; changes?: unknown };
  if (
    typeof candidate.commitVersion !== "number" ||
    !Array.isArray(candidate.changes) ||
    candidate.changes.length === 0
  ) {
    return;
  }
  const event: MailDatabaseChangeEvent = {
    type: "mail-database.changed",
    commitVersion: candidate.commitVersion,
    changes: candidate.changes as MailDatabaseChangeEvent["changes"],
  };
  for (const client of clients) client.postMessage(event);
}

function respondSuccess(
  client: MessagePortMain,
  request: MailDatabaseRequest,
  result: unknown,
  queueMs: number,
  handlerMs: number,
  lane: string,
  receivedAt: number,
): void {
  client.postMessage({
    version: MAIL_DATABASE_PROTOCOL_VERSION,
    requestId: request.requestId,
    ok: true,
    result,
    timing: {
      queueMs,
      handlerMs,
      totalMs: Math.max(0, Date.now() - receivedAt),
      lane,
    },
  } satisfies MailDatabaseResponse);
}

function respondFailure(
  client: MessagePortMain,
  requestId: string,
  code: string,
  message: string,
): void {
  client.postMessage({
    version: MAIL_DATABASE_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: {
      code,
      message,
      retryable: code === "QUERY_TIMEOUT",
    },
  } satisfies MailDatabaseResponse);
}
