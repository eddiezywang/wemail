import type { WemailMcpV1ToolName } from "../../../shared/wemail/mcp.js";

/**
 * Protocol-neutral boundary between the public MCP registry and WeMail domains.
 * Adapters receive already-validated plain data and never import JSON-RPC types.
 */
export interface McpToolInvocationContext {
  accountId: string;
  tokenId: string;
  sessionHash: string;
  signal: AbortSignal;
}

export type McpDomainHandler = (
  input: Record<string, unknown>,
  context: McpToolInvocationContext,
) => Promise<unknown> | unknown;

export interface McpEmbeddedResourceResult {
  structuredContent: Record<string, unknown>;
  content: Array<{
    type: "resource";
    resource: { uri: string; mimeType: string; blob: string };
  }>;
}

export interface McpDomainAdapter {
  readonly handlers: Partial<Record<WemailMcpV1ToolName, McpDomainHandler>>;
}

export interface McpDomainAdapters {
  account: McpDomainAdapter;
  folder: McpDomainAdapter;
  message: McpDomainAdapter;
  attachment: McpDomainAdapter;
  draft: McpDomainAdapter;
  operation: McpDomainAdapter;
  sync: McpDomainAdapter;
  todo: McpDomainAdapter;
}

export function collectMcpDomainHandlers(
  adapters: McpDomainAdapters,
): Partial<Record<WemailMcpV1ToolName, McpDomainHandler>> {
  const handlers: Partial<Record<WemailMcpV1ToolName, McpDomainHandler>> = {};
  for (const adapter of Object.values(adapters) as McpDomainAdapter[]) {
    for (const [name, handler] of Object.entries(adapter.handlers)) {
      if (handlers[name as WemailMcpV1ToolName]) {
        throw new Error(`duplicate-mcp-handler:${name}`);
      }
      handlers[name as WemailMcpV1ToolName] = handler;
    }
  }
  return handlers;
}
