import { createHash, randomUUID } from "node:crypto";
import type { MailDatabase } from "../database/Database.js";
import type {
  AgentActionRiskLevel,
  AgentPendingAction,
  HighRiskActionType,
} from "../../../shared/wemail/intelligence.js";
import type { AutomationOwner } from "../../../shared/wemail/automationCenter.js";
import { publicActionExecution, type AgentActionExecutionResult } from "./AgentActionExecutor.js";

export interface AgentPendingActionRow {
  id: string;
  conversation_id: string | null;
  action_type: string;
  description: string;
  email_id: string | null;
  input_json: string;
  risk_reason: string;
  status: "pending" | "confirmed" | "rejected" | "expired";
  created_at: string;
  resolved_at: string | null;
  /**
   * Coarse risk classification persisted alongside the action so the
   * UI can color-code without re-deriving from `action_type`. Nullable
   * for legacy rows written before migration #30; readers fall back to
   * `deriveRiskLevel(action_type)` via {@link rowToAction}.
   */
  risk_level: string | null;
  account_id?: string | null;
  owner_type?: "account" | "local_profile";
  owner_profile_id?: string | null;
  mcp_operation_id?: string | null;
  expires_at?: string | null;
  idempotency_key?: string | null;
  parameter_hash?: string | null;
  displayed_parameters_json?: string | null;
  execution_state?: "not_started" | "executing" | "succeeded" | "failed" | "outcome_unknown";
  execution_result_json?: string | null;
  execution_started_at?: string | null;
  execution_completed_at?: string | null;
}

export interface AgentPendingActionRepositoryOptions {
  db: MailDatabase;
  now?: () => string;
}

/**
 * Default mapping from `HighRiskActionType` to a coarse
 * {@link AgentActionRiskLevel}. Used both as the persisted-row
 * fall-back when `risk_level IS NULL` and as a default callers can
 * apply when proposing new actions.
 *
 * - `send` / `delete` / `mark_spam` / `run_wecli_command` → `"high"`
 * - `move` / `archive` / `unsubscribe` / `run_automation` → `"medium"`
 * - any unknown action type → `"low"`
 */
export function deriveRiskLevel(
  actionType: HighRiskActionType | string,
): AgentActionRiskLevel {
  switch (actionType) {
    case "send":
    case "delete":
    case "mark_spam":
    case "permanent_delete":
    case "delete_draft":
    case "bulk_mail_operation":
      return "high";
    case "move":
    case "archive":
    case "unsubscribe":
    case "run_automation":
    case "upload_allowance_invoices":
    case "delete_allowance_invoices":
    case "configure_smart_tag":
    case "configure_automation_rule":
    case "configure_writing_style":
    case "schedule_send":
    case "cancel_scheduled_send":
    case "configure_business_preferences":
      return "medium";
    case "run_wecli_command":
    case "install_wecli":
      return "high";
    default:
      return "low";
  }
}

function isRiskLevel(value: unknown): value is AgentActionRiskLevel {
  return value === "low" || value === "medium" || value === "high";
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function hashAgentActionParameters(parameters: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(parameters)).digest("hex");
}

export function createPendingActionAuthorization(
  id: string,
  parameters: Record<string, unknown>,
  now = new Date(),
): Required<Pick<AgentPendingAction, "parameters" | "idempotencyKey" | "expiresAt">> {
  return {
    parameters,
    idempotencyKey: `agent-action:${id}:${randomUUID()}`,
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
  };
}

/**
 * Map a raw repository row to the public `AgentPendingAction` shape
 * exposed on the API. Always populates `riskLevel` (falling back to a
 * derivation from `action_type` for legacy rows where the column is
 * NULL or contains an unexpected value).
 *
 * Note: the DB row does not currently carry a `tool_name` column, so
 * we default to `"propose_action"` — that is the only tool that
 * persists pending actions today (see `MailAgentTools.proposeAction`).
 */
export function rowToAction(row: AgentPendingActionRow): AgentPendingAction {
  const riskLevel = isRiskLevel(row.risk_level)
    ? row.risk_level
    : deriveRiskLevel(row.action_type);
  const execution = row.execution_result_json ? parseObject(row.execution_result_json) : undefined;
  const safeExecution = execution && typeof execution.ok === "boolean" && typeof execution.summary === "string"
    ? { ...publicActionExecution({ ...execution, items: Array.isArray(execution.items)
      ? execution.items.filter((item) => item && typeof item === "object" && typeof item.ok === "boolean")
      : undefined } as unknown as AgentActionExecutionResult) }
    : execution?.ok === false
      ? { ok: false, error: "操作未完成，请检查操作状态。", ...(execution.task ? { task: execution.task } : {}) }
      : execution;
  return {
    id: row.id,
    conversationId: row.conversation_id ?? undefined,
    emailId: row.email_id ?? undefined,
    actionType: row.action_type as HighRiskActionType,
    description: row.description,
    toolName: "propose_action",
    inputJson: row.input_json,
    riskReason: row.risk_reason,
    riskLevel,
    parameters: parseObject(row.displayed_parameters_json ?? row.input_json),
    idempotencyKey: row.idempotency_key ?? `legacy:${row.id}`,
    expiresAt: row.expires_at ?? row.created_at,
    status: row.status,
    executionState: row.execution_state ?? "not_started",
    ...(safeExecution
      ? { executionResult: safeExecution }
      : {}),
    ...(row.mcp_operation_id ? { origin: "mcp" as const, operationId: row.mcp_operation_id } : {}),
  };
}

export class AgentPendingActionRepository {
  private readonly db: MailDatabase;
  private readonly now: () => string;

  constructor(options: AgentPendingActionRepositoryOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  insert(action: {
    id: string;
    conversationId?: string;
    actionType: string;
    description: string;
    inputJson: string;
    riskReason: string;
    emailId?: string;
    /**
     * Optional coarse risk level. When omitted the column is left
     * NULL; readers (e.g. {@link rowToAction}) will fall back to
     * `deriveRiskLevel(actionType)` so the API never emits null.
     */
    riskLevel?: AgentActionRiskLevel;
    accountId?: string;
    owner?: AutomationOwner;
    mcpOperationId?: string;
    expiresAt?: string;
    idempotencyKey?: string;
    parameters?: Record<string, unknown>;
  }): void {
    const parameters = action.parameters ?? parseObject(action.inputJson);
    const displayedParametersJson = canonicalize(parameters);
    const createdAt = this.now();
    const expiresAt = action.expiresAt ?? new Date(
      Date.parse(createdAt) + 15 * 60_000,
    ).toISOString();
    this.db.prepare(
      `INSERT INTO agent_pending_actions (
         id, conversation_id, action_type, description, email_id, input_json,
         risk_reason, status, created_at, risk_level, account_id, mcp_operation_id,
         owner_type, owner_profile_id, expires_at, idempotency_key,
         parameter_hash, displayed_parameters_json, execution_state
       ) VALUES (
         @id, @conversationId, @actionType, @description, @emailId, @inputJson,
         @riskReason, 'pending', @createdAt, @riskLevel, @accountId, @mcpOperationId,
         @ownerType, @ownerProfileId, @expiresAt, @idempotencyKey,
         @parameterHash, @displayedParametersJson, 'not_started'
       )`
    ).run({
      id: action.id,
      conversationId: action.conversationId ?? null,
      actionType: action.actionType,
      description: action.description,
      emailId: action.emailId ?? null,
      inputJson: action.inputJson,
      riskReason: action.riskReason,
      createdAt,
      riskLevel: action.riskLevel ?? null,
      accountId: action.accountId ?? null,
      mcpOperationId: action.mcpOperationId ?? null,
      ownerType: action.owner?.type === "localProfile" ? "local_profile" : "account",
      ownerProfileId:
        action.owner?.type === "localProfile" ? action.owner.profileId : null,
      expiresAt,
      idempotencyKey: action.idempotencyKey ?? `agent-action:${action.id}:${randomUUID()}`,
      parameterHash: hashAgentActionParameters(parameters),
      displayedParametersJson,
    });
  }

  resolve(id: string, status: "confirmed" | "rejected" | "expired"): void {
    this.db.prepare(
      `UPDATE agent_pending_actions SET status = @status, resolved_at = @resolvedAt WHERE id = @id`
    ).run({ id, status, resolvedAt: this.now() });
  }

  reserveExecution(input: {
    id: string;
    idempotencyKey: string;
    parameters: Record<string, unknown>;
  }):
    | { kind: "reserved"; row: AgentPendingActionRow }
    | { kind: "duplicate"; row: AgentPendingActionRow }
    | { kind: "not_found" | "expired" | "parameter_mismatch" | "idempotency_mismatch" | "not_pending" } {
    return this.db.transaction(() => {
      const row = this.getById(input.id);
      if (!row) return { kind: "not_found" as const };
      const expectedHash = row.parameter_hash ?? hashAgentActionParameters(
        parseObject(row.displayed_parameters_json ?? row.input_json),
      );
      if (hashAgentActionParameters(input.parameters) !== expectedHash) {
        return { kind: "parameter_mismatch" as const };
      }
      if ((row.idempotency_key ?? `legacy:${row.id}`) !== input.idempotencyKey) {
        return { kind: "idempotency_mismatch" as const };
      }
      const executionState = row.execution_state ?? "not_started";
      const nonRetryable = executionState !== "not_started";
      if (row.status === "confirmed" || nonRetryable) {
        return { kind: "duplicate" as const, row };
      }
      if (row.status !== "pending") return { kind: "not_pending" as const };
      if (!row.expires_at || Date.parse(row.expires_at) <= Date.parse(this.now())) {
        this.resolve(row.id, "expired");
        return { kind: "expired" as const };
      }
      this.db.prepare(
        `UPDATE agent_pending_actions
            SET execution_state = 'executing', execution_started_at = @startedAt
          WHERE id = @id AND status = 'pending'
            AND (execution_state = 'not_started' OR execution_state IS NULL)`,
      ).run({ id: row.id, startedAt: this.now() });
      return { kind: "reserved" as const, row: this.getById(row.id)! };
    })();
  }

  completeExecution(
    id: string,
    outcome: "succeeded" | "failed" | "outcome_unknown",
    result: Record<string, unknown>,
  ): void {
    const completedAt = this.now();
    this.db.prepare(
      `UPDATE agent_pending_actions
          SET status = 'confirmed', resolved_at = COALESCE(resolved_at, @completedAt),
              execution_state = @outcome, execution_result_json = @resultJson,
              execution_completed_at = @completedAt
        WHERE id = @id`,
    ).run({ id, outcome, resultJson: JSON.stringify(result), completedAt });
  }

  getPending(conversationId?: string): AgentPendingActionRow[] {
    const rows = conversationId
      ? this.db.prepare(`SELECT * FROM agent_pending_actions
          WHERE conversation_id = @conversationId AND status = 'pending' ORDER BY created_at DESC`)
        .all({ conversationId })
      : this.db.prepare(`SELECT * FROM agent_pending_actions
          WHERE status = 'pending' ORDER BY created_at DESC`).all();
    return (rows as AgentPendingActionRow[]).map((row) => this.readState(row))
      .filter((row) => row.status === "pending");
  }

  private readState(row: AgentPendingActionRow): AgentPendingActionRow {
    const now = this.now();
    if (row.execution_state === "executing" && parseObject(row.execution_result_json ?? null).task) return row;
    if ((row.status === "pending" || row.status === "expired") &&
      (row.execution_state === "failed" || row.execution_state === "outcome_unknown")) {
      return { ...row, status: "confirmed", resolved_at: row.resolved_at ?? row.execution_completed_at ?? now };
    }
    if (row.status === "pending" && row.expires_at && row.expires_at <= now) {
      return { ...row, status: "expired", resolved_at: now };
    }
    return row;
  }

  getConfirmed(conversationId: string): AgentPendingActionRow[] {
    return this.db.prepare(
      `SELECT * FROM agent_pending_actions WHERE conversation_id = @conversationId AND status = 'confirmed' ORDER BY resolved_at DESC, created_at DESC`,
    ).all({ conversationId }) as AgentPendingActionRow[];
  }

  getConversationHistory(conversationId: string): AgentPendingActionRow[] {
    return (this.db.prepare(
      `SELECT * FROM agent_pending_actions
        WHERE conversation_id = @conversationId
        ORDER BY created_at ASC`,
    ).all({ conversationId }) as AgentPendingActionRow[]).map((row) => this.readState(row));
  }

  listForAccount(accountId: string, conversationId?: string): AgentPendingAction[] {
    if (conversationId) {
      if (this.getAccountIdForConversation(conversationId) !== accountId) return [];
      return this.getConversationHistory(conversationId).map(rowToAction);
    }
    return this.getPendingByAccount(accountId).map(rowToAction);
  }

  /**
   * Return pending actions whose conversation belongs to the given
   * account. Pending actions without a conversation_id are intentionally
   * excluded — they are shapeable into ambient global state only when an
   * account claim is established.
   */
  getPendingByAccount(accountId: string): AgentPendingActionRow[] {
    return (this.db.prepare(
      `SELECT pa.*
         FROM agent_pending_actions pa
         LEFT JOIN agent_conversations c ON c.id = pa.conversation_id
        WHERE (
          (pa.owner_type = 'account' AND COALESCE(pa.account_id, c.account_id) = @accountId)
          OR (pa.owner_type = 'local_profile' AND pa.owner_profile_id = 'default')
        ) AND pa.status = 'pending'
        ORDER BY pa.created_at DESC`,
    ).all({ accountId }) as AgentPendingActionRow[]).map((row) => this.readState(row))
      .filter((row) => row.status === "pending");
  }

  /**
   * Return the account_id associated with the action. Conversation ownership
   * wins; actions created outside a conversation fall back to email ownership.
   * Returns null when:
   *   - the action does not exist,
   *   - no conversation/email owner can be established, or
   *   - the referenced conversation/email row was deleted (orphan).
   */
  getAccountIdFor(actionId: string): string | null {
    const row = this.db.prepare(
      `SELECT COALESCE(pa.account_id, c.account_id, a.public_id) AS account_id
         FROM agent_pending_actions pa
         LEFT JOIN agent_conversations c ON c.id = pa.conversation_id
         LEFT JOIN mail_messages m ON m.public_id = pa.email_id
         LEFT JOIN mail_accounts a ON a.id = m.account_id
        WHERE pa.id = @actionId`,
    ).get({ actionId }) as { account_id: string | null } | undefined;
    if (!row) return null;
    return row.account_id ?? null;
  }

  getOwnerFor(actionId: string): AutomationOwner | null {
    const row = this.db.prepare(
      `SELECT pa.owner_type, pa.owner_profile_id,
              COALESCE(pa.account_id, c.account_id, a.public_id) AS account_id
         FROM agent_pending_actions pa
         LEFT JOIN agent_conversations c ON c.id = pa.conversation_id
         LEFT JOIN mail_messages m ON m.public_id = pa.email_id
         LEFT JOIN mail_accounts a ON a.id = m.account_id
        WHERE pa.id = @actionId`,
    ).get({ actionId }) as {
      owner_type: "account" | "local_profile";
      owner_profile_id: string | null;
      account_id: string | null;
    } | undefined;
    if (!row) return null;
    if (row.owner_type === "local_profile") {
      return row.owner_profile_id === "default"
        ? { type: "localProfile", profileId: "default" }
        : null;
    }
    return row.account_id
      ? { type: "account", accountId: row.account_id }
      : null;
  }

  getAccountIdForConversation(conversationId: string): string | null {
    const row = this.db.prepare(
      `SELECT account_id
         FROM agent_conversations
        WHERE id = @conversationId`,
    ).get({ conversationId }) as { account_id: string | null } | undefined;
    return row?.account_id ?? null;
  }

  getById(id: string): AgentPendingActionRow | undefined {
    return this.db.prepare(
      `SELECT * FROM agent_pending_actions WHERE id = @id`
    ).get({ id }) as AgentPendingActionRow | undefined;
  }

  expireStale(): void {
    const now = this.now();
    // Avoid taking SQLite's writer lock on every pending-actions poll.
    const stale = this.db.prepare(
      `SELECT 1 FROM agent_pending_actions
        WHERE (status IN ('pending', 'expired')
               AND execution_state IN ('failed', 'outcome_unknown'))
           OR (status = 'pending' AND expires_at IS NOT NULL AND expires_at <= @now
             AND NOT EXISTS (SELECT 1 FROM agent_action_executions e WHERE e.action_id=agent_pending_actions.id))
        LIMIT 1`,
    ).get({ now });
    if (!stale) return;
    this.db.prepare(
      `UPDATE agent_pending_actions
          SET status = 'confirmed',
              resolved_at = COALESCE(resolved_at, execution_completed_at, @now)
        WHERE id IN (SELECT id FROM agent_pending_actions
          WHERE status IN ('pending', 'expired')
            AND execution_state IN ('failed', 'outcome_unknown') LIMIT 100)`,
    ).run({ now });
    this.db.prepare(
      `UPDATE agent_pending_actions
          SET status = 'expired', resolved_at = @now
        WHERE id IN (SELECT id FROM agent_pending_actions
          WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= @now
            AND NOT EXISTS (SELECT 1 FROM agent_action_executions e WHERE e.action_id=agent_pending_actions.id)
            AND execution_state NOT IN ('failed', 'outcome_unknown') LIMIT 100)`,
    ).run({ now });
  }
}
