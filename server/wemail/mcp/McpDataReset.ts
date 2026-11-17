import type { MailDatabase } from "../database/Database.js";
import type { SecretStore } from "../security/SecretStore.js";

const MCP_TABLES_IN_DELETE_ORDER = [
  "mcp_audit_events",
  "mcp_idempotency_reservations",
  "mcp_prepared_operations",
  "mcp_access_tokens",
] as const;

export interface McpDataResetResult {
  cleared: Record<string, number>;
  deletedSecrets: number;
  skipped: string[];
}
function tableExists(db: MailDatabase, table: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
}

/**
 * Clears only MCP-owned credentials and runtime records.
 *
 * Callers terminate in-memory MCP sessions before invoking this function.
 * The static table allowlist cannot reach account, mailbox, draft, todo,
 * intelligence, or Agent data.
 */
export function clearMcpData(
  db: MailDatabase,
  secrets: SecretStore,
): McpDataResetResult {
  const skipped: string[] = [];
  const cleared: Record<string, number> = {};
  const secretKeys = tableExists(db, "mcp_access_tokens")
    ? (db.prepare("SELECT secret_key FROM mcp_access_tokens").all() as Array<{
        secret_key: string;
      }>).map((row) => row.secret_key)
    : [];

  db.transaction(() => {
    for (const table of MCP_TABLES_IN_DELETE_ORDER) {
      if (!tableExists(db, table)) {
        skipped.push(table);
        continue;
      }
      cleared[table] = db.prepare(`DELETE FROM ${table}`).run().changes;
    }
  })();

  for (const key of secretKeys) secrets.deleteSecret(key);
  return { cleared, deletedSecrets: secretKeys.length, skipped };
}
