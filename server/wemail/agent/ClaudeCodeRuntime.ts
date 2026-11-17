import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AppLogger } from "../telemetry/AppLogger.js";
import { windowsCommandProcessor } from "../skills/wecliPort.js";

/**
 * The Claude Code skill is intentionally close to Hermes' orchestration
 * guide. This runtime is the small local equivalent of Hermes' terminal plus
 * ProcessRegistry: it starts a print-mode Claude process, keeps it alive after
 * the calling Agent turn ends, and exposes bounded polling/waiting.
 */

export const CLAUDE_CODE_DEFAULT_WAIT_MS = 20_000;
export const CLAUDE_CODE_DEFAULT_HARD_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const CLAUDE_CODE_MAX_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const CLAUDE_CODE_MAX_OUTPUT_CHARS = 200_000;
export const CLAUDE_CODE_TOOL_OUTPUT_CHARS = 12_000;

export type ClaudeCodeTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "lost";

export interface ClaudeCodeTaskSummary {
  id: string;
  status: ClaudeCodeTaskStatus;
  cwd: string;
  pid?: number;
  pidIdentity?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  claudeSessionId?: string;
  resultSubtype?: string;
  numTurns?: number;
  totalCostUsd?: number;
  result?: string;
  error?: string;
  terminationReason?: "cancelled" | "timed_out";
  recovered?: boolean;
}

export interface ClaudeCodeTaskResult extends ClaudeCodeTaskSummary {
  output: string;
  nextCursor: number;
  outputTruncated: boolean;
}

export interface ClaudeCodeStartInput {
  prompt: string;
  cwd?: string;
  resumeSessionId?: string;
  continueLatest?: boolean;
  forkSession?: boolean;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  hardTimeoutMs?: number;
  requestedBy?: string;
}

export interface ClaudeCodeRuntimeOptions {
  dataDir: string;
  logger: Pick<AppLogger, "debug" | "info" | "warn" | "error">;
  binary?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  hardTimeoutMs?: number;
}

export interface ResolveClaudeCodeBinaryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathEnv?: string;
  exists?: (candidate: string) => boolean;
}

export interface ClaudeCodeLaunch {
  command: string;
  args: string[];
  resolvedBinary: string;
  windowsVerbatimArguments?: boolean;
}

interface ClaudeCodeTaskRecord {
  id: string;
  status: ClaudeCodeTaskStatus;
  cwd: string;
  binary: string;
  pid?: number;
  pidIdentity?: string;
  startedAt: string;
  startedAtMs: number;
  updatedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  claudeSessionId?: string;
  resultSubtype?: string;
  numTurns?: number;
  totalCostUsd?: number;
  result?: string;
  error?: string;
  terminationReason?: "cancelled" | "timed_out";
  hardTimeoutMs: number;
  promptHash: string;
  outputPath: string;
  outputReadBytes: number;
  totalOutputChars: number;
  outputTail: string;
  stdoutLineBuffer: string;
  stdoutDecoder: StringDecoder;
  child?: ChildProcess;
  completion?: Promise<void>;
  resolveCompletion?: () => void;
  hardTimeout?: NodeJS.Timeout;
  recovered?: boolean;
  finalizing?: boolean;
}

interface PersistedClaudeCodeTask {
  id: string;
  status: ClaudeCodeTaskStatus;
  cwd: string;
  binary: string;
  pid?: number;
  pidIdentity?: string;
  startedAt: string;
  startedAtMs: number;
  updatedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  claudeSessionId?: string;
  resultSubtype?: string;
  numTurns?: number;
  totalCostUsd?: number;
  result?: string;
  error?: string;
  terminationReason?: "cancelled" | "timed_out";
  hardTimeoutMs: number;
  promptHash: string;
  outputPath: string;
  outputReadBytes: number;
  totalOutputChars: number;
  recovered?: boolean;
}

const ACTIVE_STATUS: ClaudeCodeTaskStatus = "running";
const WINDOWS_CLAUDE_CANDIDATES = [
  "claude.exe",
  "claude.cmd",
  "claude.bat",
  "claude",
];

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isExplicitBinaryPath(binary: string): boolean {
  return path.isAbsolute(binary) || binary.includes("/") || binary.includes("\\");
}

/** Resolve npm-installed Claude Code shims on Windows before spawning. */
export function resolveClaudeCodeBinary(
  binary = "claude",
  options: ResolveClaudeCodeBinaryOptions = {},
): string {
  const normalized = stripWrappingQuotes(binary);
  if (isExplicitBinaryPath(normalized) || normalized !== "claude") return normalized;

  const env = options.env ?? process.env;
  const override = env.WEMAIL_CLAUDE_CODE_BINARY?.trim();
  if (override) return stripWrappingQuotes(override);

  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return normalized;

  const pathEnv = options.pathEnv ?? env.PATH ?? env.Path ?? "";
  const exists = options.exists ?? fs.existsSync;
  for (const directory of pathEnv.split(";")) {
    if (!directory.trim()) continue;
    for (const candidateName of WINDOWS_CLAUDE_CANDIDATES) {
      const candidate = path.win32.join(directory, candidateName);
      if (exists(candidate)) return candidate;
    }
  }
  return normalized;
}

function quoteWindowsCommandArg(value: string, alwaysQuote = false): string {
  if (!alwaysQuote && /^[A-Za-z0-9_./:\\=-]+$/.test(value)) return value;
  const escaped = value
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\+)$/g, "$1$1")
    .replace(/%/g, "%%");
  return `"${escaped}"`;
}

/** Turn a .cmd/.bat npm shim into an explicit cmd.exe launch. */
export function resolveClaudeCodeLaunch(
  binary: string,
  args: string[],
  options: { platform?: NodeJS.Platform; resolvedBinary?: string } = {},
): ClaudeCodeLaunch {
  const platform = options.platform ?? process.platform;
  const resolvedBinary = options.resolvedBinary ?? resolveClaudeCodeBinary(binary, { platform });
  if (platform !== "win32") return { command: resolvedBinary, args, resolvedBinary };

  const lower = resolvedBinary.toLowerCase();
  if (!lower.endsWith(".cmd") && !lower.endsWith(".bat")) {
    return { command: resolvedBinary, args, resolvedBinary };
  }

  const commandLine = [
    quoteWindowsCommandArg(resolvedBinary, true),
    ...args.map((arg) => quoteWindowsCommandArg(arg)),
  ].join(" ");
  return {
    command: windowsCommandProcessor(),
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    resolvedBinary,
    windowsVerbatimArguments: true,
  };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function safeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function isActive(status: ClaudeCodeTaskStatus): boolean {
  return status === ACTIVE_STATUS;
}

interface ProcessSnapshot {
  alive: boolean;
  identity?: string;
  commandLine?: string;
}

/**
 * Keep the PID-reuse guard from Hermes' ProcessRegistry. On Windows the
 * creation timestamp comes from CIM; on POSIX it comes from /proc when
 * available. If the host cannot provide an identity, callers degrade to a
 * liveness check and never claim stronger ownership than they have.
 */
function readProcessSnapshot(
  pid: number,
  platform: NodeJS.Platform,
): ProcessSnapshot {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { alive: false };
  if (platform === "win32") {
    try {
      const command = [
        `$p=Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"`,
        "if ($p) { $p | Select-Object CreationDate,CommandLine | ConvertTo-Json -Compress }",
      ].join("; ");
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8", timeout: 5_000, windowsHide: true },
      ).trim();
      if (!output) return { alive: false };
      const value = JSON.parse(output) as {
        CreationDate?: string;
        CommandLine?: string;
      };
      const identity = value.CreationDate?.trim() || undefined;
      return {
        alive: true,
        ...(identity ? { identity } : {}),
        ...(value.CommandLine ? { commandLine: value.CommandLine } : {}),
      };
    } catch {
      try {
        process.kill(pid, 0);
        return { alive: true };
      } catch {
        return { alive: false };
      }
    }
  }

  try {
    process.kill(pid, 0);
  } catch {
    return { alive: false };
  }
  let identity: string | undefined;
  let commandLine: string | undefined;
  try {
    commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterCommand = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    identity = afterCommand[19] || undefined;
  } catch {
    // macOS and restricted Linux environments may not expose /proc.
  }
  return {
    alive: true,
    ...(identity ? { identity } : {}),
    ...(commandLine ? { commandLine } : {}),
  };
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function taskSummary(record: ClaudeCodeTaskRecord): ClaudeCodeTaskSummary {
  return {
    id: record.id,
    status: record.status,
    cwd: record.cwd,
    ...(record.pid === undefined ? {} : { pid: record.pid }),
    ...(record.pidIdentity ? { pidIdentity: record.pidIdentity } : {}),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.claudeSessionId ? { claudeSessionId: record.claudeSessionId } : {}),
    ...(record.resultSubtype ? { resultSubtype: record.resultSubtype } : {}),
    ...(record.numTurns === undefined ? {} : { numTurns: record.numTurns }),
    ...(record.totalCostUsd === undefined ? {} : { totalCostUsd: record.totalCostUsd }),
    ...(record.result ? { result: record.result.slice(-CLAUDE_CODE_TOOL_OUTPUT_CHARS) } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.terminationReason ? { terminationReason: record.terminationReason } : {}),
    ...(record.recovered ? { recovered: true } : {}),
  };
}

function persistedTask(record: ClaudeCodeTaskRecord): PersistedClaudeCodeTask {
  return {
    ...taskSummary(record),
    binary: record.binary,
    startedAtMs: record.startedAtMs,
    hardTimeoutMs: record.hardTimeoutMs,
    promptHash: record.promptHash,
    outputPath: record.outputPath,
    outputReadBytes: record.outputReadBytes,
    totalOutputChars: record.totalOutputChars,
  };
}

function createCompletion(record: ClaudeCodeTaskRecord): void {
  record.completion = new Promise<void>((resolve) => {
    record.resolveCompletion = resolve;
  });
}

function createRecord(input: {
  id: string;
  cwd: string;
  binary: string;
  outputPath: string;
  prompt: string;
  hardTimeoutMs: number;
  now: Date;
}): ClaudeCodeTaskRecord {
  const startedAt = input.now.toISOString();
  const record: ClaudeCodeTaskRecord = {
    id: input.id,
    status: "running",
    cwd: input.cwd,
    binary: input.binary,
    hardTimeoutMs: input.hardTimeoutMs,
    startedAt,
    startedAtMs: input.now.getTime(),
    updatedAt: startedAt,
    promptHash: createHash("sha256").update(input.prompt).digest("hex"),
    outputPath: input.outputPath,
    outputReadBytes: 0,
    totalOutputChars: 0,
    outputTail: "",
    stdoutLineBuffer: "",
    stdoutDecoder: new StringDecoder("utf8"),
  };
  createCompletion(record);
  return record;
}

export class ClaudeCodeTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Claude Code task not found: ${taskId}`);
    this.name = "ClaudeCodeTaskNotFoundError";
  }
}

export class ClaudeCodeTaskService {
  private readonly taskRoot: string;
  private readonly checkpointPath: string;
  private readonly logger: ClaudeCodeRuntimeOptions["logger"];
  private readonly binary: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly platform: NodeJS.Platform;
  private readonly spawnImpl: typeof spawn;
  private readonly defaultHardTimeoutMs: number;
  private readonly tasks = new Map<string, ClaudeCodeTaskRecord>();
  private checkpointWriteQueued = false;

  constructor(options: ClaudeCodeRuntimeOptions) {
    this.taskRoot = path.join(path.resolve(options.dataDir), "claude-code-tasks");
    this.checkpointPath = path.join(this.taskRoot, "tasks.json");
    this.logger = options.logger;
    this.binary = options.binary ?? "claude";
    this.env = { ...process.env, ...options.env };
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? process.platform;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.defaultHardTimeoutMs = clampInteger(
      options.hardTimeoutMs,
      CLAUDE_CODE_DEFAULT_HARD_TIMEOUT_MS,
      60_000,
      CLAUDE_CODE_MAX_HARD_TIMEOUT_MS,
    );
    fs.mkdirSync(this.taskRoot, { recursive: true, mode: 0o700 });
    this.recoverCheckpoint();
  }

  start(input: ClaudeCodeStartInput): ClaudeCodeTaskResult {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("prompt-required");
    if (prompt.length > 200_000) throw new Error("prompt-too-large");

    const cwd = path.resolve(input.cwd?.trim() || process.cwd());
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`working-directory-not-found:${cwd}`);
    }

    const id = `cc_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const taskDir = path.join(this.taskRoot, safeFileName(id));
    fs.mkdirSync(taskDir, { recursive: true, mode: 0o700 });
    const outputPath = path.join(taskDir, "events.ndjson");
    fs.writeFileSync(outputPath, "", { flag: "ax", mode: 0o600 });

    const hardTimeoutMs = clampInteger(
      input.hardTimeoutMs,
      this.defaultHardTimeoutMs,
      60_000,
      CLAUDE_CODE_MAX_HARD_TIMEOUT_MS,
    );

    const resolvedBinary = resolveClaudeCodeBinary(this.binary, {
      env: this.env,
      platform: this.platform,
    });
    const args = this.buildArgs(input, prompt);
    const launch = resolveClaudeCodeLaunch(resolvedBinary, args, {
      platform: this.platform,
      resolvedBinary,
    });
    const record = createRecord({
      id,
      cwd,
      binary: resolvedBinary,
      outputPath,
      prompt,
      hardTimeoutMs,
      now: this.now(),
    });
    this.tasks.set(id, record);

    let outputFd: number | undefined;
    try {
      outputFd = fs.openSync(outputPath, "a");
      const child = this.spawnImpl(launch.command, launch.args, {
        cwd,
        env: this.childEnvironment(),
        detached: this.platform !== "win32",
        // File-backed output lets Claude continue if the Electron process
        // exits. The next Agent turn tails this file, like Hermes' detached
        // process registry does after a restart.
        stdio: ["ignore", outputFd, outputFd],
        windowsHide: true,
        ...(launch.windowsVerbatimArguments
          ? { windowsVerbatimArguments: true }
          : {}),
      });
      fs.closeSync(outputFd);
      outputFd = undefined;
      record.child = child;
      record.pid = child.pid;
      if (child.pid) {
        record.pidIdentity = readProcessSnapshot(child.pid, this.platform).identity;
      }
      this.scheduleHardTimeout(record);
      this.attachProcess(record);
      child.unref?.();
      this.persistCheckpoint();
      this.logger.info("claude_code.task_started", {
        taskId: record.id,
        pid: record.pid ?? null,
        cwd: record.cwd,
        binary: record.binary,
      });
    } catch (error) {
      if (outputFd !== undefined) {
        try {
          fs.closeSync(outputFd);
        } catch {
          // The spawn path may already have closed the descriptor.
        }
      }
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.updatedAt = nowIso(this.now);
      this.finishRecord(record);
    }

    return this.result(record);
  }

  get(taskId: string, cursor?: number): ClaudeCodeTaskResult {
    const record = this.requireTask(taskId);
    this.refreshOutput(record);
    this.refreshRecovered(record);
    return this.result(record, cursor);
  }

  async wait(
    taskId: string,
    timeoutMs = CLAUDE_CODE_DEFAULT_WAIT_MS,
    signal?: AbortSignal,
  ): Promise<ClaudeCodeTaskResult> {
    const record = this.requireTask(taskId);
    this.refreshOutput(record);
    this.refreshRecovered(record);
    if (!isActive(record.status)) return this.result(record);

    const effectiveTimeoutMs = clampInteger(
      timeoutMs,
      CLAUDE_CODE_DEFAULT_WAIT_MS,
      250,
      CLAUDE_CODE_DEFAULT_WAIT_MS,
    );
    const deadline = Date.now() + effectiveTimeoutMs;
    while (isActive(record.status) && Date.now() < deadline) {
      this.refreshOutput(record);
      this.refreshRecovered(record);
      if (!isActive(record.status) || signal?.aborted) break;
      const remainingMs = Math.max(1, deadline - Date.now());
      const timer = new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, Math.min(250, remainingMs));
        handle.unref?.();
      });
      const completion = record.completion ?? new Promise<void>(() => {});
      let abortHandler: (() => void) | undefined;
      const aborted = signal
        ? new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            abortHandler = () => resolve();
            signal.addEventListener("abort", abortHandler, { once: true });
          })
        : new Promise<void>(() => {});
      await Promise.race([completion, timer, aborted]);
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
    this.refreshOutput(record, true);
    this.refreshRecovered(record);
    return this.result(record);
  }

  async cancel(taskId: string): Promise<ClaudeCodeTaskResult> {
    const record = this.requireTask(taskId);
    this.refreshRecovered(record);
    if (isActive(record.status)) await this.terminate(record, "cancelled");
    return this.result(record);
  }

  list(): ClaudeCodeTaskSummary[] {
    for (const record of this.tasks.values()) {
      this.refreshOutput(record);
      this.refreshRecovered(record);
    }
    return [...this.tasks.values()]
      .sort((a, b) => b.startedAtMs - a.startedAtMs)
      .map(taskSummary);
  }

  private buildArgs(input: ClaudeCodeStartInput, prompt: string): string[] {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
    ];
    if (input.resumeSessionId?.trim()) {
      args.push("--resume", input.resumeSessionId.trim());
    } else if (input.continueLatest) {
      args.push("--continue");
    }
    if (input.forkSession) args.push("--fork-session");
    if (input.model?.trim()) args.push("--model", input.model.trim());
    if (input.maxTurns !== undefined) {
      args.push("--max-turns", String(clampInteger(input.maxTurns, 10, 1, 100)));
    }
    if (input.maxBudgetUsd !== undefined) {
      args.push(
        "--max-budget-usd",
        String(clampNumber(input.maxBudgetUsd, 1, 0.01, 1_000)),
      );
    }
    return args;
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const env = { ...this.env };
    // Do not leak WeMail's application configuration or telemetry credentials
    // into a coding agent. Claude's own auth remains available by design.
    for (const key of Object.keys(env)) {
      const normalized = key.toUpperCase();
      if (normalized.startsWith("WEMAIL_") || normalized.startsWith("VITE_") || normalized === "NODE_AUTH_TOKEN") {
        delete env[key];
      }
    }
    return env;
  }

  private attachProcess(record: ClaudeCodeTaskRecord): void {
    const child = record.child;
    if (!child) return;
    child.once("error", (error) => {
      record.error = error.message;
      if (error.message.includes("ENOENT")) record.error = "claude-not-installed";
      if (isActive(record.status)) record.status = "failed";
      this.logger.warn("claude_code.process_error", {
        taskId: record.id,
        error: record.error,
      });
    });
    child.once("close", (exitCode) => {
      this.finishProcess(record, exitCode);
    });
  }

  private appendStdout(record: ClaudeCodeTaskRecord, chunk: string): void {
    if (!chunk) return;
    this.appendOutput(record, chunk);
    record.stdoutLineBuffer += chunk;
    const lines = record.stdoutLineBuffer.split(/\r?\n/);
    record.stdoutLineBuffer = lines.pop() ?? "";
    for (const line of lines) this.consumeEvent(record, line);
    record.updatedAt = nowIso(this.now);
    this.queueCheckpoint();
  }

  private appendOutput(record: ClaudeCodeTaskRecord, chunk: string): void {
    record.totalOutputChars += chunk.length;
    record.outputTail = (record.outputTail + chunk).slice(-CLAUDE_CODE_MAX_OUTPUT_CHARS);
  }

  private refreshOutput(record: ClaudeCodeTaskRecord, flush = false): void {
    try {
      const stat = fs.statSync(record.outputPath);
      if (stat.size < record.outputReadBytes) record.outputReadBytes = 0;
      if (stat.size > record.outputReadBytes) {
        const handle = fs.openSync(record.outputPath, "r");
        try {
          let position = record.outputReadBytes;
          while (position < stat.size) {
            const length = Math.min(64 * 1024, stat.size - position);
            const buffer = Buffer.alloc(length);
            const read = fs.readSync(handle, buffer, 0, length, position);
            if (read <= 0) break;
            position += read;
            this.appendStdout(
              record,
              record.stdoutDecoder.write(buffer.subarray(0, read)),
            );
          }
          record.outputReadBytes = position;
        } finally {
          fs.closeSync(handle);
        }
      }
      if (flush) this.appendStdout(record, record.stdoutDecoder.end());
    } catch {
      // The process may be between spawn and file creation. Keep its status.
    }
  }

  private consumeEvent(record: ClaudeCodeTaskRecord, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object") return;
      event = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const sessionId = event.session_id ?? event.sessionId;
    if (typeof sessionId === "string" && sessionId.trim()) {
      record.claudeSessionId = sessionId;
    }
    if (typeof event.subtype === "string") record.resultSubtype = event.subtype;
    if (typeof event.num_turns === "number") record.numTurns = event.num_turns;
    if (typeof event.total_cost_usd === "number") {
      record.totalCostUsd = event.total_cost_usd;
    }
    if (event.type === "result") {
      if (typeof event.result === "string") record.result = event.result;
      if (event.is_error === true && isActive(record.status)) record.status = "failed";
    }
  }

  private finishProcess(record: ClaudeCodeTaskRecord, exitCode: number | null): void {
    if (record.finalizing) return;
    record.finalizing = true;
    this.refreshOutput(record, true);
    record.exitCode = exitCode;
    if (record.hardTimeout) clearTimeout(record.hardTimeout);
    if (record.stdoutLineBuffer) this.consumeEvent(record, record.stdoutLineBuffer);
    if (record.terminationReason === "cancelled") {
      record.status = "cancelled";
    } else if (record.terminationReason === "timed_out") {
      record.status = "timed_out";
    } else if (record.status === "running") {
      record.status = record.resultSubtype?.startsWith("error") || exitCode !== 0
        ? "failed"
        : "completed";
    }
    record.endedAt = nowIso(this.now);
    record.updatedAt = record.endedAt;
    this.finishRecord(record);
  }

  private finishRecord(record: ClaudeCodeTaskRecord): void {
    if (record.hardTimeout) clearTimeout(record.hardTimeout);
    record.hardTimeout = undefined;
    record.endedAt ??= nowIso(this.now);
    record.updatedAt = record.endedAt;
    record.resolveCompletion?.();
    record.resolveCompletion = undefined;
    this.pruneFinishedTasks();
    this.persistCheckpoint();
    this.logger.info("claude_code.task_finished", {
      taskId: record.id,
      status: record.status,
      exitCode: record.exitCode ?? null,
    });
  }

  private scheduleHardTimeout(record: ClaudeCodeTaskRecord): void {
    if (!isActive(record.status)) return;
    const deadline = record.startedAtMs + record.hardTimeoutMs;
    const remainingMs = Math.max(0, deadline - this.now().getTime());
    if (remainingMs === 0) {
      void this.terminate(record, "timed_out");
      return;
    }
    record.hardTimeout = setTimeout(() => {
      void this.terminate(record, "timed_out");
    }, remainingMs);
    record.hardTimeout.unref?.();
  }

  private async terminate(
    record: ClaudeCodeTaskRecord,
    reason: "cancelled" | "timed_out",
  ): Promise<void> {
    if (!isActive(record.status)) return;
    record.terminationReason = reason;
    record.updatedAt = nowIso(this.now);
    const pid = record.pid;
    if (!pid) {
      record.status = reason;
      this.finishRecord(record);
      return;
    }
    if (record.recovered && !this.isProcessOurs(record)) {
      record.status = "lost";
      record.error = "pid-identity-mismatch-process-not-terminated";
      this.finishRecord(record);
      return;
    }
    if (this.platform === "win32") {
      await new Promise<void>((resolve) => {
        execFile(
          "taskkill",
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true },
          () => resolve(),
        );
      });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          if (record.child) {
            record.child.kill("SIGTERM");
          } else {
            process.kill(pid, "SIGTERM");
          }
        } catch {
          // The process may have exited between the liveness check and kill.
        }
      }
      setTimeout(() => {
        const snapshot = readProcessSnapshot(pid, this.platform);
        if (!this.isProcessOurs(record, snapshot)) return;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Best effort escalation only.
          }
        }
      }, 2_000).unref?.();
    }
    if (record.child && record.child.exitCode === null) return;
    record.status = reason;
    this.finishRecord(record);
  }

  private refreshRecovered(record: ClaudeCodeTaskRecord): void {
    if (!record.recovered || !isActive(record.status) || !record.pid) return;
    const snapshot = readProcessSnapshot(record.pid, this.platform);
    if (snapshot.alive && this.isProcessOurs(record, snapshot)) return;
    this.loadOutputTail(record);
    if (!snapshot.alive && (record.resultSubtype || record.result)) {
      record.status = "completed";
    } else {
      record.status = "lost";
      if (snapshot.alive) record.error = "pid-identity-mismatch-process-not-adopted";
    }
    record.endedAt = nowIso(this.now);
    record.updatedAt = record.endedAt;
    this.finishRecord(record);
  }

  private isProcessOurs(
    record: ClaudeCodeTaskRecord,
    snapshot = record.pid ? readProcessSnapshot(record.pid, this.platform) : { alive: false },
  ): boolean {
    if (!snapshot.alive) return false;
    if (record.pidIdentity && snapshot.identity) {
      return record.pidIdentity === snapshot.identity;
    }
    if (snapshot.commandLine) return /claude/i.test(snapshot.commandLine);
    return true;
  }

  private loadOutputTail(record: ClaudeCodeTaskRecord): void {
    try {
      const stat = fs.statSync(record.outputPath);
      const start = Math.max(0, stat.size - CLAUDE_CODE_MAX_OUTPUT_CHARS * 4);
      const handle = fs.openSync(record.outputPath, "r");
      const buffer = Buffer.alloc(Math.max(0, stat.size - start));
      fs.readSync(handle, buffer, 0, buffer.length, start);
      fs.closeSync(handle);
      record.outputTail = buffer.toString("utf8").slice(-CLAUDE_CODE_MAX_OUTPUT_CHARS);
      record.outputReadBytes = stat.size;
      record.totalOutputChars = Math.max(record.totalOutputChars, record.outputTail.length);
      const lines = record.outputTail.split(/\r?\n/);
      record.stdoutLineBuffer = lines.pop() ?? "";
      for (const line of lines) this.consumeEvent(record, line);
    } catch {
      // A missing output file is reported through the task status, not boot.
    }
  }

  private result(record: ClaudeCodeTaskRecord, cursor?: number): ClaudeCodeTaskResult {
    const tailStart = Math.max(0, record.totalOutputChars - record.outputTail.length);
    const requestedCursor = typeof cursor === "number" && cursor >= 0 ? cursor : tailStart;
    const outputTruncated = requestedCursor < tailStart;
    const start = outputTruncated ? 0 : requestedCursor - tailStart;
    const raw = record.outputTail.slice(Math.max(0, start));
    return {
      ...taskSummary(record),
      output: raw.slice(-CLAUDE_CODE_TOOL_OUTPUT_CHARS),
      nextCursor: record.totalOutputChars,
      outputTruncated,
    };
  }

  private requireTask(taskId: string): ClaudeCodeTaskRecord {
    const normalized = taskId.trim();
    const record = this.tasks.get(normalized);
    if (!record) throw new ClaudeCodeTaskNotFoundError(normalized);
    return record;
  }

  private recoverCheckpoint(): void {
    if (!fs.existsSync(this.checkpointPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.checkpointPath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const value of parsed.slice(-64)) {
        if (!value || typeof value !== "object") continue;
        const item = value as Partial<PersistedClaudeCodeTask>;
        if (typeof item.id !== "string" || typeof item.outputPath !== "string") continue;
        const startedAt = typeof item.startedAt === "string"
          ? item.startedAt
          : nowIso(this.now);
        const parsedStartedAtMs = typeof item.startedAtMs === "number" && Number.isFinite(item.startedAtMs)
          ? item.startedAtMs
          : Date.parse(startedAt);
        const record: ClaudeCodeTaskRecord = {
          id: item.id,
          status: item.status ?? "lost",
          cwd: item.cwd ?? process.cwd(),
          binary: item.binary ?? this.binary,
          ...(item.pid === undefined ? {} : { pid: item.pid }),
          ...(item.pidIdentity ? { pidIdentity: item.pidIdentity } : {}),
          startedAt,
          startedAtMs: Number.isFinite(parsedStartedAtMs)
            ? parsedStartedAtMs
            : this.now().getTime(),
          updatedAt: item.updatedAt ?? startedAt,
          ...(item.endedAt ? { endedAt: item.endedAt } : {}),
          ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
          ...(item.claudeSessionId ? { claudeSessionId: item.claudeSessionId } : {}),
          ...(item.resultSubtype ? { resultSubtype: item.resultSubtype } : {}),
          ...(item.numTurns === undefined ? {} : { numTurns: item.numTurns }),
          ...(item.totalCostUsd === undefined ? {} : { totalCostUsd: item.totalCostUsd }),
          ...(item.result ? { result: item.result } : {}),
          ...(item.error ? { error: item.error } : {}),
          ...(item.terminationReason ? { terminationReason: item.terminationReason } : {}),
          hardTimeoutMs: clampInteger(
            item.hardTimeoutMs,
            this.defaultHardTimeoutMs,
            60_000,
            CLAUDE_CODE_MAX_HARD_TIMEOUT_MS,
          ),
          promptHash: item.promptHash ?? "",
          outputPath: this.safeOutputPath(item.id, item.outputPath),
          outputReadBytes: item.outputReadBytes ?? 0,
          totalOutputChars: item.totalOutputChars ?? 0,
          outputTail: "",
          stdoutLineBuffer: "",
          stdoutDecoder: new StringDecoder("utf8"),
          recovered: true,
        };
        createCompletion(record);
        this.tasks.set(record.id, record);
        this.loadOutputTail(record);
        if (isActive(record.status)) {
          this.refreshRecovered(record);
          this.scheduleHardTimeout(record);
        }
      }
      this.persistCheckpoint();
    } catch (error) {
      this.logger.warn("claude_code.checkpoint_recovery_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private safeOutputPath(taskId: string, outputPath: string): string {
    const fallback = path.join(this.taskRoot, safeFileName(taskId), "events.ndjson");
    const resolved = path.resolve(outputPath);
    const root = `${path.resolve(this.taskRoot)}${path.sep}`;
    return resolved.startsWith(root) ? resolved : fallback;
  }

  private queueCheckpoint(): void {
    if (this.checkpointWriteQueued) return;
    this.checkpointWriteQueued = true;
    setTimeout(() => {
      this.checkpointWriteQueued = false;
      this.persistCheckpoint();
    }, 250).unref?.();
  }

  private persistCheckpoint(): void {
    try {
      fs.mkdirSync(this.taskRoot, { recursive: true, mode: 0o700 });
      const records = [...this.tasks.values()]
        .sort((a, b) => b.startedAtMs - a.startedAtMs)
        .slice(0, 64)
        .map(persistedTask);
      const temporaryPath = `${this.checkpointPath}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify(records, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporaryPath, this.checkpointPath);
    } catch (error) {
      this.logger.warn("claude_code.checkpoint_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private pruneFinishedTasks(): void {
    if (this.tasks.size <= 64) return;
    const removable = [...this.tasks.values()]
      .filter((record) => !isActive(record.status))
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
    while (this.tasks.size > 64 && removable.length > 0) {
      const record = removable.shift();
      if (record) this.tasks.delete(record.id);
    }
  }
}
