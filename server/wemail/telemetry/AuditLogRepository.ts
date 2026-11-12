/**
 * Append-only audit log for wecli invocations (Handoff §2, §5.I).
 *
 * - Every wecli invocation MUST produce one row here, regardless of
 *   whether it was auto-approved, confirmed, refused, or errored.
 * - Rows are never updated. Retention pruning (Package H) calls
 *   {@link AuditLogRepository.deleteOlderThan} — it is the only
 *   write path other than {@link AuditLogRepository.record}.
 * - Stdout/stderr are persisted to the DB (size-capped) but MUST
 *   NOT be echoed to application logs by callers. Application
 *   logs carry `{command, kind, exitCode, durationMs}` only.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  WecliAuditEntry,
  WecliCommandClassification,
} from "../../../shared/wemail/wecliTypes.js";

const WECLI_AUDIT_LOGS_TABLE = "wecli_audit_logs";

/** Maximum bytes of stdout/stderr kept per audit row. */
export const AUDIT_STREAM_CAP_BYTES = 64 * 1024;

export interface AuditLogInput {
  /** Opaque identifier (user/session id). Never a password/secret. */
  approvedBy?: string;
  command: string;
  args: string[];
  classification: WecliCommandClassification;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  /** Optional override for the `invoked_at` / `created_at` timestamp. */
  invokedAt?: string;
}

export interface AuditListOptions {
  limit?: number;
  /** ISO-8601 lower bound (inclusive). */
  since?: string;
}

interface AuditRow {
  id: string;
  command: string;
  args_json: string;
  approval_status: string;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  duration_ms: number | null;
  created_at: string;
}

function truncate(value: string | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.length <= AUDIT_STREAM_CAP_BYTES) return value;
  return `${value.slice(0, AUDIT_STREAM_CAP_BYTES)}…[truncated]`;
}

function rowToEntry(row: AuditRow): WecliAuditEntry {
  // `approval_status` persists the full classification as JSON so we
  // round-trip `kind`, `subcommand`, and `reason` faithfully. Legacy
  // rows (from the empty phase-zero scaffold) stored just the kind
  // string; we degrade gracefully if parsing fails.
  let classification: WecliCommandClassification;
  try {
    const parsed = JSON.parse(row.approval_status) as WecliCommandClassification;
    classification = {
      kind: parsed.kind,
      command: parsed.command ?? "wecli",
      subcommand: parsed.subcommand ?? "",
      reason: parsed.reason ?? "",
    };
  } catch {
    classification = {
      kind:
        row.approval_status === "auto-approved"
          ? "auto-approved"
          : "requires-confirmation",
      command: "wecli",
      subcommand: "",
      reason: row.approval_status,
    };
  }

  const args = JSON.parse(row.args_json) as string[];
  return {
    id: row.id,
    invokedAt: row.created_at,
    command: row.command,
    args,
    classification,
    stdout: row.stdout ?? undefined,
    stderr: row.stderr ?? undefined,
    exitCode: row.exit_code ?? undefined,
    durationMs: row.duration_ms ?? 0,
  };
}

export class AuditLogRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Insert one audit row. Returns the persisted {@link WecliAuditEntry}.
   */
  record(input: AuditLogInput): WecliAuditEntry {
    const id = randomUUID();
    const invokedAt = input.invokedAt ?? this.now().toISOString();
    const argsJson = JSON.stringify(input.args ?? []);
    const approvalStatus = JSON.stringify(input.classification);

    const stmt = this.db.prepare(
      `INSERT INTO ${WECLI_AUDIT_LOGS_TABLE}
       (id, command, args_json, approval_status, exit_code, stdout, stderr, duration_ms, created_at)
       VALUES (@id, @command, @args_json, @approval_status, @exit_code, @stdout, @stderr, @duration_ms, @created_at)`,
    );

    stmt.run({
      id,
      command: input.command,
      args_json: argsJson,
      approval_status: approvalStatus,
      exit_code: input.exitCode ?? null,
      stdout: truncate(input.stdout),
      stderr: truncate(input.stderr),
      duration_ms: input.durationMs,
      created_at: invokedAt,
    });

    return {
      id,
      invokedAt,
      command: input.command,
      args: input.args,
      classification: input.classification,
      stdout: truncate(input.stdout) ?? undefined,
      stderr: truncate(input.stderr) ?? undefined,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
    };
  }

  /** List audit rows newest-first. */
  list(options: AuditListOptions = {}): WecliAuditEntry[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const since = options.since;

    const rows = since
      ? (this.db
          .prepare(
            `SELECT * FROM ${WECLI_AUDIT_LOGS_TABLE}
             WHERE created_at >= ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(since, limit) as AuditRow[])
      : (this.db
          .prepare(
            `SELECT * FROM ${WECLI_AUDIT_LOGS_TABLE}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(limit) as AuditRow[]);

    return rows.map(rowToEntry);
  }

  /**
   * Retention hook for Package H. Returns the number of deleted rows.
   */
  deleteOlderThan(cutoffISO: string): number {
    const info = this.db
      .prepare(
        `DELETE FROM ${WECLI_AUDIT_LOGS_TABLE} WHERE created_at < ?`,
      )
      .run(cutoffISO);
    return info.changes ?? 0;
  }
}
