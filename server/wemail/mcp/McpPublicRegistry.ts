import type { WemailMcpError, WemailMcpV1ToolName } from "../../../shared/wemail/mcp.js";
import type { McpDomainHandler, McpToolInvocationContext } from "./McpDomainAdapters.js";
import { mapMcpError, McpDomainError } from "./McpErrorMapper.js";
import {
  WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME,
  WEMAIL_MCP_V1_TOOL_DEFINITIONS,
  type WemailMcpToolDefinition,
} from "./McpToolCatalog.js";
import { validateMcpSchema } from "./McpSchemaValidator.js";

export interface McpStructuredToolResult {
  content: Array<
    | { type: "text"; text: string; resource?: never }
    | { type: "resource"; resource: { uri: string; mimeType: string; blob: string }; text?: never }
  >;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export class McpPublicRegistry {
  constructor(
    private readonly handlers: Partial<Record<WemailMcpV1ToolName, McpDomainHandler>>,
  ) {}

  list(): readonly WemailMcpToolDefinition[] {
    return WEMAIL_MCP_V1_TOOL_DEFINITIONS;
  }

  hasHandler(name: WemailMcpV1ToolName): boolean {
    return WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.has(name) && typeof this.handlers[name] === "function";
  }

  definition(name: string): WemailMcpToolDefinition | undefined {
    return WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get(name as WemailMcpV1ToolName);
  }

  async call(
    name: string,
    input: unknown,
    context: McpToolInvocationContext,
  ): Promise<McpStructuredToolResult> {
    const definition = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get(name as WemailMcpV1ToolName);
    const handler = this.handlers[name as WemailMcpV1ToolName];
    if (!definition || !handler) {
      return this.errorResult(mapMcpError(new McpDomainError("invalid_request", "Unknown public tool.")));
    }
    const inputIssues = validateMcpSchema(definition.inputSchema, input);
    if (inputIssues.length > 0) {
      // Surface the concrete violations — callers previously only saw a bare
      // "invalid arguments" and could not tell a missing required field
      // (e.g. search_directory_contacts.accountId) from anything else.
      const detail = inputIssues.map((issue) => `${issue.path} ${issue.message}`).join("; ");
      return this.errorResult(mapMcpError(new McpDomainError("invalid_arguments", `Invalid arguments: ${detail}`)));
    }
    try {
      const output = await handler(input as Record<string, unknown>, context);
      const embedded = output && typeof output === "object" && "structuredContent" in output && "content" in output
        ? output as { structuredContent: Record<string, unknown>; content: McpStructuredToolResult["content"] }
        : undefined;
      const structured = embedded?.structuredContent ?? output;
      const outputIssues = validateMcpSchema(definition.outputSchema, structured);
      if (outputIssues.length > 0) throw new Error("mcp-handler-output-schema-violation");
      const structuredContent = structured as Record<string, unknown>;
      const content = embedded?.content ?? [{ type: "text" as const, text: this.textFallback(name as WemailMcpV1ToolName, structuredContent) }];
      const encoded = JSON.stringify({ structuredContent, content });
      if (Buffer.byteLength(encoded, "utf8") > definition.maxResponseBytes) {
        throw new McpDomainError("response_too_large", "Response too large.");
      }
      return {
        structuredContent,
        content,
      };
    } catch (error) {
      return this.errorResult(mapMcpError(error));
    }
  }

  private errorResult(error: WemailMcpError): McpStructuredToolResult {
    return {
      isError: true,
      structuredContent: { error },
      content: [{ type: "text", text: `${error.code}: ${error.message}` }],
    };
  }

  private textFallback(name: WemailMcpV1ToolName, output: Record<string, unknown>): string {
    const collection = Object.values(output).find(Array.isArray);
    if (collection) return `${name} returned ${collection.length} item(s).`;
    return `${name} completed successfully.`;
  }
}
