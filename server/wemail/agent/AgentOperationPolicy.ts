import type { HighRiskActionType } from "../../../shared/wemail/intelligence.js";

export type AgentOperationDisposition =
  | "direct_read"
  | "direct_draft"
  | "direct_low_risk_single"
  | "confirmation_required";

const CONFIRMATION_REQUIRED_ACTIONS: ReadonlySet<HighRiskActionType> = new Set([
  "send", "delete", "move", "archive", "mark_spam", "unsubscribe",
  "run_automation", "run_wecli_command", "install_wecli",
  "upload_allowance_invoices", "delete_allowance_invoices",
  "configure_smart_tag", "configure_automation_rule",
  "configure_writing_style", "schedule_send", "cancel_scheduled_send",
  "permanent_delete", "delete_draft", "bulk_mail_operation",
  "configure_business_preferences",
]);

const FORBIDDEN_DIRECT_TOOLS = new Set([
  "send_mail", "delete_mail", "move_mail", "archive_mail", "mark_spam",
  "unsubscribe", "run_automation",
]);

export function operationDispositionForAction(
  actionType: HighRiskActionType,
): AgentOperationDisposition {
  return CONFIRMATION_REQUIRED_ACTIONS.has(actionType)
    ? "confirmation_required"
    : "direct_low_risk_single";
}

export function isConfirmationRequiredAction(
  actionType: HighRiskActionType | string,
): actionType is HighRiskActionType {
  return CONFIRMATION_REQUIRED_ACTIONS.has(actionType as HighRiskActionType);
}

/** Authoritative semantic guard for tools that can mutate state directly. */
export function directToolPolicy(
  toolName: string,
  args: Record<string, unknown>,
): { disposition: AgentOperationDisposition; reason?: string } {
  if (FORBIDDEN_DIRECT_TOOLS.has(toolName)) {
    return {
      disposition: "confirmation_required",
      reason: `${toolName} requires an exact-parameter confirmation proposal.`,
    };
  }
  if (toolName === "set_mail_state") {
    const ids = Array.isArray(args.emailIds)
      ? args.emailIds.filter((value) => typeof value === "string" && value.length > 0)
      : [];
    const explicitSingle =
      (typeof args.emailId === "string" && args.emailId.length > 0 && ids.length === 0) ||
      (ids.length === 1 && args.emailId === undefined);
    return explicitSingle
      ? { disposition: "direct_low_risk_single" }
      : { disposition: "confirmation_required", reason: "Mail-state changes may execute directly only for one explicitly named email." };
  }
  if (toolName === "set_mail_smart_tag") {
    return typeof args.emailId === "string" && args.emailId.length > 0
      ? { disposition: "direct_low_risk_single" }
      : { disposition: "confirmation_required", reason: "Smart-tag changes require one explicitly named email." };
  }
  if (toolName === "save_mail_draft") return { disposition: "direct_draft" };
  return { disposition: "direct_read" };
}

export const confirmationRequiredActionTypes = Object.freeze([...CONFIRMATION_REQUIRED_ACTIONS]);
