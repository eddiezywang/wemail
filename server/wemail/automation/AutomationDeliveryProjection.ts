import type { AutomationDeliveryOutcome } from "../../../shared/wemail/automationCenter.js";
import type { MailDatabase } from "../database/Database.js";

interface DeliveryLedgerRow {
  id: string;
  platform: "feishu" | "wecom";
  state:
    | "pending"
    | "leased"
    | "retrying"
    | "sent"
    | "ambiguous"
    | "failed"
    | "needs_reauthorization";
  error_code: string | null;
}

/**
 * The channel ledger is the source of truth for Bot delivery. Pipeline step
 * completion only means the message was accepted into the delivery queue.
 */
export function projectAutomationDeliveries(
  db: MailDatabase,
  runId: string,
): AutomationDeliveryOutcome[] {
  const rows = db
    .prepare(
      `SELECT id, platform, state, error_code
         FROM channel_deliveries
        WHERE automation_run_id = ?
        ORDER BY sequence, created_at, id`,
    )
    .all(runId) as DeliveryLedgerRow[];

  return rows.map((row) => ({
    destination: row.platform === "feishu" ? "feishu_bot" : "wecom_bot",
    status: projectStatus(row.state),
    outputId: row.id,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  }));
}

function projectStatus(
  state: DeliveryLedgerRow["state"],
): AutomationDeliveryOutcome["status"] {
  if (state === "sent") return "succeeded";
  if (state === "failed" || state === "needs_reauthorization") return "failed";
  if (state === "ambiguous") return "unknown";
  return "pending";
}
