import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import type {
  AccountWorkerCommand,
  AccountWorkerEvent,
} from "./AccountWorkerProtocol.js";
import {
  MailCoreAccountRuntime,
  type MailCoreAccountRuntimeOptions,
} from "./MailCoreAccountRuntime.js";
import type { MailJob } from "./MailJobQueueTypes.js";

class FakeAccountWorker extends EventEmitter {
  constructor(private readonly message: MailMessage) {
    super();
    queueMicrotask(() => this.emit("message", {
      type: "account-worker.ready",
      accountId: message.accountId,
      threadId: 7,
      metrics: {
        rssBytes: 100,
        heapUsedBytes: 20,
        heapTotalBytes: 30,
        externalBytes: 4,
        arrayBuffersBytes: 5,
        queueDepth: 0,
        activeJobKind: null,
        activeJobAgeMs: null,
      },
    } satisfies AccountWorkerEvent));
  }

  postMessage(command: AccountWorkerCommand): void {
    if (command.type !== "account-worker.fetch-body") return;
    queueMicrotask(() => this.emit("message", {
      type: "account-worker.body-result",
      accountId: this.message.accountId,
      jobId: command.jobId,
      emailId: command.emailId,
      ok: true,
      message: this.message,
    } satisfies AccountWorkerEvent));
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

class FakeOperationWorker extends EventEmitter {
  operation: AccountWorkerCommand | null = null;

  constructor(private readonly accountId: string) {
    super();
    queueMicrotask(() => this.emit("message", {
      type: "account-worker.ready",
      accountId,
      threadId: 8,
    } satisfies AccountWorkerEvent));
  }

  postMessage(command: AccountWorkerCommand): void {
    if (command.type !== "account-worker.execute-operation") return;
    this.operation = command;
    queueMicrotask(() => this.emit("message", {
      type: "account-worker.operation-result",
      accountId: this.accountId,
      outboxId: command.outboxId,
      ok: true,
    } satisfies AccountWorkerEvent));
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

class FakeMetadataWorker extends EventEmitter {
  constructor(private readonly message: MailMessage) {
    super();
    queueMicrotask(() => this.emit("message", {
      type: "account-worker.ready",
      accountId: message.accountId,
      threadId: 9,
    } satisfies AccountWorkerEvent));
  }

  postMessage(command: AccountWorkerCommand): void {
    if (command.type !== "account-worker.sync-metadata") return;
    queueMicrotask(() => this.emit("message", {
      type: "account-worker.metadata-result",
      accountId: this.message.accountId,
      jobId: command.jobId,
      origin: command.origin,
      ok: true,
      messages: [this.message],
      replaceCursors: false,
      completed: true,
    } satisfies AccountWorkerEvent));
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

class RecordingWorker extends EventEmitter {
  commands: AccountWorkerCommand[] = [];

  constructor(private readonly accountId: string) {
    super();
    queueMicrotask(() => this.emit("message", {
      type: "account-worker.ready",
      accountId,
      threadId: 11,
    } satisfies AccountWorkerEvent));
  }

  postMessage(command: AccountWorkerCommand): void {
    this.commands.push(command);
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

class FakeCredentialFailureWorker extends EventEmitter {
  constructor(private readonly accountId: string) {
    super();
    queueMicrotask(() => this.emit("message", {
      type: "account-worker.ready",
      accountId,
      threadId: 10,
    } satisfies AccountWorkerEvent));
  }

  postMessage(command: AccountWorkerCommand): void {
    if (command.type !== "account-worker.fetch-body") return;
    queueMicrotask(() => this.emit("message", {
      type: "account-worker.body-result",
      accountId: this.accountId,
      jobId: command.jobId,
      emailId: command.emailId,
      ok: false,
      errorCode: "imap.login:AUTHENTICATIONFAILED",
      retryable: false,
      credentialRequired: true,
    } satisfies AccountWorkerEvent));
  }

  async terminate(): Promise<number> {
    queueMicrotask(() => this.emit("exit", 1));
    return 1;
  }
}

test("account runtime persists a P0 body job through the DB Writer", async () => {
  const message = bodyMessage();
  let queued: MailJob | null = null;
  let persisted: MailMessage | null = null;
  let completed = false;
  const foregroundClaims: string[] = [];
  let terminalPolicy: "reuse" | "revive" | undefined;
  const writer = {
    enqueueJob: async (input: { kind: string; accountId?: string; payload: unknown; priority: number; terminalPolicy?: "reuse" | "revive" }) => {
      terminalPolicy = input.terminalPolicy;
      queued = {
        id: 11,
        kind: input.kind,
        accountId: input.accountId ?? null,
        payload: input.payload,
        priority: 0,
        attempts: 0,
        maxAttempts: 5,
        availableAt: new Date().toISOString(),
        leaseOwner: null,
        leaseUntil: null,
        idempotencyKey: `body.ensure:${message.id}`,
      };
      return queued;
    },
    claimJob: async (_owner: string, _leaseMs?: number, filter?: { kinds?: readonly string[]; subjectPublicId?: string }) => {
      if (filter?.subjectPublicId) foregroundClaims.push(filter.subjectPublicId);
      if (!queued || queued.leaseOwner || !filter?.kinds?.includes(queued.kind)) return null;
      queued = { ...queued, attempts: 1, leaseOwner: "account-worker" };
      return queued;
    },
    completeJob: async () => {
      completed = true;
      return true;
    },
    failJob: async () => true,
    claimOutbox: async () => null,
    failOutbox: async () => true,
    claimSend: async () => null,
    completeSend: async () => ({ value: { outboxId: "unused", messageId: "unused" }, commitVersion: 0, changes: [] }),
    failSend: async () => true,
    persistMailBody: async (value: MailMessage) => {
      persisted = value;
      return { emailId: value.id, bodyCached: true };
    },
    recordMailBodyFailure: async () => ({ attempts: 1, nextRetryAt: new Date().toISOString() }),
    persistMailMetadata: async () => ({ inserted: [], updatedCount: 0 }),
    resolveRemoteOperation: async (
      input: NonNullable<Parameters<NonNullable<ConstructorParameters<typeof MailCoreAccountRuntime>[0]["dbWriter"]["resolveRemoteOperation"]>>[0]>,
    ) => ({
      ...input,
      remoteEmailId: input.emailId,
      messageId: input.fallbackMessageId ?? "message-42",
      locator: input.fallbackLocator ?? { folder: "INBOX", uid: 1, uidValidity: 1, internalDate: "", state: "ready" },
    }),
    completeRemoteOperation: async () => true,
  };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js",
    dataDir: ".wemail",
    accountId: message.accountId,
    dbWriter: writer,
    autoSync: false,
    createWorker: () => new FakeAccountWorker(message),
  });

  await runtime.start();
  const result = await runtime.ensureBody(message.id);
  await waitFor(() => completed);

  assert.deepEqual(result, { status: "queued", jobId: 11 });
  assert.equal(terminalPolicy, "revive");
  const claimedJob = queued as MailJob | null;
  const persistedMessage = persisted as MailMessage | null;
  assert.equal(claimedJob?.priority, 0);
  assert.ok(foregroundClaims.includes(message.id));
  assert.equal(persistedMessage?.id, message.id);
  assert.equal(runtime.health().threadId, 7);
  assert.equal(runtime.health().metrics?.rssBytes, 100);
  assert.equal(runtime.health().metrics?.restartCount, 0);
  await runtime.stop();
});

test("account runtime fuses IMAP work after a definitive credential failure", async () => {
  let queued: MailJob | null = null;
  let claimCount = 0;
  let credentialEvents = 0;
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js",
    dataDir: ".wemail",
    accountId: "acct-1",
    autoSync: false,
    dbWriter: {
      enqueueJob: async (input) => {
        queued = {
          id: 12,
          kind: input.kind,
          accountId: input.accountId ?? null,
          payload: input.payload,
          priority: input.priority,
          attempts: 0,
          maxAttempts: input.maxAttempts ?? 5,
          availableAt: new Date().toISOString(),
          leaseOwner: null,
          leaseUntil: null,
          idempotencyKey: input.idempotencyKey ?? null,
        };
        return queued;
      },
      claimJob: async (_owner, _lease, filter) => {
        claimCount += 1;
        if (!queued || queued.leaseOwner || !filter?.kinds?.includes(queued.kind)) return null;
        queued = { ...queued, attempts: 1, leaseOwner: "credential-worker" };
        return queued;
      },
      completeJob: async () => true,
      failJob: async () => true,
      persistMailBody: async () => ({ emailId: "unused", bodyCached: true }),
      recordMailBodyFailure: async () => ({ attempts: 1, nextRetryAt: new Date().toISOString() }),
      claimOutbox: async () => null,
      failOutbox: async () => true,
      claimSend: async () => null,
      completeSend: async () => ({ value: { outboxId: "unused", messageId: "unused" }, commitVersion: 0, changes: [] }),
      failSend: async () => true,
      persistMailMetadata: async () => ({ inserted: [], updatedCount: 0 }),
      resolveRemoteOperation: async () => {
        throw new Error("not used");
      },
      completeRemoteOperation: async () => true,
    },
    createWorker: () => new FakeCredentialFailureWorker("acct-1"),
    onCredentialInvalid: () => {
      credentialEvents += 1;
    },
  });

  await runtime.start();
  await runtime.ensureBody("acct-1:INBOX:1:42");
  await waitFor(() => runtime.health().state === "credential-required");
  const claimsAtFuse = claimCount;
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(runtime.health().state, "credential-required");
  assert.equal(credentialEvents, 1);
  assert.equal(claimCount, claimsAtFuse);
  await runtime.stop();
});

test("account runtime drains a durable remote mutation outbox", async () => {
  const item: MailJob = {
    id: 21,
    kind: "mail.remote.mutation",
    accountId: "acct-1",
    payload: {
      accountId: "acct-1",
      emailId: "acct-1:INBOX:1:42",
      mutation: { type: "flags", patch: { seen: true } },
    },
    priority: 1,
    attempts: 1,
    maxAttempts: 100,
    availableAt: new Date().toISOString(),
    leaseOwner: "outbox-worker",
    leaseUntil: new Date(Date.now() + 30_000).toISOString(),
    idempotencyKey: "mutation-21",
  };
  let claimed = false;
  let completed = false;
  const worker = new FakeOperationWorker("acct-1");
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js",
    dataDir: ".wemail",
    accountId: "acct-1",
    dbWriter: {
      enqueueJob: async () => item,
      claimJob: async () => null,
      completeJob: async () => true,
      failJob: async () => true,
      persistMailBody: async () => ({ emailId: "unused", bodyCached: true }),
      recordMailBodyFailure: async () => ({ attempts: 1, nextRetryAt: new Date().toISOString() }),
      persistMailMetadata: async () => ({ inserted: [], updatedCount: 0 }),
      resolveRemoteOperation: async (input) => ({
        accountId: input.accountId,
        emailId: input.emailId,
        remoteEmailId: "acct-1:INBOX:1:42",
        messageId: "message-42",
        locator: { folder: "INBOX", uid: 42, uidValidity: 1, internalDate: "", state: "ready" },
        mutation: input.mutation,
      }),
      completeRemoteOperation: async () => {
        completed = true;
        return true;
      },
      claimOutbox: async () => {
        if (claimed) return null;
        claimed = true;
        return item;
      },
      failOutbox: async () => true,
      claimSend: async () => null,
      completeSend: async () => ({ value: { outboxId: "unused", messageId: "unused" }, commitVersion: 0, changes: [] }),
      failSend: async () => true,
    },
    autoSync: false,
    createWorker: () => worker,
  });

  await runtime.start();
  await waitFor(() => completed);
  assert.equal(worker.operation?.type, "account-worker.execute-operation");
  assert.equal(runtime.health().currentOutboxId, null);
  await runtime.stop();
});

test("account runtime claims realtime metadata before incremental and historical bodies", async () => {
  const worker = new RecordingWorker("acct-1");
  const jobs: MailJob[] = [
    job(61, "mail.metadata.sync", 2, { origin: "bootstrap" }),
    job(62, "mail.body.ensure", 40, { emailId: "acct-1:INBOX:1:40" }),
    job(63, "mail.body.ensure", 1, { emailId: "acct-1:INBOX:1:63" }),
  ];
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js",
    dataDir: ".wemail",
    accountId: "acct-1",
    autoSync: false,
    dbWriter: queueWriter(jobs),
    createWorker: () => worker,
  });

  await runtime.start();
  await waitFor(() => worker.commands.length > 0);

  assert.deepEqual(worker.commands[0], {
    type: "account-worker.sync-metadata",
    jobId: 61,
    origin: "bootstrap",
  });
  await runtime.stop();
});

test("account runtime yields historical metadata after one page", async () => {
  const synced = bodyMessage();
  const worker = new RecordingWorker(synced.accountId);
  const metadataJob = job(68, "mail.metadata.sync", 4, { origin: "historical" });
  let claimed = false;
  let yielded = false;
  const logs: Array<{ phase: string; data?: Record<string, unknown> }> = [];
  const writer = queueWriter([metadataJob]);
  writer.claimJob = async (_owner, _lease, filter) => {
    if (claimed || !filter?.kinds?.includes("mail.metadata.sync") || !filter.priorities?.includes(4)) {
      return null;
    }
    claimed = true;
    return { ...metadataJob, attempts: 1, leaseOwner: _owner };
  };
  writer.deferJob = async (_id, _owner, reason) => {
    yielded = reason === "historical-page-yield";
    return true;
  };
  writer.persistMailMetadata = async () => ({ inserted: [synced], updatedCount: 0 });
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js",
    dataDir: ".wemail",
    accountId: synced.accountId,
    autoSync: false,
    dbWriter: writer,
    createWorker: () => worker,
    log: (phase, data) => logs.push({ phase, data }),
  });

  await runtime.start();
  await waitFor(() => worker.commands[0]?.type === "account-worker.sync-metadata");
  worker.emit("message", {
    type: "account-worker.metadata-result",
    accountId: synced.accountId,
    jobId: metadataJob.id,
    origin: "historical",
    ok: true,
    messages: [synced],
    replaceCursors: false,
    completed: false,
    checkpoint: {
      folder: "INBOX", previous: null, mode: "repair",
      next: { ...synced.sync, repair: { version: 1, since: "2026-05-01T00:00:00Z", uid: 42, completed: false } },
    },
  } satisfies AccountWorkerEvent);
  await waitFor(() => yielded);

  assert.equal(yielded, true);
  assert.deepEqual(logs.find(({ phase }) => phase === "account-worker-metadata-committed")?.data?.repairCoverage, {
    folder: "INBOX", version: 1, since: "2026-05-01T00:00:00Z", completed: false,
  });
  assert.ok(worker.commands.some((command) =>
    command.type === "account-worker.metadata-ack" && command.continue,
  ));
  await runtime.stop();
});

test("account runtime claims newest historical body before historical metadata", async () => {
  const worker = new RecordingWorker("acct-1");
  const jobs: MailJob[] = [
    job(71, "mail.metadata.sync", 4, { origin: "historical" }),
    job(72, "mail.body.ensure", 20, { emailId: "acct-1:INBOX:1:72" }),
    job(73, "mail.body.ensure", 20, { emailId: "acct-1:INBOX:1:73" }),
  ];
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js",
    dataDir: ".wemail",
    accountId: "acct-1",
    autoSync: false,
    dbWriter: queueWriter(jobs),
    createWorker: () => worker,
  });

  await runtime.start();
  await waitFor(() => worker.commands.length > 0);

  assert.deepEqual(worker.commands[0], {
    type: "account-worker.fetch-body",
    jobId: 73,
    emailId: "acct-1:INBOX:1:73",
    lane: "background",
  });
  await runtime.stop();
});

test("historical metadata makes progress between body jobs while realtime checks retain priority", async () => {
  const worker = new RecordingWorker("acct-1");
  const jobs = [
    job(71, "mail.metadata.sync", 4, { origin: "historical" }),
    ...Array.from({ length: 50 }, (_, index) => job(100 + index, "mail.body.ensure", 1, { emailId: bodyMessage().id })),
  ];
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1", autoSync: false,
    dbWriter: queueWriter(jobs), createWorker: () => worker,
  });
  try {
    await runtime.start();
    await waitFor(() => worker.commands.length > 0);
    const body = worker.commands[0];
    assert.equal(body.type, "account-worker.fetch-body");
    if (body.type !== "account-worker.fetch-body") return;
    worker.emit("message", {
      type: "account-worker.body-result", accountId: "acct-1", jobId: body.jobId,
      emailId: body.emailId, ok: true, message: bodyMessage(),
    } satisfies AccountWorkerEvent);
    await waitFor(() => worker.commands.length >= 2);
    assert.deepEqual(worker.commands[1], { type: "account-worker.sync-metadata", jobId: 71, origin: "historical" });
    jobs.push(job(72, "mail.metadata.sync", 1, { origin: "manual" }));
    worker.emit("message", {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: 71,
      origin: "historical", ok: true, messages: [], replaceCursors: false, completed: true,
    } satisfies AccountWorkerEvent);
    await waitFor(() => worker.commands.some((command) => command.type === "account-worker.sync-metadata" && command.jobId === 72));
    assert.equal(worker.commands.filter((command) => command.type === "account-worker.fetch-body").length, 1,
      "core demand still precedes the remaining body backlog");
  } finally { await runtime.stop(); }
});

test("account runtime bootstraps metadata through the DB Writer", async () => {
  const synced = bodyMessage();
  let metadataJob: MailJob | null = null;
  let persisted = false;
  let committed = false;
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js",
    dataDir: ".wemail",
    accountId: synced.accountId,
    dbWriter: {
      enqueueJob: async (input) => {
        metadataJob = {
          id: 31,
          kind: input.kind,
          accountId: input.accountId ?? null,
          payload: input.payload,
          priority: input.priority,
          attempts: 0,
          maxAttempts: input.maxAttempts ?? 10,
          availableAt: new Date().toISOString(),
          leaseOwner: null,
          leaseUntil: null,
          idempotencyKey: input.idempotencyKey ?? null,
        };
        return metadataJob;
      },
      claimJob: async (_owner, _lease, filter) => {
        const job = metadataJob;
        if (!job || job.leaseOwner || !filter?.kinds?.includes(job.kind)) return null;
        metadataJob = { ...job, attempts: 1, leaseOwner: "metadata-worker" };
        return metadataJob;
      },
      completeJob: async () => {
        committed = true;
        return true;
      },
      failJob: async () => true,
      persistMailBody: async () => ({ emailId: "unused", bodyCached: true }),
      recordMailBodyFailure: async () => ({ attempts: 1, nextRetryAt: new Date().toISOString() }),
      persistMailMetadata: async (batch) => {
        persisted = batch.messages[0]?.id === synced.id;
        return { inserted: batch.messages, updatedCount: 0 };
      },
      resolveRemoteOperation: async (input) => ({
        accountId: input.accountId,
        emailId: input.emailId,
        remoteEmailId: input.emailId,
        messageId: "message-42",
        locator: input.fallbackLocator ?? { folder: "INBOX", uid: 1, uidValidity: 1, internalDate: "", state: "ready" },
        mutation: input.mutation,
      }),
      completeRemoteOperation: async () => true,
      claimOutbox: async () => null,
      failOutbox: async () => true,
      claimSend: async () => null,
      completeSend: async () => ({ value: { outboxId: "unused", messageId: "unused" }, commitVersion: 0, changes: [] }),
      failSend: async () => true,
    },
    createWorker: () => new FakeMetadataWorker(synced),
    onMetadataCommitted: (origin, result) => {
      assert.equal(origin, "bootstrap");
      assert.equal(result.inserted[0]?.id, synced.id);
    },
  });

  await runtime.start();
  await waitFor(() => committed);
  assert.equal(persisted, true);
  await runtime.stop();
});

test("account runtime yields background claim to a paused resource governor and aborts cleanly on stop", async () => {
  const synced = bodyMessage();
  let governorCalls = 0;
  let backgroundClaimCalls = 0;
  // A governor that never admits background work: waitForAdmission blocks until
  // the caller's signal aborts (simulating a paused governor / machine under load).
  const pausedGovernor = {
    canRun: () => false,
    waitForAdmission: async (_workload: string, signal?: AbortSignal): Promise<boolean> => {
      governorCalls += 1;
      return new Promise<boolean>((resolve) => {
        if (signal?.aborted) return resolve(false);
        signal?.addEventListener("abort", () => resolve(false), { once: true });
      });
    },
  };
  let metadataJob: MailJob | null = null;
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js",
    dataDir: ".wemail",
    accountId: synced.accountId,
    resourceGovernor: pausedGovernor as unknown as MailCoreAccountRuntimeOptions["resourceGovernor"],
    dbWriter: {
      enqueueJob: async (input) => {
        metadataJob = {
          id: 51,
          kind: input.kind,
          accountId: input.accountId ?? null,
          payload: input.payload,
          priority: input.priority,
          attempts: 0,
          maxAttempts: input.maxAttempts ?? 10,
          availableAt: new Date().toISOString(),
          leaseOwner: null,
          leaseUntil: null,
          idempotencyKey: input.idempotencyKey ?? null,
        };
        return metadataJob;
      },
      claimJob: async (_owner, _lease, filter) => {
        if (filter?.kinds?.includes("mail.metadata.sync")) backgroundClaimCalls += 1;
        return null;
      },
      completeJob: async () => true,
      failJob: async () => true,
      persistMailBody: async () => ({ emailId: "unused", bodyCached: true }),
      recordMailBodyFailure: async () => ({ attempts: 1, nextRetryAt: new Date().toISOString() }),
      persistMailMetadata: async () => ({ inserted: [], updatedCount: 0 }),
      resolveRemoteOperation: async (input) => ({
        accountId: input.accountId,
        emailId: input.emailId,
        remoteEmailId: input.emailId,
        messageId: "message-42",
        locator: input.fallbackLocator ?? { folder: "INBOX", uid: 1, uidValidity: 1, internalDate: "", state: "ready" },
        mutation: input.mutation,
      }),
      completeRemoteOperation: async () => true,
      claimOutbox: async () => null,
      failOutbox: async () => true,
      claimSend: async () => null,
      completeSend: async () => ({ value: { outboxId: "unused", messageId: "unused" }, commitVersion: 0, changes: [] }),
      failSend: async () => true,
    },
    createWorker: () => new FakeMetadataWorker(synced),
  });

  await runtime.start();
  // Give the async wake chain time to reach the governor.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(governorCalls >= 1, "background claim must have consulted the governor");
  assert.ok(backgroundClaimCalls > 0, "core metadata must remain claimable while background work is paused");
  const claimsBeforeStop = backgroundClaimCalls;
  await runtime.stop();
  assert.equal(backgroundClaimCalls, claimsBeforeStop, "stop must not dispatch more work");
});

test("account runtime restores metadata after an idle Worker exits and reloads its committed cursor", async () => {
  const workers: RecordingWorker[] = [];
  const jobs: MailJob[] = [];
  const writer = queueWriter(jobs);
  let nextId = 100;
  writer.enqueueJob = async (input) => {
    const queued = job(nextId++, input.kind, input.priority, input.payload);
    jobs.push(queued);
    return queued;
  };
  const cursor = { uid: 91, uidValidity: 17, internalDate: "2026-11-04T00:00:00Z" };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1",
    initialCursor: { ...cursor, uid: 1 },
    loadSyncCursor: async () => cursor,
    dbWriter: writer,
    createWorker: () => {
      const worker = new RecordingWorker("acct-1");
      workers.push(worker);
      return worker;
    },
  });
  try {
    await runtime.start();
    await waitFor(() => workers[0].commands.length > 0);
    const first = workers[0].commands[0];
    assert.equal(first.type, "account-worker.sync-metadata");
    if (first.type !== "account-worker.sync-metadata") return;
    workers[0].emit("message", {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: first.jobId,
      origin: "bootstrap", ok: true, messages: [], replaceCursors: false, completed: true,
    } satisfies AccountWorkerEvent);
    await waitFor(() => runtime.health().currentBackgroundJobId === null);
    workers[0].emit("exit", 1);
    await waitFor(() => workers.length === 2 && workers[1].commands.length > 0, 2_000);
    const restored = workers[1].commands[0];
    assert.equal(restored.type, "account-worker.sync-metadata");
    if (restored.type === "account-worker.sync-metadata") assert.deepEqual(restored.cursor, cursor);
  } finally { await runtime.stop(); }
});

test("startup keeps replacing failed Workers beyond six exits until one becomes ready", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-04T00:00:00Z") });
  let attempts = 0;
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1", autoSync: false,
    dbWriter: queueWriter([]),
    createWorker: () => {
      const worker = Object.assign(new EventEmitter(), {
        postMessage: (_command: AccountWorkerCommand) => undefined,
        terminate: async () => 0,
      });
      const attempt = ++attempts;
      queueMicrotask(() => {
        if (attempt <= 8) worker.emit("exit", 1);
        else worker.emit("message", {
          type: "account-worker.ready", accountId: "acct-1", threadId: 9,
        } satisfies AccountWorkerEvent);
      });
      return worker;
    },
  });
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const started = runtime.start();
  try {
    for (let i = 0; i < 8; i++) {
      await settle();
      assert.equal(runtime.health().state, "degraded");
      t.mock.timers.tick(30_000);
    }
    await started;
    assert.equal(attempts, 9);
    assert.equal(runtime.health().state, "ready");
    assert.equal(runtime.health().receipt.generation, 9);
  } finally { await runtime.stop(); }
});

test("account runtime compensates missing push events and coalesces demand until persistence finishes", async () => {
  const worker = new RecordingWorker("acct-1");
  const jobs: MailJob[] = [];
  const writer = queueWriter(jobs);
  let enqueues = 0;
  writer.enqueueJob = async (input) => {
    const queued = job(++enqueues, input.kind, input.priority, input.payload);
    jobs.push(queued);
    return queued;
  };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1",
    initialCursor: { uid: 1, uidValidity: 17, internalDate: "2026-11-04T00:00:00Z" },
    metadataCheckIntervalMs: 20, dbWriter: writer, createWorker: () => worker,
  });
  try {
    await runtime.start();
    await waitFor(() => worker.commands.length > 0);
    const first = worker.commands[0];
    if (first.type !== "account-worker.sync-metadata") throw new Error("expected metadata");
    await Promise.all([
      runtime.enqueueMetadataSync("manual", 1),
      runtime.enqueueMetadataSync("live-idle", 2),
    ]);
    assert.equal(enqueues, 1);
    worker.emit("message", {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: first.jobId,
      origin: first.origin, ok: true, messages: [], replaceCursors: false, completed: true,
    } satisfies AccountWorkerEvent);
    await waitFor(() => enqueues === 2);
    const second = jobs[1];
    assert.deepEqual(second.payload, { origin: "manual" });
    await waitFor(() => runtime.health().currentBackgroundJobId === second.id);
    worker.emit("message", {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: second.id,
      origin: "manual", ok: true, messages: [], replaceCursors: false, completed: true,
    } satisfies AccountWorkerEvent);
    await waitFor(() => enqueues >= 3);
    assert.deepEqual(jobs[2].payload, { origin: "live-poll" });
  } finally { await runtime.stop(); }
});

test("account runtime retries a transient background DB claim failure", async () => {
  const worker = new RecordingWorker("acct-1");
  const writer = queueWriter([]);
  const logs: Array<{ phase: string; data?: Record<string, unknown> }> = [];
  let nextMailDueCalls = 0;
  writer.nextMailDue = async () => {
    nextMailDueCalls += 1;
    if (nextMailDueCalls === 1) throw new Error("DB Service producer timeout:queue.nextMailDue");
    return null;
  };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js",
    dataDir: ".wemail",
    accountId: "acct-1",
    autoSync: false,
    dbWriter: writer,
    createWorker: () => worker,
    log: (phase, data) => logs.push({ phase, data }),
  });

  await runtime.start();
  await waitFor(() => nextMailDueCalls >= 2, 2_000);

  assert.ok(logs.some(({ phase, data }) =>
    phase === "mail.claim-failed" && data?.lane === "background"
  ));
  await runtime.stop();
});

test("pending manual demand is forwarded at the next durable page without another queued job", async () => {
  const worker = new RecordingWorker("acct-1");
  const jobs: MailJob[] = [];
  const writer = queueWriter(jobs);
  let enqueues = 0;
  writer.enqueueJob = async (input) => {
    const queued = job(++enqueues, input.kind, input.priority, input.payload);
    jobs.push(queued);
    return queued;
  };
  writer.deferJob = async (id) => {
    jobs.find((candidate) => candidate.id === id)!.leaseOwner = null;
    return true;
  };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1",
    initialCursor: { uid: 1, uidValidity: 17, internalDate: "2026-11-04T00:00:00Z" },
    loadSyncStates: async () => ({}), dbWriter: writer, createWorker: () => worker,
  });
  try {
    await runtime.start();
    await waitFor(() => worker.commands.some((command) => command.type === "account-worker.sync-metadata"));
    const accepted = await runtime.enqueueMetadataSync("manual", 1);
    worker.emit("message", {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: jobs[0].id,
      origin: "bootstrap", ok: true, messages: [], replaceCursors: false, completed: false,
    } satisfies AccountWorkerEvent);
    await waitFor(() => worker.commands.filter((command) => command.type === "account-worker.sync-metadata").length === 2);
    const resumed = worker.commands.filter((command) => command.type === "account-worker.sync-metadata")[1];
    assert.equal(resumed.recheckInbox, true);
    assert.equal(enqueues, 1);
    worker.emit("message", {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: jobs[0].id,
      origin: "bootstrap", ok: true, messages: [], replaceCursors: false, completed: true,
    } satisfies AccountWorkerEvent);
    await waitFor(() => runtime.health().receipt.completedVersion === accepted.receiptVersion);
  } finally { await runtime.stop(); }
});

test("old Worker completion cannot acknowledge or complete a newer receipt generation", async () => {
  const workers: RecordingWorker[] = [];
  const jobs: MailJob[] = [];
  const writer = queueWriter(jobs);
  let enqueues = 0;
  writer.enqueueJob = async (input) => {
    const queued = job(++enqueues, input.kind, input.priority, input.payload);
    jobs.push(queued);
    return queued;
  };
  let finishCommit!: (value: boolean) => void;
  let completing = false;
  writer.completeJob = async () => {
    completing = true;
    return new Promise<boolean>((resolve) => { finishCommit = resolve; });
  };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1",
    initialCursor: { uid: 1, uidValidity: 17, internalDate: "2026-11-04T00:00:00Z" },
    dbWriter: writer, createWorker: () => {
      const worker = new RecordingWorker("acct-1");
      workers.push(worker);
      return worker;
    },
  });
  try {
    await runtime.start();
    await waitFor(() => workers[0].commands.length > 0);
    workers[0].emit("message", {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: jobs[0].id,
      origin: "bootstrap", ok: true, messages: [], replaceCursors: false, completed: true,
    } satisfies AccountWorkerEvent);
    await waitFor(() => completing);
    workers[0].emit("exit", 1);
    await waitFor(() => workers.length === 2 && workers[1].commands.length > 0, 2_000);
    finishCommit(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(runtime.health().receipt.completedVersion, 0);
    assert.ok(!workers[0].commands.some((command) => command.type === "account-worker.metadata-ack"));
  } finally { await runtime.stop(); }
});

test("metadata watchdog measures operation progress even while heartbeats keep arriving", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-04T00:00:00Z") });
  const worker = new RecordingWorker("acct-1");
  let terminations = 0;
  worker.terminate = async () => { terminations++; return 0; };
  const jobs: MailJob[] = [];
  const writer = queueWriter(jobs);
  writer.enqueueJob = async (input) => {
    const queued = job(jobs.length + 1, input.kind, input.priority, input.payload);
    jobs.push(queued);
    return queued;
  };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1", dbWriter: writer,
    createWorker: () => worker,
  });
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const heartbeat = () => worker.emit("message", {
    type: "account-worker.heartbeat", accountId: "acct-1", threadId: 1, at: Date.now(),
  } satisfies AccountWorkerEvent);
  try {
    await runtime.start();
    await settle();
    assert.equal(runtime.health().currentBackgroundJobId, 1);
    for (let i = 0; i < 15; i++) { t.mock.timers.tick(2_000); heartbeat(); }
    worker.emit("message", {
      type: "account-worker.metadata-progress", accountId: "acct-1", jobId: 1,
    } satisfies AccountWorkerEvent);
    for (let i = 0; i < 29; i++) { t.mock.timers.tick(2_000); heartbeat(); }
    assert.equal(terminations, 0, "completed provider commands extend the progress deadline");
    t.mock.timers.tick(4_000);
    heartbeat();
    assert.ok(terminations > 0, "heartbeats alone cannot hide a stuck metadata operation");
  } finally { await runtime.stop(); }
});

test("a late Writer result cannot acknowledge receipt after progress recovery begins", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-04T00:00:00Z") });
  const worker = new RecordingWorker("acct-1");
  const jobs: MailJob[] = [];
  const writer = queueWriter(jobs);
  writer.enqueueJob = async (input) => {
    const queued = job(jobs.length + 1, input.kind, input.priority, input.payload);
    jobs.push(queued);
    return queued;
  };
  let finishCommit!: () => void;
  let commits = 0;
  let completions = 0;
  let terminations = 0;
  writer.persistMailMetadata = async () => {
    commits++;
    await new Promise<void>((resolve) => { finishCommit = resolve; });
    return { inserted: [], updatedCount: 0 };
  };
  writer.completeJob = async () => { completions++; return true; };
  // Leave the exit event pending to exercise the interval between termination and exit.
  worker.terminate = async () => { terminations++; return 0; };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1",
    dbWriter: writer, createWorker: () => worker,
  });
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  try {
    await runtime.start();
    await settle();
    const result = {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: 1,
      origin: "bootstrap", ok: true, messages: [], replaceCursors: false, completed: true,
    } satisfies AccountWorkerEvent;
    worker.emit("message", result);
    await settle();
    assert.equal(commits, 1);
    for (let i = 0; i < 31; i++) {
      worker.emit("message", {
        type: "account-worker.heartbeat", accountId: "acct-1", threadId: 1, at: Date.now(),
      } satisfies AccountWorkerEvent);
      t.mock.timers.tick(2_000);
    }
    assert.ok(terminations > 0);
    assert.equal(runtime.health().state, "degraded");
    finishCommit();
    await settle();
    worker.emit("message", result);
    await settle();
    assert.equal(commits, 1, "a result arriving after recovery must not start another commit");
    assert.equal(completions, 0);
    assert.equal(runtime.health().receipt.completedVersion, 0);
    assert.ok(!worker.commands.some((command) => command.type === "account-worker.metadata-ack"));
  } finally { await runtime.stop(); }
});

test("metadata recovery cancels only receipt while SMTP remains in flight and fences its late Writer result", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-04T00:00:00Z") });
  const worker = new RecordingWorker("acct-1");
  const jobs: MailJob[] = [];
  const writer = queueWriter(jobs);
  writer.enqueueJob = async (input) => {
    const queued = job(jobs.length + 1, input.kind, input.priority, input.payload);
    jobs.push(queued);
    return queued;
  };
  let sending = false;
  let sent = 0;
  let sendFailures = 0;
  writer.claimSend = async (owner) => {
    if (sending) return null;
    sending = true;
    return { id: 7, publicId: "send-7", accountId: "acct-1", messageIdHeader: "<stable@example.test>",
      attempts: 1, maxAttempts: 3, leaseOwner: owner,
      draft: { accountId: "acct-1", to: [{ email: "to@example.test" }], subject: "Fixture", bodyText: "", bodyHtml: "" } };
  };
  writer.completeSend = async () => { sent++; return { value: { outboxId: "send-7", messageId: "sent" }, commitVersion: 1, changes: [] }; };
  writer.failSend = async () => { sendFailures++; return true; };
  let finishCommit!: () => void;
  writer.persistMailMetadata = async () => {
    await new Promise<void>((resolve) => { finishCommit = resolve; });
    return { inserted: [], updatedCount: 0 };
  };
  let terminations = 0;
  worker.terminate = async () => { terminations++; return 0; };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1", autoSync: false,
    dbWriter: writer, createWorker: () => worker,
  });
  const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
  try {
    await runtime.start();
    await runtime.enqueueMetadataSync("manual", 1);
    await settle();
    assert.equal(runtime.health().currentSendId, "send-7");
    worker.emit("message", {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: 1,
      origin: "manual", ok: true, messages: [], replaceCursors: false, completed: true,
    } satisfies AccountWorkerEvent);
    await settle();
    for (let i = 0; i < 31; i++) {
      worker.emit("message", {
        type: "account-worker.heartbeat", accountId: "acct-1", threadId: 1, at: Date.now(),
      } satisfies AccountWorkerEvent);
      t.mock.timers.tick(2_000);
    }
    assert.equal(terminations, 0);
    assert.equal(sendFailures, 0);
    assert.equal(worker.commands.filter((command) => command.type === "account-worker.cancel-metadata").length, 1);
    worker.emit("message", { type: "account-worker.metadata-cancelled", accountId: "acct-1", jobId: 999 } satisfies AccountWorkerEvent);
    await settle();
    assert.equal(runtime.health().state, "degraded");
    worker.emit("message", { type: "account-worker.metadata-cancelled", accountId: "acct-1", jobId: 1 } satisfies AccountWorkerEvent);
    await settle();
    assert.equal(runtime.health().state, "ready");
    assert.equal(runtime.health().currentSendId, "send-7");
    finishCommit();
    await settle();
    assert.equal(runtime.health().receipt.completedVersion, 0);
    assert.ok(!worker.commands.some((command) => command.type === "account-worker.metadata-ack" && command.continue));
    worker.emit("message", { type: "account-worker.send-result", accountId: "acct-1", outboxId: 7, ok: true, messageId: "sent" } satisfies AccountWorkerEvent);
    await settle();
    assert.equal(sent, 1);
    assert.equal(sendFailures, 0);
    assert.equal(worker.commands.filter((command) => command.type === "account-worker.send-draft").length, 1);
  } finally { await runtime.stop(); }
});

test("an empty successful mailbox check remains healthy without new-mail progress", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-04T00:00:00Z") });
  const worker = new RecordingWorker("acct-1");
  const jobs: MailJob[] = [];
  const writer = queueWriter(jobs);
  writer.enqueueJob = async (input) => {
    const queued = job(jobs.length + 1, input.kind, input.priority, input.payload);
    jobs.push(queued);
    return queued;
  };
  let terminations = 0;
  worker.terminate = async () => { terminations++; return 0; };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1", autoSync: false,
    dbWriter: writer, createWorker: () => worker,
  });
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  try {
    await runtime.start();
    const accepted = await runtime.enqueueMetadataSync("manual", 1);
    await settle();
    t.mock.timers.tick(10);
    const checkedAt = Date.now();
    worker.emit("message", {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: 1,
      origin: "manual", ok: true, messages: [], replaceCursors: false, completed: true,
    } satisfies AccountWorkerEvent);
    await settle();
    assert.equal(runtime.health().receipt.completedVersion, accepted.receiptVersion);
    assert.equal(runtime.health().receipt.lastSuccessfulCheckAt, checkedAt);
    assert.equal(runtime.health().receipt.lastCommittedAt, checkedAt);
    assert.equal(runtime.health().receipt.activeStartedAt, null);
    assert.equal(runtime.health().receipt.stage, "idle");
    for (let i = 0; i < 60; i++) {
      worker.emit("message", {
        type: "account-worker.heartbeat", accountId: "acct-1", threadId: 1, at: Date.now(),
      } satisfies AccountWorkerEvent);
      t.mock.timers.tick(2_000);
    }
    assert.equal(terminations, 0, "an idle mailbox must not time out for receiving no new messages");
  } finally { await runtime.stop(); }
});

test("an uncertain Writer timeout rejects ACK and the next request reloads committed progress", async () => {
  const worker = new RecordingWorker("acct-1");
  const jobs: MailJob[] = [];
  const writer = queueWriter(jobs);
  writer.enqueueJob = async (input) => {
    if (jobs.length === 0) jobs.push(job(1, input.kind, input.priority, input.payload));
    return jobs[0];
  };
  writer.failJob = async () => { jobs[0].leaseOwner = null; return true; };
  let durable = { uid: 0, uidValidity: 17, internalDate: "2026-11-04T00:00:00Z" };
  writer.persistMailMetadata = async () => {
    durable = { ...durable, uid: 1 };
    throw new Error("DB Service producer timeout:mail.persistMetadata");
  };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1", autoSync: false,
    loadSyncStates: async () => ({ INBOX: { ...durable } }),
    dbWriter: writer, createWorker: () => worker,
  });
  try {
    await runtime.start();
    const first = await runtime.enqueueMetadataSync("manual", 1);
    await waitFor(() => worker.commands.length > 0);
    worker.emit("message", {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: 1,
      origin: "manual", ok: true, messages: [], replaceCursors: false, completed: true,
    } satisfies AccountWorkerEvent);
    await waitFor(() => runtime.health().currentBackgroundJobId === null);
    assert.equal(runtime.health().receipt.failedVersion, first.receiptVersion);
    assert.equal(runtime.health().receipt.completedVersion, 0);
    assert.ok(worker.commands.some((command) => command.type === "account-worker.metadata-ack" && !command.continue));
    assert.ok(!worker.commands.some((command) => command.type === "account-worker.metadata-ack" && command.continue));
    await runtime.enqueueMetadataSync("manual", 1);
    await waitFor(() => worker.commands.filter((command) => command.type === "account-worker.sync-metadata").length === 2);
    const resumed = worker.commands.filter((command) => command.type === "account-worker.sync-metadata")[1];
    assert.equal(resumed.syncStates?.INBOX.uid, 1, "unknown outcome must reconcile with the Writer before fetching again");
  } finally { await runtime.stop(); }
});

test("a failed checkpoint read releases the coordinator so a later request can revive terminal work", async () => {
  const worker = new RecordingWorker("acct-1");
  const jobs: MailJob[] = [];
  const writer = queueWriter(jobs);
  let enqueues = 0;
  writer.enqueueJob = async (input) => {
    const queued = job(++enqueues, input.kind, input.priority, input.payload);
    jobs.push(queued);
    return queued;
  };
  let loadFails = true;
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1", autoSync: false,
    loadSyncStates: async () => { if (loadFails) throw new Error("database unavailable"); return {}; },
    dbWriter: writer, createWorker: () => worker,
  });
  try {
    await runtime.start();
    await runtime.enqueueMetadataSync("manual", 1);
    await waitFor(() => runtime.health().receipt.stage === "recovery");
    loadFails = false;
    await runtime.enqueueMetadataSync("manual", 1);
    await waitFor(() => worker.commands.some((command) => command.type === "account-worker.sync-metadata"));
    assert.equal(enqueues, 2, "the failed request must not remain the coalescing anchor");
  } finally { await runtime.stop(); }
});

test("provider retry deadlines block manual and historical metadata until the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-04T00:00:00Z") });
  const worker = new RecordingWorker("acct-1");
  const jobs: MailJob[] = [];
  const writer = queueWriter(jobs);
  writer.enqueueJob = async (input) => {
    const queued = job(jobs.length + 1, input.kind, input.priority, input.payload);
    jobs.push(queued);
    return queued;
  };
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1", autoSync: false,
    heartbeatTimeoutMs: 1_000_000, dbWriter: writer, createWorker: () => worker,
  });
  try {
    await runtime.start();
    await runtime.enqueueMetadataSync("manual", 1);
    await settle();
    worker.emit("message", {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: 1, origin: "manual",
      ok: false, errorCode: "server busy", retryable: true, retryAfterMs: 120_000,
    } satisfies AccountWorkerEvent);
    await settle();
    await runtime.enqueueMetadataSync("historical", 4);
    await runtime.enqueueMetadataSync("manual", 1);
    await settle();
    t.mock.timers.tick(119_999);
    await settle();
    assert.equal(worker.commands.filter((command) => command.type === "account-worker.sync-metadata").length, 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(worker.commands.filter((command) => command.type === "account-worker.sync-metadata").length, 2);
  } finally { await runtime.stop(); }
});

test("account compensation revives receipt after the durable job exhausts six attempts", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-04T00:00:00Z") });
  const worker = new RecordingWorker("acct-1");
  const writer = queueWriter([]);
  let durable: MailJob | null = null;
  let terminal = false;
  let revivals = 0;
  writer.enqueueJob = async (input) => {
    assert.equal(input.terminalPolicy, "revive");
    if (!durable) durable = job(1, input.kind, input.priority, input.payload);
    if (terminal) { durable.attempts = 0; terminal = false; revivals++; }
    return durable;
  };
  writer.claimJob = async (owner, _lease, filter) => {
    if (!durable || durable.leaseOwner || terminal || !filter?.kinds?.includes("mail.metadata.sync")) return null;
    durable.attempts++;
    durable.leaseOwner = owner;
    return { ...durable };
  };
  writer.failJob = async () => {
    durable!.leaseOwner = null;
    terminal = durable!.attempts >= 6;
    return true;
  };
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1",
    heartbeatTimeoutMs: 1_000_000, dbWriter: writer, createWorker: () => worker,
    initialCursor: { uid: 1, uidValidity: 17, internalDate: "2026-11-04T00:00:00Z" },
  });
  try {
    await runtime.start();
    await settle();
    for (let i = 0; i < 8; i++) {
      assert.equal(runtime.health().currentBackgroundJobId, 1);
      worker.emit("message", {
        type: "account-worker.metadata-result", accountId: "acct-1", jobId: 1,
        origin: "bootstrap", ok: false, errorCode: "offline", retryable: true,
      } satisfies AccountWorkerEvent);
      await settle();
      t.mock.timers.tick(60_000);
      await settle();
    }
    assert.ok(revivals >= 1);
    worker.emit("message", {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: 1,
      origin: "bootstrap", ok: true, messages: [], replaceCursors: false, completed: true,
    } satisfies AccountWorkerEvent);
    await settle();
    assert.equal(runtime.health().receipt.consecutiveFailures, 0);
    assert.ok(runtime.health().receipt.completedVersion > 0);
  } finally { await runtime.stop(); }
});

test("a metadata lease arriving after stop is returned without waiting for lease expiry", async () => {
  const worker = new RecordingWorker("acct-1");
  const writer = queueWriter([]);
  let finishClaim!: (job: MailJob) => void;
  let owner: string | undefined;
  let released = false;
  writer.claimJob = async (requestedOwner, _lease, filter) => {
    if (!filter?.kinds?.includes("mail.metadata.sync")) return null;
    owner = requestedOwner;
    return new Promise<MailJob>((resolve) => { finishClaim = resolve; });
  };
  writer.deferJob = async (id, requestedOwner, _reason, delay) => {
    assert.equal(id, 1);
    assert.equal(requestedOwner, owner);
    assert.equal(delay, 0);
    released = true;
    return true;
  };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1", autoSync: false,
    dbWriter: writer, createWorker: () => worker,
  });
  try {
    await runtime.start();
    await waitFor(() => owner !== undefined);
    await runtime.stop();
    finishClaim({ ...job(1, "mail.metadata.sync", 1, { origin: "manual" }), leaseOwner: owner! });
    await waitFor(() => released);
    assert.ok(!worker.commands.some((command) => command.type === "account-worker.sync-metadata"));
    assert.equal(runtime.health().currentBackgroundJobId, null);
  } finally { await runtime.stop(); }
});

test("stopping still awaits termination when the Worker shutdown port is already closed", async () => {
  const worker = new RecordingWorker("acct-1");
  let terminated = false;
  worker.postMessage = (command) => {
    if (command.type === "account-worker.shutdown") throw new Error("port closed");
  };
  worker.terminate = async () => { terminated = true; return 0; };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1", autoSync: false,
    dbWriter: queueWriter([]), createWorker: () => worker,
  });
  await runtime.start();
  await runtime.stop();
  assert.equal(terminated, true);
  assert.equal(runtime.health().state, "stopped");
});

test("sleep compensation emits one current intent and stopped runtimes do not replay expired checks", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-04T00:00:00Z") });
  const worker = new RecordingWorker("acct-1");
  const jobs: MailJob[] = [];
  const writer = queueWriter(jobs);
  writer.enqueueJob = async (input) => {
    const queued = job(jobs.length + 1, input.kind, input.priority, input.payload);
    jobs.push(queued);
    return queued;
  };
  const runtime = new MailCoreAccountRuntime({
    entryPath: "account-worker.js", dataDir: ".wemail", accountId: "acct-1", dbWriter: writer,
    initialCursor: { uid: 1, uidValidity: 17, internalDate: "2026-11-04T00:00:00Z" },
    createWorker: () => worker,
  });
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  try {
    await runtime.start();
    await settle();
    worker.emit("message", {
      type: "account-worker.metadata-result", accountId: "acct-1", jobId: 1,
      origin: "bootstrap", ok: true, messages: [], replaceCursors: false, completed: true,
    } satisfies AccountWorkerEvent);
    await settle();
    const beforeSleep = runtime.health().receipt.requestedVersion;
    t.mock.timers.setTime(Date.now() + 10 * 60_000);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(runtime.health().receipt.requestedVersion, beforeSleep + 1);
    await runtime.stop();
    const stoppedVersion = runtime.health().receipt.requestedVersion;
    t.mock.timers.tick(10 * 60_000);
    await settle();
    assert.equal(runtime.health().receipt.requestedVersion, stoppedVersion);
    assert.equal(jobs.length, 2);
  } finally { await runtime.stop(); }
});

function job(id: number, kind: string, priority: number, payload: unknown): MailJob {
  return {
    id,
    kind,
    accountId: "acct-1",
    payload,
    priority,
    attempts: 0,
    maxAttempts: 5,
    availableAt: new Date().toISOString(),
    leaseOwner: null,
    leaseUntil: null,
    idempotencyKey: `${kind}:${id}`,
  };
}

function queueWriter(jobs: MailJob[]): MailCoreAccountRuntimeOptions["dbWriter"] {
  return {
    enqueueJob: async (input) => job(99, input.kind, input.priority, input.payload),
    claimJob: async (_owner, _lease, filter) => {
      const candidates = jobs.filter((candidate) =>
        !candidate.leaseOwner &&
        (!filter?.kinds?.length || filter.kinds.includes(candidate.kind)) &&
        (!filter?.priorities?.length || filter.priorities.includes(candidate.priority)) &&
        (filter?.minPriority === undefined || candidate.priority >= filter.minPriority),
      );
      candidates.sort((left, right) =>
        left.priority - right.priority ||
        (filter?.order === "lifo" ? right.id - left.id : left.id - right.id),
      );
      const selected = candidates[0];
      if (!selected) return null;
      selected.attempts += 1;
      selected.leaseOwner = _owner;
      return { ...selected };
    },
    completeJob: async () => true,
    failJob: async () => true,
    claimOutbox: async () => null,
    failOutbox: async () => true,
    claimSend: async () => null,
    completeSend: async () => ({ value: { outboxId: "unused", messageId: "unused" }, commitVersion: 0, changes: [] }),
    failSend: async () => true,
    persistMailBody: async () => ({ emailId: "unused", bodyCached: true }),
    recordMailBodyFailure: async () => ({ attempts: 1, nextRetryAt: new Date().toISOString() }),
    persistMailMetadata: async () => ({ inserted: [], updatedCount: 0 }),
    resolveRemoteOperation: async () => {
      throw new Error("not used");
    },
    completeRemoteOperation: async () => true,
  };
}

function bodyMessage(): MailMessage {
  return {
    id: "acct-1:INBOX:1:42",
    accountId: "acct-1",
    folder: "INBOX",
    messageId: "message-42",
    from: { email: "sender@example.com" },
    to: [{ email: "user@example.com" }],
    cc: [],
    bcc: [],
    subject: "Subject",
    snippet: "Body",
    bodyText: "Body",
    bodyCachedUntil: "2026-08-01T00:00:00.000Z",
    receivedAt: "2026-07-29T00:00:00.000Z",
    hasAttachments: false,
    attachments: [],
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: { uid: 42, uidValidity: 1, internalDate: "2026-07-29T00:00:00.000Z" },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for account runtime");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
