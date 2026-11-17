import type { WemailMcpToolRisk } from "../../../shared/wemail/mcp.js";
import type { MailDatabase } from "../database/Database.js";

export interface McpAuditEventInput {
  occurredAt?: string;
  tokenFingerprint?: string;
  sessionHash?: string;
  toolName: string;
  accountId?: string;
  riskClass: WemailMcpToolRisk;
  argumentShape: Record<string, unknown>;
  durationMs: number;
  outcomeCode: string;
  responseBytes?: number;
  operationId?: string;
  idempotencyKeyHash?: string;
}
export interface McpAuditEventRecord extends McpAuditEventInput {
  id: number;
  occurredAt: string;
  responseBytes: number;
}

interface AuditRow {
  id: number;
  occurred_at: string;
  token_fingerprint: string | null;
  session_hash: string | null;
  tool_name: string;
  account_id: string | null;
  risk_class: WemailMcpToolRisk;
  argument_shape_json: string;
  duration_ms: number;
  outcome_code: string;
  response_bytes: number;
  operation_id: string | null;
  idempotency_key_hash: string | null;
}

function toRecord(row: AuditRow): McpAuditEventRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    ...(row.token_fingerprint ? { tokenFingerprint: row.token_fingerprint } : {}),
    ...(row.session_hash ? { sessionHash: row.session_hash } : {}),
    toolName: row.tool_name,
    ...(row.account_id ? { accountId: row.account_id } : {}),
    riskClass: row.risk_class,
    argumentShape: JSON.parse(row.argument_shape_json) as Record<string, unknown>,
    durationMs: row.duration_ms,
    outcomeCode: row.outcome_code,
    responseBytes: row.response_bytes,
    ...(row.operation_id ? { operationId: row.operation_id } : {}),
    ...(row.idempotency_key_hash
      ? { idempotencyKeyHash: row.idempotency_key_hash }
      : {}),
  };
}

export class McpAuditRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(input: McpAuditEventInput): McpAuditEventRecord {
    const result = this.db
      .prepare(
        `INSERT INTO mcp_audit_events (
           occurred_at, token_fingerprint, session_hash, tool_name,
           account_id, risk_class, argument_shape_json, duration_ms,
           outcome_code, response_bytes, operation_id, idempotency_key_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.occurredAt ?? this.now().toISOString(),
        input.tokenFingerprint ?? null,
        input.sessionHash ?? null,
        input.toolName,
        input.accountId ?? null,
        input.riskClass,
        JSON.stringify(input.argumentShape),
        Math.max(0, Math.floor(input.durationMs)),
        input.outcomeCode,
        Math.max(0, Math.floor(input.responseBytes ?? 0)),
        input.operationId ?? null,
        input.idempotencyKeyHash ?? null,
      );
    return this.get(Number(result.lastInsertRowid))!;
  }

  get(id: number): McpAuditEventRecord | null {
    const row = this.db
      .prepare("SELECT * FROM mcp_audit_events WHERE id = ?")
      .get(id) as AuditRow | undefined;
    return row ? toRecord(row) : null;
  }

  listRecent(limit = 100): McpAuditEventRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM mcp_audit_events ORDER BY occurred_at DESC LIMIT ?")
        .all(Math.max(1, Math.min(1000, Math.floor(limit)))) as AuditRow[]
    ).map(toRecord);
  }

  deleteBefore(isoTimestamp: string): number {
    return this.db
      .prepare("DELETE FROM mcp_audit_events WHERE occurred_at < ?")
      .run(isoTimestamp).changes;
  }
}
