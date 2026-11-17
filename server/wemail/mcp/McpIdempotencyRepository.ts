import type { MailDatabase } from "../database/Database.js";

export type McpDispatchState =
  | "reserved"
  | "dispatching"
  | "succeeded"
  | "failed_retryable"
  | "outcome_unknown";

interface IdempotencyRow {
  id: number;
  account_id: string;
  operation_id: string;
  key_hash: string;
  payload_hash: string;
  dispatch_state: McpDispatchState;
  result_code: string | null;
  result_summary_json: string | null;
  created_at: string;
  updated_at: string;
}
export interface McpIdempotencyRecord {
  id: number;
  accountId: string;
  operationId: string;
  keyHash: string;
  payloadHash: string;
  dispatchState: McpDispatchState;
  resultCode?: string;
  resultSummary?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type McpReservationResult =
  | { status: "created"; reservation: McpIdempotencyRecord }
  | { status: "existing"; reservation: McpIdempotencyRecord }
  | { status: "conflict"; reservation: McpIdempotencyRecord };

function parseSummary(value: string | null): Record<string, unknown> | undefined {
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

function toRecord(row: IdempotencyRow): McpIdempotencyRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    operationId: row.operation_id,
    keyHash: row.key_hash,
    payloadHash: row.payload_hash,
    dispatchState: row.dispatch_state,
    ...(row.result_code ? { resultCode: row.result_code } : {}),
    ...(parseSummary(row.result_summary_json)
      ? { resultSummary: parseSummary(row.result_summary_json) }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class McpIdempotencyRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  reserve(input: {
    accountId: string;
    operationId: string;
    keyHash: string;
    payloadHash: string;
  }): McpReservationResult {
    const reserve = this.db.transaction((): McpReservationResult => {
      const existing = this.db
        .prepare(
          "SELECT * FROM mcp_idempotency_reservations WHERE account_id = ? AND key_hash = ?",
        )
        .get(input.accountId, input.keyHash) as IdempotencyRow | undefined;
      if (existing) {
        const reservation = toRecord(existing);
        return existing.operation_id === input.operationId &&
          existing.payload_hash === input.payloadHash
          ? { status: "existing", reservation }
          : { status: "conflict", reservation };
      }
      const at = this.now().toISOString();
      const result = this.db
        .prepare(
          `INSERT INTO mcp_idempotency_reservations (
             account_id, operation_id, key_hash, payload_hash,
             dispatch_state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'reserved', ?, ?)`,
        )
        .run(
          input.accountId,
          input.operationId,
          input.keyHash,
          input.payloadHash,
          at,
          at,
        );
      const row = this.db
        .prepare("SELECT * FROM mcp_idempotency_reservations WHERE id = ?")
        .get(Number(result.lastInsertRowid)) as IdempotencyRow;
      return { status: "created", reservation: toRecord(row) };
    });
    return reserve();
  }

  get(accountId: string, keyHash: string): McpIdempotencyRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM mcp_idempotency_reservations WHERE account_id = ? AND key_hash = ?",
      )
      .get(accountId, keyHash) as IdempotencyRow | undefined;
    return row ? toRecord(row) : null;
  }

  setState(
    id: number,
    state: McpDispatchState,
    result?: { code?: string; summary?: Record<string, unknown> },
  ): McpIdempotencyRecord {
    const at = this.now().toISOString();
    const changed = this.db
      .prepare(
        `UPDATE mcp_idempotency_reservations
            SET dispatch_state = ?, result_code = ?, result_summary_json = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        state,
        result?.code ?? null,
        result?.summary ? JSON.stringify(result.summary) : null,
        at,
        id,
      );
    if (changed.changes === 0) throw new Error("idempotency-reservation-not-found");
    const row = this.db
      .prepare("SELECT * FROM mcp_idempotency_reservations WHERE id = ?")
      .get(id) as IdempotencyRow;
    return toRecord(row);
  }

  reconcileStartup(): { safeToRetry: number; outcomeUnknown: number } {
    return this.db.transaction(() => {
      const at = this.now().toISOString();
      const reservations = this.db.prepare(
        `UPDATE mcp_idempotency_reservations
            SET dispatch_state = 'outcome_unknown', result_code = 'outcome_unknown', updated_at = ?
          WHERE dispatch_state = 'dispatching'`,
      ).run(at);
      const unknown = this.db.prepare(
        `UPDATE mcp_prepared_operations
            SET state = 'outcome_unknown', result_code = 'outcome_unknown', updated_at = ?
          WHERE state = 'committing'
            AND EXISTS (
              SELECT 1 FROM mcp_idempotency_reservations r
               WHERE r.operation_id = mcp_prepared_operations.id
                 AND r.dispatch_state = 'outcome_unknown'
            )`,
      ).run(at);
      const retry = this.db.prepare(
        `UPDATE mcp_prepared_operations
            SET state = 'approved', updated_at = ?
          WHERE state = 'committing'
            AND EXISTS (
              SELECT 1 FROM mcp_idempotency_reservations r
               WHERE r.operation_id = mcp_prepared_operations.id
                 AND r.dispatch_state = 'reserved'
            )`,
      ).run(at);
      return {
        safeToRetry: retry.changes,
        outcomeUnknown: Math.max(reservations.changes, unknown.changes),
      };
    })();
  }
}
