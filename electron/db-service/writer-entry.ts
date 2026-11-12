import { MailDatabaseChannelLeaseParamsSchema } from "../../shared/wemail/mailDatabaseProtocol.js";
import { DirectoryWriteParamsSchema } from "../../shared/wemail/directoryDatabase.js";
import { DatabaseRetentionBatchParamsSchema } from "../../shared/wemail/retention.js";
import { BusinessPreferencesPatchSchema } from "../../shared/wemail/businessPreferences.js";
import { parentPort, threadId, workerData } from "node:worker_threads";
import type {
  MailDatabaseWorkerData,
  MailDatabaseWorkerEvent,
  MailDatabaseWorkerRequest,
} from "../../shared/wemail/mailDatabaseProtocol.js";
import {
  MailDatabaseFailBodyParamsSchema,
  MailDatabaseConfigureAccountParamsSchema,
  MailDatabaseMutationParamsSchema,
  MailDatabaseRequestIntelligenceParamsSchema,
  MailDatabasePersistBodyParamsSchema,
  MailDatabasePersistMetadataParamsSchema,
  MailDatabaseClaimJobParamsSchema,
  MailDatabaseResetAiJobsParamsSchema,
  MailDatabaseCompleteRemoteMutationParamsSchema,
  MailDatabaseEnqueueJobParamsSchema,
  MailDatabaseEnqueueSendParamsSchema,
  MailDatabaseSaveDraftParamsSchema,
  MailDatabaseRecordAiUsageParamsSchema,
} from "../../shared/wemail/mailDatabaseProtocol.js";
import fs from "node:fs";
import {
  createMailDatabase,
  openMailDatabase,
  validateMailDatabase,
} from "../../server/wemail/database/Database.js";
import { runMailDatabaseMigrations } from "../../server/wemail/database/Migrations.js";
import { MAIL_DATABASE_SCHEMA_VERSION } from "../../server/wemail/database/Schema.generated.js";
import { MailDatabaseQueryRepository } from "../../server/wemail/database/MailDatabaseQueryRepository.js";
import { AgentPendingActionRepository } from "../../server/wemail/agent/AgentPendingActionRepository.js";
import { ActionExecutionRepository } from "../../server/wemail/agent/ActionExecutionRepository.js";
import { ActionExecutionCommandSchema } from "../../shared/wemail/actionExecution.js";
import { describeError } from "./describe-error.js";
import { MailDatabaseWriter } from "../../server/wemail/database/MailDatabaseWriter.js";
import { AiUsageRepository } from "../../server/wemail/settings/AiUsageRepository.js";

/**
 * Writer-lane AI/background queue methods. Routed to backgroundQueue so the
 * continuous AI drain (claim → LLM → complete, thousands of ops during a
 * backlog) can never jump ahead of a user-facing write. The drain loop
 * shifts interactiveQueue first and only touches backgroundQueue when
 * interactive is empty, so a mark-read / persistBody / saveDraft issued
 * mid-drain no longer sits behind a pile of claimJob/completeAiArtifact
 * (observed ~1.1s queueMs on mail.mutate while the AI worker drained).
 * Send-path queue ops (claimSend/completeSend/…) stay interactive.
 */
const AI_BACKGROUND_QUEUE_METHODS = new Set<string>([
  "directory.write",
  "channels.leaseNext",
  "maintenance.runRetentionBatch",
  "intelligence.recordUsage",
  "queue.claimJob",
  "queue.completeJob",
  "queue.completeAiArtifact",
  "queue.completeAiArtifactBatch",
  "queue.failJob",
  "queue.terminalJob",
  "queue.deferJob",
  "queue.reconcileAiJobs",
  "queue.reconcileBodyHydration",
  "queue.resetTerminalAiJobs",
  "queue.nextJobDue",
]);

if (!parentPort) throw new Error("DB Service writer must run in a worker thread");
const workerPort = parentPort;
const data = workerData as MailDatabaseWorkerData;
const db = fs.existsSync(data.databasePath)
  ? openMailDatabase(data.databasePath, { fileMustExist: true })
  : createMailDatabase(data.databasePath);
// Startup gate uses only the cheap schema_version check (integrityCheck:
// false). quick_check/foreign_key_check are full-DB scans that gate readiness
// and blow the 30s budget on a large/cold database; they still run inside
// runMailDatabaseMigrations (assertMigrationIntegrity) whenever a migration
// applies, so the per-startup sweep is redundant in the common no-migration
// case. schemaVersion stays the authoritative incompatible-DB gate.
const validation = validateMailDatabase(db, { integrityCheck: false });
if (
  validation.schemaVersion !== MAIL_DATABASE_SCHEMA_VERSION ||
  validation.quickCheck.some((value) => value !== "ok") ||
  validation.foreignKeyErrors.length > 0
) {
  db.close();
  throw new Error(
    `incompatible-mail-database: run npm run reset:demo-data -- --yes`,
  );
}
let migrationResult: ReturnType<typeof runMailDatabaseMigrations>;
try {
  migrationResult = runMailDatabaseMigrations(db);
} catch (error) {
  db.close();
  throw error;
}
if (migrationResult.applied.length > 0) {
  process.stdout.write(
    `[db-service:${data.label}] migrated database ${migrationResult.fromVersion}`
    + ` -> ${migrationResult.toVersion}: ${migrationResult.applied.join(", ")}\n`,
  );
}
const queries = new MailDatabaseQueryRepository(db);
const aiUsage = new AiUsageRepository(db);
const writer = new MailDatabaseWriter(db, {
  // Drain side (CanonicalAiWorker) reads the same flag; keeping enqueue in
  // sync means a disabled reply-decision produces no pending ai.reply-decision
  // backlog.
  replyDecisionEnabled: process.env.WEMAIL_REPLY_DECISION_ENABLED === "1",
});
// One-shot cleanup: cancel pending legacy-kind jobs that have no canonical
// consumer (Layer-A JobRepository paths produce summary/tags/… that nothing
// claims). Idempotent — only affects state='pending' legacy rows.
const orphanedCancelled = writer.cancelOrphanedLegacyJobs();
if (orphanedCancelled > 0) {
  process.stderr.write(
    `[db-service:${data.label}] cancelled ${orphanedCancelled} orphaned legacy jobs\n`,
  );
}
const interactiveQueue: Extract<MailDatabaseWorkerRequest, { type: "query" }>[] = [];
const backgroundQueue: Extract<MailDatabaseWorkerRequest, { type: "query" }>[] = [];
let draining = false;
let cjkIndexTimer: NodeJS.Timeout | null = null;
let cjkIndexBuildStarted = false;
const heartbeat = setInterval(() => {
  workerPort.postMessage({
    type: "heartbeat",
    label: data.label,
    threadId,
    at: Date.now(),
    commitVersion: writer.commitVersion(),
    queueDepth: interactiveQueue.length + backgroundQueue.length,
  } satisfies MailDatabaseWorkerEvent);
}, 5_000);
heartbeat.unref();

// Best-effort periodic PASSIVE checkpoint. wal_autocheckpoint=1000 already
// triggers PASSIVE, but under sustained readers it may not complete; this
// nudges it from the writer thread (the natural owner) and logs busy/log/
// checkpointed so the real WAL blocker can be correlated with queue depth,
// lane restarts, and request queueMs/handlerMs. PASSIVE never blocks.
const checkpoint = setInterval(() => {
  try {
    const rows = db.pragma("wal_checkpoint(PASSIVE)") as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const r = rows[0];
    if (r && (r.busy || r.checkpointed > 0)) {
      process.stderr.write(
        `[db-service:${data.label}] wal_checkpoint(PASSIVE) busy=${r.busy} log=${r.log} checkpointed=${r.checkpointed}\n`,
      );
    }
  } catch {
    /* best-effort; PASSIVE is non-blocking */
  }
}, 30_000);
checkpoint.unref();

const pendingActions = new AgentPendingActionRepository({ db });
const actionExecutions = new ActionExecutionRepository(db);

// One bounded sweep per service, rather than one sweep per consumer claim.
writer.recoverExpiredJobLeases();
const leaseRecovery = setInterval(() => {
  if (interactiveQueue.length > 0) return;
  try {
    writer.recoverExpiredJobLeases();
    pendingActions.expireStale();
  } catch (error) {
    process.stderr.write(`[db-service:${data.label}] lease recovery failed: ${describeError(error)}\n`);
  }
}, 1_000);
leaseRecovery.unref();

workerPort.on("message", (request: MailDatabaseWorkerRequest) => {
  if (request.type === "shutdown") {
    respond(request.requestId, {
      schemaVersion: queries.schemaVersion(),
      commitVersion: queries.commitVersion(),
    });
    clearInterval(heartbeat);
    clearInterval(checkpoint);
    clearInterval(leaseRecovery);
    if (cjkIndexTimer) clearTimeout(cjkIndexTimer);
    cjkIndexTimer = null;
    db.close();
    workerPort.close();
    return;
  }
  if (request.type === "health") {
    respond(request.requestId, {
      schemaVersion: queries.schemaVersion(),
      commitVersion: queries.commitVersion(),
    });
    return;
  }
  const queue = isInteractiveRequest(request)
    ? interactiveQueue
    : backgroundQueue;
  queue.push(request);
  scheduleDrain();
});

workerPort.postMessage({
  type: "ready",
  label: data.label,
  threadId,
  commitVersion: writer.commitVersion(),
  queueDepth: 0,
} satisfies MailDatabaseWorkerEvent);

function scheduleDrain(): void {
  if (draining) return;
  draining = true;
  setImmediate(drainNext);
}

function scheduleCjkIndexRebuild(delayMs = 75): void {
  if (cjkIndexTimer) return;
  cjkIndexTimer = setTimeout(() => {
    cjkIndexTimer = null;
    if (draining || interactiveQueue.length > 0 || backgroundQueue.length > 0) {
      scheduleCjkIndexRebuild(500);
      return;
    }
    try {
      const result = writer.rebuildCjkSearchIndexBatch(10);
      if (result.indexedCount > 0 && !cjkIndexBuildStarted) {
        cjkIndexBuildStarted = true;
        process.stdout.write(`[db-service:${data.label}] CJK search index build started\n`);
      }
      if (result.complete) {
        if (cjkIndexBuildStarted) {
          process.stdout.write(`[db-service:${data.label}] CJK search index ready\n`);
        }
        return;
      }
      scheduleCjkIndexRebuild();
    } catch (error) {
      process.stderr.write(
        `[db-service:${data.label}] CJK search index rebuild failed: ${describeError(error)}\n`,
      );
      scheduleCjkIndexRebuild(5_000);
    }
  }, delayMs);
  cjkIndexTimer.unref();
}

function isInteractiveRequest(
  request: Extract<MailDatabaseWorkerRequest, { type: "query" }>,
): boolean {
  const method = request.request.method;
  if (!method.startsWith("queue.")) {
    return method === "mail.mutate" ||
      method === "mail.requestIntelligence" ||
      method === "mail.configureAccount" ||
      method === "mail.persistBody" ||
      method === "mail.failBody" ||
      method === "mail.resetBodyFailure" ||
      method === "mail.saveDraft" ||
      method === "mail.enqueueSend" ||
      method === "mail.deleteDraft" ||
      method === "mail.cancelScheduled" ||
      method === "mail.deleteScheduled" ||
      method === "mail.setSnooze";
  }
  if (!AI_BACKGROUND_QUEUE_METHODS.has(method)) {
    return true;
  }
  // A focused message claims its exact body job. Keep that claim and its
  // account-owned completion/failure ahead of AI maintenance work.
  if (method === "queue.claimJob") {
    const filter = (request.request.params as {
      filter?: { subjectPublicId?: unknown; priorities?: unknown; minPriority?: unknown };
    })?.filter;
    // Interactive (foreground) lane only for an exact-message claim
    // (subjectPublicId) or a claim that exclusively targets priority 0
    // (on-demand ensureBody). Background body hydration uses minPriority>=1
    // (no priority-0), so it must take the background lane and never compete
    // with foreground user writes.
    if (typeof filter?.subjectPublicId === "string") return true;
    const priorities = Array.isArray(filter?.priorities) ? filter.priorities : [];
    return priorities.length === 1 && priorities[0] === 0;
  }
  if (
    method === "queue.completeJob" ||
    method === "queue.failJob" ||
    method === "queue.deferJob" ||
    method === "queue.terminalJob"
  ) {
    const owner = (request.request.params as { owner?: unknown })?.owner;
    return typeof owner === "string" &&
      owner.startsWith("account:") &&
      !owner.includes(":metadata:") &&
      !owner.includes(":body-prefetch:");
  }
  return false;
}

function drainNext(): void {
  const request = interactiveQueue.shift() ?? backgroundQueue.shift();
  if (!request) {
    draining = false;
    return;
  }
  const startedAt = Date.now();
  try {
    let result: unknown;
    switch (request.request.method) {
      case "agent.writeActionExecution":
        result = actionExecutions.dispatch(ActionExecutionCommandSchema.parse(request.request.params));
        break;
      case "directory.write":
        result = writer.writeDirectory(DirectoryWriteParamsSchema.parse(request.request.params));
        break;
      case "channels.leaseNext":
        result = writer.leaseChannelWork(MailDatabaseChannelLeaseParamsSchema.parse(request.request.params));
        break;
      case "intelligence.recordUsage":
        aiUsage.record(MailDatabaseRecordAiUsageParamsSchema.parse(request.request.params));
        result = true;
        break;
      case "maintenance.runRetentionBatch":
        result = writer.runRetentionBatch(DatabaseRetentionBatchParamsSchema.parse(request.request.params));
        break;
      case "maintenance.startCjkSearchIndexBuild":
        scheduleCjkIndexRebuild();
        result = true;
        break;
      case "mail.configureAccount":
        result = writer.configureAccount(
          MailDatabaseConfigureAccountParamsSchema.parse(request.request.params),
        );
        break;
      case "mail.mutate":
        result = writer.mutate(
          MailDatabaseMutationParamsSchema.parse(request.request.params),
        );
        break;
      case "mail.persistMetadata":
        result = writer.persistMetadata(
          MailDatabasePersistMetadataParamsSchema.parse(request.request.params),
        );
        break;
      case "mail.persistBody":
        result = writer.persistBody(
          MailDatabasePersistBodyParamsSchema.parse(request.request.params),
        );
        break;
      case "mail.failBody":
        result = writer.failBody(
          MailDatabaseFailBodyParamsSchema.parse(request.request.params),
        );
        break;
      case "settings.saveBusinessPreferences":
        result = writer.saveBusinessPreferences(BusinessPreferencesPatchSchema.parse(request.request.params));
        break;
      case "mail.requestIntelligence":
        result = writer.requestIntelligence(
          MailDatabaseRequestIntelligenceParamsSchema.parse(request.request.params),
        );
        break;
      case "mail.resetBodyFailure": {
        const params = request.request.params as { accountId?: unknown; emailId?: unknown };
        if (typeof params?.accountId !== "string" || typeof params.emailId !== "string") {
          throw new Error("invalid-body-reset-params");
        }
        result = writer.resetBodyFailure(params.accountId, params.emailId);
        break;
      }
      case "queue.enqueueJob":
        result = writer.enqueueJob(
          MailDatabaseEnqueueJobParamsSchema.parse(request.request.params),
        );
        break;
      case "queue.reconcileAiJobs": {
        const limit = (request.request.params as { limit?: unknown })?.limit;
        result = writer.reconcileAiJobs(typeof limit === "number" ? limit : undefined);
        break;
      }
      case "queue.reconcileBodyHydration": {
        const params = request.request.params as {
          accountId?: unknown;
          limit?: unknown;
          nowMs?: unknown;
          base?: unknown;
          minuteMs?: unknown;
          maxPriority?: unknown;
        };
        if (typeof params?.accountId !== "string") {
          throw new Error("invalid-reconcile-body-hydration-params");
        }
        result = writer.reconcileBodyHydration(params.accountId, {
          limit: typeof params.limit === "number" ? params.limit : undefined,
          nowMs: typeof params.nowMs === "number" ? params.nowMs : undefined,
          base: typeof params.base === "number" ? params.base : undefined,
          minuteMs: typeof params.minuteMs === "number" ? params.minuteMs : undefined,
          maxPriority: typeof params.maxPriority === "number" ? params.maxPriority : undefined,
        });
        break;
      }
      case "mail.saveDraft":
        result = writer.saveDraft(
          MailDatabaseSaveDraftParamsSchema.parse(request.request.params),
        );
        break;
      case "mail.deleteDraft": {
        const params = request.request.params as { accountId: string; id: string };
        result = writer.deleteDraft(params.accountId, params.id);
        break;
      }
      case "mail.setSnooze": {
        const params = request.request.params as { accountId?: unknown; emailId?: unknown; until?: unknown };
        if (typeof params.accountId !== "string" || typeof params.emailId !== "string" ||
          (params.until !== undefined && typeof params.until !== "string")) {
          throw new Error("invalid-snooze-params");
        }
        result = writer.setSnooze({
          accountId: params.accountId,
          emailId: params.emailId,
          ...(typeof params.until === "string" ? { until: params.until } : {}),
        });
        break;
      }
      case "mail.enqueueSend":
        result = writer.enqueueSend(
          MailDatabaseEnqueueSendParamsSchema.parse(request.request.params),
        );
        break;
      case "mail.cancelScheduled":
      case "mail.deleteScheduled": {
        const params = request.request.params as { accountId?: unknown; id?: unknown };
        if (typeof params?.accountId !== "string" || typeof params.id !== "string") {
          throw new Error("invalid-scheduled-send-params");
        }
        result = request.request.method === "mail.cancelScheduled"
          ? writer.cancelScheduled(params.accountId, params.id)
          : writer.deleteScheduled(params.accountId, params.id);
        break;
      }
      case "queue.claimJob":
        result = writer.claimJob(
          MailDatabaseClaimJobParamsSchema.parse(request.request.params),
        );
        break;
      case "queue.resetTerminalAiJobs":
        result = writer.resetTerminalAiJobsForRetry(MailDatabaseResetAiJobsParamsSchema.parse(request.request.params));
        break;
      case "queue.completeJob": {
        const params = request.request.params as { id?: unknown; owner?: unknown };
        if (typeof params?.id !== "number" || typeof params.owner !== "string") {
          throw new Error("invalid-queue-complete-params");
        }
        result = writer.completeJob(params.id, params.owner);
        break;
      }
      case "queue.completeAiArtifact": {
        result = writer.completeAiArtifact(
          request.request.params as import("../../shared/wemail/mailDatabaseProtocol.js").MailDatabaseCompleteAiArtifactParams,
        );
        break;
      }
      case "queue.completeAiArtifactBatch": {
        result = writer.completeAiArtifactBatch(
          request.request.params as import("../../shared/wemail/mailDatabaseProtocol.js").MailDatabaseCompleteAiArtifactBatchParams,
        );
        break;
      }
      case "queue.failJob": {
        const params = request.request.params as {
          id?: unknown;
          owner?: unknown;
          error?: unknown;
          retryDelayMs?: unknown;
        };
        if (
          typeof params?.id !== "number" ||
          typeof params.owner !== "string" ||
          typeof params.error !== "string"
        ) throw new Error("invalid-queue-fail-params");
        result = writer.failJob(
          params.id,
          params.owner,
          params.error,
          typeof params.retryDelayMs === "number" ? params.retryDelayMs : undefined,
        );
        break;
      }
      case "queue.deferJob": {
        const params = request.request.params as {
          id?: unknown;
          owner?: unknown;
          reason?: unknown;
          delayMs?: unknown;
        };
        if (
          typeof params?.id !== "number" ||
          typeof params.owner !== "string" ||
          typeof params.reason !== "string" ||
          typeof params.delayMs !== "number"
        ) throw new Error("invalid-queue-defer-params");
        result = writer.deferJob(
          params.id,
          params.owner,
          params.reason,
          params.delayMs,
        );
        break;
      }
      case "queue.terminalJob": {
        const params = request.request.params as {
          id?: unknown;
          owner?: unknown;
          error?: unknown;
        };
        if (
          typeof params?.id !== "number" ||
          typeof params.owner !== "string" ||
          typeof params.error !== "string"
        ) throw new Error("invalid-queue-terminal-params");
        result = writer.terminalJob(params.id, params.owner, params.error);
        break;
      }
      case "queue.nextMailDue": {
        const params = request.request.params as { accountId?: unknown };
        if (typeof params?.accountId !== "string") {
          throw new Error("invalid-queue-next-due-params");
        }
        result = writer.nextMailDue(params.accountId);
        break;
      }
      case "queue.nextJobDue": {
        const params = request.request.params as { kinds?: unknown };
        if (
          !Array.isArray(params?.kinds) ||
          params.kinds.length === 0 ||
          !params.kinds.every((kind) => typeof kind === "string" && kind.length > 0)
        ) throw new Error("invalid-queue-next-job-due-params");
        result = writer.nextJobDue(params.kinds);
        break;
      }
      case "queue.claimRemoteMutation": {
        const params = request.request.params as {
          accountId?: unknown;
          owner?: unknown;
          leaseMs?: unknown;
        };
        if (typeof params?.accountId !== "string" || typeof params.owner !== "string") {
          throw new Error("invalid-remote-mutation-claim-params");
        }
        result = writer.claimRemoteMutation(
          params.accountId,
          params.owner,
          typeof params.leaseMs === "number" ? params.leaseMs : undefined,
        );
        break;
      }
      case "queue.completeRemoteMutation": {
        result = writer.completeRemoteMutation(
          MailDatabaseCompleteRemoteMutationParamsSchema.parse(request.request.params),
        );
        break;
      }
      case "queue.failRemoteMutation": {
        const params = request.request.params as {
          id?: unknown;
          owner?: unknown;
          error?: unknown;
          retryDelayMs?: unknown;
        };
        if (
          typeof params?.id !== "number" ||
          typeof params.owner !== "string" ||
          typeof params.error !== "string"
        ) throw new Error("invalid-remote-mutation-fail-params");
        result = writer.failRemoteMutation(
          params.id,
          params.owner,
          params.error,
          typeof params.retryDelayMs === "number" ? params.retryDelayMs : undefined,
        );
        break;
      }
      case "queue.claimSend": {
        const params = request.request.params as {
          accountId?: unknown;
          owner?: unknown;
          leaseMs?: unknown;
        };
        if (typeof params?.accountId !== "string" || typeof params.owner !== "string") {
          throw new Error("invalid-send-claim-params");
        }
        result = writer.claimSend(
          params.accountId,
          params.owner,
          typeof params.leaseMs === "number" ? params.leaseMs : undefined,
        );
        break;
      }
      case "queue.completeSend": {
        const params = request.request.params as {
          id?: unknown;
          owner?: unknown;
          messageId?: unknown;
          delivery?: unknown;
        };
        if (
          typeof params?.id !== "number" ||
          typeof params.owner !== "string" ||
          typeof params.messageId !== "string"
        ) throw new Error("invalid-send-complete-params");
        result = writer.completeSend(params as Parameters<typeof writer.completeSend>[0]);
        break;
      }
      case "queue.failSend": {
        const params = request.request.params as {
          id?: unknown;
          owner?: unknown;
          error?: unknown;
          retryDelayMs?: unknown;
        };
        if (
          typeof params?.id !== "number" ||
          typeof params.owner !== "string" ||
          typeof params.error !== "string"
        ) throw new Error("invalid-send-fail-params");
        result = writer.failSend(
          params.id,
          params.owner,
          params.error,
          typeof params.retryDelayMs === "number" ? params.retryDelayMs : undefined,
        );
        break;
      }
      default:
        throw new Error(`unsupported-writer-method:${request.request.method}`);
    }
    workerPort.postMessage({
      type: "response",
      requestId: request.request.requestId,
      ok: true,
      result,
      queueMs: Math.max(0, startedAt - request.queuedAt),
      handlerMs: Math.max(0, Date.now() - startedAt),
    } satisfies MailDatabaseWorkerEvent);
  } catch (error) {
    workerPort.postMessage({
      type: "response",
      requestId: request.request.requestId,
      ok: false,
      error: describeError(error),
    } satisfies MailDatabaseWorkerEvent);
  }
  setImmediate(drainNext);
}

function respond(requestId: string, result: unknown): void {
  workerPort.postMessage({
    type: "response",
    requestId,
    ok: true,
    result,
    queueMs: 0,
    handlerMs: 0,
  } satisfies MailDatabaseWorkerEvent);
}
