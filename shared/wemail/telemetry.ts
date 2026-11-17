export const TELEMETRY_EVENT_NAMES = [
  "wemail_app_started",
  "wemail_app_ready",
  "wemail_app_usage_heartbeat",
  "wemail_app_quit_requested",
  "wemail_app_abnormal_exit_detected",
  "wemail_app_runtime_error",
  "wemail_account_login_attempted",
  "wemail_account_login_succeeded",
  "wemail_account_login_failed",
  "wemail_account_logout",
  "wemail_account_logout_failed",
  "wemail_mail_sync_started",
  "wemail_mail_sync_succeeded",
  "wemail_mail_sync_failed",
  "wemail_mail_refresh_started",
  "wemail_mail_refresh_succeeded",
  "wemail_mail_refresh_failed",
  "wemail_surface_viewed",
  "wemail_mail_action_completed",
  "wemail_search_executed",
  "wemail_compose_opened",
  "wemail_mail_send_attempted",
  "wemail_mail_send_succeeded",
  "wemail_mail_send_failed",
  "wemail_ai_feature_started",
  "wemail_ai_feature_succeeded",
  "wemail_ai_feature_failed",
  "wemail_agent_action_decided",
  "wemail_automation_action_completed",
  "wemail_settings_changed",
  "wemail_telemetry_enabled",
  "wemail_telemetry_disabled",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];
export type TelemetryArgValue = string | number | boolean;
export type TelemetryArgs = Record<string, TelemetryArgValue | undefined>;

export interface TelemetryEventArgsMap {
  [event: string]: TelemetryArgs;
}

export interface TelemetrySink {
  track<K extends TelemetryEventName>(
    event: K,
    args?: TelemetryEventArgsMap[K],
  ): void;
}

export interface TelemetryEnvelope {
  event: TelemetryEventName;
  timestamp: string;
  username: string;
  install_id: string;
  argv: string[];
  entry_mode: "desktop-electron";
  platform: string;
  arch: string;
  node_version: string;
  app_version: string;
}

const EVENT_SET = new Set<string>(TELEMETRY_EVENT_NAMES);
const ARG_KEY_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
const ARG_STRING_PATTERN = /^[a-zA-Z0-9_.:-]{1,96}$/;
const SENSITIVE_VALUE_PATTERNS = [
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i,
  /https?:\/\//i,
  /(?:[a-z]:\\|\\\\|\/(?:home|users?|tmp|var)\/)/i,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
];

export const TELEMETRY_ARG_KEYS = new Set([
  "source",
  "duration_bucket",
  "usage_duration_bucket",
  "last_phase",
  "uptime_bucket",
  "stage",
  "error_class",
  "reason",
  "stack_fingerprint",
  "provider_family",
  "origin",
  "inserted_count_bucket",
  "updated_count_bucket",
  "disposition",
  "changed",
  "surface",
  "action",
  "scope",
  "filter_count_bucket",
  "result_count_bucket",
  "compose_mode",
  "has_attachment",
  "recipient_count_bucket",
  "feature",
  "initiator",
  "action_family",
  "decision",
  "risk_level",
  "result",
  "matched_count_bucket",
  "applied_count_bucket",
  "setting",
  "enabled",
]);

export function isTelemetryEventName(value: unknown): value is TelemetryEventName {
  return typeof value === "string" && EVENT_SET.has(value);
}

export function validateTelemetryArgs(args: unknown): args is TelemetryArgs {
  if (args === undefined) return true;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length > 16) return false;
  return entries.every(([key, value]) => {
    if (!ARG_KEY_PATTERN.test(key) || !TELEMETRY_ARG_KEYS.has(key)) return false;
    if (value === undefined) return true;
    if (typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 1_000_000;
    if (typeof value !== "string" || !ARG_STRING_PATTERN.test(value)) return false;
    return !SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  });
}

export function telemetryArgsToArgv(args: TelemetryArgs = {}): string[] {
  if (!validateTelemetryArgs(args)) return [];
  return Object.entries(args)
    .filter((entry): entry is [string, TelemetryArgValue] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`);
}

export function parseTelemetryArgv(argv: unknown): Record<string, string> | null {
  if (!Array.isArray(argv) || argv.length > 16) return null;
  const parsed: Record<string, string> = {};
  for (const item of argv) {
    if (typeof item !== "string" || item.length > 148) return null;
    const separator = item.indexOf("=");
    if (separator <= 0) return null;
    const key = item.slice(0, separator);
    const value = item.slice(separator + 1);
    if (!TELEMETRY_ARG_KEYS.has(key) || !ARG_KEY_PATTERN.test(key)) return null;
    if (!ARG_STRING_PATTERN.test(value)) return null;
    if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) return null;
    parsed[key] = value;
  }
  return parsed;
}

export function durationBucket(durationMs: number): string {
  if (durationMs < 100) return "lt_100ms";
  if (durationMs < 500) return "100_500ms";
  if (durationMs < 1_000) return "500ms_1s";
  if (durationMs < 3_000) return "1s_3s";
  if (durationMs < 10_000) return "3s_10s";
  if (durationMs < 30_000) return "10s_30s";
  return "gte_30s";
}

export function countBucket(count: number): string {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2_5";
  if (count <= 20) return "6_20";
  if (count <= 100) return "21_100";
  return "gte_101";
}

export function normalizeTelemetryErrorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return ARG_STRING_PATTERN.test(name) ? name.slice(0, 96) : "other";
}
