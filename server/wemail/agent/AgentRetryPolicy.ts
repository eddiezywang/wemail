import { AgentTerminalToolError } from "./AgentRuntime.js";

const IDEMPOTENT_READ_TOOLS = new Set([
  "get_current_time",
  "list_mail",
  "read_mail",
  "read_mail_source",
  "batch_read_mail_source",
  "search_mail",
  "list_recent_emails",
  "batch_get_mail_intelligence",
  "summarize_mail",
  "get_summary",
  "get_tags",
  "get_reply_decision",
  "get_reply_draft",
  "get_intelligence_state",
  "get_todos",
  "get_smart_links",
  "get_translation",
  "find_invoice_attachments",
  "get_suggestions",
  "search_directory_contacts",
  "get_directory_contact",
  "list_directory_departments",
  "resolve_directory_recipients",
  "get_directory_status",
  "list_smart_tags",
  "list_automation_rules",
  "discover_automation_capabilities",
  "preview_automation_rule",
  "preview_pipeline_automation_rule",
  "list_mail_drafts",
  "list_scheduled_mail",
  "get_mail_draft",
  "list_writing_styles",
  "get_business_preferences",
  "inspect_workflow_capabilities",
  "review_pipeline_preview",
  "resume_automation_rule_draft",
]);

export function isApprovedIdempotentReadTool(toolName: string): boolean {
  return IDEMPOTENT_READ_TOOLS.has(toolName);
}

export function isTransientAgentError(error: unknown): boolean {
  if (error instanceof AgentTerminalToolError) return false;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const status = Number(candidate?.status ?? candidate?.statusCode);
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
    return true;
  }
  const text = [candidate?.code, candidate?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return /timeout|timed out|deadline|temporar|rate.?limit|econnreset|econnrefused|enotfound|network|socket|fetch failed|service unavailable/.test(text);
}
