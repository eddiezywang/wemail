import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { WemailMcpConfigurationTarget } from "../../shared/wemail/mcp.js";
import {
  MAIL_CORE_PROTOCOL_VERSION,
  type MailCoreControlMessage,
  type MailCoreAttachmentFetchParams,
  type MailRefreshResult,
  type MailboxCredentialEnvelope,
} from "../../shared/wemail/mailCoreProtocol.js";
import type {
  ManagedMcpCredential,
  ManagedMcpCredentialVault,
} from "../../server/wemail/mcp/ManagedMcpCredentialVault.js";
import { safeStreamWrite } from "./safe-stream-write.js";
import { formatProcessLog, type ProcessLogLevel } from "./process-log.js";
import { MailReceiptHealthSchema, type MailReceiptHealth } from "../../shared/wemail/mailSync.js";

export interface MailCoreSupervisorLog {
  (phase: string, extra?: Record<string, unknown>): void;
}

export interface MailCoreApiEndpointState {
  state: "recovering" | "ready";
  port: number | null;
  generation: number;
}

export class MailCoreSupervisor {
  private child: UtilityProcess | null = null;
  private controlPort: MessagePortMain | null = null;
  private ready = false;
  private stopping = false;
  private lastHeartbeatAt = 0;
  private receipt: { accountId: string; health: MailReceiptHealth } | null = null;
  private missedHeartbeatChecks = 0;
  private restartAttempt = 0;
  private apiPort: number | null = null;
  private apiEndpointGeneration = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private heartbeatMonitor: NodeJS.Timeout | null = null;
  private readonly readyWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private databaseWriterPortFactory: (() => MessagePortMain) | null = null;
  private mailboxCredential: MailboxCredentialEnvelope | null = null;
  private readonly renderers = new Set<WebContents>();
  private readonly mailChangedListeners = new Set<(
    event: Extract<MailCoreControlMessage, { type: "mail-core.mail-changed" }>,
  ) => void>();
  private readonly credentialInvalidListeners = new Set<(
    event: Extract<MailCoreControlMessage, { type: "mail-core.mail-credential-invalid" }>,
  ) => void>();
  private readonly apiEndpointListeners = new Set<(
    state: MailCoreApiEndpointState,
  ) => void>();
  private readonly configurationRequests = new Map<string, {
    resolve: (configuration: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly attachmentRequests = new Map<string, {
    resolve: (result: { bytes: Buffer; mediaType: string }) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    removeAbortListener?: () => void;
  }>();
  private readonly refreshRequests = new Map<string, {
    resolve: (result: MailRefreshResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly entryPath: string,
    private readonly log: MailCoreSupervisorLog,
    private readonly managedMcpCredentials?: ManagedMcpCredentialVault,
    private readonly isDebugLoggingEnabled: () => boolean =
      () => process.env.WEMAIL_DEBUG_MODE === "1",
  ) {}

  start(): void {
    if (this.child || this.stopping) return;
    this.spawn();
    this.heartbeatMonitor = setInterval(() => this.checkHeartbeat(), 5_000);
    this.heartbeatMonitor.unref();
  }

  reloadAccount(): void {
    this.receipt = null;
    this.controlPort?.postMessage({
      type: "mail-core.reload-account",
    } satisfies MailCoreControlMessage);
  }

  configureAccountCredential(credential: MailboxCredentialEnvelope | null): void {
    this.receipt = null;
    this.mailboxCredential = credential;
    if (!this.ready || !this.controlPort) return;
    this.controlPort.postMessage({
      type: "mail-core.configure-account",
      credential,
    } satisfies MailCoreControlMessage);
  }

  getApiPort(): number | null {
    return this.apiPort;
  }

  getMailReceipt(accountId: string): MailReceiptHealth | null {
    return this.ready && this.receipt?.accountId === accountId
      ? { ...this.receipt.health, observedAt: this.lastHeartbeatAt } : null;
  }

  onApiEndpointChanged(
    listener: (state: MailCoreApiEndpointState) => void,
  ): () => void {
    this.apiEndpointListeners.add(listener);
    listener({
      state: this.apiPort ? "ready" : "recovering",
      port: this.apiPort,
      generation: this.apiEndpointGeneration,
    });
    return () => this.apiEndpointListeners.delete(listener);
  }

  getMcpConfiguration(
    target: WemailMcpConfigurationTarget,
    timeoutMs = 2_000,
  ): Promise<string> {
    if (!this.ready || !this.controlPort) {
      return Promise.reject(new Error("mcp-not-ready"));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.configurationRequests.delete(requestId);
        reject(new Error("mcp-configuration-timeout"));
      }, timeoutMs);
      timer.unref();
      this.configurationRequests.set(requestId, { resolve, reject, timer });
      this.controlPort!.postMessage({
        type: "mail-core.mcp-configuration-request",
        requestId,
        target,
      } satisfies MailCoreControlMessage);
    });
  }

  refreshMail(accountId: string, timeoutMs = 5_000): Promise<MailRefreshResult> {
    if (!this.ready || !this.controlPort) {
      return Promise.resolve({ status: "account-unavailable" });
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.refreshRequests.delete(requestId);
        reject(new Error("mail-refresh-timeout"));
      }, timeoutMs);
      timer.unref();
      this.refreshRequests.set(requestId, { resolve, reject, timer });
      this.controlPort!.postMessage({
        type: "mail-core.refresh-request",
        requestId,
        accountId,
      } satisfies MailCoreControlMessage);
    });
  }

  fetchAttachment(
    params: MailCoreAttachmentFetchParams & { signal?: AbortSignal },
    timeoutMs = 45_000,
  ): Promise<{ bytes: Buffer; mediaType: string }> {
    if (params.signal?.aborted) {
      return Promise.reject(namedError(
        "ATTACHMENT_CANCELLED",
        "attachment request cancelled",
      ));
    }
    if (!this.ready || !this.controlPort) {
      return Promise.reject(namedError(
        "ATTACHMENT_SERVICE_UNAVAILABLE",
        "Mail Core is unavailable",
      ));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancelAttachmentRequest(
          requestId,
          namedError("ATTACHMENT_FETCH_TIMEOUT", "Mail Core attachment request timed out"),
        );
      }, timeoutMs);
      timer.unref();
      const removeAbortListener = params.signal
        ? () => params.signal?.removeEventListener("abort", onAbort)
        : undefined;
      const onAbort = () => {
        this.cancelAttachmentRequest(
          requestId,
          namedError("ATTACHMENT_CANCELLED", "attachment request cancelled"),
        );
      };
      params.signal?.addEventListener("abort", onAbort, { once: true });
      this.attachmentRequests.set(requestId, {
        resolve,
        reject,
        timer,
        ...(removeAbortListener ? { removeAbortListener } : {}),
      });
      this.controlPort!.postMessage({
        type: "mail-core.attachment-request",
        requestId,
        params: {
          accountId: params.accountId,
          remoteEmailId: params.remoteEmailId,
          partPath: params.partPath,
          ...(params.source ? { source: params.source } : {}),
          ...(params.viewId ? { viewId: params.viewId } : {}),
        },
      } satisfies MailCoreControlMessage);
    });
  }

  private cancelAttachmentRequest(requestId: string, error: Error): void {
    const pending = this.attachmentRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    this.attachmentRequests.delete(requestId);
    this.controlPort?.postMessage({
      type: "mail-core.attachment-cancel",
      requestId,
    } satisfies MailCoreControlMessage);
    pending.reject(error);
  }

  onMailCredentialInvalid(
    listener: (
      event: Extract<MailCoreControlMessage, { type: "mail-core.mail-credential-invalid" }>,
    ) => void,
  ): () => void {
    this.credentialInvalidListeners.add(listener);
    return () => this.credentialInvalidListeners.delete(listener);
  }

  onMailChanged(
    listener: (
      event: Extract<MailCoreControlMessage, { type: "mail-core.mail-changed" }>,
    ) => void,
  ): () => void {
    this.mailChangedListeners.add(listener);
    return () => this.mailChangedListeners.delete(listener);
  }

  whenReady(timeoutMs = 15_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          this.readyWaiters.delete(waiter);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(waiter.timer);
          this.readyWaiters.delete(waiter);
          reject(error);
        },
        timer: setTimeout(() => undefined, timeoutMs),
      };
      clearTimeout(waiter.timer);
      waiter.timer = setTimeout(() => {
        waiter.reject(new Error("Mail Core readiness timed out"));
      }, timeoutMs);
      waiter.timer.unref();
      this.readyWaiters.add(waiter);
    });
  }

  attachRenderer(webContents: WebContents): void {
    this.renderers.add(webContents);
    webContents.once("destroyed", () => this.renderers.delete(webContents));
    if (this.ready) this.connectRenderer(webContents);
  }

  attachDatabaseWriter(port: MessagePortMain): void {
    if (!this.ready || !this.controlPort) {
      port.close();
      throw new Error("Mail Core is unavailable for DB Service attachment");
    }
    this.controlPort.postMessage({
      type: "mail-core.attach-database-writer",
    } satisfies MailCoreControlMessage, [port]);
    this.log("mail-core-database-writer-attached");
  }

  configureDatabaseWriter(factory: (() => MessagePortMain) | null): void {
    this.databaseWriterPortFactory = factory;
    if (!factory || !this.ready) return;
    try {
      this.attachDatabaseWriter(factory());
    } catch (error) {
      this.log("mail-core-database-writer-attach-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.heartbeatMonitor) clearInterval(this.heartbeatMonitor);
    this.restartTimer = null;
    this.heartbeatMonitor = null;
    const child = this.child;
    const controlPort = this.controlPort;
    if (!child) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish();
      }, 1_000);
      timeout.unref();
      controlPort?.once("message", (event) => {
        const message = event.data as MailCoreControlMessage;
        if (message.type !== "mail-core.shutdown-complete") return;
        clearTimeout(timeout);
        finish();
      });
      controlPort?.postMessage({ type: "mail-core.shutdown" } satisfies MailCoreControlMessage);
      if (!controlPort) {
        clearTimeout(timeout);
        child.kill();
        finish();
      }
    });
    this.disposeCurrent();
    this.rejectReadyWaiters(new Error("Mail Core stopped"));
  }

  forceTerminate(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.heartbeatMonitor) clearInterval(this.heartbeatMonitor);
    this.restartTimer = null;
    this.heartbeatMonitor = null;
    this.child?.kill();
  }

  private spawn(): void {
    const channel = new MessageChannelMain();
    const child = utilityProcess.fork(this.entryPath, [], {
      serviceName: "WeMail Mail Core",
      stdio: "pipe",
      env: { ...process.env },
      // 64MB was too tight for full-mailbox IMAP sync + MIME parsing; the worker
      // OOM'd on large accounts and crash-restarted in a loop (which also
      // re-triggered bot-core reconfigure → WeCom duplicate-connection fights).
      execArgv: ["--max-old-space-size=128"],
    });
    this.child = child;
    this.controlPort = channel.port1;
    this.ready = false;
    this.lastHeartbeatAt = Date.now();

    channel.port1.on("message", (event) => this.handleControl(event.data));
    channel.port1.start();
    child.stdout?.on("data", (chunk) => {
      const line = String(chunk);
      // Persist worker memory/error diagnostics to startup.log so heap growth
      // can be analyzed post-hoc (the [mail-core] stream otherwise only hits
      // stdout). Filtered to keep the log clean.
      const criticalLine =
        line.includes("account-worker-error") || line.includes("message-too-large");
      const structuredDebugLine = line.includes('"level":"debug"');
      const structuredWarnLine = line.includes('"level":"warn"');
      const structuredErrorLine = line.includes('"level":"error"');
      const structuredFailureLine = /"phase":"[^"]*(?:failed|error|timeout|credential-required|restart-budget-exhausted)[^"]*"/.test(line);
      const debugLine =
        structuredDebugLine ||
        line.includes("account-worker-memory") ||
        line.includes("account-worker-op") ||
        line.includes("account-worker-provider") ||
        line.includes("account-worker-body-ready") ||
        line.includes("getMessage-probe");
      const governorLine = line.includes("performance.governor");
      const debugEnabled = this.isDebugLoggingEnabled();
      const level: ProcessLogLevel = criticalLine || structuredErrorLine || structuredFailureLine
        ? "error"
        : structuredWarnLine
          ? "warn"
          : debugLine || governorLine
            ? "debug"
            : "info";
      if (level !== "debug" || debugEnabled) {
        safeStreamWrite(process.stdout, formatProcessLog("[mail-core]", line, level));
      }
      if (criticalLine || level === "warn" || level === "error" || (debugEnabled && debugLine)) {
        this.log("mail-core-stdout", {
          level,
          line: line.trim(),
        });
      }
    });
    child.stderr?.on("data", (chunk) => {
      const line = String(chunk);
      safeStreamWrite(process.stderr, formatProcessLog("[mail-core]", line, "error"));
      // Persist to startup.log too — uncaught worker exceptions only reach
      // stderr, which is invisible under a double-click launch.
      this.log("mail-core-stderr", { level: "error", line: line.trim() });
    });
    child.on("spawn", () => {
      this.log("mail-core-spawned", { pid: child.pid, entryPath: this.entryPath });
      let managedMcpCredential: ManagedMcpCredential | undefined;
      try {
        const vault = this.managedMcpCredentials as (
          ManagedMcpCredentialVault & { readStoredCredential?: () => ManagedMcpCredential | null }
        ) | undefined;
        managedMcpCredential = vault?.readStoredCredential?.() ?? undefined;
      } catch (error) {
        this.log("mail-core-mcp-credential-load-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      child.postMessage({
        type: "mail-core.bootstrap",
        protocolVersion: MAIL_CORE_PROTOCOL_VERSION,
        managedMcpCredentialAvailable: this.managedMcpCredentials?.isAvailable() ?? false,
        ...(managedMcpCredential ? { managedMcpCredential } : {}),
      }, [channel.port2]);
    });
    child.on("error", (error) => {
      this.log("mail-core-error", { message: String(error) });
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      const unsignedCode = code >>> 0;
      this.log("mail-core-exit", {
        pid: child.pid,
        code,
        codeHex: `0x${unsignedCode.toString(16).toUpperCase().padStart(8, "0")}`,
        stopping: this.stopping,
        ready: this.ready,
        apiPort: this.apiPort,
        apiEndpointGeneration: this.apiEndpointGeneration,
        lastHeartbeatAt: this.lastHeartbeatAt || null,
        millisecondsSinceHeartbeat: this.lastHeartbeatAt
          ? Date.now() - this.lastHeartbeatAt
          : null,
      });
      this.disposeCurrent();
      if (!this.stopping) this.scheduleRestart();
    });
  }

  private handleControl(input: unknown): void {
    const message = input as MailCoreControlMessage;
    if (message.type === "mail-core.ready") {
      if (message.protocolVersion !== MAIL_CORE_PROTOCOL_VERSION) {
        this.log("mail-core-protocol-mismatch", {
          expected: MAIL_CORE_PROTOCOL_VERSION,
          actual: message.protocolVersion,
        });
        this.restartNow();
        return;
      }
      this.ready = true;
      this.lastHeartbeatAt = Date.now();
      this.missedHeartbeatChecks = 0;
      this.restartAttempt = 0;
      this.apiPort = message.apiPort ?? null;
      this.apiEndpointGeneration += 1;
      this.log("mail-core-ready", { pid: message.pid, apiPort: this.apiPort });
      if (this.databaseWriterPortFactory) {
        try {
          this.attachDatabaseWriter(this.databaseWriterPortFactory());
        } catch (error) {
          this.log("mail-core-database-writer-attach-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.controlPort?.postMessage({
        type: "mail-core.configure-account",
        credential: this.mailboxCredential,
      } satisfies MailCoreControlMessage);
      this.publishApiEndpoint({
        state: "ready",
        port: this.apiPort,
        generation: this.apiEndpointGeneration,
      });
      for (const waiter of [...this.readyWaiters]) waiter.resolve();
      for (const renderer of this.renderers) this.connectRenderer(renderer);
      return;
    }
    if (message.type === "mail-core.heartbeat") {
      const receipt = message.receipt && MailReceiptHealthSchema.safeParse(message.receipt.health);
      this.receipt = receipt?.success && typeof message.receipt?.accountId === "string"
        ? { accountId: message.receipt.accountId, health: receipt.data } : null;
      this.lastHeartbeatAt = Date.now();
      this.missedHeartbeatChecks = 0;
      return;
    }
    if (message.type === "mail-core.mail-changed") {
      for (const listener of this.mailChangedListeners) listener(message);
      return;
    }
    if (message.type === "mail-core.mail-credential-invalid") {
      for (const listener of this.credentialInvalidListeners) listener(message);
      return;
    }
    if (message.type === "mail-core.mcp-credential-save") {
      try {
        this.managedMcpCredentials?.save(message.credential);
      } catch (error) {
        this.log("mail-core-mcp-credential-save-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === "mail-core.mcp-credential-delete") {
      try {
        this.managedMcpCredentials?.delete(message.accountId);
      } catch (error) {
        this.log("mail-core-mcp-credential-delete-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === "mail-core.mcp-configuration-response") {
      const pending = this.configurationRequests.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.configurationRequests.delete(message.requestId);
      if (message.ok) pending.resolve(message.configuration);
      else pending.reject(new Error(message.error));
      return;
    }
    if (message.type === "mail-core.attachment-response") {
      const pending = this.attachmentRequests.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      this.attachmentRequests.delete(message.requestId);
      if (message.ok) {
        pending.resolve({
          bytes: Buffer.from(message.result.bytes),
          mediaType: message.result.mediaType,
        });
      } else {
        pending.reject(namedError(message.error, message.error));
      }
      return;
    }
    if (message.type === "mail-core.refresh-response") {
      const pending = this.refreshRequests.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.refreshRequests.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
      return;
    }
  }

  private connectRenderer(webContents: WebContents): void {
    const controlPort = this.controlPort;
    if (!controlPort || webContents.isDestroyed()) return;
    const channel = new MessageChannelMain();
    controlPort.postMessage({ type: "mail-core.attach-client" } satisfies MailCoreControlMessage, [channel.port1]);
    webContents.postMessage("mail-core:port", {
      protocolVersion: MAIL_CORE_PROTOCOL_VERSION,
    }, [channel.port2]);
    this.log("mail-core-renderer-attached", { rendererId: webContents.id });
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of [...this.readyWaiters]) waiter.reject(error);
  }

  private checkHeartbeat(): void {
    if (!this.child || !this.ready || this.stopping) return;
    if (Date.now() - this.lastHeartbeatAt <= 15_000) {
      this.missedHeartbeatChecks = 0;
      return;
    }
    this.missedHeartbeatChecks += 1;
    // The supervisor itself shares Electron's main loop. A long legacy task
    // can delay both the heartbeat event and this timer, so require several
    // consecutive misses before declaring the separate core unhealthy.
    if (this.missedHeartbeatChecks < 3) return;
    this.log("mail-core-heartbeat-timeout", { lastHeartbeatAt: this.lastHeartbeatAt });
    this.restartNow();
  }

  private restartNow(): void {
    const child = this.child;
    this.disposeCurrent();
    child?.kill();
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    const delays = [1_000, 2_000, 5_000, 10_000, 30_000];
    const delay = delays[Math.min(this.restartAttempt, delays.length - 1)];
    this.restartAttempt += 1;
    this.log("mail-core-restart-scheduled", { delay, attempt: this.restartAttempt });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawn();
    }, delay);
    this.restartTimer.unref();
  }

  private disposeCurrent(): void {
    this.ready = false;
    this.receipt = null;
    const hadApiEndpoint = this.apiPort !== null;
    this.apiPort = null;
    if (hadApiEndpoint) {
      this.apiEndpointGeneration += 1;
      this.publishApiEndpoint({
        state: "recovering",
        port: null,
        generation: this.apiEndpointGeneration,
      });
    }
    this.controlPort?.close();
    this.controlPort = null;
    this.child = null;
    for (const pending of this.configurationRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Mail Core disconnected"));
    }
    this.configurationRequests.clear();
    for (const pending of this.attachmentRequests.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(namedError(
        "ATTACHMENT_SERVICE_UNAVAILABLE",
        "Mail Core disconnected",
      ));
    }
    this.attachmentRequests.clear();
    for (const pending of this.refreshRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Mail Core disconnected"));
    }
    this.refreshRequests.clear();
  }

  private publishApiEndpoint(state: MailCoreApiEndpointState): void {
    for (const listener of this.apiEndpointListeners) listener(state);
  }
}

export function resolveMailCoreEntryPath(mainDir: string): string {
  return path.join(mainDir, "../mail-core/entry.js");
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
