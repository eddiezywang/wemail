import { parentPort, threadId, workerData } from "node:worker_threads";
import type { AccountService } from "../../server/wemail/account/AccountService.js";
import { imapPasswordKey, smtpPasswordKey } from "../../server/wemail/account/AccountTypes.js";
import { BackgroundTransferMailProvider } from "../../server/wemail/mail/BackgroundTransferMailProvider.js";
import { FileInjectedMailProvider } from "../../server/wemail/mail/FileInjectedMailProvider.js";
import {
  ImapSmtpMailProvider,
  MailProviderCommandError,
} from "../../server/wemail/mail/ImapSmtpMailProvider.js";
import { classifyMailProviderFailure, mailProviderRetryAfterMs, type MailProviderFailureKind } from "../../server/wemail/mail/MailProviderFailure.js";
import type { MailMetadataPage, MailProvider } from "../../server/wemail/mail/MailProvider.js";
import { LazyMailProviderResource } from "../../server/wemail/mail/LazyMailProviderResource.js";
import { EphemeralSecretStore } from "../../server/wemail/security/EphemeralSecretStore.js";
import { isMailBodyCached, type MailMessage } from "../../shared/wemail/mail.js";
import type {
  AccountWorkerCommand,
  AccountWorkerData,
  AccountWorkerEvent,
} from "../../server/wemail/mail-core/AccountWorkerProtocol.js";
import { resolveRemoteLocatorWithRetry } from "../../server/wemail/mail-core/MailCoreRemoteLocatorResolver.js";
import { isPermanentBodyError } from "../../server/wemail/mail-core/MailJobRetryPolicy.js";
import { readWorkerHeartbeatMetrics } from "../../server/wemail/mail-core/WorkerRuntimeMetrics.js";

if (!parentPort) throw new Error("Account Worker must run in a worker thread");
const accountPort = parentPort;
const data = workerData as AccountWorkerData;
const secrets = new EphemeralSecretStore({
  [imapPasswordKey(data.accountId)]: data.credential.imapPassword,
  ...(data.credential.smtpPassword
    ? { [smtpPasswordKey(data.accountId)]: data.credential.smtpPassword }
    : {}),
});
const accountService = {
  getCurrentAccount: () => data.credential.account,
} as AccountService;
const createProvider = (
  role: "foreground-realtime" | "interactive-transfer" | "background-transfer",
): MailProvider =>
  data.e2eMode
    ? new FileInjectedMailProvider({ baseDir: data.dataDir })
    : new ImapSmtpMailProvider({
        accountService,
        secrets,
        role,
        maxConnectAttempts: 1,
        onSyncProgress: () => {
          if (activeBackgroundWorkKind !== "account-worker.sync-metadata" || activeBackgroundWorkId === null) return;
          if (role === "interactive-transfer") return;
          accountPort.postMessage({
            type: "account-worker.metadata-progress", accountId: data.accountId, jobId: activeBackgroundWorkId,
          } satisfies AccountWorkerEvent);
        },
        logger: (message) => console.info(JSON.stringify({ level: "debug", phase: "account-worker-provider", role, message })),
        onOperationTiming: (timing) => console.info(JSON.stringify({
          level: "debug",
          phase: "account-worker-provider-timing",
          accountId: data.accountId,
          ...timing,
        })),
      });
const realtimeProvider = createProvider("foreground-realtime");
const interactiveProvider = new LazyMailProviderResource<BackgroundTransferMailProvider>(
  () => new BackgroundTransferMailProvider(createProvider("interactive-transfer")),
  Number(process.env.WEMAIL_MAIL_CORE_INTERACTIVE_PROVIDER_IDLE_MS ?? 5 * 60_000),
);
const backgroundProvider = new LazyMailProviderResource<BackgroundTransferMailProvider>(
  () => new BackgroundTransferMailProvider(createProvider("background-transfer")),
  Number(process.env.WEMAIL_MAIL_CORE_BACKGROUND_PROVIDER_IDLE_MS ?? 5 * 60_000),
);
const backgroundProviderReaper = setInterval(() => {
  void Promise.all([
    interactiveProvider.releaseIfIdle(activeInteractiveWorkId !== null),
    backgroundProvider.releaseIfIdle(activeBackgroundWorkId !== null),
  ]).then(([interactiveReleased, backgroundReleased]) => {
    if (interactiveReleased || backgroundReleased) {
      console.info(JSON.stringify({ level: "debug", phase: "account-worker-background-provider-released" }));
    }
  }).catch(() => undefined);
}, 30_000);
backgroundProviderReaper.unref();
let activeInteractiveWorkId: number | string | null = null;
let activeInteractiveWorkKind: string | null = null;
let activeInteractiveWorkStartedAt: number | null = null;
let activeBackgroundWorkId: number | null = null;
let activeBackgroundWorkKind: string | null = null;
let activeBackgroundWorkStartedAt: number | null = null;
let stopping = false;
let watcherStarted = false;
let watcherAbort: AbortController | null = null;
let syncCursor = data.initialCursor ?? null;
/**
 * Candidate INBOX cursor from the current live sync. Applied to `syncCursor`
 * only after the runtime acknowledges a successful metadata persist
 * (`metadata-ack` with `continue: true`). Advancing the cursor before the
 * messages are durable made a failed persist permanently skip those messages
 * on retry: the follow-up sync started past the lost window (wemail bug: 8/7
 * INBOX/告警 mail pulled but dropped on `DB Service producer timeout`, then
 * never re-fetched because the cursor had already advanced past it).
 */
let pendingLiveCursor: typeof syncCursor = null;
const metadataAcknowledgements = new Map<number, (shouldContinue: boolean) => void>();
let cancelledMetadataJob: number | null = null;
let historicalMetadataIterator: AsyncIterator<MailMetadataPage> | null = null;
let realtimeMetadataIterator: AsyncIterator<MailMetadataPage> | null = null;
const attachmentControllers = new Map<string, AbortController>();

let heartbeatTick = 0;
const heartbeat = setInterval(() => {
  heartbeatTick += 1;
  accountPort.postMessage({
    type: "account-worker.heartbeat",
    accountId: data.accountId,
    threadId,
    at: Date.now(),
    metrics: readWorkerHeartbeatMetrics({
      queueDepth:
        Number(activeInteractiveWorkId !== null) + Number(activeBackgroundWorkId !== null),
      activeJobKind: activeInteractiveWorkKind ?? activeBackgroundWorkKind,
      activeJobStartedAt: activeInteractiveWorkStartedAt ?? activeBackgroundWorkStartedAt,
    }),
  } satisfies AccountWorkerEvent);
  // Sample this worker_thread's heap every ~10s so a leak (monotonic climb)
  // vs a spike (one big fetch) can be told apart from startup.log.
  if (heartbeatTick % 2 === 0) {
    const mem = process.memoryUsage();
    console.info(JSON.stringify({
      level: "debug",
      phase: "account-worker-memory",
      accountId: data.accountId,
      tick: heartbeatTick,
      heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
      heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
      rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    }));
  }
}, 5_000);
heartbeat.unref();

accountPort.on("message", (command: AccountWorkerCommand) => {
  if (command.type === "account-worker.cancel-metadata") {
    if (activeBackgroundWorkId !== command.jobId || activeBackgroundWorkKind !== "account-worker.sync-metadata") return;
    cancelledMetadataJob = command.jobId;
    watcherAbort?.abort();
    pendingLiveCursor = null;
    void (realtimeProvider.invalidateConnection?.(new Error("mail-provider-metadata-cancelled"))
      ?? realtimeProvider.disconnect()).catch(() => undefined);
    metadataAcknowledgements.get(command.jobId)?.(false);
    metadataAcknowledgements.delete(command.jobId);
    return;
  }
  if (command.type === "account-worker.metadata-ack") {
    // Only a successful persist may advance the incremental cursor. On
    // failure the pending candidate is discarded so the retry re-fetches the
    // same window instead of skipping past it.
    if (command.continue && pendingLiveCursor) {
      syncCursor = pendingLiveCursor;
    }
    pendingLiveCursor = null;
    metadataAcknowledgements.get(command.jobId)?.(command.continue);
    metadataAcknowledgements.delete(command.jobId);
    return;
  }
  if (command.type === "account-worker.shutdown") {
    void shutdown();
    return;
  }
  if (command.type === "account-worker.cancel-attachment") {
    attachmentControllers.get(command.requestId)?.abort();
    return;
  }
  const lane = command.type === "account-worker.execute-operation" ||
      command.type === "account-worker.send-draft" ||
      command.type === "account-worker.fetch-attachment" ||
      (command.type === "account-worker.fetch-body" && command.lane === "interactive")
    ? "interactive"
    : "background";
  const busy = lane === "interactive"
    ? activeInteractiveWorkId !== null
    : activeBackgroundWorkId !== null;
  if (busy) {
    if (command.type === "account-worker.fetch-body") {
      accountPort.postMessage({
        type: "account-worker.body-result",
        accountId: data.accountId,
        jobId: command.jobId,
        emailId: command.emailId,
        ok: false,
        errorCode: "account-worker-busy",
        retryable: true,
      } satisfies AccountWorkerEvent);
    } else if (command.type === "account-worker.fetch-attachment") {
      accountPort.postMessage({
        type: "account-worker.attachment-result",
        accountId: data.accountId,
        requestId: command.requestId,
        ok: false,
        errorCode: "account-worker-busy",
        retryable: true,
      } satisfies AccountWorkerEvent);
    } else if (command.type === "account-worker.execute-operation") {
      accountPort.postMessage({
        type: "account-worker.operation-result",
        accountId: data.accountId,
        outboxId: command.outboxId,
        ok: false,
        errorCode: "account-worker-busy",
        retryable: true,
      } satisfies AccountWorkerEvent);
    } else if (command.type === "account-worker.send-draft") {
      accountPort.postMessage({
        type: "account-worker.send-result",
        accountId: data.accountId,
        outboxId: command.outboxId,
        ok: false,
        errorCode: "account-worker-busy",
        retryable: true,
      } satisfies AccountWorkerEvent);
    } else {
      accountPort.postMessage({
        type: "account-worker.metadata-result",
        accountId: data.accountId,
        jobId: command.jobId,
        origin: command.origin,
        ok: false,
        errorCode: "account-worker-busy",
        retryable: true,
      } satisfies AccountWorkerEvent);
    }
    return;
  }
  const workId = command.type === "account-worker.execute-operation" ||
      command.type === "account-worker.send-draft"
    ? command.outboxId
    : command.type === "account-worker.fetch-attachment"
      ? command.requestId
      : command.jobId;
  if (lane === "interactive") {
    activeInteractiveWorkId = workId;
    activeInteractiveWorkKind = command.type;
    activeInteractiveWorkStartedAt = Date.now();
  } else {
    activeBackgroundWorkId = typeof workId === "number" ? workId : null;
    activeBackgroundWorkKind = command.type;
    activeBackgroundWorkStartedAt = Date.now();
  }
  console.info(JSON.stringify({
    level: "debug",
    phase: "account-worker-op",
    op: command.type.replace("account-worker.", ""),
    ...(command.type === "account-worker.fetch-body" ? { emailId: command.emailId } : {}),
    heapUsedMb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10,
  }));
  const attachmentController = command.type === "account-worker.fetch-attachment"
    ? new AbortController()
    : undefined;
  if (attachmentController && command.type === "account-worker.fetch-attachment") {
    attachmentControllers.set(command.requestId, attachmentController);
  }
  const work = command.type === "account-worker.fetch-body"
    ? fetchBody(command)
    : command.type === "account-worker.fetch-attachment"
      ? fetchAttachment(command, attachmentController!.signal)
    : command.type === "account-worker.execute-operation"
      ? executeOperation(command)
      : command.type === "account-worker.send-draft"
        ? sendDraft(command)
      : syncMetadata(command);
  void work.finally(() => {
    if (command.type === "account-worker.fetch-attachment") {
      attachmentControllers.delete(command.requestId);
    }
    if (lane === "interactive") {
      activeInteractiveWorkId = null;
      activeInteractiveWorkKind = null;
      activeInteractiveWorkStartedAt = null;
    } else {
      activeBackgroundWorkId = null;
      activeBackgroundWorkKind = null;
      activeBackgroundWorkStartedAt = null;
      if (command.type === "account-worker.sync-metadata" && cancelledMetadataJob === command.jobId) {
        cancelledMetadataJob = null;
        accountPort.postMessage({ type: "account-worker.metadata-cancelled", accountId: data.accountId, jobId: command.jobId } satisfies AccountWorkerEvent);
      }
    }
  });
});

accountPort.postMessage({
  type: "account-worker.ready",
  accountId: data.accountId,
  threadId,
  metrics: readWorkerHeartbeatMetrics(),
} satisfies AccountWorkerEvent);

async function fetchBody(
  command: Extract<AccountWorkerCommand, { type: "account-worker.fetch-body" }>,
): Promise<void> {
  const providerStartedAt = Date.now();
  const provider = command.lane === "interactive"
    ? interactiveProvider.get()
    : backgroundProvider.get();
  try {
    let message = await provider.getMessage(command.emailId, {
      ...(command.onDemand === true ? { onDemand: true } : {}),
    });
    if (!message || message.accountId !== data.accountId || !isMailBodyCached(message)) {
      throw new Error("mail-body-missing");
    }
    if (
      !message.bodyText?.trim() &&
      !message.bodyHtml?.trim() &&
      message.snippet.trim()
    ) {
      // A non-empty server preview with an empty parsed body is not a valid
      // hydration result. Keeping it as `ready` would suppress foreground
      // recovery and enqueue AI work against an empty source.
      throw new Error("mail-body-empty-after-fetch");
    }
    accountPort.postMessage({
      type: "account-worker.body-result",
      accountId: data.accountId,
      jobId: command.jobId,
      emailId: command.emailId,
      ...(command.traceId ? { traceId: command.traceId } : {}),
      providerMs: Math.max(0, Date.now() - providerStartedAt),
      ok: true,
      message,
    } satisfies AccountWorkerEvent);
  } catch (error) {
    const failureKind = classifyMailProviderFailure(error);
    const errorCode = bodyErrorCode(error, failureKind);
    const permanent = isPermanentBodyError(errorCode);
    accountPort.postMessage({
      type: "account-worker.body-result",
      accountId: data.accountId,
      jobId: command.jobId,
      emailId: command.emailId,
      ...(command.traceId ? { traceId: command.traceId } : {}),
      providerMs: Math.max(0, Date.now() - providerStartedAt),
      ok: false,
      errorCode,
      retryable:
        (failureKind === "connection" ||
          failureKind === "throttling" ||
          failureKind === "protocol") &&
        !permanent,
      credentialRequired: failureKind === "credential",
    } satisfies AccountWorkerEvent);
    if (failureKind === "connection") {
      await provider.invalidateConnection?.(error).catch(() => undefined);
    }
  }
}

async function fetchAttachment(
  command: Extract<AccountWorkerCommand, { type: "account-worker.fetch-attachment" }>,
  signal?: AbortSignal,
): Promise<void> {
  const provider = interactiveProvider.get();
  try {
    if (!provider.fetchAttachment) {
      throw new Error("attachment-fetch-unavailable");
    }
    const result = await provider.fetchAttachment(
      command.remoteEmailId,
      command.partPath,
      signal,
    );
    if (!result) throw new Error("attachment-content-unavailable");
    accountPort.postMessage({
      type: "account-worker.attachment-result",
      accountId: data.accountId,
      requestId: command.requestId,
      ok: true,
      bytes: result.bytes,
      mediaType: result.mimetype,
    } satisfies AccountWorkerEvent);
  } catch (error) {
    const classification = classifyMailProviderFailure(error);
    accountPort.postMessage({
      type: "account-worker.attachment-result",
      accountId: data.accountId,
      requestId: command.requestId,
      ok: false,
      errorCode: operationErrorCode(error),
      retryable:
        classification === "connection" ||
        classification === "throttling" ||
        classification === "protocol",
      credentialRequired: classification === "credential",
    } satisfies AccountWorkerEvent);
    if (classification === "connection") {
      await provider.invalidateConnection?.(error).catch(() => undefined);
    }
  }
}

async function executeOperation(
  command: Extract<AccountWorkerCommand, { type: "account-worker.execute-operation" }>,
): Promise<void> {
  const provider = interactiveProvider.get();
  try {
    const operation = await resolveOperationLocator(provider, command.operation);
    const { remoteEmailId, mutation } = operation;
    let relocation: import("../../server/wemail/mail-core/MailCoreMutation.js").MailCoreRemoteRelocation | undefined;
    if (mutation.type === "flags") {
      await provider.updateFlags(remoteEmailId, mutation.patch);
    } else if (mutation.type === "move") {
      const moved = await provider.moveMessage(remoteEmailId, mutation.folder);
      relocation = await resolveMoveRelocation(
        moved?.folder ?? mutation.folder,
        operation.messageId,
        moved || undefined,
        provider,
      );
    } else if (mutation.type === "trash") {
      const moved = await provider.moveMessage(remoteEmailId, "Trash");
      relocation = await resolveMoveRelocation(
        moved?.folder ?? "Trash",
        operation.messageId,
        moved || undefined,
        provider,
      );
    } else {
      await provider.deleteMessage(remoteEmailId);
    }
    accountPort.postMessage({
      type: "account-worker.operation-result",
      accountId: data.accountId,
      outboxId: command.outboxId,
      ok: true,
      ...(relocation ? { relocation } : {}),
    } satisfies AccountWorkerEvent);
  } catch (error) {
    const classification = classifyMailProviderFailure(error);
    accountPort.postMessage({
      type: "account-worker.operation-result",
      accountId: data.accountId,
      outboxId: command.outboxId,
      ok: false,
      errorCode: operationErrorCode(error),
      retryable: classification !== "credential",
    } satisfies AccountWorkerEvent);
    if (classification === "connection") {
      await provider.invalidateConnection?.(error).catch(() => undefined);
    }
  }
}

async function sendDraft(
  command: Extract<AccountWorkerCommand, { type: "account-worker.send-draft" }>,
): Promise<void> {
  const provider = interactiveProvider.get();
  try {
    const result = await provider.sendDraft({
      ...command.draft,
      smtpMessageId: command.messageIdHeader,
    });
    accountPort.postMessage({
      type: "account-worker.send-result",
      accountId: data.accountId,
      outboxId: command.outboxId,
      ok: true,
      messageId: result.messageId,
      ...(result.delivery ? { delivery: result.delivery } : {}),
    } satisfies AccountWorkerEvent);
  } catch (error) {
    const classification = classifyMailProviderFailure(error);
    accountPort.postMessage({
      type: "account-worker.send-result",
      accountId: data.accountId,
      outboxId: command.outboxId,
      ok: false,
      errorCode: operationErrorCode(error),
      retryable:
        classification === "connection" ||
        classification === "throttling" ||
        classification === "protocol",
      credentialRequired: classification === "credential",
    } satisfies AccountWorkerEvent);
    if (classification === "connection") {
      await provider.invalidateConnection?.(error).catch(() => undefined);
    }
  }
}

async function resolveOperationLocator(
  provider: BackgroundTransferMailProvider,
  operation: import("../../server/wemail/mail-core/MailCoreMutation.js").MailCoreRemoteOperation,
): Promise<import("../../server/wemail/mail-core/MailCoreMutation.js").MailCoreRemoteOperation> {
  if (operation.locator.state === "ready") return operation;
  const resolved = await resolveRemoteLocatorWithRetry(
    provider,
    operation.locator.folder,
    operation.messageId,
  );
  if (!resolved) throw new Error(`remote-locator-unresolved:${operation.emailId}`);
  return {
    ...operation,
    remoteEmailId: `${operation.accountId}:${operation.locator.folder}:${resolved.uidValidity}:${resolved.uid}`,
    locator: {
      ...operation.locator,
      uid: resolved.uid,
      uidValidity: resolved.uidValidity,
      state: "ready",
    },
  };
}

async function resolveMoveRelocation(
  folder: string,
  messageId: string,
  moved?: { uid?: number; uidValidity?: number },
  provider?: BackgroundTransferMailProvider,
): Promise<import("../../server/wemail/mail-core/MailCoreMutation.js").MailCoreRemoteRelocation> {
  if (moved?.uid !== undefined && moved.uidValidity !== undefined) {
    return { folder, uid: moved.uid, uidValidity: moved.uidValidity, state: "ready" };
  }
  if (!provider) return { folder, state: "unknown" };
  const resolved = await resolveRemoteLocatorWithRetry(provider, folder, messageId);
  return resolved
    ? { folder, uid: resolved.uid, uidValidity: resolved.uidValidity, state: "ready" }
    : { folder, state: "unknown" };
}

async function syncMetadata(
  command: Extract<AccountWorkerCommand, { type: "account-worker.sync-metadata" }>,
): Promise<void> {
  let replaceCursors = false;
  try {
    if (command.cursor !== undefined) syncCursor = command.cursor;
    const pagedProvider = command.origin === "historical" ? backgroundProvider.get() : realtimeProvider;
    if (pagedProvider.syncIncrementalPages && command.syncStates) {
      const historical = command.origin === "historical";
      const options = {
        states: command.syncStates,
        since: new Date(Date.now() - Number(process.env.WEMAIL_INITIAL_HISTORY_DAYS ?? 180) * 86_400_000),
        repair: historical,
      };
      const iterator = historical
        ? historicalMetadataIterator ??= pagedProvider.syncIncrementalPages(options)[Symbol.asyncIterator]()
        : realtimeMetadataIterator ??= pagedProvider.syncIncrementalPages(options)[Symbol.asyncIterator]();
      const providerStartedAt = Date.now();
      const step = await iterator.next({ states: command.syncStates, recheckInbox: command.recheckInbox === true });
      const accepted = await postMetadataPage(command, step.done ? [] : step.value.messages, Boolean(step.done), step.done ? undefined : step.value.checkpoint, Date.now() - providerStartedAt);
      if (!accepted || step.done) {
        await iterator.return?.();
        if (historical) historicalMetadataIterator = null;
        else realtimeMetadataIterator = null;
      }
      if (!historical && accepted) startWatcher();
      return;
    }
    let messages: MailMessage[];
    if (command.origin === "historical") {
      const historySince = new Date(
        Date.now() - Number(process.env.WEMAIL_INITIAL_HISTORY_DAYS ?? 180) * 86_400_000,
      );
      const provider = backgroundProvider.get();
      if (provider.syncMetadataPages) {
        historicalMetadataIterator ??= provider.syncMetadataPages({
          since: historySince,
          pageSize: 50,
        })[Symbol.asyncIterator]();
        const step = await historicalMetadataIterator.next();
        if (step.done) {
          historicalMetadataIterator = null;
          await postMetadataPage(command, [], true);
          return;
        }
        const shouldContinue = await postMetadataPage(command, step.value.messages, false);
        if (!shouldContinue) {
          await historicalMetadataIterator.return?.();
          historicalMetadataIterator = null;
        }
        return;
      }
      messages = await provider.syncSince(historySince);
    } else {
      await realtimeProvider.connect();
      if (syncCursor && realtimeProvider.syncAfterCursor) {
      const incremental = await realtimeProvider.syncAfterCursor(syncCursor);
      if (incremental === null) {
        replaceCursors = true;
          messages = await realtimeProvider.syncRecent(50);
      } else {
        messages = incremental;
      }
      } else {
        replaceCursors = true;
        messages = await realtimeProvider.syncRecent(50);
      }
    }
    const inboxMessages = messages.filter((message) => message.folder === "INBOX");
    const latest = inboxMessages.reduce<(typeof inboxMessages)[number] | null>(
      (current, message) => !current || message.sync.uid > current.sync.uid ? message : current,
      null,
    );
    if (latest && command.origin !== "historical") {
      // Defer the cursor advance until the runtime acks a successful persist
      // (see pendingLiveCursor in the metadata-ack handler).
      pendingLiveCursor = {
        uid: latest.sync.uid,
        uidValidity: latest.sync.uidValidity,
        internalDate: latest.sync.internalDate,
      };
    }
    if (cancelledMetadataJob === command.jobId) return;
    accountPort.postMessage({
      type: "account-worker.metadata-result",
      accountId: data.accountId,
      jobId: command.jobId,
      origin: command.origin,
      ok: true,
      messages,
      replaceCursors,
      completed: true,
    } satisfies AccountWorkerEvent);
    if (command.origin !== "historical") startWatcher();
  } catch (error) {
    const iterator = command.origin === "historical" ? historicalMetadataIterator : realtimeMetadataIterator;
    if (command.origin === "historical") historicalMetadataIterator = null;
    else realtimeMetadataIterator = null;
    await iterator?.return?.().catch(() => undefined);
    if (cancelledMetadataJob === command.jobId) return;
    const classification = classifyMailProviderFailure(error);
    accountPort.postMessage({
      type: "account-worker.metadata-result",
      accountId: data.accountId,
      jobId: command.jobId,
      origin: command.origin,
      ok: false,
      errorCode: operationErrorCode(error),
      retryable: classification !== "credential",
      ...(classification === "throttling" ? { retryAfterMs: mailProviderRetryAfterMs(error) ?? 60_000 } : {}),
    } satisfies AccountWorkerEvent);
    if (classification === "connection") {
      await (command.origin === "historical" ? backgroundProvider.get() : realtimeProvider)
        .invalidateConnection?.(error).catch(() => undefined);
    }
  }
}

function postMetadataPage(
  command: Extract<AccountWorkerCommand, { type: "account-worker.sync-metadata" }>,
  messages: MailMessage[],
  completed: boolean,
  checkpoint?: MailMetadataPage["checkpoint"],
  providerMs?: number,
): Promise<boolean> {
  if (cancelledMetadataJob === command.jobId) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    metadataAcknowledgements.set(command.jobId, resolve);
    accountPort.postMessage({
      type: "account-worker.metadata-result",
      accountId: data.accountId,
      jobId: command.jobId,
      origin: command.origin,
      ok: true,
      messages,
      replaceCursors: false,
      completed,
      ...(checkpoint ? { checkpoint } : {}),
      ...(providerMs === undefined ? {} : { providerMs }),
    } satisfies AccountWorkerEvent);
  });
}

function startWatcher(): void {
  if (watcherStarted || stopping) return;
  watcherStarted = true;
  watcherAbort = new AbortController();
  void watchMailbox(watcherAbort.signal).finally(() => { watcherStarted = false; });
}

async function watchMailbox(signal: AbortSignal): Promise<void> {
  while (!stopping && !signal.aborted) {
    try {
      if (realtimeProvider.supportsPushWatch?.() && realtimeProvider.waitForMailboxChange) {
        await realtimeProvider.waitForMailboxChange(signal);
      } else {
        // Account runtime owns the independent compensation/recovery timer.
        return;
      }
      if (stopping || signal.aborted) break;
      accountPort.postMessage({
        type: "account-worker.sync-request",
        accountId: data.accountId,
        origin: "live-idle",
      } satisfies AccountWorkerEvent);
    } catch (error) {
      if (signal.aborted || stopping) break;
      await realtimeProvider.invalidateConnection?.(error).catch(() => undefined);
      accountPort.postMessage({
        type: "account-worker.sync-request", accountId: data.accountId, origin: "live-poll",
      } satisfies AccountWorkerEvent);
      await delay(2_000, signal).catch(() => undefined);
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(done, Math.max(100, ms));
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function bodyErrorCode(error: unknown, failureKind: MailProviderFailureKind): string {
  // Permanent: message source exceeds the fetch cap. The provider throws a
  // MailProviderCommandError whose message carries "mail-provider-message-too-
  // large"; re-fetching will never succeed, so this must be classified permanent.
  if (error instanceof MailProviderCommandError && /too-large/i.test(error.message)) {
    return "mail-body-too-large";
  }
  // Credential failure: recoverable only after re-login, not via periodic retry.
  if (failureKind === "credential") return "mail-body-credential";
  // Provider could not find the message (UIDVALIDITY drift / UID expunged /
  // empty fetch). Self-corrects on the next metadata sync.
  if (failureKind === "item") return "mail-body-item-missing";
  if (error instanceof Error && error.message === "mail-body-missing") {
    return "mail-body-item-missing";
  }
  if (error instanceof MailProviderCommandError) {
    return `${error.phase}:${error.code ?? "failed"}`;
  }
  return "mail-body-fetch-failed";
}

function operationErrorCode(error: unknown): string {
  if (error instanceof MailProviderCommandError) {
    return `${error.phase}:${error.code ?? "failed"}`;
  }
  return error instanceof Error && error.message.startsWith("mail-provider-")
    ? error.message
    : "mail-remote-operation-failed";
}

async function shutdown(): Promise<void> {
  stopping = true;
  watcherAbort?.abort();
  watcherAbort = null;
  clearInterval(heartbeat);
  clearInterval(backgroundProviderReaper);
  await historicalMetadataIterator?.return?.().catch(() => undefined);
  await realtimeMetadataIterator?.return?.().catch(() => undefined);
  historicalMetadataIterator = null;
  await Promise.all([
    backgroundProvider.close().catch(() => undefined),
    interactiveProvider.close().catch(() => undefined),
    realtimeProvider.disconnect().catch(() => undefined),
  ]);
  accountPort.postMessage({
    type: "account-worker.shutdown-complete",
    accountId: data.accountId,
  } satisfies AccountWorkerEvent);
  accountPort.close();
}
