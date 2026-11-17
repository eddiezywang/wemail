import {
  MessageChannelMain,
  powerMonitor,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
  type WebContents,
} from "electron";
import path from "node:path";
import {
  MAIL_DATABASE_PROTOCOL_VERSION,
  type MailDatabaseControlMessage,
  type MailDatabaseWorkload,
} from "../../shared/wemail/mailDatabaseProtocol.js";
import { MailDatabasePortBroker } from "./mail-database-port-broker.js";
import { safeStreamWrite } from "./safe-stream-write.js";
import { formatProcessLog, type ProcessLogLevel } from "./process-log.js";

export class MailDatabaseSupervisor {
  private static readonly HEARTBEAT_STALE_MS = 15_000;
  private static readonly PROBE_TIMEOUT_MS = 2_000;
  private static readonly RESUME_GRACE_MS = 15_000;
  private child: UtilityProcess | null = null;
  private controlPort: MessagePortMain | null = null;
  private ready = false;
  private stopping = false;
  private lastHeartbeatAt = 0;
  private monitor: NodeJS.Timeout | null = null;
  private suspended = false;
  private resumeGraceUntil = 0;
  private probeSequence = 0;
  private probeInFlight: {
    probeId: string;
    reason: "heartbeat-stale" | "resume";
    startedAt: number;
    timer: NodeJS.Timeout;
  } | null = null;
  private powerMonitorAttached = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private terminalFailure: Error | null = null;
  private readonly broker = new MailDatabasePortBroker();
  private readonly readyListeners = new Set<() => void>();
  private readonly waiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly handleSuspend = (): void => {
    this.suspended = true;
    this.log("mail-database-suspend", {
      childPid: this.child?.pid ?? null,
      lastHeartbeatAt: this.lastHeartbeatAt,
    });
  };
  private readonly handleResume = (): void => {
    this.suspended = false;
    this.resumeGraceUntil = Date.now() + MailDatabaseSupervisor.RESUME_GRACE_MS;
    this.log("mail-database-resume", {
      childPid: this.child?.pid ?? null,
      graceMs: MailDatabaseSupervisor.RESUME_GRACE_MS,
      lastHeartbeatAt: this.lastHeartbeatAt,
    });
    this.probe("resume");
  };

  constructor(
    private readonly entryPath: string,
    private readonly databasePath: string,
    private readonly log: (phase: string, extra?: Record<string, unknown>) => void,
    private readonly isDebugLoggingEnabled: () => boolean =
      () => process.env.WEMAIL_DEBUG_MODE === "1",
    private readonly editionFeatures?: import("../../shared/wemail/edition.js").EditionFeatures,
  ) {}

  start(): void {
    if (this.child || this.stopping || this.terminalFailure) return;
    this.attachPowerMonitor();
    const channel = new MessageChannelMain();
    const child = utilityProcess.fork(this.entryPath, [], {
      serviceName: "WeMail Database Service",
      stdio: "pipe",
      env: { ...process.env },
      execArgv: ["--max-old-space-size=48"],
    });
    this.child = child;
    this.controlPort = channel.port1;
    this.lastHeartbeatAt = Date.now();
    channel.port1.on("message", (event) => this.handleControl(event.data));
    channel.port1.start();
    child.stdout?.on("data", (chunk) => {
      const line = String(chunk);
      // Persist worker diagnostics to startup.log so failures survive a
      // double-click launch (the [db-service] stream otherwise only hits
      // stdout). Mirrors the mail-core relay: lane logs are structured
      // `{phase,...}` JSON on stdout; uncaught worker exceptions arrive
      // on stderr (the writer bootstrap failure that used to surface as
      // the opaque "[object Object]").
      const structuredDebugLine = line.includes('"level":"debug"');
      const structuredWarnLine = line.includes('"level":"warn"');
      const structuredErrorLine = line.includes('"level":"error"');
      const criticalLine =
        line.includes("db-lane-error") ||
        line.includes("db-lane-restart-budget-exhausted") ||
        line.includes("bootstrap-failed");
      const debugEnabled = this.isDebugLoggingEnabled();
      const level: ProcessLogLevel = criticalLine || structuredErrorLine
        ? "error"
        : structuredWarnLine
          ? "warn"
          : structuredDebugLine
            ? "debug"
            : "info";
      safeStreamWrite(process.stdout, formatProcessLog("[db-service]", line, level));
      if (criticalLine || level === "warn" || level === "error" || (debugEnabled && structuredDebugLine)) {
        this.log("db-service-stdout", {
          level,
          line: line.trim(),
        });
      }
    });
    child.stderr?.on("data", (chunk) => {
      const line = String(chunk);
      const debugLine = line.includes("wal_checkpoint");
      if (!debugLine || this.isDebugLoggingEnabled()) {
        safeStreamWrite(
          process.stderr,
          formatProcessLog("[db-service]", line, debugLine ? "debug" : "error"),
        );
      }
      if (!debugLine || this.isDebugLoggingEnabled()) {
        this.log("db-service-stderr", {
          level: debugLine ? "debug" : "error",
          line: line.trim(),
        });
      }
    });
    child.on("spawn", () => {
      this.log("mail-database-spawned", {
        pid: child.pid,
        databasePath: this.databasePath,
      });
      child.postMessage({
        type: "mail-database.bootstrap",
        protocolVersion: MAIL_DATABASE_PROTOCOL_VERSION,
        databasePath: this.databasePath,
        ...(this.editionFeatures ? { editionFeatures: this.editionFeatures } : {}),
      } satisfies MailDatabaseControlMessage, [channel.port2]);
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.log("mail-database-exit", {
        childPid: child.pid,
        code,
        stopping: this.stopping,
      });
      this.dispose();
      this.rejectWaiters(new Error(`DB Service exited:${code}`));
      if (!this.stopping && !this.terminalFailure) this.scheduleRestart();
    });
    this.monitor = setInterval(() => this.checkHeartbeat(), 5_000);
    this.monitor.unref();
  }

  whenReady(timeoutMs = 30_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.terminalFailure) return Promise.reject(this.terminalFailure);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          reject(error);
        },
        timer: setTimeout(() => undefined, timeoutMs),
      };
      clearTimeout(waiter.timer);
      waiter.timer = setTimeout(
        () => waiter.reject(new Error("DB Service readiness timed out")),
        timeoutMs,
      );
      waiter.timer.unref();
      this.waiters.add(waiter);
    });
  }

  attachRenderer(webContents: WebContents): void {
    if (webContents.isDestroyed()) return;
    webContents.postMessage("mail-database:port", {
      protocolVersion: MAIL_DATABASE_PROTOCOL_VERSION,
    }, [this.createProducerPort()]);
  }

  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    if (this.ready) listener();
    return () => this.readyListeners.delete(listener);
  }

  createProducerPort(workload: MailDatabaseWorkload = "interactive"): MessagePortMain {
    const channel = new MessageChannelMain();
    this.broker.registerClient(channel.port1, workload);
    return channel.port2;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.detachPowerMonitor();
    this.clearProbe();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
    const child = this.child;
    const port = this.controlPort;
    if (!child) {
      this.broker.close();
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve();
      }, 1_000);
      timeout.unref();
      port?.once("message", (event) => {
        const message = event.data as MailDatabaseControlMessage;
        if (message.type !== "mail-database.shutdown-complete") return;
        clearTimeout(timeout);
        resolve();
      });
      port?.postMessage({
        type: "mail-database.shutdown",
      } satisfies MailDatabaseControlMessage);
    });
    this.dispose();
    this.broker.close();
  }

  forceTerminate(): void {
    this.stopping = true;
    this.detachPowerMonitor();
    this.clearProbe();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.monitor) clearInterval(this.monitor);
    this.restartTimer = null;
    this.monitor = null;
    this.child?.kill();
  }

  private handleControl(input: unknown): void {
    const message = input as MailDatabaseControlMessage;
    if (message.type === "mail-database.heartbeat") {
      this.lastHeartbeatAt = Date.now();
      return;
    }
    if (message.type === "mail-database.pong") {
      this.handlePong(message);
      return;
    }
    if (message.type === "mail-database.request-trace") {
      this.log("mail-database-request", {
        method: message.method,
        requestId: message.requestId,
        traceId: message.traceId,
        outcome: message.outcome,
        totalMs: message.totalMs,
        ...(message.queueMs === undefined ? {} : { queueMs: message.queueMs }),
        ...(message.handlerMs === undefined ? {} : { handlerMs: message.handlerMs }),
        ...(message.lane ? { lane: message.lane } : {}),
        ...(message.found === undefined ? {} : { found: message.found }),
        ...(message.bodyState ? { bodyState: message.bodyState } : {}),
        ...(message.errorCode ? { errorCode: message.errorCode } : {}),
      });
      return;
    }
    if (message.type === "mail-database.bootstrap-failed") {
      const error = new Error(`${message.code}: ${message.message}`);
      this.terminalFailure = error;
      this.log("mail-database-bootstrap-failed", {
        code: message.code,
        message: message.message,
      });
      this.rejectWaiters(error);
      this.child?.kill();
      return;
    }
    if (message.type !== "mail-database.ready") return;
    if (message.protocolVersion !== MAIL_DATABASE_PROTOCOL_VERSION) {
      this.child?.kill();
      return;
    }
    this.ready = true;
    this.restartAttempt = 0;
    this.lastHeartbeatAt = Date.now();
    this.log("mail-database-ready", {
      pid: message.pid,
      schemaVersion: message.schemaVersion,
    });
    this.broker.replaceUpstreamFactory((workload) => this.createDirectProducerPort(workload));
    for (const waiter of [...this.waiters]) waiter.resolve();
    for (const listener of this.readyListeners) listener();
  }

  private createDirectProducerPort(workload: MailDatabaseWorkload): MessagePortMain {
    if (!this.ready || !this.controlPort) {
      throw new Error("DB Service producer is unavailable");
    }
    const channel = new MessageChannelMain();
    this.controlPort.postMessage({
      type: "mail-database.attach-client",
      workload,
    } satisfies MailDatabaseControlMessage, [channel.port1]);
    return channel.port2;
  }

  private dispose(): void {
    this.ready = false;
    this.clearProbe();
    this.broker.replaceUpstreamFactory(null);
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
    this.controlPort?.close();
    this.controlPort = null;
    this.child = null;
  }

  private checkHeartbeat(): void {
    const now = Date.now();
    if (
      !this.child ||
      !this.ready ||
      this.stopping ||
      this.suspended ||
      now < this.resumeGraceUntil ||
      this.probeInFlight
    ) {
      return;
    }
    if (now - this.lastHeartbeatAt <= MailDatabaseSupervisor.HEARTBEAT_STALE_MS) {
      return;
    }
    this.probe("heartbeat-stale");
  }

  private probe(reason: "heartbeat-stale" | "resume"): void {
    if (
      !this.child ||
      !this.ready ||
      this.stopping ||
      this.suspended ||
      !this.controlPort ||
      this.probeInFlight
    ) {
      return;
    }
    const controlPort = this.controlPort;
    const probeId = `db-probe-${Date.now()}-${++this.probeSequence}`;
    const startedAt = Date.now();
    const timer = setTimeout(
      () => this.handleProbeTimeout(probeId),
      MailDatabaseSupervisor.PROBE_TIMEOUT_MS,
    );
    timer.unref();
    this.probeInFlight = { probeId, reason, startedAt, timer };
    this.log(reason === "heartbeat-stale"
      ? "mail-database-heartbeat-stale"
      : "mail-database-resume-probe", {
      childPid: this.child.pid,
      reason,
      lastHeartbeatAt: this.lastHeartbeatAt,
      staleMs: Math.max(0, startedAt - this.lastHeartbeatAt),
    });
    try {
      controlPort.postMessage({
        type: "mail-database.ping",
        probeId,
        at: startedAt,
      } satisfies MailDatabaseControlMessage);
    } catch (error) {
      this.handleProbeTimeout(probeId, error);
    }
  }

  private handlePong(
    message: Extract<MailDatabaseControlMessage, { type: "mail-database.pong" }>,
  ): void {
    const probe = this.probeInFlight;
    if (!probe || probe.probeId !== message.probeId) return;
    clearTimeout(probe.timer);
    this.probeInFlight = null;
    this.lastHeartbeatAt = Date.now();
    this.log("mail-database-probe-ok", {
      childPid: this.child?.pid ?? message.pid,
      probeId: message.probeId,
      reason: probe.reason,
      probeMs: Math.max(0, Date.now() - probe.startedAt),
      servicePid: message.pid,
    });
  }

  private handleProbeTimeout(probeId: string, cause?: unknown): void {
    const probe = this.probeInFlight;
    if (!probe || probe.probeId !== probeId) return;
    clearTimeout(probe.timer);
    this.probeInFlight = null;
    const now = Date.now();
    this.log("mail-database-probe-timeout", {
      childPid: this.child?.pid ?? null,
      probeId,
      reason: probe.reason,
      probeMs: Math.max(0, now - probe.startedAt),
      lastHeartbeatAt: this.lastHeartbeatAt,
      ...(cause ? { error: cause instanceof Error ? cause.message : String(cause) } : {}),
    });
    if (
      probe.reason === "resume" ||
      this.suspended ||
      now < this.resumeGraceUntil
    ) {
      return;
    }
    this.terminateUnhealthy("heartbeat-probe-timeout");
  }

  private terminateUnhealthy(reason: string): void {
    const child = this.child;
    if (!child || this.stopping) return;
    this.ready = false;
    this.clearProbe();
    this.broker.replaceUpstreamFactory(null);
    this.log("mail-database-unhealthy-kill", {
      childPid: child.pid,
      reason,
      lastHeartbeatAt: this.lastHeartbeatAt,
    });
    child.kill();
  }

  private clearProbe(): void {
    if (!this.probeInFlight) return;
    clearTimeout(this.probeInFlight.timer);
    this.probeInFlight = null;
  }

  private attachPowerMonitor(): void {
    if (this.powerMonitorAttached) return;
    powerMonitor.on("suspend", this.handleSuspend);
    powerMonitor.on("resume", this.handleResume);
    this.powerMonitorAttached = true;
  }

  private detachPowerMonitor(): void {
    if (!this.powerMonitorAttached) return;
    powerMonitor.removeListener("suspend", this.handleSuspend);
    powerMonitor.removeListener("resume", this.handleResume);
    this.powerMonitorAttached = false;
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping || this.terminalFailure) return;
    const delays = [1_000, 2_000, 5_000] as const;
    if (this.restartAttempt >= delays.length) {
      const error = new Error("DB Service restart budget exhausted");
      this.terminalFailure = error;
      this.log("mail-database-restart-budget-exhausted", {
        attempts: this.restartAttempt,
      });
      this.broker.failUnavailable(
        "DB_SERVICE_RESTART_BUDGET_EXHAUSTED",
        error.message,
      );
      this.rejectWaiters(error);
      return;
    }
    const delay = delays[this.restartAttempt];
    this.restartAttempt += 1;
    this.log("mail-database-restart-scheduled", {
      delay,
      attempt: this.restartAttempt,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      try {
        this.start();
      } catch (error) {
        this.log("mail-database-restart-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        this.scheduleRestart();
      }
    }, delay);
    this.restartTimer.unref();
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of [...this.waiters]) waiter.reject(error);
  }
}

export function resolveMailDatabaseEntryPath(mainDir: string): string {
  return path.join(mainDir, "../db-service/entry.js");
}
