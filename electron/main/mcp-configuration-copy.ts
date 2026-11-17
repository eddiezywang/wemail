import {
  WEMAIL_MCP_CONFIGURATION_TARGETS,
  type WemailMcpConfigurationCopyResult,
} from "../../shared/wemail/mcp.js";
import type { McpListenerController } from "../../server/wemail/mcp/McpListenerController.js";

export function copyMcpConfigurationWith(input: {
  target: unknown;
  controller: McpListenerController | null;
  writeText: (value: string) => void;
}): WemailMcpConfigurationCopyResult {
  const target = WEMAIL_MCP_CONFIGURATION_TARGETS.find(
    (candidate) => candidate === input.target,
  );
  if (!target) {
    return { ok: false, target: "codex", error: "unsupported_target" };
  }
  try {
    if (!input.controller) throw new Error("mcp-not-ready");
    input.writeText(input.controller.configuration(target));
    return { ok: true, target };
  } catch (error) {
    const message = error instanceof Error ? error.message : "mcp-not-ready";
    return {
      ok: false,
      target,
      error:
        message === "mcp-credential-corrupt"
          ? "credential_corrupt"
          : message === "mcp-credential-unavailable"
            ? "credential_unavailable"
            : "mcp_not_ready",
    };
  }
}
