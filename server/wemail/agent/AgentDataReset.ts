import fs from "node:fs";
import type { MailDatabase } from "../database/Database.js";

const AGENT_TABLES_IN_DELETE_ORDER = [
  "agent_attachment_refs",
  "agent_citations",
  "agent_attachments",
  "agent_tool_executions",
  "agent_followup_queue",
  "agent_runs",
  "agent_user_preferences",
  "agent_user_behavior_events",
  "agent_pending_actions",
  "agent_messages",
  "agent_conversations",
] as const;

export interface AgentDataResetResult {
  cleared: Record<string, number>;
  skipped: string[];
}

function tableExists(db: MailDatabase, table: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
}

/**
 * Clears only Agent-owned runtime and learning data.
 *
 * The allow-list is intentionally static: accounts, emails, drafts, mailbox
 * state, and intelligence data cannot be reached through this function.
 */
export function clearAgentData(
  db: MailDatabase,
  options: { attachmentRoot?: string } = {},
): AgentDataResetResult {
  const cleared: Record<string, number> = {};
  const skipped: string[] = [];

  db.transaction(() => {
    for (const table of AGENT_TABLES_IN_DELETE_ORDER) {
      if (!tableExists(db, table)) {
        skipped.push(table);
        continue;
      }
      const result = db.prepare(`DELETE FROM ${table}`).run();
      cleared[table] = result.changes;
    }
  })();

  if (options.attachmentRoot) {
    fs.rmSync(options.attachmentRoot, { recursive: true, force: true });
  }

  return { cleared, skipped };
}
