import type { MailDatabase } from "../database/Database.js";

export interface AutomationRuleRuntimeState {
  ruleId: string;
  ruleVersion: number;
  lastScheduledAt?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  nextRunAt?: string;
  consecutiveFailures: number;
  pausedReason?: string;
  updatedAt: string;
}

interface Row {
  rule_id: string; rule_version: number; last_scheduled_at: string | null; last_started_at: string | null;
  last_completed_at: string | null; next_run_at: string | null; consecutive_failures: number;
  paused_reason: string | null; updated_at: string;
}

export class AutomationRuleRuntimeRepository {
  constructor(private readonly db: MailDatabase, private readonly now = () => new Date().toISOString()) {}

  get(ruleId: string): AutomationRuleRuntimeState | null {
    const row = this.db.prepare("SELECT * FROM automation_rule_runtime_state WHERE rule_id = ?").get(ruleId) as Row | undefined;
    return row ? map(row) : null;
  }

  upsert(input: Omit<AutomationRuleRuntimeState, "updatedAt">): AutomationRuleRuntimeState {
    const updatedAt = this.now();
    this.db.prepare(`INSERT INTO automation_rule_runtime_state (
      rule_id, rule_version, last_scheduled_at, last_started_at, last_completed_at,
      next_run_at, consecutive_failures, paused_reason, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(rule_id) DO UPDATE SET
      rule_version=excluded.rule_version, last_scheduled_at=excluded.last_scheduled_at,
      last_started_at=excluded.last_started_at, last_completed_at=excluded.last_completed_at,
      next_run_at=excluded.next_run_at, consecutive_failures=excluded.consecutive_failures,
      paused_reason=excluded.paused_reason, updated_at=excluded.updated_at`).run(
      input.ruleId, input.ruleVersion, input.lastScheduledAt ?? null, input.lastStartedAt ?? null,
      input.lastCompletedAt ?? null, input.nextRunAt ?? null, input.consecutiveFailures,
      input.pausedReason ?? null, updatedAt,
    );
    return this.get(input.ruleId)!;
  }

  settleScheduled(input: {
    ruleId: string; ruleVersion: number; plannedAt: string; startedAt: string;
    completedAt: string; nextRunAt: string; consecutiveFailures: number; pausedReason?: string;
  }): boolean {
    const result = this.db.prepare(`UPDATE automation_rule_runtime_state
      SET last_completed_at = ?, next_run_at = ?, consecutive_failures = ?,
          paused_reason = ?, updated_at = ?
      WHERE rule_id = ? AND rule_version = ? AND last_scheduled_at = ?
        AND last_started_at = ? AND paused_reason IS NULL`).run(
      input.completedAt, input.nextRunAt, input.consecutiveFailures, input.pausedReason ?? null,
      this.now(), input.ruleId, input.ruleVersion, input.plannedAt, input.startedAt,
    );
    if (result.changes === 0 && input.pausedReason === "execution-outcome-unknown") {
      // An older in-flight run may finish after a rule edit. Its uncertain
      // side effects still require reconciliation before future scheduling.
      this.db.prepare(`UPDATE automation_rule_runtime_state
        SET paused_reason = 'execution-outcome-unknown', last_scheduled_at = ?, updated_at = ?
        WHERE rule_id = ? AND (paused_reason IS NULL OR paused_reason != 'execution-outcome-unknown')`).run(input.plannedAt, this.now(), input.ruleId);
    }
    return result.changes === 1;
  }

  due(accountRuleIds: string[], at: string): AutomationRuleRuntimeState[] {
    if (!accountRuleIds.length) return [];
    const placeholders = accountRuleIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM automation_rule_runtime_state WHERE rule_id IN (${placeholders}) AND paused_reason IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`).all(...accountRuleIds, at) as Row[];
    return rows.map(map);
  }

  remove(ruleId: string): void { this.db.prepare("DELETE FROM automation_rule_runtime_state WHERE rule_id = ?").run(ruleId); }
}

function map(row: Row): AutomationRuleRuntimeState {
  return { ruleId: row.rule_id, ruleVersion: row.rule_version, lastScheduledAt: row.last_scheduled_at ?? undefined, lastStartedAt: row.last_started_at ?? undefined, lastCompletedAt: row.last_completed_at ?? undefined, nextRunAt: row.next_run_at ?? undefined, consecutiveFailures: row.consecutive_failures, pausedReason: row.paused_reason ?? undefined, updatedAt: row.updated_at };
}
