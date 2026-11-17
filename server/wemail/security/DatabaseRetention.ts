import type { MailDatabase } from "../database/Database.js";
import { cleanupDirectorySnapshots } from "../directory/DirectorySnapshotMaintenance.js";
import { APP_LOG_RETENTION_DAYS } from "../telemetry/AppLogger.js";
import {
  DatabaseRetentionBatchParamsSchema,
  type DatabaseRetentionBatchParams,
  type DatabaseRetentionBatchResult,
} from "../../../shared/wemail/retention.js";

export const RETENTION_DAYS = {
  mailBody: null,
  attachments: null,
  appLogs: APP_LOG_RETENTION_DAYS,
  wecliAuditLogs: 30,
  automationDetails: 30,
} as const;

// Caller owns the transaction; each table changes at most limit rows per pass.
export function runDatabaseRetentionBatch(db: MailDatabase, input: DatabaseRetentionBatchParams): DatabaseRetentionBatchResult {
  const { now, limit } = DatabaseRetentionBatchParamsSchema.parse(input);
  const auditCutoff = new Date(Date.parse(now) - RETENTION_DAYS.wecliAuditLogs * 86_400_000).toISOString();
  const wecliAuditLogsDeleted = db.prepare(`DELETE FROM wecli_audit_logs WHERE rowid IN (
    SELECT rowid FROM wecli_audit_logs WHERE created_at < ? ORDER BY created_at LIMIT ?
  )`).run(auditCutoff, limit).changes;
  const applicationMessagesDeleted = db.prepare(`DELETE FROM application_messages WHERE rowid IN (
    SELECT rowid FROM application_messages WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
  )`).run(now, limit).changes;
  const automationPreviewsDeleted = db.prepare(`DELETE FROM automation_rule_previews WHERE rowid IN (
    SELECT rowid FROM automation_rule_previews WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
  )`).run(now, limit).changes;
  const automationManifestItemsDeleted = db.prepare(`DELETE FROM automation_run_manifest_items WHERE rowid IN (
    SELECT items.rowid FROM automation_run_manifests manifests
    JOIN automation_run_manifest_items items ON items.run_id = manifests.run_id
    WHERE manifests.expires_at <= ? LIMIT ?
  )`).run(now, limit).changes;
  const automationResultsExpired = db.prepare(`UPDATE automation_result_envelopes
    SET status = 'expired', result_json = NULL, provenance_json = '[]', action_candidates_json = '[]', warnings_json = '[]'
    WHERE rowid IN (SELECT rowid FROM automation_result_envelopes
      WHERE expires_at IS NOT NULL AND expires_at <= ? AND status <> 'expired'
      ORDER BY expires_at LIMIT ?)
  `).run(now, limit).changes;
  const automationStepDetailsExpired = db.prepare(`UPDATE automation_step_runs
    SET input_summary_json = NULL, output_summary_json = NULL, output_json = NULL,
      error_json = CASE WHEN error_json IS NULL THEN NULL ELSE '{"code":"detail-expired","message":"运行详情已按保留策略清理"}' END,
      usage_json = NULL, retry_safety_json = '{"retrySafe":false,"reason":"detail-expired"}',
      effect_evidence_json = NULL, delivery_destination_json = NULL
    WHERE rowid IN (SELECT rowid FROM automation_step_runs
      WHERE expires_at IS NOT NULL AND expires_at <= ? AND (
        input_summary_json IS NOT NULL OR output_summary_json IS NOT NULL OR output_json IS NOT NULL OR
        usage_json IS NOT NULL OR effect_evidence_json IS NOT NULL
      ) ORDER BY expires_at LIMIT ?)
  `).run(now, limit).changes;
  const counts = { wecliAuditLogsDeleted, applicationMessagesDeleted, automationPreviewsDeleted,
    automationManifestItemsDeleted, automationResultsExpired, automationStepDetailsExpired };
  const directoryBatch = cleanupDirectorySnapshots(db, Date.parse(now), limit);
  return { ...counts, hasMore: directoryBatch === limit || Object.values(counts).some((count) => count === limit) };
}
