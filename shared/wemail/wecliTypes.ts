// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Wire contracts for the optional WeCLI integration (P2 extraction).
 *
 * This file deliberately contains **types only**. The runtime, installer,
 * health checker, command classifier, catalog constants (including the
 * private registry / download URLs) and the `/api/skills` HTTP surface live
 * in the private edition overlay. The open tree keeps just enough shape to
 * compile its generic seams and to deserialize existing rows.
 *
 * Edition code must never be imported at runtime from here: the edition
 * modules are compiled into `dist-electron/edition-modules/**` and cannot
 * resolve a runtime import back into the open source tree.
 */

// ── Classification / audit (formerly server/wemail/skills/WecliTypes.ts) ──

export type WecliClassificationKind = "auto-approved" | "requires-confirmation";

export interface WecliCommandClassification {
  kind: WecliClassificationKind;
  command: string;
  subcommand: string;
  reason: string;
}

export interface WecliAuditEntry {
  id: string;
  invokedAt: string;
  command: string;
  args: string[];
  classification: WecliCommandClassification;
  approvedBy?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs: number;
}

/** Input shape accepted by the wecli audit repository. */
export interface WecliAuditLogInput {
  approvedBy?: string;
  command: string;
  args: string[];
  classification: WecliCommandClassification;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  invokedAt?: string;
}

// ── Runtime (formerly WecliSkillRuntime.ts) ─────────────────────────────

export interface WecliRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
}

export type WecliRunner = (
  binary: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<WecliRunnerResult>;

export interface WecliRunOptions {
  approvedBy?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WecliRunResult {
  classification: WecliCommandClassification;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  auditId: string;
  parsed?: unknown;
  parseWarning?: string;
}

// ── Health (formerly WecliHealthChecker.ts) ─────────────────────────────

export interface WecliHealthCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export type WecliHealthRunner = (
  binary: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<WecliHealthCommandResult>;

export interface WecliComponentStatus {
  state: "missing" | "ready" | "error";
  installed: boolean;
  connected: boolean;
  binary?: string;
  version?: string;
  checkedAt: string;
  daemon?: { running: boolean; port?: number; version?: string };
  extension?: { connected: boolean; version?: string };
  /** Edition-supplied browser-extension download URL (never baked into open). */
  extensionDownloadUrl?: string;
  doctor: {
    command: string;
    exitCode?: number;
    durationMs?: number;
    timedOut?: boolean;
    error?: string;
    diagnostic?: string;
  };
}

// ── Installer (formerly WecliInstaller.ts) ──────────────────────────────

export interface WecliInstallResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export type WecliInstallRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<Omit<WecliInstallResult, "command">>;

// ── Command catalog (`wecli list -f json` projection) ───────────────────

export interface WecliCatalogCommand {
  command: string;
  site: string;
  name: string;
  description: string;
  strategy: string;
  browser: boolean;
  deprecated: boolean;
  replacedBy: string | null;
}

export interface WecliCatalogSite {
  name: string;
  count: number;
  commands: WecliCatalogCommand[];
}

export interface WecliCatalogResponse {
  ok: boolean;
  fetchedAt: string;
  total: number;
  siteCount: number;
  sites: WecliCatalogSite[];
}

// ── Setup / update pipeline ─────────────────────────────────────────────

export interface WecliSetupStepStatus {
  status: "ok" | "skipped" | "failed";
  detail?: string;
  durationMs?: number;
}

export interface WecliSetupSkillStep extends WecliSetupStepStatus {
  registered?: boolean;
}

export interface WecliSetupResult {
  succeeded: boolean;
  cli: WecliSetupStepStatus;
  pmCli: WecliSetupStepStatus;
  skill: WecliSetupSkillStep;
  health?: {
    connected: boolean;
    version?: string;
    extensionConnected?: boolean;
    extensionVersion?: string;
  };
}

export interface WecliUpdateCheckResult {
  currentVersion?: string;
  latestVersion?: string;
  status: string;
  updateAvailable: boolean;
  detail?: string;
}

export interface WecliUpdateResult {
  updated: boolean;
  status: string;
  currentVersion?: string;
  latestVersion?: string;
  detail?: string;
}

export interface WecliCommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export type WecliSetupRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<WecliCommandRunResult>;
