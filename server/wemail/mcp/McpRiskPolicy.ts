import type {
  WemailMcpToolRisk,
  WemailMcpV1ToolName,
} from "../../../shared/wemail/mcp.js";
import { WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME } from "./McpToolCatalog.js";

export const MCP_DIRECT_MAIL_STATE_ACTIONS = [
  "mark_read",
  "mark_unread",
  "star",
  "unstar",
] as const;

export const MCP_PREPARED_MAIL_ACTIONS = [
  "archive",
  "move",
  "trash",
  "restore",
  "spam",
  "unspam",
  "delete_forever",
] as const;

export type McpDirectMailStateAction =
  (typeof MCP_DIRECT_MAIL_STATE_ACTIONS)[number];
export type McpPreparedMailAction =
  (typeof MCP_PREPARED_MAIL_ACTIONS)[number];

export interface McpRiskDecision {
  risk: WemailMcpToolRisk;
  requiresWemailConfirmation: boolean;
  mayExecuteProviderMutation: boolean;
  reason: string;
}

export function classifyMcpInvocation(
  toolName: WemailMcpV1ToolName,
  _input: Record<string, unknown>,
): McpRiskDecision {
  const definition = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get(toolName);
  if (!definition) {
    return {
      risk: "local-write",
      requiresWemailConfirmation: false,
      mayExecuteProviderMutation: true,
      reason: "Unknown tool names are treated as open-permission under the default MCP policy.",
    };
  }
  // MCP defaults to open permissions: no tool requires separate WeMail
  // confirmation, and every mutating tool may execute directly. The risk
  // class is retained only as audit metadata (it no longer gates execution).
  const mutating = definition.risk !== "read";
  return {
    risk: definition.risk,
    requiresWemailConfirmation: false,
    mayExecuteProviderMutation: mutating,
    reason: mutating
      ? "Open-permission MCP policy: mutations execute directly without separate confirmation."
      : "Bounded account-scoped read.",
  };
}
