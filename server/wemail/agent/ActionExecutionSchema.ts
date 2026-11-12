import type { MailDatabase } from "../database/Database.js";

export function ensureActionExecutionSchema(db: MailDatabase): void {
  // Accepted tasks survive conversation deletion; their rows own the execution data.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_action_executions (
      id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL, state TEXT NOT NULL,
      plan_version INTEGER NOT NULL DEFAULT 1 CHECK(plan_version = 1),
      revision INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT, lease_until_ms INTEGER, created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_action_execution_due
      ON agent_action_executions(state, lease_until_ms, created_at_ms);
    CREATE TABLE IF NOT EXISTS agent_action_execution_items (
      execution_id TEXT NOT NULL, item_index INTEGER NOT NULL, data_json TEXT NOT NULL,
      account_id TEXT NOT NULL, sha256 TEXT, phase TEXT NOT NULL,
      PRIMARY KEY(execution_id, item_index),
      FOREIGN KEY(execution_id) REFERENCES agent_action_executions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_action_execution_content
      ON agent_action_execution_items(account_id, sha256, phase) WHERE sha256 IS NOT NULL;
    CREATE TABLE IF NOT EXISTS agent_action_legacy_submissions (
      account_id TEXT NOT NULL, email_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
      PRIMARY KEY(account_id, email_id, attachment_id)
    );
    UPDATE agent_pending_actions
       SET status='confirmed', execution_state='outcome_unknown',
           resolved_at=COALESCE(resolved_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           execution_completed_at=COALESCE(execution_completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           execution_result_json=json_set(CASE WHEN json_valid(execution_result_json) THEN execution_result_json ELSE '{}' END,
             '$.ok', json('false'), '$.summary', '上次执行中断，结果待核实。请先检查平台，未自动重新执行。')
     WHERE execution_state='executing'
       AND NOT EXISTS (SELECT 1 FROM agent_action_executions e WHERE e.action_id=agent_pending_actions.id);
    INSERT OR IGNORE INTO agent_action_legacy_submissions(account_id,email_id,attachment_id)
      SELECT COALESCE(pa.account_id,conv.account_id),json_extract(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.emailId'),json_extract(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.attachmentId')
      FROM agent_pending_actions pa LEFT JOIN agent_conversations conv ON conv.id=pa.conversation_id,
        json_each(CASE WHEN json_valid(pa.input_json) THEN pa.input_json ELSE '{}' END,'$.items') item
      WHERE pa.action_type='upload_allowance_invoices' AND COALESCE(pa.account_id,conv.account_id) IS NOT NULL
        AND json_type(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.emailId')='text'
        AND json_type(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.attachmentId')='text'
        AND (pa.execution_state IN ('outcome_unknown','succeeded') OR
          (pa.execution_state='failed' AND EXISTS (SELECT 1 FROM json_each(
            CASE WHEN json_valid(pa.execution_result_json) THEN pa.execution_result_json ELSE '{}' END,'$.items') result
            WHERE json_extract(CASE WHEN result.type='object' THEN result.value ELSE '{}' END,'$.command') IS NOT NULL
               OR json_extract(CASE WHEN result.type='object' THEN result.value ELSE '{}' END,'$.auditId') IS NOT NULL)));
  `);
}
