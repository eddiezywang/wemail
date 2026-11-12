import type {
  WemailMcpOperationState,
  WemailMcpOperationType,
} from "../../../shared/wemail/mcp.js";
import type { MailDatabase } from "../database/Database.js";

interface PreparedOperationRow {
  id: string;
  account_id: string;
  token_id: string | null;
  session_hash: string | null;
  operation_type: WemailMcpOperationType;
  risk: "high";
  payload_json: string;
  payload_hash: string;
  preview: string;
  state: WemailMcpOperationState;
  expires_at: string;
  approved_at: string | null;
  approval_event_id: string | null;
  result_code: string | null;
  result_summary_json: string | null;
  created_at: string;
  updated_at: string;
}
export interface McpPreparedOperationRecord {
  id: string;
  accountId: string;
  tokenId?: string;
  sessionHash?: string;
  operationType: WemailMcpOperationType;
  risk: "high";
  payload: Record<string, unknown>;
  payloadHash: string;
  preview: string;
  state: WemailMcpOperationState;
  expiresAt: string;
  approvedAt?: string;
  approvalEventId?: string;
  resultCode?: string;
  resultSummary?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMcpPreparedOperationInput {
  id: string;
  accountId: string;
  tokenId?: string;
  sessionHash?: string;
  operationType: WemailMcpOperationType;
  payload: Record<string, unknown>;
  payloadHash: string;
  preview: string;
  expiresAt: string;
  state?: "prepared" | "awaiting_confirmation" | "approved";
}

function parseObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function toRecord(row: PreparedOperationRow): McpPreparedOperationRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    ...(row.token_id ? { tokenId: row.token_id } : {}),
    ...(row.session_hash ? { sessionHash: row.session_hash } : {}),
    operationType: row.operation_type,
    risk: row.risk,
    payload: parseObject(row.payload_json) ?? {},
    payloadHash: row.payload_hash,
    preview: row.preview,
    state: row.state,
    expiresAt: row.expires_at,
    ...(row.approved_at ? { approvedAt: row.approved_at } : {}),
    ...(row.approval_event_id ? { approvalEventId: row.approval_event_id } : {}),
    ...(row.result_code ? { resultCode: row.result_code } : {}),
    ...(parseObject(row.result_summary_json)
      ? { resultSummary: parseObject(row.result_summary_json) }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class McpPreparedOperationRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: CreateMcpPreparedOperationInput): McpPreparedOperationRecord {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO mcp_prepared_operations (
           id, account_id, token_id, session_hash, operation_type, risk,
           payload_json, payload_hash, preview, state, expires_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'high', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.accountId,
        input.tokenId ?? null,
        input.sessionHash ?? null,
        input.operationType,
        JSON.stringify(input.payload),
        input.payloadHash,
        input.preview,
        input.state ?? "awaiting_confirmation",
        input.expiresAt,
        now,
        now,
      );
    return this.get(input.id)!;
  }

  get(id: string): McpPreparedOperationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM mcp_prepared_operations WHERE id = ?")
      .get(id) as PreparedOperationRow | undefined;
    return row ? toRecord(row) : null;
  }

  getOwned(id: string, accountId: string): McpPreparedOperationRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM mcp_prepared_operations WHERE id = ? AND account_id = ?",
      )
      .get(id, accountId) as PreparedOperationRow | undefined;
    return row ? toRecord(row) : null;
  }

  approve(input: {
    id: string;
    accountId: string;
    payloadHash: string;
    approvalEventId: string;
  }): McpPreparedOperationRecord {
    const row = this.getOwned(input.id, input.accountId);
    if (!row) throw new Error("operation-not-found");
    const now = this.now();
    if (Date.parse(row.expiresAt) <= now.getTime()) {
      this.transition(row.id, "expired");
      throw new Error("operation-expired");
    }
    if (row.payloadHash !== input.payloadHash) throw new Error("operation-payload-mismatch");
    if (!new Set<WemailMcpOperationState>(["prepared", "awaiting_confirmation"]).has(row.state)) {
      throw new Error("operation-not-awaiting-confirmation");
    }
    const at = now.toISOString();
    this.db
      .prepare(
        `UPDATE mcp_prepared_operations
            SET state = 'approved', approved_at = ?, approval_event_id = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(at, input.approvalEventId, at, input.id);
    return this.get(input.id)!;
  }

  cancel(id: string, accountId: string): McpPreparedOperationRecord {
    const row = this.getOwned(id, accountId);
    if (!row) throw new Error("operation-not-found");
    if (!new Set<WemailMcpOperationState>(["prepared", "awaiting_confirmation", "approved"]).has(row.state)) {
      throw new Error("operation-not-cancellable");
    }
    return this.transition(id, "cancelled");
  }

  transition(
    id: string,
    state: WemailMcpOperationState,
    result?: { code?: string; summary?: Record<string, unknown> },
  ): McpPreparedOperationRecord {
    const at = this.now().toISOString();
    const changed = this.db
      .prepare(
        `UPDATE mcp_prepared_operations
            SET state = ?, result_code = ?, result_summary_json = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        state,
        result?.code ?? null,
        result?.summary ? JSON.stringify(result.summary) : null,
        at,
        id,
      );
    if (changed.changes === 0) throw new Error("operation-not-found");
    return this.get(id)!;
  }

  expireDue(): number {
    const at = this.now().toISOString();
    return this.db
      .prepare(
        `UPDATE mcp_prepared_operations
            SET state = 'expired', updated_at = ?
          WHERE expires_at <= ?
            AND state IN ('prepared', 'awaiting_confirmation', 'approved')`,
      )
      .run(at, at).changes;
  }

  listPending(accountId: string, limit = 100): McpPreparedOperationRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM mcp_prepared_operations
            WHERE account_id = ?
              AND state IN ('prepared', 'awaiting_confirmation', 'approved', 'committing')
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .all(accountId, Math.max(1, Math.min(100, Math.floor(limit)))) as PreparedOperationRow[]
    ).map(toRecord);
  }

  listRecent(accountId: string, limit = 20): McpPreparedOperationRecord[] {
    return (
      this.db.prepare(
        `SELECT * FROM mcp_prepared_operations
          WHERE account_id = ? ORDER BY updated_at DESC LIMIT ?`,
      ).all(accountId, Math.max(1, Math.min(100, Math.floor(limit)))) as PreparedOperationRow[]
    ).map(toRecord);
  }

  deleteTerminalBefore(isoTimestamp: string): number {
    return this.db.prepare(
      `DELETE FROM mcp_prepared_operations
        WHERE updated_at < ?
          AND state IN ('succeeded', 'failed_retryable', 'cancelled', 'expired', 'outcome_unknown')`,
    ).run(isoTimestamp).changes;
  }
}
