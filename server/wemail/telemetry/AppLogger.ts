import fs from "node:fs";
import path from "node:path";

/**
 * Structured application logger for WeMail.
 *
 * Every log line is a single JSON object appended to the daily log file
 * `<baseDir>/app-YYYY-MM-DD.log`. The logger performs *deep redaction* of
 * field names that are likely to contain sensitive data (mail body,
 * credentials) — see {@link REDACTED_KEYS}. This is the mechanism that
 * enforces Handoff §6's hard rule: never write full mail body into logs.
 *
 * The logger is intentionally minimal: no external deps, no async queue,
 * fs writes are synchronous `appendFileSync`. Throughput is far below the
 * rate at which an Electron app logs; correctness and safety beat latency.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const REDACTED_KEYS = new Set<string>([
  "body",
  "bodyText",
  "bodyHtml",
  "content",
  "password",
  "token",
  "apiKey",
  "secret",
  "prompt",
  "promptBody",
  "userText",
  "assistantOutput",
  "attachmentText",
  "toolInput",
  "toolOutput",
  "authorization",
  "cookie",
  // Raw model/LLM payloads — same sensitivity class as bodyText/bodyHtml
  // (AiFeedbackEventRepository.FORBIDDEN_PAYLOAD_KEYS and
  // PromptBuilder.LOG_FORBIDDEN_KEYS treat these as never-log keys).
  "rawResponse",
  "rawLlmResponse",
  "llmResponse",
  // Round-8 suggestion 7: personalization feedback fields from
  // PromptBuilder.LOG_FORBIDDEN_KEYS. The generic redact() walks every log
  // record's fields, so REDACTED_KEYS must cover the UNION of the two
  // never-log sets above — these three previously slipped through verbatim.
  "feedbackText",
  "originalText",
  "editedText",
  // common variants worth defending against too
  "rfc822",
  "raw",
]);

export const REDACTED_PLACEHOLDER = "[REDACTED]";

export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export interface AppLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /**
   * Adapter for legacy `(message: string) => void` sinks used by some
   * packages (IntelligenceOrchestrator, QueueRunner, etc.). Applies the
   * production event policy before choosing `debug`, `info`, or `warn`.
   */
  asMessageSink(event?: string): (message: string) => void;
  setDebugMode(enabled: boolean, durationMs?: number): AppLoggingDiagnostics;
  getDiagnostics(): AppLoggingDiagnostics;
  exportDiagnosticPackage?(): { filePath: string; fileName: string; expiresAt: string };
}

export interface AppLoggingDiagnostics {
  debugEnabled: boolean;
  expiresAt: string | null;
  remainingSeconds: number;
  retentionDays: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface AppLoggerOptions {
  /** Directory where rotated log files live. Created if missing. */
  baseDir: string;
  /** Minimum level actually persisted. Default: `"info"`. */
  minLevel?: LogLevel;
  /** Enable debug output for the lifetime of this logger. */
  debugEnabled?: boolean;
  /** Clock injection (tests). Default: `() => new Date()`. */
  now?: () => Date;
  /**
   * Writer injection (tests). Receives the rendered JSON line (no trailing
   * newline) and the filename of the current day's log. When absent, the
   * logger writes directly to disk with `fs.appendFileSync`.
   */
  writer?: (line: string, file: string) => void;
  maxFileBytes?: number;
  debugDurationMs?: number;
}

export const APP_LOG_RETENTION_DAYS = 7;
export const APP_LOG_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const APP_LOG_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const APP_LOG_DEBUG_DURATION_MS = 30 * 60 * 1000;
export const APP_LOG_MAX_DEBUG_DURATION_MS = 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_PACKAGE_RETENTION_DAYS = 7;
export const APP_LOG_FILE_PATTERN = /^app-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/;

const MAX_LOG_STRING_LENGTH = 512;
const MAX_LOG_ARRAY_ENTRIES = 64;
const MAX_LOG_OBJECT_KEYS = 48;
const MAX_LOG_REDACTION_DEPTH = 6;
const LOG_TRUNCATION_SUFFIX = "…[truncated]";

/**
 * Recursively walk a plain object / array, replacing any value whose key
 * matches {@link REDACTED_KEYS} with {@link REDACTED_PLACEHOLDER}. Cycles
 * are broken by a visited-set. Non-plain values (Date, Buffer, Error) are
 * converted to a compact string form.
 */
export function redact(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/^(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var|etc)\/)/.test(value)) {
      return "[REDACTED_PATH]";
    }
    if (value.length <= MAX_LOG_STRING_LENGTH) return value;
    return value.slice(0, MAX_LOG_STRING_LENGTH - LOG_TRUNCATION_SUFFIX.length) +
      LOG_TRUNCATION_SUFFIX;
  }
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message, seen, depth + 1),
      stack: value.stack
        ? value.stack
          .replace(/[A-Za-z]:[\\/][^\s)]+|\/(?:Users|home|tmp|var|etc)\/[^\s)]+/g, "[REDACTED_PATH]")
          .slice(0, MAX_LOG_STRING_LENGTH)
        : undefined,
    };
  }
  if (Buffer.isBuffer?.(value as Buffer)) {
    return `<Buffer length=${(value as Buffer).length}>`;
  }
  if (depth >= MAX_LOG_REDACTION_DEPTH) return "[TRUNCATED_DEPTH]";
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    const entries = value
      .slice(0, MAX_LOG_ARRAY_ENTRIES)
      .map((entry) => redact(entry, seen, depth + 1));
    if (value.length > MAX_LOG_ARRAY_ENTRIES) {
      entries.push(`[TRUNCATED_ARRAY:${value.length - MAX_LOG_ARRAY_ENTRIES}]`);
    }
    return entries;
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, child] of entries.slice(0, MAX_LOG_OBJECT_KEYS)) {
    if ([...REDACTED_KEYS].some((sensitive) => sensitive.toLowerCase() === key.toLowerCase())) {
      out[key] = REDACTED_PLACEHOLDER;
      continue;
    }
    out[key] = redact(child, seen, depth + 1);
  }
  if (entries.length > MAX_LOG_OBJECT_KEYS) {
    out._logTruncatedKeys = entries.length - MAX_LOG_OBJECT_KEYS;
  }
  return out;
}

function dayKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function logFileName(date: Date): string {
  return `app-${dayKey(date)}.log`;
}

export function createAppLogger(options: AppLoggerOptions): AppLogger {
  const now = options.now ?? (() => new Date());
  const minRank = LEVEL_RANK[options.minLevel ?? "info"];
  const baseDir = options.baseDir;
  const maxFileBytes = Math.max(1, options.maxFileBytes ?? APP_LOG_MAX_FILE_BYTES);
  const debugDurationMs = Math.max(1, options.debugDurationMs ?? APP_LOG_DEBUG_DURATION_MS);
  let debugExpiresAtMs = options.debugEnabled ? Number.POSITIVE_INFINITY : 0;
  let activeDay = "";
  let activeFile = "";
  let activeSize = 0;
  const rateLimits = new Map<string, { nextAt: number; suppressed: number }>();
  try {
    purgeExpiredAppLogs(baseDir, now().getTime() - APP_LOG_RETENTION_DAYS * 86_400_000);
  } catch {
    // Retention is best-effort and must never prevent the application from booting.
  }
  const writer =
    options.writer ??
    ((line, file) => {
      fs.mkdirSync(baseDir, { recursive: true });
      const day = file.slice(4, 14);
      const bytes = Buffer.byteLength(`${line}\n`, "utf8");
      if (activeDay !== day || !activeFile) {
        activeDay = day;
        activeFile = selectWritableLogFile(baseDir, file, maxFileBytes);
        activeSize = safeFileSize(path.join(baseDir, activeFile));
        enforceLogDirectoryLimit(baseDir, APP_LOG_MAX_TOTAL_BYTES, activeFile);
      }
      if (activeSize > 0 && activeSize + bytes > maxFileBytes) {
        activeFile = nextRotatedLogFile(baseDir, file);
        activeSize = safeFileSize(path.join(baseDir, activeFile));
        enforceLogDirectoryLimit(baseDir, APP_LOG_MAX_TOTAL_BYTES, activeFile);
      }
      fs.appendFileSync(path.join(baseDir, activeFile), `${line}\n`, "utf8");
      activeSize += bytes;
    });

  function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    const ts = now();
    const debugEnabled = debugExpiresAtMs > ts.getTime();
    if (!debugEnabled && debugExpiresAtMs > 0 && Number.isFinite(debugExpiresAtMs)) {
      debugExpiresAtMs = 0;
    }
    const effectiveLevel = normalizeInfoLevel(level, event);
    if (LEVEL_RANK[effectiveLevel] < minRank && !(effectiveLevel === "debug" && debugEnabled)) return;
    const limitedFields = applyRateLimit(effectiveLevel, event, fields, ts.getTime(), rateLimits);
    if (limitedFields === null) return;
    const record: LogRecord = {
      ts: ts.toISOString(),
      level: effectiveLevel,
      event,
      ...(limitedFields ? (redact(limitedFields) as Record<string, unknown>) : {}),
    };
    const line = JSON.stringify(record);
    const file = logFileName(ts);
    try {
      writer(line, file);
    } catch {
      // Logging must never throw into the caller. Swallow and move on;
      // a diagnostics channel is out of scope for phase one.
    }
  }

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    asMessageSink(event = "legacy") {
      return (message: string) =>
        emit(messageSinkLevel(event, message), event, { message });
    },
    setDebugMode(enabled, durationMs = debugDurationMs) {
      debugExpiresAtMs = enabled
        ? now().getTime() + Math.min(APP_LOG_MAX_DEBUG_DURATION_MS, Math.max(1, durationMs))
        : 0;
      return diagnostics();
    },
    getDiagnostics: diagnostics,
    exportDiagnosticPackage() {
      const timestamp = now();
      const packageDir = path.join(baseDir, "diagnostic-packages");
      fs.mkdirSync(packageDir, { recursive: true });
      cleanupDiagnosticPackages(packageDir, timestamp);
      const filePath = path.join(
        packageDir,
        `wemail-diagnostics-${timestamp.toISOString().replace(/[:.]/g, "-")}.json`,
      );
      const logs = fs.existsSync(baseDir)
        ? fs.readdirSync(baseDir)
            .filter((name) => APP_LOG_FILE_PATTERN.test(name))
            .sort()
            .flatMap((name) => {
              try {
                return fs.readFileSync(path.join(baseDir, name), "utf8")
                  .split(/\r?\n/)
                  .filter(Boolean)
                  .slice(-500)
                  .map((line) => {
                    try { return redact(JSON.parse(line)); } catch { return { event: "unparseable-log-line" }; }
                  });
              } catch {
                return [];
              }
            })
        : [];
      fs.writeFileSync(filePath, JSON.stringify({
        schemaVersion: 1,
        createdAt: timestamp.toISOString(),
        expiresAt: new Date(timestamp.getTime() + DIAGNOSTIC_PACKAGE_RETENTION_DAYS * 86_400_000).toISOString(),
        uploaded: false,
        logs,
      }, null, 2), "utf8");
      return {
        filePath,
        fileName: path.basename(filePath),
        expiresAt: new Date(timestamp.getTime() + DIAGNOSTIC_PACKAGE_RETENTION_DAYS * 86_400_000).toISOString(),
      };
    },
  };

  function diagnostics(): AppLoggingDiagnostics {
    const currentMs = now().getTime();
    if (debugExpiresAtMs > 0 && debugExpiresAtMs <= currentMs) debugExpiresAtMs = 0;
    return {
      debugEnabled: debugExpiresAtMs > currentMs,
      expiresAt: debugExpiresAtMs > currentMs && Number.isFinite(debugExpiresAtMs)
        ? new Date(debugExpiresAtMs).toISOString()
        : null,
      remainingSeconds: debugExpiresAtMs > currentMs && Number.isFinite(debugExpiresAtMs)
        ? Math.max(0, Math.ceil((debugExpiresAtMs - currentMs) / 1000))
        : 0,
      retentionDays: APP_LOG_RETENTION_DAYS,
      maxFileBytes,
      maxTotalBytes: APP_LOG_MAX_TOTAL_BYTES,
    };
  }
}

function cleanupDiagnosticPackages(directory: string, now: Date): void {
  const cutoff = now.getTime() - DIAGNOSTIC_PACKAGE_RETENTION_DAYS * 86_400_000;
  for (const name of fs.readdirSync(directory)) {
    if (!/^wemail-diagnostics-.*\.json$/.test(name)) continue;
    const target = path.join(directory, name);
    try {
      if (fs.statSync(target).mtimeMs < cutoff) fs.unlinkSync(target);
    } catch {
      // Best-effort local retention cleanup.
    }
  }
}

function purgeExpiredAppLogs(baseDir: string, cutoffMs: number): void {
  if (!fs.existsSync(baseDir)) return;
  for (const name of fs.readdirSync(baseDir)) {
    if (!APP_LOG_FILE_PATTERN.test(name)) continue;
    const target = path.join(baseDir, name);
    try {
      if (fs.statSync(target).mtimeMs < cutoffMs) fs.unlinkSync(target);
    } catch {
      // Best-effort local retention cleanup.
    }
  }
}

function messageSinkLevel(event: string, message: string): LogLevel {
  if (event === "mail.watcher" || event === "queue.runner") return "debug";
  const normalizedEvent = event.toLowerCase();
  const normalizedMessage = message.toLowerCase();
  if (
    normalizedEvent.startsWith("intel.") ||
    normalizedEvent.startsWith("ai.") ||
    normalizedEvent === "imap.smtp"
  ) {
    return /failed|error|timeout|reconnect|disconnect|credential|invalid/.test(normalizedMessage)
      ? "warn"
      : "debug";
  }
  if (event === "mail.sync" || event === "mail.sync.background") {
    return /sync page committed|sync trigger|new-mail /.test(message)
      ? "debug"
      : /failed|error|reconnect/.test(message)
        ? "warn"
        : "info";
  }
  return "info";
}

function normalizeInfoLevel(level: LogLevel, event: string): LogLevel {
  if (level !== "info") return level;
  const normalizedEvent = event.toLowerCase();
  if (
    normalizedEvent.startsWith("intel.") ||
    normalizedEvent.startsWith("ai.") ||
    normalizedEvent === "imap.smtp"
  ) {
    return /failed|error|timeout|reconnect|disconnect|credential|invalid/.test(normalizedEvent)
      ? "warn"
      : "debug";
  }
  return normalizedEvent === "retention.run" ||
    normalizedEvent === "mail.attachment.response" ||
    normalizedEvent === "directory.sync.completed" ||
    normalizedEvent.startsWith("performance.governor.")
    ? "debug"
    : level;
}

function applyRateLimit(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> | undefined,
  nowMs: number,
  state: Map<string, { nextAt: number; suppressed: number }>,
): Record<string, unknown> | undefined | null {
  const governorEvent = event.startsWith("performance.governor.");
  const errorSignature = level === "warn" || level === "error"
    ? repeatedErrorSignature(fields)
    : "";
  if (!governorEvent && !errorSignature) return fields;
  const key = governorEvent
    ? `${event}:${String(fields?.reason ?? "unknown")}`
    : `${event}:${String(fields?.accountId ?? "global")}:${errorSignature}`;
  const current = state.get(key);
  if (current && nowMs < current.nextAt) {
    current.suppressed += 1;
    return null;
  }
  const suppressedCount = current?.suppressed ?? 0;
  state.set(key, { nextAt: nowMs + 60_000, suppressed: 0 });
  return suppressedCount > 0 ? { ...fields, suppressedCount } : fields;
}

function repeatedErrorSignature(fields: Record<string, unknown> | undefined): string {
  if (!fields) return "";
  const raw = fields.errorCode ?? fields.error ?? fields.err ?? fields.message;
  if (raw === undefined || raw === null) return "";
  const value = typeof raw === "string"
    ? raw
    : raw instanceof Error
      ? `${raw.name}:${raw.message}`
      : JSON.stringify(redact(raw)) ?? String(raw);
  return value.slice(0, 300);
}

function selectWritableLogFile(
  baseDir: string,
  baseFile: string,
  maxFileBytes: number,
): string {
  const candidates = listRotatedLogFiles(baseDir, baseFile);
  const latest = candidates.at(-1) ?? baseFile;
  return safeFileSize(path.join(baseDir, latest)) < maxFileBytes
    ? latest
    : nextRotatedLogFile(baseDir, baseFile);
}

function nextRotatedLogFile(baseDir: string, baseFile: string): string {
  const candidates = listRotatedLogFiles(baseDir, baseFile);
  const highest = candidates.reduce((max, file) => {
    const match = file.match(/\.(\d+)\.log$/);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0);
  return baseFile.replace(/\.log$/, `.${highest + 1}.log`);
}

function listRotatedLogFiles(baseDir: string, baseFile: string): string[] {
  if (!fs.existsSync(baseDir)) return [];
  const prefix = baseFile.slice(0, -4);
  return fs.readdirSync(baseDir)
    .filter((file) => file === baseFile || new RegExp(`^${prefix}\\.\\d+\\.log$`).test(file))
    .sort((left, right) => rotationIndex(left) - rotationIndex(right));
}

function rotationIndex(file: string): number {
  const match = file.match(/\.(\d+)\.log$/);
  return match ? Number(match[1]) : 0;
}

function safeFileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function enforceLogDirectoryLimit(
  baseDir: string,
  maxTotalBytes: number,
  activeFile: string,
): void {
  try {
    const files = fs.readdirSync(baseDir)
      .filter((file) => APP_LOG_FILE_PATTERN.test(file))
      .map((file) => {
        const stat = fs.statSync(path.join(baseDir, file));
        return { file, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (totalBytes <= maxTotalBytes) break;
      if (file.file === activeFile) continue;
      fs.unlinkSync(path.join(baseDir, file.file));
      totalBytes -= file.size;
    }
  } catch {
    // Rotation cleanup is best-effort and must never affect the caller.
  }
}
