import { randomUUID } from "node:crypto";
import type {
  AtExpressionExecution,
  AutomationAction,
} from "../../../shared/wemail/automation.js";
import type { MailDatabase } from "../database/Database.js";
import type { SemanticFieldDependency } from "./AutomationFieldRegistry.js";

export type AutomationDeferredStatus =
  | "pending"
  | "waiting_fields"
  | "blocked_missing_field"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "cancelled";

interface DeferredRow {
  id: string;
  rule_id: string;
  rule_version: string;
  account_id: string;
  email_id: string;
  due_at: string | null;
  actions_json: string;
  execution_json: string | null;
  dependencies_json: string;
  resolution_json: string | null;
  status: AutomationDeferredStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AutomationDeferredExecution {
  id: string;
  ruleId: string;
  ruleVersion: string;
  accountId: string;
  emailId: string;
  dueAt?: string;
  actions: AutomationAction[];
  execution?: AtExpressionExecution;
  dependencies: SemanticFieldDependency[];
  resolution?: unknown;
  status: AutomationDeferredStatus;
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
}

export interface WaitingExecutionInput {
  ruleId: string;
  ruleVersion: string;
  accountId: string;
  emailId: string;
  actions: AutomationAction[];
  execution: AtExpressionExecution;
  dependencies: SemanticFieldDependency[];
}

export interface DueExecutionClaim {
  id: string;
  ruleId: string;
  ruleVersion: string;
  accountId: string;
  emailId: string;
  now: string;
}

function toExecution(row: DeferredRow): AutomationDeferredExecution {
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    accountId: row.account_id,
    emailId: row.email_id,
    ...(row.due_at === null ? {} : { dueAt: row.due_at }),
    actions: JSON.parse(row.actions_json) as AutomationAction[],
    ...(row.execution_json === null
      ? {}
      : {
          execution: JSON.parse(row.execution_json) as AtExpressionExecution,
        }),
    dependencies: JSON.parse(row.dependencies_json) as SemanticFieldDependency[],
    ...(row.resolution_json === null
      ? {}
      : { resolution: JSON.parse(row.resolution_json) as unknown }),
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

export class AutomationDeferredExecutionRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get(id: string): AutomationDeferredExecution | null {
    const row = this.db.prepare(
      "SELECT * FROM automation_deferred_executions WHERE id = ?",
    ).get(id) as DeferredRow | undefined;
    return row ? toExecution(row) : null;
  }

  schedule(input: {
    ruleId: string;
    ruleVersion: string;
    accountId: string;
    emailId: string;
    dueAt: string;
    actions: AutomationAction[];
  }): AutomationDeferredExecution {
    const now = this.now();
    const id = `automation-exec-${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO automation_deferred_executions (
         id, rule_id, rule_version, account_id, email_id, due_at,
         actions_json, status, attempts, created_at, updated_at
       ) VALUES (
         @id, @ruleId, @ruleVersion, @accountId, @emailId, @dueAt,
         @actionsJson, 'pending', 0, @now, @now
       )
       ON CONFLICT(rule_id, rule_version, email_id) DO NOTHING`,
    ).run({
      id,
      ...input,
      actionsJson: JSON.stringify(input.actions),
      now,
    });
    const row = this.db.prepare(
      `SELECT * FROM automation_deferred_executions
       WHERE rule_id = ? AND rule_version = ? AND email_id = ?`,
    ).get(input.ruleId, input.ruleVersion, input.emailId) as DeferredRow;
    return toExecution(row);
  }

  scheduleWaiting(input: WaitingExecutionInput): AutomationDeferredExecution {
    const now = this.now();
    const id = `automation-exec-${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO automation_deferred_executions (
         id, rule_id, rule_version, account_id, email_id, due_at,
         actions_json, execution_json, dependencies_json, status, attempts,
         created_at, updated_at
       ) VALUES (
         @id, @ruleId, @ruleVersion, @accountId, @emailId, NULL,
         @actionsJson, @executionJson, @dependenciesJson, 'waiting_fields', 0,
         @now, @now
       )
       ON CONFLICT(rule_id, rule_version, email_id) DO NOTHING`,
    ).run({
      id,
      ruleId: input.ruleId,
      ruleVersion: input.ruleVersion,
      accountId: input.accountId,
      emailId: input.emailId,
      actionsJson: JSON.stringify(input.actions),
      executionJson: JSON.stringify(input.execution),
      dependenciesJson: JSON.stringify(input.dependencies),
      now,
    });
    const row = this.db.prepare(
      `SELECT * FROM automation_deferred_executions
       WHERE rule_id = ? AND rule_version = ? AND email_id = ?`,
    ).get(input.ruleId, input.ruleVersion, input.emailId) as DeferredRow;
    return toExecution(row);
  }

  listWaiting(accountId: string, limit?: number): AutomationDeferredExecution[] {
    const rows = (limit === undefined
      ? this.db.prepare(
          `SELECT * FROM automation_deferred_executions
           WHERE account_id = ? AND status = 'waiting_fields'
           ORDER BY created_at ASC`,
        ).all(accountId)
      : this.db.prepare(
          `SELECT * FROM automation_deferred_executions
           WHERE account_id = @accountId AND status = 'waiting_fields'
           ORDER BY created_at ASC
           LIMIT @limit`,
        ).all({ accountId, limit })
    ) as DeferredRow[];
    return rows.map(toExecution);
  }

  listDue(accountId: string, now: string, limit = 100): AutomationDeferredExecution[] {
    const staleBefore = new Date(Date.parse(now) - 10 * 60 * 1000).toISOString();
    this.db.prepare(
      `UPDATE automation_deferred_executions
       SET status = 'retry_wait', next_attempt_at = @now,
           last_error = COALESCE(last_error, 'interrupted-execution-recovered'),
           updated_at = @now
       WHERE account_id = @accountId AND status = 'running' AND updated_at <= @staleBefore`,
    ).run({ accountId, now, staleBefore });
    const rows = this.db.prepare(
      `SELECT * FROM automation_deferred_executions
       WHERE account_id = @accountId
         AND status IN ('pending', 'retry_wait')
         AND due_at IS NOT NULL
         AND due_at <= @now
         AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
       ORDER BY due_at ASC
       LIMIT @limit`,
    ).all({ accountId, now, limit }) as DeferredRow[];
    return rows.map(toExecution);
  }

  markRunning(id: string): boolean {
    const result = this.db.prepare(
      `UPDATE automation_deferred_executions
       SET status = 'running', attempts = attempts + 1, updated_at = @now
       WHERE id = @id AND status IN ('pending', 'retry_wait')`,
    ).run({ id, now: this.now() });
    return result.changes > 0;
  }

  claimDue(input: DueExecutionClaim): boolean {
    const result = this.db.prepare(
      `UPDATE automation_deferred_executions
       SET status = 'running', attempts = attempts + 1, updated_at = @now
       WHERE id = @id
         AND rule_id = @ruleId
         AND rule_version = @ruleVersion
         AND account_id = @accountId
         AND email_id = @emailId
         AND status IN ('pending', 'retry_wait')
         AND due_at IS NOT NULL
         AND due_at <= @now
         AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
         AND EXISTS (
           SELECT 1
           FROM automation_rules
           WHERE id = @ruleId
             AND account_id = @accountId
             AND enabled = 1
             AND updated_at = @ruleVersion
         )`,
    ).run(input);
    return result.changes > 0;
  }

  cancelIfClaimable(id: string): boolean {
    const now = this.now();
    const result = this.db.prepare(
      `UPDATE automation_deferred_executions
       SET status = 'cancelled', completed_at = @now, updated_at = @now
       WHERE id = @id AND status IN ('pending', 'retry_wait')`,
    ).run({ id, now });
    return result.changes > 0;
  }

  markWaiting(id: string, dependencies: SemanticFieldDependency[]): void {
    this.db.prepare(
      `UPDATE automation_deferred_executions
       SET status = 'waiting_fields', due_at = NULL,
           dependencies_json = @dependenciesJson, resolution_json = NULL,
           next_attempt_at = NULL, last_error = NULL, completed_at = NULL,
           updated_at = @now
       WHERE id = @id AND status = 'waiting_fields'`,
    ).run({
      id,
      dependenciesJson: JSON.stringify(dependencies),
      now: this.now(),
    });
  }

  markPending(id: string, dueAt: string, resolution: unknown): void {
    this.db.prepare(
      `UPDATE automation_deferred_executions
       SET status = 'pending', due_at = @dueAt,
           resolution_json = @resolutionJson, next_attempt_at = NULL,
           last_error = NULL, completed_at = NULL, updated_at = @now
       WHERE id = @id AND status = 'waiting_fields'`,
    ).run({
      id,
      dueAt,
      resolutionJson: JSON.stringify(resolution) ?? "null",
      now: this.now(),
    });
  }

  markBlockedMissingField(id: string, resolution: unknown): void {
    const now = this.now();
    this.db.prepare(
      `UPDATE automation_deferred_executions
       SET status = 'blocked_missing_field', due_at = NULL,
           resolution_json = @resolutionJson, next_attempt_at = NULL,
           last_error = NULL, completed_at = @now, updated_at = @now
       WHERE id = @id AND status = 'waiting_fields'`,
    ).run({
      id,
      resolutionJson: JSON.stringify(resolution) ?? "null",
      now,
    });
  }

  markSucceeded(id: string): void {
    const now = this.now();
    this.db.prepare(
      `UPDATE automation_deferred_executions
       SET status = 'succeeded', completed_at = @now, updated_at = @now,
           next_attempt_at = NULL, last_error = NULL
       WHERE id = @id`,
    ).run({ id, now });
  }

  markFailed(id: string, error: string, retryAt?: string): void {
    const now = this.now();
    this.db.prepare(
      `UPDATE automation_deferred_executions
       SET status = @status, next_attempt_at = @retryAt, last_error = @error,
           completed_at = @completedAt, updated_at = @now
       WHERE id = @id`,
    ).run({
      id,
      status: retryAt ? "retry_wait" : "failed",
      retryAt: retryAt ?? null,
      error: error.slice(0, 2000),
      completedAt: retryAt ? null : now,
      now,
    });
  }

  cancelForRule(ruleId: string): number {
    const result = this.db.prepare(
      `UPDATE automation_deferred_executions
       SET status = 'cancelled', completed_at = @now, updated_at = @now
       WHERE rule_id = @ruleId
         AND status IN (
           'pending', 'retry_wait', 'waiting_fields', 'blocked_missing_field'
         )`,
    ).run({ ruleId, now: this.now() });
    return result.changes;
  }

  markCancelled(id: string): void {
    const now = this.now();
    this.db.prepare(
      `UPDATE automation_deferred_executions
       SET status = 'cancelled', completed_at = @now, updated_at = @now
       WHERE id = @id`,
    ).run({ id, now });
  }
}
