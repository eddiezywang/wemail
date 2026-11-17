import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
} from "electron";
import {
  BOT_CORE_PROTOCOL_VERSION,
  type BotCoreConfiguration,
  type BotCoreControlMessage,
  type BotCoreInboundEnvelope,
  type BotCoreRequest,
  type BotCoreStreamResult,
} from "../../shared/wemail/botCoreProtocol.js";
import type { ChannelChatKind } from "../../shared/wemail/channels.js";
import { safeStreamWrite } from "./safe-stream-write.js";
import { formatProcessLog, type ProcessLogLevel } from "./process-log.js";

export class BotCoreRequestError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

export interface BotCoreSupervisorOptions {
  log: (phase: string, extra?: Record<string, unknown>) => void;
  isDebugLoggingEnabled?: () => boolean;
  onInbound?: (envelope: BotCoreInboundEnvelope) => void | Promise<void>;
  onStatus?: (
    event: Extract<BotCoreControlMessage, { type: "bot-core.status" }>,
  ) => void;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: BotCoreControlMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

type BotCoreShutdownOutcome = "graceful" | "forced";

const BOT_CORE_SHUTDOWN_TIMEOUT_MS = 1_500;
const BOT_CORE_EXIT_WAIT_TIMEOUT_MS = 2_000;
const WECOM_GRACEFUL_RECONNECT_COOLDOWN_MS = 8_000;
const WECOM_FORCED_RECONNECT_COOLDOWN_MS = 15_000;

function classifyBotCoreStderr(line: string): ProcessLogLevel {
  const normalized = line.toLowerCase();
  return /failed|error|duplicate|kicked|kick|credential|auth|timeout|network|disconnected|rate limit|45009/.test(normalized)
    ? "error"
    : "debug";
}

export class BotCoreSupervisor {
  private child: UtilityProcess | null = null;
  private controlPort: MessagePortMain | null = null;
  private ready = false;
  private stopping = false;
  private lastHeartbeatAt = 0;
  private missedHeartbeatChecks = 0;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartInProgress = false;
  private heartbeatMonitor: NodeJS.Timeout | null = null;
  private configurations: BotCoreConfiguration[] = [];
  private configurationRevision = 0;
  private appliedConfigurationRevision = -1;
  private childGeneration = 0;
  private configurationFlight: Promise<void> | null = null;
  private configurationCooldownUntil = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly readyWaiters = new Set<ReadyWaiter>();

  constructor(
    private readonly entryPath: string,
    private readonly options: BotCoreSupervisorOptions,
  ) {}

  start(): void {
    if (this.child || this.stopping) return;
    this.spawn();
    this.heartbeatMonitor = setInterval(() => this.checkHeartbeat(), 5_000);
    this.heartbeatMonitor.unref();
  }

  async configure(configurations: BotCoreConfiguration[]): Promise<void> {
    this.configurations = configurations.map((configuration) => ({
      ...configuration,
    }));
    this.configurationRevision += 1;
    if (this.configurations.length === 0 && !this.child) return;
    await this.ensureConfigured();
  }

  async send(input: {
    profileId: string;
    targetType: ChannelChatKind;
    targetId: string;
    text: string;
  }): Promise<void> {
    await this.ensureConfigured();
    await this.request({
      type: "bot-core.send",
      requestId: randomUUID(),
      ...input,
    });
  }

  async setReaction(input: {
    profileId: string;
    messageId: string;
    emojiType: string;
    action: "add" | "remove";
  }): Promise<void> {
    await this.ensureConfigured();
    await this.request({
      type: "bot-core.reaction",
      requestId: randomUUID(),
      ...input,
    });
  }

  async probe(profileId: string): Promise<void> {
    await this.ensureConfigured();
    await this.request({
      type: "bot-core.probe",
      requestId: randomUUID(),
      profileId,
    });
  }

  /**
   * Push one WeCom streaming frame. Returns the SDK send outcome
   * (`sent`/`skipped`/`failed`/`no-frame`). Any transport/ready/timeout error
   * collapses to `failed` so the caller can fall back to a one-shot send.
   */
  async streamFrame(input: {
    profileId: string;
    sourceEventId: string;
    streamId: string;
    content: string;
    finish: boolean;
  }): Promise<BotCoreStreamResult> {
    try {
      await this.ensureConfigured();
      const response = await this.request({
        type: "bot-core.stream-frame",
        requestId: randomUUID(),
        ...input,
      });
      if (response.type === "bot-core.response" && response.ok) {
        return response.streamResult ?? "failed";
      }
      return "failed";
    } catch {
      return "failed";
    }
  }

  /**
   * Feishu Card Kit streaming ops. Each reuses the typed request/response and a
   * server-supplied stable `uuid` (idempotent across timeout retries). Errors
   * collapse to `failed` so the session can fall back / clean up.
   */
  async feishuStreamStart(input: {
    profileId: string;
    receiveId: string;
    uuid: string;
  }): Promise<
    | { outcome: "created"; cardId: string; messageId: string }
    | { outcome: "failed" }
  > {
    try {
      await this.ensureConfigured();
      const response = await this.request({
        type: "bot-core.feishu-stream",
        requestId: randomUUID(),
        profileId: input.profileId,
        op: "create",
        receiveId: input.receiveId,
        uuid: input.uuid,
      });
      if (
        response.type === "bot-core.response" &&
        response.ok &&
        response.feishuStream?.outcome === "created" &&
        response.feishuStream.cardId &&
        response.feishuStream.messageId
      ) {
        return {
          outcome: "created",
          cardId: response.feishuStream.cardId,
          messageId: response.feishuStream.messageId,
        };
      }
      return { outcome: "failed" };
    } catch {
      return { outcome: "failed" };
    }
  }

  async feishuStreamText(input: {
    profileId: string;
    cardId: string;
    elementId: string;
    text: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed"> {
    try {
      await this.ensureConfigured();
      const response = await this.request({
        type: "bot-core.feishu-stream",
        requestId: randomUUID(),
        profileId: input.profileId,
        op: "text",
        cardId: input.cardId,
        elementId: input.elementId,
        text: input.text,
        sequence: input.sequence,
        uuid: input.uuid,
      });
      if (
        response.type === "bot-core.response" &&
        response.ok &&
        response.feishuStream?.outcome === "sent"
      ) {
        return "sent";
      }
      return "failed";
    } catch {
      return "failed";
    }
  }

  async feishuStreamEnd(input: {
    profileId: string;
    cardId: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed"> {
    try {
      await this.ensureConfigured();
      const response = await this.request({
        type: "bot-core.feishu-stream",
        requestId: randomUUID(),
        profileId: input.profileId,
        op: "end",
        cardId: input.cardId,
        sequence: input.sequence,
        uuid: input.uuid,
      });
      if (
        response.type === "bot-core.response" &&
        response.ok &&
        response.feishuStream?.outcome === "sent"
      ) {
        return "sent";
      }
      return "failed";
    } catch {
      return "failed";
    }
  }

  async feishuStreamAbort(input: {
    profileId: string;
    messageId: string;
  }): Promise<void> {
    try {
      await this.ensureConfigured();
      await this.request({
        type: "bot-core.feishu-stream",
        requestId: randomUUID(),
        profileId: input.profileId,
        op: "abort",
        messageId: input.messageId,
      });
    } catch {
      // best-effort cleanup
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.heartbeatMonitor) clearInterval(this.heartbeatMonitor);
    this.restartTimer = null;
    this.heartbeatMonitor = null;
    this.rejectPending("bot-core-stopped");
    this.rejectReadyWaiters(new BotCoreRequestError("bot-core-stopped", true));
    await this.shutdownChild();
    this.disposeCurrent();
  }

  forceTerminate(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.heartbeatMonitor) clearInterval(this.heartbeatMonitor);
    this.restartTimer = null;
    this.heartbeatMonitor = null;
    this.child?.kill();
  }

  private async request(request: BotCoreRequest): Promise<BotCoreControlMessage> {
    if (!this.ready || !this.controlPort) {
      throw new BotCoreRequestError("bot-core-not-ready", true);
    }
    return new Promise<BotCoreControlMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new BotCoreRequestError("bot-core-request-timeout", true));
      }, this.options.requestTimeoutMs ?? 15_000);
      timeout.unref();
      this.pending.set(request.requestId, { resolve, reject, timeout });
      this.controlPort!.postMessage(request satisfies BotCoreControlMessage);
    });
  }

  private ensureReady(): Promise<void> {
    if (this.ready && this.controlPort) return Promise.resolve();
    this.start();
    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.readyWaiters.delete(waiter);
          reject(new BotCoreRequestError("bot-core-start-timeout", true));
        }, this.options.requestTimeoutMs ?? 15_000),
      };
      waiter.timeout.unref();
      this.readyWaiters.add(waiter);
    });
  }

  private async ensureConfigured(): Promise<void> {
    await this.ensureReady();
    await this.reconcileConfigurations();
  }

  private reconcileConfigurations(): Promise<void> {
    if (this.configurationFlight) return this.configurationFlight;
    const flight = this.runConfigurationReconcile();
    this.configurationFlight = flight;
    void flight.then(
      () => {
        if (this.configurationFlight === flight) this.configurationFlight = null;
      },
      () => {
        if (this.configurationFlight === flight) this.configurationFlight = null;
      },
    );
    return flight;
  }

  private async runConfigurationReconcile(): Promise<void> {
    while (true) {
      if (!this.ready || !this.controlPort || !this.child) {
        throw new BotCoreRequestError("bot-core-not-ready", true);
      }
      const generation = this.childGeneration;
      const revision = this.configurationRevision;
      if (
        this.appliedConfigurationRevision === revision &&
        this.appliedConfigurationRevision >= 0
      ) {
        return;
      }
      const configurations = this.configurations.map((configuration) => ({
        ...configuration,
      }));
      const waitMs = Math.max(0, this.configurationCooldownUntil - Date.now());
      if (waitMs > 0) await this.delay(waitMs);
      if (revision !== this.configurationRevision) continue;
      this.options.log("bot-core-configure-start", {
        childGeneration: generation,
        revision,
        profileCount: configurations.length,
      });
      try {
        await this.request({
          type: "bot-core.configure",
          requestId: randomUUID(),
          configurations,
        });
      } catch (error) {
        this.options.log("bot-core-configure-failed", {
          childGeneration: generation,
          revision,
          profileCount: configurations.length,
          errorCode:
            error instanceof BotCoreRequestError
              ? error.code
              : "bot-core-configure-failed",
        });
        throw error;
      }
      if (generation !== this.childGeneration || !this.ready) {
        continue;
      }
      this.appliedConfigurationRevision = revision;
      this.options.log("bot-core-configure-done", {
        childGeneration: generation,
        revision,
        profileCount: configurations.length,
      });
      if (revision === this.configurationRevision) return;
      this.options.log("bot-core-configure-coalesced", {
        childGeneration: generation,
        appliedRevision: revision,
        nextRevision: this.configurationRevision,
      });
    }
  }

  private async shutdownChild(): Promise<BotCoreShutdownOutcome> {
    const child = this.child;
    const port = this.controlPort;
    if (!child) return "graceful";

    let forced = false;
    let exited = false;
    let shutdownComplete = false;
    let resolveExit!: () => void;
    let resolveShutdown!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const shutdownPromise = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const onExit = () => {
      exited = true;
      resolveExit();
    };
    const onMessage = (event: Electron.MessageEvent) => {
      const message = event.data as BotCoreControlMessage;
      if (message.type !== "bot-core.shutdown-complete") return;
      shutdownComplete = true;
      resolveShutdown();
    };
    child.once("exit", onExit);
    port?.on("message", onMessage);

    if (port) {
      try {
        port.postMessage({
          type: "bot-core.shutdown",
        } satisfies BotCoreControlMessage);
      } catch {
        forced = true;
        child.kill();
      }
    } else {
      forced = true;
      child.kill();
    }

    if (!forced) {
      await Promise.race([
        shutdownPromise,
        this.delay(BOT_CORE_SHUTDOWN_TIMEOUT_MS),
      ]);
      if (!shutdownComplete) {
        forced = true;
        child.kill();
      }
    }

    if (!exited) {
      await Promise.race([
        exitPromise,
        this.delay(BOT_CORE_EXIT_WAIT_TIMEOUT_MS),
      ]);
      if (!exited) {
        forced = true;
        child.kill();
        await Promise.race([
          exitPromise,
          this.delay(BOT_CORE_EXIT_WAIT_TIMEOUT_MS),
        ]);
      }
    }

    port?.removeListener("message", onMessage);
    child.removeListener("exit", onExit);
    return forced ? "forced" : "graceful";
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref();
    });
  }

  private spawn(): void {
    const channel = new MessageChannelMain();
    const child = utilityProcess.fork(this.entryPath, [], {
      serviceName: "WeMail Bot Core",
      stdio: "pipe",
      env: { ...process.env },
      execArgv: ["--max-old-space-size=96"],
    });
    this.child = child;
    this.controlPort = channel.port1;
    this.ready = false;
    this.childGeneration += 1;
    this.appliedConfigurationRevision = -1;
    this.lastHeartbeatAt = Date.now();
    channel.port1.on("message", (event) => {
      void this.handleControl(event.data);
    });
    channel.port1.start();
    child.stdout?.on("data", (chunk) =>
      safeStreamWrite(process.stdout, formatProcessLog("[bot-core]", String(chunk), "info")),
    );
    child.stderr?.on("data", (chunk) => {
      const line = String(chunk);
      // Third-party channel SDKs write normal connection chatter to stderr.
      // Keep that chatter at debug and preserve actual connection/kick/auth
      // failures at error so delivery logs remain actionable.
      const level = classifyBotCoreStderr(line);
      if (level !== "debug" || this.options.isDebugLoggingEnabled?.()) {
        safeStreamWrite(process.stderr, formatProcessLog("[bot-core]", line, level));
        this.options.log("bot-core-stderr", { level, line: line.trim() });
      }
    });
    child.on("spawn", () => {
      this.options.log("bot-core-spawned", {
        pid: child.pid,
        entryPath: this.entryPath,
      });
      child.postMessage(
        {
          type: "bot-core.bootstrap",
          protocolVersion: BOT_CORE_PROTOCOL_VERSION,
        },
        [channel.port2],
      );
    });
    child.on("error", () => {
      this.options.log("bot-core-error", {
        errorClass: "UtilityProcessError",
      });
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.options.log("bot-core-exit", { code, stopping: this.stopping });
      if (this.restartInProgress) return;
      this.disposeCurrent();
      if (!this.stopping) {
        this.configurationCooldownUntil = Math.max(
          this.configurationCooldownUntil,
          Date.now() + WECOM_FORCED_RECONNECT_COOLDOWN_MS,
        );
        this.options.log("bot-core-exit-restart-cooldown", {
          cooldownMs: WECOM_FORCED_RECONNECT_COOLDOWN_MS,
        });
        this.scheduleRestart(WECOM_FORCED_RECONNECT_COOLDOWN_MS);
      }
    });
  }

  private async handleControl(input: unknown): Promise<void> {
    const message = input as BotCoreControlMessage;
    if (message.type === "bot-core.ready") {
      if (message.protocolVersion !== BOT_CORE_PROTOCOL_VERSION) {
        this.options.log("bot-core-protocol-mismatch", {
          expected: BOT_CORE_PROTOCOL_VERSION,
          actual: message.protocolVersion,
        });
        this.restartNow();
        return;
      }
      this.ready = true;
      this.lastHeartbeatAt = Date.now();
      this.missedHeartbeatChecks = 0;
      this.restartAttempt = 0;
      this.options.log("bot-core-ready", { pid: message.pid });
      this.resolveReadyWaiters();
      void this.reconcileConfigurations().catch((error) => {
        this.options.log("bot-core-configure-failed", {
          childGeneration: this.childGeneration,
          revision: this.configurationRevision,
          errorCode:
            error instanceof BotCoreRequestError
              ? error.code
              : "bot-core-configure-failed",
        });
      });
      return;
    }
    if (message.type === "bot-core.heartbeat") {
      this.lastHeartbeatAt = Date.now();
      this.missedHeartbeatChecks = 0;
      return;
    }
    if (message.type === "bot-core.response") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message);
      else {
        const code = message.errorCode ?? "bot-core-request-failed";
        pending.reject(new BotCoreRequestError(code, isRetryable(code)));
      }
      return;
    }
    if (message.type === "bot-core.inbound") {
      try {
        await this.options.onInbound?.(message.envelope);
      } catch {
        this.options.log("bot-core-inbound-rejected", {
          platform: message.envelope.platform,
          profileId: message.envelope.profileId,
        });
      }
      return;
    }
    if (message.type === "bot-core.status") {
      this.options.onStatus?.(message);
    }
  }

  private resolveReadyWaiters(): void {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    this.readyWaiters.clear();
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.readyWaiters.clear();
  }

  private checkHeartbeat(): void {
    if (!this.child || !this.ready || this.stopping) return;
    if (Date.now() - this.lastHeartbeatAt <= 15_000) {
      this.missedHeartbeatChecks = 0;
      return;
    }
    this.missedHeartbeatChecks += 1;
    if (this.missedHeartbeatChecks < 3) return;
    this.options.log("bot-core-heartbeat-timeout", {
      lastHeartbeatAt: this.lastHeartbeatAt,
    });
    this.restartNow();
  }

  private restartNow(): void {
    if (this.stopping || this.restartInProgress || !this.child) return;
    this.restartInProgress = true;
    this.ready = false;
    this.rejectPending("bot-core-restarting");
    void (async () => {
      let outcome: BotCoreShutdownOutcome = "forced";
      try {
        outcome = await this.shutdownChild();
      } finally {
        this.disposeCurrent();
        const cooldownMs =
          outcome === "forced"
            ? WECOM_FORCED_RECONNECT_COOLDOWN_MS
            : WECOM_GRACEFUL_RECONNECT_COOLDOWN_MS;
        this.configurationCooldownUntil = Math.max(
          this.configurationCooldownUntil,
          Date.now() + cooldownMs,
        );
        this.options.log(`bot-core-restart-${outcome}`, {
          cooldownMs,
          childGeneration: this.childGeneration,
        });
        this.restartInProgress = false;
        if (!this.stopping) this.scheduleRestart(cooldownMs);
      }
    })();
  }

  private scheduleRestart(minDelayMs = 0): void {
    if (this.stopping || this.restartTimer) return;
    const delays = [1_000, 2_000, 5_000, 10_000, 30_000];
    const delay = Math.max(
      minDelayMs,
      delays[Math.min(this.restartAttempt, delays.length - 1)]!,
    );
    this.restartAttempt += 1;
    this.options.log("bot-core-restart-scheduled", {
      delay,
      attempt: this.restartAttempt,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawn();
    }, delay);
    this.restartTimer.unref();
  }

  private rejectPending(code: string): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new BotCoreRequestError(code, true));
    }
    this.pending.clear();
  }

  private disposeCurrent(): void {
    this.ready = false;
    this.rejectPending("bot-core-disconnected");
    this.controlPort?.close();
    this.controlPort = null;
    this.child = null;
  }
}

export function resolveBotCoreEntryPath(mainDir: string): string {
  return path.join(mainDir, "../bot-core/entry.js");
}

function isRetryable(code: string): boolean {
  return (
    code === "bot-core-not-ready" ||
    code === "bot-core-request-timeout" ||
    code === "platform-temporarily-unavailable" ||
    code === "platform-connection-failed"
  );
}
