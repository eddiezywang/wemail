import type {
  ConfigurationConfirmationSnapshot,
  ConfigurationEffect,
  ConfigurationIssue,
  ConfigurationRecoveryAction,
  ConfigurationReference,
  ConfigurationStep,
  ConfigurationTaskSnapshot,
} from "../../../shared/wemail/configuration.js";
import { assertValidConfigurationSnapshot } from "../../../shared/wemail/configuration.js";
import type { MailDatabase } from "../database/Database.js";
import { sanitizeConfigurationDiagnostic } from "./ConfigurationDiagnostics.js";

interface TaskRow {
  id: string;
  account_id: string;
  session_id: string | null;
  kind: string;
  target_key: string;
  operation: ConfigurationTaskSnapshot["operation"];
  title: string;
  status: ConfigurationTaskSnapshot["status"];
  current_phase: ConfigurationTaskSnapshot["currentPhase"];
  source_surface: ConfigurationTaskSnapshot["source"]["surface"];
  source_id: string | null;
  revision: number;
  references_json: string;
  authorization_json: string | null;
  pipeline_draft_id: string | null;
  review_checkpoint_ids_json: string;
  interaction_json: string | null;
  confirmation_snapshot_id: string | null;
  retention_until: string | null;
  created_at: string;
  updated_at: string;
}

export class ConfigurationTaskConflictError extends Error {
  constructor(readonly current?: ConfigurationTaskSnapshot) {
    super("configuration-task-revision-conflict");
    this.name = "ConfigurationTaskConflictError";
  }
}

export class ConfigurationTaskRepository {
  constructor(private readonly db: MailDatabase) {}

  create(snapshot: ConfigurationTaskSnapshot): ConfigurationTaskSnapshot {
    assertValidConfigurationSnapshot(snapshot);
    if (snapshot.revision !== 1) {
      throw new Error("new-configuration-task-revision-must-be-1");
    }
    try {
      this.db.transaction(() => {
        this.insertTask(snapshot);
        this.replaceChildren(snapshot);
      })();
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new ConfigurationTaskConflictError(
          this.findActive(
            snapshot.accountId,
            snapshot.kind,
            snapshot.targetKey,
            snapshot.operation,
          ) ?? undefined,
        );
      }
      throw error;
    }
    return this.get(snapshot.id, snapshot.accountId)!;
  }

  replace(
    snapshot: ConfigurationTaskSnapshot,
    expectedRevision: number,
  ): ConfigurationTaskSnapshot {
    assertValidConfigurationSnapshot(snapshot);
    if (snapshot.revision !== expectedRevision + 1) {
      throw new Error("configuration-task-next-revision-required");
    }
    const updated = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE configuration_tasks SET
            session_id = ?, title = ?, status = ?, current_phase = ?,
            source_surface = ?, source_id = ?, revision = ?,
            references_json = ?, authorization_json = ?, retention_until = ?,
            pipeline_draft_id = ?, review_checkpoint_ids_json = ?,
            interaction_json = ?, confirmation_snapshot_id = ?, updated_at = ?
           WHERE id = ? AND account_id = ? AND revision = ?`,
        )
        .run(
          snapshot.sessionId ?? null,
          snapshot.title,
          snapshot.status,
          snapshot.currentPhase,
          snapshot.source.surface,
          snapshot.source.sourceId ?? null,
          snapshot.revision,
          JSON.stringify(snapshot.references),
          snapshot.authorization
            ? JSON.stringify(snapshot.authorization)
            : null,
          snapshot.retentionUntil ?? null,
          snapshot.pipelineDraftId ?? null,
          JSON.stringify(snapshot.reviewCheckpointIds ?? []),
          snapshot.interaction ? JSON.stringify(snapshot.interaction) : null,
          snapshot.confirmationSnapshot?.id ?? null,
          snapshot.updatedAt,
          snapshot.id,
          snapshot.accountId,
          expectedRevision,
        );
      if (result.changes !== 1) {
        throw new ConfigurationTaskConflictError(
          this.get(snapshot.id, snapshot.accountId) ?? undefined,
        );
      }
      this.replaceChildren(snapshot);
      this.replaceConfirmationSnapshot(snapshot);
    });
    updated();
    return this.get(snapshot.id, snapshot.accountId)!;
  }

  get(id: string, accountId: string): ConfigurationTaskSnapshot | null {
    const row = this.db
      .prepare(
        "SELECT * FROM configuration_tasks WHERE id = ? AND account_id = ?",
      )
      .get(id, accountId) as TaskRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  findActive(
    accountId: string,
    kind: string,
    targetKey: string,
    operation: ConfigurationTaskSnapshot["operation"],
  ): ConfigurationTaskSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT * FROM configuration_tasks
         WHERE account_id = ? AND kind = ? AND target_key = ? AND operation = ?
           AND status NOT IN ('completed', 'completed_with_warnings', 'failed', 'cancelled')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(accountId, kind, targetKey, operation) as TaskRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  list(accountId: string, limit = 50): ConfigurationTaskSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM configuration_tasks
         WHERE account_id = ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(accountId, Math.max(1, Math.min(200, limit))) as TaskRow[];
    return rows.map((row) => this.hydrate(row));
  }

  cleanupExpired(now: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM configuration_tasks
         WHERE retention_until IS NOT NULL AND retention_until <= ?
           AND status IN ('completed', 'completed_with_warnings', 'failed', 'cancelled')`,
      )
      .run(now);
    return result.changes;
  }

  private insertTask(snapshot: ConfigurationTaskSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO configuration_tasks (
          id, account_id, session_id, kind, target_key, operation, title,
          status, current_phase, source_surface, source_id, revision,
          references_json, authorization_json, retention_until, created_at, updated_at
          , pipeline_draft_id, review_checkpoint_ids_json, interaction_json,
          confirmation_snapshot_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.accountId,
        snapshot.sessionId ?? null,
        snapshot.kind,
        snapshot.targetKey,
        snapshot.operation,
        snapshot.title,
        snapshot.status,
        snapshot.currentPhase,
        snapshot.source.surface,
        snapshot.source.sourceId ?? null,
        snapshot.revision,
        JSON.stringify(snapshot.references),
        snapshot.authorization ? JSON.stringify(snapshot.authorization) : null,
        snapshot.retentionUntil ?? null,
        snapshot.createdAt,
        snapshot.updatedAt,
        snapshot.pipelineDraftId ?? null,
        JSON.stringify(snapshot.reviewCheckpointIds ?? []),
        snapshot.interaction ? JSON.stringify(snapshot.interaction) : null,
        snapshot.confirmationSnapshot?.id ?? null,
      );
    this.replaceConfirmationSnapshot(snapshot);
  }

  private replaceChildren(snapshot: ConfigurationTaskSnapshot): void {
    for (const table of [
      "configuration_task_recoveries",
      "configuration_task_effects",
      "configuration_task_issues",
      "configuration_task_steps",
    ]) {
      this.db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(snapshot.id);
    }

    const insertStep = this.db.prepare(
      `INSERT INTO configuration_task_steps (
        task_id, step_id, phase, label, status, summary, started_at, completed_at, position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    snapshot.steps.forEach((step, index) =>
      insertStep.run(
        snapshot.id,
        step.id,
        step.phase,
        step.label,
        step.status,
        step.summary ?? null,
        step.startedAt ?? null,
        step.completedAt ?? null,
        index,
      ),
    );

    const insertIssue = this.db.prepare(
      `INSERT INTO configuration_task_issues (
        id, task_id, category, code, phase, severity, user_message,
        responsibility, retryability, privacy_class, affected_scope_json,
        unaffected_scope_json, diagnostic_json, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const issue of snapshot.issues) {
      const diagnostic = sanitizeConfigurationDiagnostic(issue.diagnostic);
      insertIssue.run(
        issue.id,
        snapshot.id,
        issue.category,
        issue.code,
        issue.phase,
        issue.severity,
        issue.userMessage,
        issue.responsibility,
        issue.retryability,
        issue.privacyClass,
        JSON.stringify(issue.affectedScope),
        issue.unaffectedScope
          ? JSON.stringify(issue.unaffectedScope)
          : null,
        diagnostic ? JSON.stringify(diagnostic) : null,
        issue.createdAt,
        issue.resolvedAt ?? null,
      );
    }

    const insertRecovery = this.db.prepare(
      `INSERT INTO configuration_task_recoveries (
        id, task_id, issue_id, type, label, description, target,
        requires_confirmation, dangerous, preferred, resumes_from_phase,
        expires_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const recovery of snapshot.recoveries) {
      insertRecovery.run(
        recovery.id,
        snapshot.id,
        recovery.issueId,
        recovery.type,
        recovery.label,
        recovery.description ?? null,
        recovery.target ?? null,
        recovery.requiresConfirmation ? 1 : 0,
        recovery.dangerous ? 1 : 0,
        recovery.preferred ? 1 : 0,
        recovery.resumesFromPhase ?? null,
        recovery.expiresAt ?? null,
        recovery.resolvedAt ?? null,
      );
    }

    const insertEffect = this.db.prepare(
      `INSERT INTO configuration_task_effects (
        id, task_id, phase, type, state, summary, external_audit_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const effect of snapshot.effects) {
      insertEffect.run(
        effect.id,
        snapshot.id,
        effect.phase,
        effect.type,
        effect.state,
        effect.summary,
        effect.externalAuditId ?? null,
        effect.createdAt,
        effect.updatedAt,
      );
    }
  }

  private replaceConfirmationSnapshot(snapshot: ConfigurationTaskSnapshot): void {
    this.db
      .prepare("DELETE FROM configuration_confirmation_snapshots WHERE task_id = ?")
      .run(snapshot.id);
    const confirmation = snapshot.confirmationSnapshot;
    if (!confirmation) return;
    this.db
      .prepare(
        `INSERT INTO configuration_confirmation_snapshots (
          id, task_id, task_revision, account_id, pipeline_draft_id,
          pipeline_draft_revision, rule_hash, skill_snapshots_json,
          capability_snapshots_json, review_hashes_json, risk, configuration_json,
          expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        confirmation.id,
        confirmation.taskId,
        confirmation.taskRevision,
        confirmation.accountId,
        confirmation.pipelineDraftId,
        confirmation.pipelineDraftRevision,
        confirmation.ruleHash,
        JSON.stringify(confirmation.skillSnapshots),
        JSON.stringify(confirmation.capabilitySnapshots),
        JSON.stringify(confirmation.reviewHashes),
        confirmation.risk,
        confirmation.configuration
          ? JSON.stringify(confirmation.configuration)
          : null,
        confirmation.expiresAt,
        snapshot.updatedAt,
      );
  }

  private hydrate(row: TaskRow): ConfigurationTaskSnapshot {
    const steps = this.db
      .prepare(
        "SELECT * FROM configuration_task_steps WHERE task_id = ? ORDER BY position",
      )
      .all(row.id) as Array<Record<string, unknown>>;
    const issues = this.db
      .prepare(
        "SELECT * FROM configuration_task_issues WHERE task_id = ? ORDER BY created_at, id",
      )
      .all(row.id) as Array<Record<string, unknown>>;
    const recoveries = this.db
      .prepare(
        "SELECT * FROM configuration_task_recoveries WHERE task_id = ? ORDER BY rowid",
      )
      .all(row.id) as Array<Record<string, unknown>>;
    const effects = this.db
      .prepare(
        "SELECT * FROM configuration_task_effects WHERE task_id = ? ORDER BY created_at, id",
      )
      .all(row.id) as Array<Record<string, unknown>>;
    const confirmation = row.confirmation_snapshot_id
      ? (this.db
          .prepare(
            "SELECT * FROM configuration_confirmation_snapshots WHERE id = ? AND task_id = ?",
          )
          .get(row.confirmation_snapshot_id, row.id) as
          | Record<string, unknown>
          | undefined)
      : undefined;
    return {
      id: row.id,
      accountId: row.account_id,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      kind: row.kind,
      targetKey: row.target_key,
      operation: row.operation,
      title: row.title,
      status: row.status,
      currentPhase: row.current_phase,
      source: {
        surface: row.source_surface,
        ...(row.source_id ? { sourceId: row.source_id } : {}),
      },
      steps: steps.map(mapStep),
      issues: issues.map(mapIssue),
      recoveries: recoveries.map(mapRecovery),
      effects: effects.map(mapEffect),
      references: parseJson<ConfigurationReference[]>(row.references_json, []),
      ...(row.authorization_json
        ? { authorization: parseJson(row.authorization_json, undefined) }
        : {}),
      ...(row.pipeline_draft_id
        ? { pipelineDraftId: row.pipeline_draft_id }
        : {}),
      reviewCheckpointIds: parseJson<string[]>(
        row.review_checkpoint_ids_json,
        [],
      ),
      ...(row.interaction_json
        ? { interaction: parseJson(row.interaction_json, undefined) }
        : {}),
      ...(confirmation
        ? { confirmationSnapshot: mapConfirmationSnapshot(confirmation) }
        : {}),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.retention_until
        ? { retentionUntil: row.retention_until }
        : {}),
    };
  }
}

function mapConfirmationSnapshot(
  row: Record<string, unknown>,
): ConfigurationConfirmationSnapshot {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    taskRevision: Number(row.task_revision),
    accountId: String(row.account_id),
    pipelineDraftId: String(row.pipeline_draft_id),
    pipelineDraftRevision: Number(row.pipeline_draft_revision),
    ruleHash: String(row.rule_hash),
    skillSnapshots: parseJson(String(row.skill_snapshots_json), []),
    capabilitySnapshots: parseJson(
      String(row.capability_snapshots_json),
      [],
    ),
    reviewHashes: parseJson(String(row.review_hashes_json), []),
    risk: row.risk as ConfigurationConfirmationSnapshot["risk"],
    ...(row.configuration_json
      ? {
          configuration: parseJson(
            String(row.configuration_json),
            undefined,
          ),
        }
      : {}),
    expiresAt: String(row.expires_at),
  };
}

function mapStep(row: Record<string, unknown>): ConfigurationStep {
  return {
    id: String(row.step_id),
    phase: row.phase as ConfigurationStep["phase"],
    label: String(row.label),
    status: row.status as ConfigurationStep["status"],
    ...(row.summary ? { summary: String(row.summary) } : {}),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
  };
}

function mapIssue(row: Record<string, unknown>): ConfigurationIssue {
  return {
    id: String(row.id),
    category: row.category as ConfigurationIssue["category"],
    code: String(row.code),
    phase: row.phase as ConfigurationIssue["phase"],
    severity: row.severity as ConfigurationIssue["severity"],
    userMessage: String(row.user_message),
    responsibility:
      row.responsibility as ConfigurationIssue["responsibility"],
    retryability: row.retryability as ConfigurationIssue["retryability"],
    privacyClass: row.privacy_class as ConfigurationIssue["privacyClass"],
    affectedScope: parseJson(String(row.affected_scope_json), []),
    ...(row.unaffected_scope_json
      ? {
          unaffectedScope: parseJson(
            String(row.unaffected_scope_json),
            [],
          ),
        }
      : {}),
    ...(row.diagnostic_json
      ? { diagnostic: parseJson(String(row.diagnostic_json), undefined) }
      : {}),
    createdAt: String(row.created_at),
    ...(row.resolved_at ? { resolvedAt: String(row.resolved_at) } : {}),
  };
}

function mapRecovery(
  row: Record<string, unknown>,
): ConfigurationRecoveryAction {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    type: row.type as ConfigurationRecoveryAction["type"],
    label: String(row.label),
    ...(row.description ? { description: String(row.description) } : {}),
    ...(row.target ? { target: String(row.target) } : {}),
    requiresConfirmation: row.requires_confirmation === 1,
    dangerous: row.dangerous === 1,
    preferred: row.preferred === 1,
    ...(row.resumes_from_phase
      ? {
          resumesFromPhase:
            row.resumes_from_phase as ConfigurationRecoveryAction["resumesFromPhase"],
        }
      : {}),
    ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}),
    ...(row.resolved_at ? { resolvedAt: String(row.resolved_at) } : {}),
  };
}

function mapEffect(row: Record<string, unknown>): ConfigurationEffect {
  return {
    id: String(row.id),
    phase: row.phase as ConfigurationEffect["phase"],
    type: String(row.type),
    state: row.state as ConfigurationEffect["state"],
    summary: String(row.summary),
    ...(row.external_audit_id
      ? { externalAuditId: String(row.external_audit_id) }
      : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    /unique constraint failed/i.test(error.message)
  );
}
