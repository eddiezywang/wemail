/**
 * Minimal WeCLI ports for the open edition (P2 step 3 / module two).
 *
 * The WeCLI runtime, installer, health checker, setup service, command
 * classifier and catalog constants all moved to the private edition overlay.
 * The open tree keeps only the *shape* of those pieces plus structural error
 * matching, so it can still compile generic seams (agent tools, action
 * executor, integration status, HTTP routes) without importing — or even
 * referencing — an internal implementation.
 *
 * Error identity is a string `code`, not a class. This mirrors P2.4's
 * `directoryRemoteErrorCode`: an edition implementation lives in a different
 * compiled package (`dist-electron/edition-modules/**`) and must never hold
 * a runtime `instanceof` dependency on a class from the open tree.
 */
import path from "node:path";
import type { Hono } from "hono";
import type {
  WecliAuditEntry,
  WecliAuditLogInput,
  WecliCatalogResponse,
  WecliClassificationKind,
  WecliCommandClassification,
  WecliComponentStatus,
  WecliInstallResult,
  WecliRunOptions,
  WecliRunResult,
  WecliRunner,
  WecliSetupResult,
  WecliUpdateCheckResult,
  WecliUpdateResult,
} from "../../../shared/wemail/wecliTypes.js";
import type { AutomationProvider } from "../automation/providers/AutomationProvider.js";
import type { SkillCenterService } from "../skill-center/SkillCenterService.js";
import type { AuditLogRepository } from "../telemetry/AuditLogRepository.js";

// ── Structural error identity ──────────────────────────────────────────

export const WECLI_ERROR_CODES = Object.freeze({
  binaryMissing: "wecli-binary-missing",
  spawn: "wecli-spawn",
  confirmationRequired: "wecli-confirmation-required",
  invalidApprovedBy: "wecli-invalid-approved-by",
  timeout: "wecli-timeout",
  notWired: "wecli-not-wired",
});

export type WecliErrorCode = (typeof WECLI_ERROR_CODES)[keyof typeof WECLI_ERROR_CODES];

/** Read an edition error's stable `code` without importing its class. */
export function wecliErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

export function isWecliErrorCode(error: unknown, code: WecliErrorCode): boolean {
  return wecliErrorCode(error) === code;
}

/** Spawn failures carry process details the allowance upload receipt needs. */
export interface WecliSpawnFailure {
  binary?: string;
  resolvedBinary?: string;
  args?: string[];
  errorCode?: string;
}

export function wecliSpawnFailure(error: unknown): WecliSpawnFailure {
  if (!isWecliErrorCode(error, WECLI_ERROR_CODES.spawn)) return {};
  const value = error as Record<string, unknown>;
  return {
    ...(typeof value.binary === "string" ? { binary: value.binary } : {}),
    ...(typeof value.resolvedBinary === "string"
      ? { resolvedBinary: value.resolvedBinary }
      : {}),
    ...(Array.isArray(value.args) ? { args: value.args as string[] } : {}),
    ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
  };
}

export function wecliConfirmationClassification(
  error: unknown,
): WecliCommandClassification | undefined {
  if (!isWecliErrorCode(error, WECLI_ERROR_CODES.confirmationRequired)) return undefined;
  const classification = (error as { classification?: unknown }).classification;
  return classification && typeof classification === "object"
    ? (classification as WecliCommandClassification)
    : undefined;
}

export function wecliTimeoutMs(error: unknown): number | undefined {
  if (!isWecliErrorCode(error, WECLI_ERROR_CODES.timeout)) return undefined;
  const value = (error as { timeoutMs?: unknown }).timeoutMs;
  return typeof value === "number" ? value : undefined;
}

// ── Ports ──────────────────────────────────────────────────────────────

/** The single method every open consumer needs from the WeCLI runtime. */
export interface WecliRuntimePort {
  run(command: string, options?: WecliRunOptions): Promise<WecliRunResult>;
}

export type WecliClassifierPort = (command: string) => WecliCommandClassification;
export type WecliTokenizerPort = (command: string) => string[];

export interface WecliHealthPort {
  check(): Promise<WecliComponentStatus>;
}

export interface WecliInstallerPort {
  install(): Promise<WecliInstallResult>;
}

export interface WecliSetupPort {
  setup(): Promise<WecliSetupResult>;
  checkForUpdate(): Promise<WecliUpdateCheckResult>;
  performUpdate(): Promise<WecliUpdateResult>;
  ensureUsageSkill(): Promise<unknown>;
}

export interface WecliHealthFactoryInput {
  now?: () => Date;
}

export interface WecliRuntimeFactoryInput {
  audit: {
    record(input: WecliAuditLogInput): WecliAuditEntry | Promise<WecliAuditEntry>;
  };
  runner?: WecliRunner;
  now?: () => Date;
  timeoutMs?: number;
  binary?: string;
}

/** Only the two Skill Center methods the edition setup pipeline needs. */
export type WecliSkillCenterPort = Pick<
  SkillCenterService,
  "installPersonalFromDirectory" | "list"
>;

export interface WecliSetupFactoryInput {
  installer: WecliInstallerPort;
  health: WecliHealthPort;
  skillCenter: WecliSkillCenterPort;
}

/** `/api/skills/wecli/*` is mounted only when an edition supplies it. */
export interface WecliSkillRoutesDeps {
  /**
   * Hono instance created by the open HTTP layer and handed to the edition
   * module. The internal bundle therefore has ZERO bare runtime imports
   * (no private npm dependency needs staging into the overlay).
   */
  app: Hono;
  runtime?: WecliRuntimePort;
  audit?: Pick<AuditLogRepository, "list">;
}

export type WecliSkillRoutesFactory = (deps: WecliSkillRoutesDeps) => Hono;

/** Confirmed `install_wecli` pending actions are validated against this. */
export interface WecliInstallRequest {
  command: string;
  packageName: string;
  registry: string;
  networkRequirement: string;
}

export type WecliAutomationProviderFactory = (
  runtime: WecliRuntimePort,
  materialize?: (references: unknown, context: unknown) => Promise<{
    paths: string[];
    cleanup: () => Promise<void>;
  }>,
) => AutomationProvider;

/** Aggregate of everything an edition contributes for the WeCLI module. */
export interface EditionWecliModules {
  describeAutomationAction?: (action: import("../../../shared/wemail/automation.js").AutomationAction) => string | undefined;
  executeAutomationAction?: (
    accountId: string, emailId: string,
    action: Extract<import("../../../shared/wemail/automation.js").AutomationAction, { type: "external" }>,
    runtime: WecliRuntimePort,
  ) => Promise<import("../automation/AutomationActionExecutor.js").AutomationActionResult | undefined>;
  createRuntime(input: WecliRuntimeFactoryInput): WecliRuntimePort;
  classifier: WecliClassifierPort;
  tokenize: WecliTokenizerPort;
  normalizeAgentTokens?: (tokens: string[]) => string[];
  createHealth(input?: WecliHealthFactoryInput): WecliHealthPort;
  createInstaller(): WecliInstallerPort;
  createSetup(input: WecliSetupFactoryInput): WecliSetupPort;
  buildSkillRoutes: WecliSkillRoutesFactory;
  createAutomationProvider: WecliAutomationProviderFactory;
  installRequest: WecliInstallRequest;
}

// ── Open defaults (no WeCLI installed, no internal dependency) ──────────

/** Thrown when a generic open seam is reached without an edition module. */
export class WecliNotWiredError extends Error {
  readonly code = WECLI_ERROR_CODES.notWired;
  constructor() {
    super("wecli module is not available in this edition");
    this.name = "WecliNotWiredError";
  }
}

export const OPEN_WECLI_RUNTIME: WecliRuntimePort = Object.freeze({
  async run(): Promise<WecliRunResult> {
    throw new WecliNotWiredError();
  },
});

const READ_ONLY_TOKENS = new Set(["ls", "list", "status", "show", "query", "help", "get", "read"]);

/** Quote-aware tokenizer — generic, contains no edition-specific data. */
export function openTokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (current.length > 0) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** Conservative default: only plain read-only verbs are auto-approved. */
export function openClassifyCommand(command: string): WecliCommandClassification {
  const tokens = openTokenizeCommand((command ?? "").trim());
  if (tokens[0]?.toLowerCase() === "wecli" || tokens[0]?.toLowerCase() === "wecli.exe") {
    tokens.shift();
  }
  const subcommand = (tokens[0] ?? "").toLowerCase();
  const kind: WecliClassificationKind =
    subcommand.length > 0 && READ_ONLY_TOKENS.has(subcommand)
      ? "auto-approved"
      : "requires-confirmation";
  return {
    kind,
    command: "wecli",
    subcommand,
    reason: kind === "auto-approved"
      ? `read-only ${subcommand} auto-approved`
      : "command requires confirmation",
  };
}

export const OPEN_WECLI_CLASSIFIER: WecliClassifierPort = openClassifyCommand;
export const OPEN_WECLI_TOKENIZER: WecliTokenizerPort = openTokenizeCommand;

/**
 * Absolute path to the Windows command processor. Kept here because the
 * Claude Code task runtime (open tree) needs it too; it contains no
 * edition-specific data. The edition's own installer/setup modules have
 * their own copy so they never import open-tree code at runtime.
 */
export function windowsCommandProcessor(): string {
  return (
    process.env.ComSpec ??
    (process.env.SystemRoot
      ? path.win32.join(process.env.SystemRoot, "System32", "cmd.exe")
      : "cmd.exe")
  );
}

/** Convenience for tests/harnesses that want a typed catalog response. */
export type WecliCatalogResult = WecliCatalogResponse;
