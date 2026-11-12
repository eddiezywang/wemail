import type { MessagePortMain } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MAIL_CORE_PROTOCOL_VERSION,
  type MailCoreControlMessage,
  type MailRefreshResult,
  type MailboxCredentialEnvelope,
} from "../../shared/wemail/mailCoreProtocol.js";
import { mailAttachmentCacheKey } from "../../shared/wemail/mail.js";
import { MailCoreRpcHost } from "../../server/wemail/mail-core/MailCoreRpcHost.js";
import { MailCoreAccountRuntime } from "../../server/wemail/mail-core/MailCoreAccountRuntime.js";
import { retryAccountConfiguration } from "../../server/wemail/mail-core/retryAccountConfiguration.js";
import { ResourceGovernor } from "../../server/wemail/performance/ResourceGovernor.js";
import { MailAttachmentCache } from "../../server/wemail/mail/MailAttachmentCache.js";
import { MailDatabaseProducer } from "./mail-database-producer.js";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Mail Core must run as an Electron Utility Process");

let rpcHost: MailCoreRpcHost | null = null;
let accountRuntime: MailCoreAccountRuntime | null = null;
let controlPort: MessagePortMain | null = null;
let heartbeat: NodeJS.Timeout | null = null;
let resourceGovernor: ResourceGovernor | null = null;
let databaseProducer: MailDatabaseProducer | null = null;
let mailboxCredential: MailboxCredentialEnvelope | null = null;
let accountReloadGeneration = 0;
let accountRuntimeStop = Promise.resolve();
let accountConfiguration: {
  credential: MailboxCredentialEnvelope;
  producer: MailDatabaseProducer;
  promise: Promise<boolean>;
} | null = null;

// UI/operational phases that only add noise to the info log (foreground
// focus/blur/wait/dispatch/complete of the open mail view, attachment
// cancels). Suppressed unless verbose diagnostic logging is on, mirroring
// the main process traceOnlyBootPhases gate so the default info stream
// carries real events, not every user interaction.
const MAIL_CORE_TRACE_ONLY_PHASES = new Set([
  "mail.foreground.focused",
  "mail.foreground.blurred",
  "mail.foreground.waiting",
  "mail.foreground.dispatched",
  "mail.foreground.completed",
  "mail.attachment.cancelled",
]);
// Internal scheduling/heartbeat events are useful when diagnosing a mailbox
// or provider, but are not delivery-facing application events. Keep them out
// of the default info stream; WEMAIL_DEBUG_MODE/WEMAIL_DEV_TRACE restores them.
const MAIL_CORE_DEBUG_ONLY_PHASES = new Set([
  ...MAIL_CORE_TRACE_ONLY_PHASES,
  "mail.bootstrap-sync-enqueue-deferred",
  "mail.body.claimed",
  "mail.body.claim-empty",
  "mail.governor.wait",
  "account-worker-operation-complete",
  "account-worker-send-complete",
  "account-worker-metadata-committed",
  "mail.metadata.requested",
  "mail.metadata.dispatched",
  "mail-body-reconcile",
  "mail-body-inserted-prefetch-scheduled",
  "account-worker-body-ready",
  "mail.body.completed",
  "account-worker-background-provider-released",
  "mail-database-producer-attached",
]);
function isMailCoreVerboseLogging(): boolean {
  return process.env.WEMAIL_DEV_TRACE === "1" || process.env.WEMAIL_DEBUG_MODE === "1";
}

parentPort.once("message", (event) => {
  void bootstrap(event);
});

async function bootstrap(event: {
  data: unknown;
  ports: MessagePortMain[];
}): Promise<void> {
  const input = event.data as {
    type?: string;
    protocolVersion?: number;
    managedMcpCredentialAvailable?: boolean;
    managedMcpCredential?: {
      version: 1;
      accountId: string;
      tokenId: string;
      token: string;
    };
  };
  const [port] = event.ports;
  if (
    input?.type !== "mail-core.bootstrap" ||
    input.protocolVersion !== MAIL_CORE_PROTOCOL_VERSION ||
    !port
  ) {
    throw new Error("Mail Core bootstrap protocol mismatch");
  }
  resourceGovernor = new ResourceGovernor({
    // Surface background pause/resume to the [mail-core] stdout stream. Event
    // loop pressure is diagnostic noise; actual CPU/memory pressure remains a
    // warning so a hard resource-boundary event is still visible.
    onTransition: (transition, reason, metrics) => {
      console.info(JSON.stringify({
        level: transition === "paused" && (reason === "cpu-high" || reason === "memory-high")
          ? "warn"
          : "debug",
        phase: "performance.governor",
        transition,
        reason,
        cpuPercent: Math.round(metrics.cpuPercent * 100) / 100,
        workingSetBytes: metrics.workingSetBytes,
        eventLoopP95Ms: Math.round(metrics.eventLoopP95Ms * 100) / 100,
        queueDepth: metrics.queueDepth,
      }));
    },
  });
  resourceGovernor.start();
  await reloadAccountRuntime();
  rpcHost = new MailCoreRpcHost({
    getRuntimeHealth: () => ({
      accountRuntime: accountRuntime?.health() ?? null,
      backgroundRuntime: null,
      maintenanceRuntime: null,
      intelligenceRuntime: null,
      apiRuntime: null,
      snapshotRuntime: null,
      readers: [],
    }),
    onInteractiveRequest: () => {
      resourceGovernor?.markForegroundActivity(2_000);
    },
    ensureBody: async (emailId, accountId, traceId) => {
      if (!accountRuntime || accountRuntime.health().accountId !== accountId) {
        return { status: "account-unavailable" };
      }
      return accountRuntime.ensureBody(emailId, { traceId, onDemand: true });
    },
    retryBody: async (emailId, accountId, traceId, onDemand) => {
      if (!accountRuntime || accountRuntime.health().accountId !== accountId) {
        return { status: "account-unavailable" };
      }
      return accountRuntime.ensureBody(emailId, {
        forceRetry: true,
        traceId,
        ...(onDemand ? { onDemand: true } : {}),
      });
    },
    focusMessage: async (emailId, accountId, traceId) => {
      if (!accountRuntime || accountRuntime.health().accountId !== accountId) {
        return { status: "account-unavailable" };
      }
      return accountRuntime.focusMessage(emailId, traceId);
    },
    blurMessage: async (emailId, accountId, traceId) => {
      if (!accountRuntime || accountRuntime.health().accountId !== accountId) {
        return { status: "account-unavailable" };
      }
      return accountRuntime.blurMessage(emailId, traceId);
    },
    refreshMail: async (accountId) => {
      if (!accountRuntime || accountRuntime.health().accountId !== accountId) {
        return { status: "account-unavailable" };
      }
      const queued = await accountRuntime.enqueueMetadataSync("manual", 1);
      return { ...queued, accountId };
    },
  });

  controlPort = port;
  controlPort.on("message", (messageEvent) => {
    handleControlMessage(messageEvent.data as MailCoreControlMessage, messageEvent.ports);
  });
  controlPort.start();
  controlPort.postMessage({
    type: "mail-core.ready",
    protocolVersion: MAIL_CORE_PROTOCOL_VERSION,
    pid: process.pid,
  } satisfies MailCoreControlMessage);
  heartbeat = setInterval(() => {
    const account = accountRuntime?.health();
    controlPort?.postMessage({
      type: "mail-core.heartbeat",
      at: Date.now(),
      pid: process.pid,
      receipt: account ? { accountId: account.accountId, health: account.receipt } : null,
    } satisfies MailCoreControlMessage);
  }, 5_000);
  heartbeat.unref();
}

function handleControlMessage(
  message: MailCoreControlMessage,
  ports: MessagePortMain[],
): void {
  if (message.type === "mail-core.attach-client") {
    const [clientPort] = ports;
    if (clientPort) rpcHost?.attach(clientPort);
    return;
  }
  if (message.type === "mail-core.attach-database-writer") {
    const [producerPort] = ports;
    databaseProducer?.close(new Error("DB Service producer port replaced"));
    databaseProducer = producerPort
      ? new MailDatabaseProducer(producerPort, (event) => {
          const interactiveWorkInserted = event.resetRequired === true || event.changes.some(
            (change) =>
              change.operation === "insert" &&
              (change.entityType === "remote_mutation" || change.entityType === "outbox"),
          );
          if (interactiveWorkInserted) accountRuntime?.wake(true);
        })
      : null;
    console.info(JSON.stringify({
      level: "debug",
      phase: "mail-database-producer-attached",
    }));
    void reloadAccountRuntime().catch((error) => {
      console.error(JSON.stringify({
        phase: "account-runtime-after-database-attach-failed",
        message: error instanceof Error ? error.message : String(error),
      }));
    });
    return;
  }
  if (message.type === "mail-core.configure-account") {
    if (
      !message.credential ||
      !mailboxCredential ||
      message.credential.account.id !== mailboxCredential.account.id ||
      message.credential.generation >= mailboxCredential.generation
    ) {
      mailboxCredential = message.credential;
      void reloadAccountRuntime().catch((error) => {
        console.error(JSON.stringify({
          phase: "account-runtime-configure-failed",
          message: error instanceof Error ? error.message : String(error),
        }));
      });
    }
    return;
  }
  if (message.type === "mail-core.reload-account") {
    void reloadAccountRuntime().catch((error) => {
      console.error(JSON.stringify({
        phase: "account-runtime-reload-failed",
        message: error instanceof Error ? error.message : String(error),
      }));
    });
    return;
  }
  if (message.type === "mail-core.attachment-request") {
    const runtime = accountRuntime;
    void (async () => {
      if (!runtime || runtime.health().accountId !== message.params.accountId) {
        throw namedError(
          "ATTACHMENT_SERVICE_UNAVAILABLE",
          "account-runtime-unavailable",
        );
      }
      return runtime.fetchAttachment({
        requestId: message.requestId,
        remoteEmailId: message.params.remoteEmailId,
        partPath: message.params.partPath,
        ...(message.params.source ? { source: message.params.source } : {}),
        ...(message.params.viewId ? { viewId: message.params.viewId } : {}),
      });
    })()
      .then((result) => {
        controlPort?.postMessage({
          type: "mail-core.attachment-response",
          requestId: message.requestId,
          ok: true,
          result: {
            bytes: result.bytes,
            mediaType: result.mediaType,
          },
        } satisfies MailCoreControlMessage);
      })
      .catch((error) => {
        const code = error instanceof Error
          ? error.name || "ATTACHMENT_FETCH_FAILED"
          : "ATTACHMENT_FETCH_FAILED";
        controlPort?.postMessage({
          type: "mail-core.attachment-response",
          requestId: message.requestId,
          ok: false,
          error: code,
          retryable: !/credential|unavailable/i.test(code),
        } satisfies MailCoreControlMessage);
      });
    return;
  }
  if (message.type === "mail-core.attachment-cancel") {
    accountRuntime?.cancelAttachment(message.requestId);
    return;
  }
  if (message.type === "mail-core.refresh-request") {
    void (async (): Promise<MailRefreshResult> => {
      if (!accountRuntime || accountRuntime.health().accountId !== message.accountId) {
        return { status: "account-unavailable" };
      }
      const queued = await accountRuntime.enqueueMetadataSync("manual", 1);
      return { ...queued, accountId: message.accountId };
    })()
      .then((result) => {
        controlPort?.postMessage({
          type: "mail-core.refresh-response",
          requestId: message.requestId,
          ok: true,
          result,
        } satisfies MailCoreControlMessage);
      })
      .catch((error) => {
        controlPort?.postMessage({
          type: "mail-core.refresh-response",
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "refresh-failed",
        } satisfies MailCoreControlMessage);
      });
    return;
  }
  if (message.type === "mail-core.mcp-configuration-request") {
    void Promise.reject(new Error("mcp-configuration-moved-to-main-runtime"))
      .then((configuration) => {
        controlPort?.postMessage({
          type: "mail-core.mcp-configuration-response",
          requestId: message.requestId,
          ok: true,
          configuration,
        } satisfies MailCoreControlMessage);
      })
      .catch((error) => {
        controlPort?.postMessage({
          type: "mail-core.mcp-configuration-response",
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "mcp-not-ready",
        } satisfies MailCoreControlMessage);
      });
    return;
  }
  if (message.type === "mail-core.shutdown") {
    accountReloadGeneration++;
    mailboxCredential = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    rpcHost?.close();
    rpcHost = null;
    resourceGovernor?.stop();
    resourceGovernor = null;
    databaseProducer?.close();
    databaseProducer = null;
    void Promise.all([
      accountRuntimeStop,
      accountRuntime?.stop(),
    ]).finally(() => {
      accountRuntime = null;
      controlPort?.postMessage({ type: "mail-core.shutdown-complete" } satisfies MailCoreControlMessage);
      controlPort?.close();
      controlPort = null;
      process.exit(0);
    });
  }
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * Pre-seed the shared attachment disk cache (`<dataDir>/mail-attachment-cache`,
 * the same rootDir the HTTP route reads) for inline images whose bytes were
 * captured during body parse. Write-only: no in-memory LRU, no eviction
 * (eviction is owned by the route's instance to avoid cross-process races).
 * Bytes are matched to attachment public-ids by normalized Content-ID. All
 * failures are swallowed — a miss simply means the route loads on demand once.
 */
async function seedInlineImages(
  dataDir: string,
  accountPublicId: string,
  result: {
    messagePublicId: string;
    inlineImagePublicIds: Array<{ contentId: string; publicId: string }>;
  },
  inlineImages: unknown,
): Promise<void> {
  if (!Array.isArray(inlineImages) || inlineImages.length === 0) return;
  if (!result.inlineImagePublicIds.length) return;
  const cache = new MailAttachmentCache({
    rootDir: path.join(dataDir, "mail-attachment-cache"),
    memoryMaxBytes: 0,
  });
  const publicIdByContentId = new Map(
    result.inlineImagePublicIds.map((entry) => [entry.contentId, entry.publicId]),
  );
  for (const raw of inlineImages) {
    if (!raw || typeof raw !== "object") continue;
    const { contentId, bytes } = raw as { contentId?: unknown; bytes?: unknown };
    if (typeof contentId !== "string" || !(bytes instanceof Uint8Array)) continue;
    const publicId = publicIdByContentId.get(contentId);
    if (!publicId) continue;
    await cache.seed(
      mailAttachmentCacheKey(accountPublicId, result.messagePublicId, publicId),
      bytes,
    );
  }
}

// Boot-time DB writer contention can exceed the 5s producer timeout on
// mail.configureAccount; without a retry the account runtime never comes up
// (manual refresh then reports account-unavailable for the whole session).
function configureAccountWithRetry(credential: MailboxCredentialEnvelope): Promise<boolean> {
  const producer = databaseProducer;
  if (!producer || credential !== mailboxCredential) return Promise.resolve(false);
  if (accountConfiguration?.credential === credential && accountConfiguration.producer === producer) {
    return accountConfiguration.promise;
  }
  const promise = retryAccountConfiguration(
    async () => {
      await producer.configureAccount({
        account: credential.account,
        credentialRef: `safe-storage:mailbox:${credential.account.id}`,
        credentialGeneration: credential.generation,
      });
    },
    () => credential === mailboxCredential && producer === databaseProducer,
    (attempt, delayMs, error) => {
      console.error(JSON.stringify({
        phase: "account-runtime-configure-retry",
        attempt,
        delayMs,
        message: error instanceof Error ? error.message : String(error),
      }));
    },
  );
  const request = { credential, producer, promise };
  accountConfiguration = request;
  void promise.finally(() => {
    if (accountConfiguration === request) accountConfiguration = null;
  }).catch(() => undefined);
  return promise;
}

async function reloadAccountRuntime(): Promise<void> {
  const generation = ++accountReloadGeneration;
  const previous = accountRuntime;
  accountRuntime = null;
  // Overlapping reloads must all wait for the old Worker to release its sessions.
  accountRuntimeStop = accountRuntimeStop.then(() => previous?.stop());
  await accountRuntimeStop;
  if (generation !== accountReloadGeneration) return;
  const credential = mailboxCredential;
  const producer = databaseProducer;
  if (!credential || !producer) return;
  if (!await configureAccountWithRetry(credential)) return;
  if (generation !== accountReloadGeneration || credential !== mailboxCredential || producer !== databaseProducer) return;
  const accountId = credential.account.id;
  const initialCursor = await producer.getSyncCursor(accountId).catch((error) => {
    console.error(JSON.stringify({
      phase: "account-runtime-initial-cursor-deferred",
      message: error instanceof Error ? error.message : String(error),
    }));
    // Dispatch reloads committed checkpoints; a transient read must not prevent startup.
    return null;
  });
  if (generation !== accountReloadGeneration || credential !== mailboxCredential || producer !== databaseProducer) return;
  const dataDir = process.env.WEMAIL_DATA_DIR ?? process.cwd();
  const next = new MailCoreAccountRuntime({
    entryPath: fileURLToPath(new URL("./account-worker-entry.js", import.meta.url)),
    dataDir,
    accountId,
    credential,
    ...(initialCursor ? { initialCursor } : {}),
    loadSyncCursor: () => producer.getSyncCursor(accountId),
    loadSyncStates: () => producer.getSyncStates(accountId),
    dbWriter: {
      enqueueJob: (job) => {
        const { availableAt, ...input } = job;
        return producer.enqueueJob({
          ...input,
          accountId: job.accountId ?? accountId,
          ...(availableAt ? { availableAt: availableAt.toISOString() } : {}),
        });
      },
      claimJob: (owner, leaseMs, filter) => producer.claimJob(
        owner,
        leaseMs,
        filter,
      ),
      completeJob: (id, owner) => producer.completeJob(id, owner),
      failJob: (id, owner, error, retryDelayMs) => producer.failJob(
        id,
        owner,
        error,
        retryDelayMs,
      ),
      deferJob: (id, owner, reason, delayMs) => producer.deferJob(
        id,
        owner,
        reason,
        delayMs,
      ),
      nextMailDue: (requestedAccountId) => producer.nextMailDue(requestedAccountId),
      claimOutbox: (owner, leaseMs) => producer.claimRemoteMutation(
        accountId,
        owner,
        leaseMs,
      ),
      failOutbox: (id, owner, error, retryDelayMs) => producer.failRemoteMutation(
        id,
        owner,
        error,
        retryDelayMs,
      ),
      claimSend: (owner, leaseMs) => producer.claimSend(accountId, owner, leaseMs),
      completeSend: (input) => producer.completeSend(input),
      failSend: (id, owner, error, retryDelayMs) => producer.failSend(
        id,
        owner,
        error,
        retryDelayMs,
      ),
      persistMailBody: async () => {
        throw new Error("canonical-persist-body-callback-required");
      },
      recordMailBodyFailure: async () => {
        throw new Error("canonical-persist-body-failure-callback-required");
      },
      persistMailMetadata: async () => {
        throw new Error("canonical-persist-metadata-callback-required");
      },
      resolveRemoteOperation: async (pending) => {
        const locator = pending.fallbackLocator;
        if (!locator) throw new Error("canonical-remote-locator-missing");
        return {
          accountId: pending.accountId,
          emailId: pending.emailId,
          remoteEmailId: `${pending.accountId}:${locator.folder}:${locator.uidValidity}:${locator.uid}`,
          messageId: pending.fallbackMessageId ?? pending.emailId,
          locator,
          mutation: pending.mutation,
        };
      },
      completeRemoteOperation: (id, owner, emailId, relocation) =>
        producer.completeRemoteMutation({ id, owner, emailId, relocation }),
      resetMailBodyFailure: async (emailId) => {
        const committed = await producer.resetBodyFailure(accountId, emailId);
        return committed.value;
      },
      reconcileBodyHydration: (requestedAccountId, options) =>
        producer.reconcileBodyHydration(requestedAccountId, options),
    },
    e2eMode: process.env.WEMAIL_E2E_MODE === "1",
    // Gate background sync/body/reconcile on the process resource governor so
    // they yield to the machine under load (interactive body is not gated).
    resourceGovernor: resourceGovernor ?? undefined,
    log: (phase, extra) => {
      const debugPhase = MAIL_CORE_DEBUG_ONLY_PHASES.has(phase);
      if (!isMailCoreVerboseLogging() && debugPhase) return;
      const failurePhase = /failed|error|timeout|credential-required|restart-budget-exhausted/.test(phase);
      console.info(JSON.stringify({
        phase,
        ...extra,
        level: failurePhase ? "error" : debugPhase ? "debug" : "info",
      }));
    },
    onCredentialInvalid: (invalid) => {
      controlPort?.postMessage({
        type: "mail-core.mail-credential-invalid",
        ...invalid,
      } satisfies MailCoreControlMessage);
    },
    persistBody: async (message, job, inlineImages) => {
      if (producer !== databaseProducer) throw new Error("canonical-database-writer-unavailable");
      const committed = await producer.persistBody({
        message,
        completedAt: new Date().toISOString(),
        jobId: job.id,
        jobOwner: job.owner,
      }, job.traceId);
      // Best-effort: pre-seed the shared attachment disk cache for inline
      // images captured at parse, so opening the detail view never re-fetches
      // them from IMAP. The write-only cache shares the route's rootDir; the
      // route reads the same sha256 layout. Failures are swallowed — the
      // existing on-demand path loads once on first open.
      await seedInlineImages(
        dataDir,
        message.accountId,
        committed.value,
        inlineImages,
      ).catch(() => {
        /* best-effort seed; on-demand fallback covers misses */
      });
      return { jobCompleted: committed.value.jobCompleted };
    },
    persistBodyFailure: async (failure) => {
      if (producer !== databaseProducer) throw new Error("canonical-database-writer-unavailable");
      const committed = await producer.failBody({
        accountId: failure.accountId,
        emailId: failure.emailId,
        errorCode: failure.errorCode,
        failedAt: failure.failedAt,
        ...(failure.retryAt ? { retryAt: failure.retryAt } : {}),
        retryable: failure.retryable,
        jobId: failure.job.id,
        jobOwner: failure.job.owner,
      });
      return {
        attempts: committed.value.attempts,
        nextRetryAt: committed.value.nextRetryAt ?? failure.failedAt,
        jobCompleted: committed.value.jobCompleted,
      };
    },
    persistMetadata: async (origin, messages, _replaceCursors, initialSyncCompleted, checkpoint, lease) => {
      if (producer !== databaseProducer) throw new Error("canonical-database-writer-unavailable");
      const committed = await producer.persistMetadata({
        accountId,
        origin,
        messages,
        ...(initialSyncCompleted ? { initialSyncCompleted: true } : {}),
        ...(checkpoint ? { checkpoint, lease } : {}),
      }, lease?.owner);
      const inserted = new Set(committed.value.insertedIds);
      return {
        inserted: messages.filter((message) => inserted.has(message.id)),
        updatedCount: committed.value.updatedCount,
        bodiesQueued: Boolean(checkpoint),
        commitVersion: committed.commitVersion,
      };
    },
    onMetadataCommitted: (origin, result) => {
      if (origin === "bootstrap" || origin === "historical" || result.inserted.length === 0) return;
      controlPort?.postMessage({
        type: "mail-core.mail-changed",
        accountId,
        origin,
        inserted: result.inserted.map((message) => ({
          id: message.id,
          subject: message.subject,
          from: message.from.email,
        })),
      } satisfies MailCoreControlMessage);
    },
  });
  accountRuntime = next;
  await next.start();
}
