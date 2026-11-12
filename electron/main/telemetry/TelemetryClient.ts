import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  TelemetryArgs,
  TelemetryEnvelope,
  TelemetryEventName,
  TelemetrySink,
} from "../../../shared/wemail/telemetry.js";
import {
  isTelemetryEventName,
  telemetryArgsToArgv,
  validateTelemetryArgs,
} from "../../../shared/wemail/telemetry.js";

// Telemetry endpoints are never hardcoded: they must be provided at startup
// via environment variables (see loadTelemetryRuntimeConfig). With no
// configured endpoint the client stays inert — the open-source build ships
// with telemetry disabled unless an operator explicitly configures it.
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_IN_FLIGHT = 8;
const DEFAULT_USAGE_HEARTBEAT_INTERVAL_MS = 60 * 60 * 1_000;

interface TelemetryEndpoint {
  name: "primary" | "secondary";
  url: string;
  token?: string;
  inFlight: number;
}

interface SessionMarker {
  sessionId: string;
  startedAt: string;
  lastPhase: string;
  cleanExit: boolean;
}

export interface TelemetryRuntimeConfig {
  primaryUrl?: string;
  secondaryUrl?: string;
  secondaryToken?: string;
}

export interface TelemetryClientOptions extends TelemetryRuntimeConfig {
  userDataDir: string;
  appVersion: string;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  username?: string;
  timeoutMs?: number;
  maxInFlight?: number;
  usageHeartbeatIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function usageDurationBucket(durationMs: number): string {
  if (durationMs < 60_000) return "lt_1m";
  if (durationMs < 10 * 60_000) return "1m_10m";
  if (durationMs < 30 * 60_000) return "10m_30m";
  if (durationMs < 60 * 60_000) return "30m_1h";
  if (durationMs < 2 * 60 * 60_000) return "1h_2h";
  return "gte_2h";
}

function safeReadJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function safeWriteJson(filePath: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } catch {
    // Telemetry state must never affect application behavior.
  }
}

function resolveUsername(explicit?: string): string {
  const candidate = explicit ?? (() => {
    try {
      return os.userInfo().username;
    } catch {
      return "unknown";
    }
  })();
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.length > 128 || /[\r\n]/.test(trimmed)) return "unknown";
  return trimmed;
}

function normalizeUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function stackFingerprint(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.stack) return undefined;
  const canonical = error.stack
    .split("\n")
    .slice(0, 12)
    .map((line) => line.replace(/(?:[a-z]:\\|\/)[^():\s]+/gi, "<path>"))
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export class TelemetryClient implements TelemetrySink {
  private readonly settingsPath: string;
  private readonly installPath: string;
  private readonly sessionPath: string;
  private readonly appVersion: string;
  private readonly platform: string;
  private readonly arch: string;
  private readonly nodeVersion: string;
  private readonly username: string;
  private readonly timeoutMs: number;
  private readonly maxInFlight: number;
  private readonly usageHeartbeatIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly installId: string;
  private readonly endpoints: TelemetryEndpoint[];
  private readonly recentEvents = new Map<string, number>();
  private enabled: boolean;
  private currentSession: SessionMarker | null = null;
  private usageHeartbeatTimer: NodeJS.Timeout | null = null;
  private lastUsageReportedAtMs: number | null = null;

  constructor(options: TelemetryClientOptions) {
    this.settingsPath = path.join(options.userDataDir, "telemetry-settings.json");
    this.installPath = path.join(options.userDataDir, "telemetry-install.json");
    this.sessionPath = path.join(options.userDataDir, "telemetry-session.json");
    this.appVersion = options.appVersion;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.nodeVersion = options.nodeVersion ?? process.version;
    this.username = resolveUsername(options.username);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.usageHeartbeatIntervalMs = Math.max(
      1_000,
      options.usageHeartbeatIntervalMs ?? DEFAULT_USAGE_HEARTBEAT_INTERVAL_MS,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.enabled = safeReadJson<{ enabled?: boolean }>(this.settingsPath)?.enabled !== false;

    const persistedInstallId = safeReadJson<{ installId?: string }>(this.installPath)?.installId;
    this.installId =
      typeof persistedInstallId === "string" && /^[0-9a-f-]{36}$/i.test(persistedInstallId)
        ? persistedInstallId
        : randomUUID();
    safeWriteJson(this.installPath, { installId: this.installId });

    // Startup-time configuration only: an endpoint exists only when it was
    // explicitly provided (env var or operator-provided config file). No
    // endpoint means no telemetry leaves the machine, regardless of the
    // persisted enabled flag.
    const primaryUrl = normalizeUrl(options.primaryUrl);
    const secondaryUrl = normalizeUrl(options.secondaryUrl);
    this.endpoints = [];
    if (primaryUrl) this.endpoints.push({ name: "primary", url: primaryUrl, inFlight: 0 });
    if (secondaryUrl && options.secondaryToken?.trim()) {
      this.endpoints.push({
        name: "secondary",
        url: secondaryUrl,
        token: options.secondaryToken.trim(),
        inFlight: 0,
      });
    }
    if (this.endpoints.length === 0) this.enabled = false;
  }

  getEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    if (!enabled) this.track("wemail_telemetry_disabled", { source: "main" });
    this.enabled = enabled;
    safeWriteJson(this.settingsPath, { enabled });
    if (enabled) this.track("wemail_telemetry_enabled", { source: "main" });
  }

  startSession(): void {
    const previous = safeReadJson<SessionMarker>(this.sessionPath);
    const now = this.now();
    if (previous && !previous.cleanExit) {
      const uptime = Math.max(0, now.getTime() - Date.parse(previous.startedAt));
      this.track("wemail_app_abnormal_exit_detected", {
        last_phase: previous.lastPhase || "unknown",
        uptime_bucket: uptime < 60_000 ? "lt_1m" : uptime < 600_000 ? "1m_10m" : "gte_10m",
      });
    }
    this.currentSession = {
      sessionId: randomUUID(),
      startedAt: now.toISOString(),
      lastPhase: "starting",
      cleanExit: false,
    };
    this.lastUsageReportedAtMs = now.getTime();
    if (this.usageHeartbeatTimer) clearInterval(this.usageHeartbeatTimer);
    this.usageHeartbeatTimer = setInterval(
      () => this.trackUsageDuration("heartbeat"),
      this.usageHeartbeatIntervalMs,
    );
    this.usageHeartbeatTimer.unref?.();
    safeWriteJson(this.sessionPath, this.currentSession);
  }

  trackUsageDuration(source: "heartbeat" | "shutdown"): void {
    const nowMs = this.now().getTime();
    const previousMs = this.lastUsageReportedAtMs ?? nowMs;
    const durationMs = Math.max(0, nowMs - previousMs);
    this.track("wemail_app_usage_heartbeat", {
      source,
      usage_duration_bucket: usageDurationBucket(durationMs),
    });
    this.lastUsageReportedAtMs = nowMs;
  }

  setSessionPhase(phase: string): void {
    if (!this.currentSession || !/^[a-z0-9_.-]{1,48}$/i.test(phase)) return;
    this.currentSession = { ...this.currentSession, lastPhase: phase };
    safeWriteJson(this.sessionPath, this.currentSession);
  }

  markCleanExit(): void {
    if (!this.currentSession) return;
    if (this.lastUsageReportedAtMs !== null) this.trackUsageDuration("shutdown");
    if (this.usageHeartbeatTimer) clearInterval(this.usageHeartbeatTimer);
    this.usageHeartbeatTimer = null;
    this.lastUsageReportedAtMs = null;
    this.currentSession = { ...this.currentSession, lastPhase: "stopped", cleanExit: true };
    safeWriteJson(this.sessionPath, this.currentSession);
  }

  track(event: TelemetryEventName, args: TelemetryArgs = {}): void {
    if (!this.enabled || !isTelemetryEventName(event) || !validateTelemetryArgs(args)) return;
    const argv = telemetryArgsToArgv(args);
    const dedupeKey = `${event}\0${argv.join("\0")}`;
    const nowMs = this.now().getTime();
    const previous = this.recentEvents.get(dedupeKey);
    if (previous !== undefined && nowMs - previous < 1_000) return;
    this.recentEvents.set(dedupeKey, nowMs);
    if (this.recentEvents.size > 256) {
      for (const [key, timestamp] of this.recentEvents) {
        if (nowMs - timestamp > 60_000) this.recentEvents.delete(key);
      }
    }

    const envelope: TelemetryEnvelope = {
      event,
      timestamp: new Date(nowMs).toISOString(),
      username: this.username,
      install_id: this.installId,
      argv,
      entry_mode: "desktop-electron",
      platform: this.platform,
      arch: this.arch,
      node_version: this.nodeVersion,
      app_version: this.appVersion,
    };
    const body = JSON.stringify(envelope);
    for (const endpoint of this.endpoints) this.send(endpoint, body);
  }

  private send(endpoint: TelemetryEndpoint, body: string): void {
    if (endpoint.inFlight >= this.maxInFlight) return;
    endpoint.inFlight += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (endpoint.token) headers.Authorization = `Bearer ${endpoint.token}`;
    void this.fetchImpl(endpoint.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeout);
        endpoint.inFlight -= 1;
      });
  }
}

export function loadTelemetryRuntimeConfig(
  appPath: string,
  resourcesPath: string,
  env: NodeJS.ProcessEnv = process.env,
): TelemetryRuntimeConfig {
  const candidates = [
    path.join(resourcesPath, "app", "build", "telemetry-config.json"),
    path.join(appPath, "build", "telemetry-config.json"),
    path.join(process.cwd(), "build", "telemetry-config.json"),
  ];
  const packaged = candidates.map((candidate) => safeReadJson<TelemetryRuntimeConfig>(candidate)).find(Boolean);
  return {
    primaryUrl: env.WEMAIL_TELEMETRY_PRIMARY_URL ?? packaged?.primaryUrl,
    secondaryUrl: env.WEMAIL_TELEMETRY_SECONDARY_URL ?? packaged?.secondaryUrl,
    secondaryToken: env.WEMAIL_TELEMETRY_SECONDARY_TOKEN ?? packaged?.secondaryToken,
  };
}
