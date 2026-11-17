import {
  WEMAIL_MCP_PROTOCOL_VERSIONS,
  WEMAIL_MCP_SERVER_NAME,
  WEMAIL_MCP_SERVER_VERSION,
} from "../../../../shared/wemail/mcp.js";

const protocolVersion = WEMAIL_MCP_PROTOCOL_VERSIONS[0];

export const MCP_PROTOCOL_FIXTURES = Object.freeze({
  initializeRequest: {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "wemail-contract-test", version: "1.0.0" },
    },
  },
  initializeResponse: {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: {
        name: WEMAIL_MCP_SERVER_NAME,
        version: WEMAIL_MCP_SERVER_VERSION,
      },
    },
  },
  initializedNotification: {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  },
  toolsListRequest: {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  },
  structuredToolSuccess: {
    jsonrpc: "2.0",
    id: 3,
    result: {
      content: [{ type: "text", text: "Found 0 mail accounts." }],
      structuredContent: { accounts: [] },
    },
  },
  toolError: {
    jsonrpc: "2.0",
    id: 4,
    result: {
      isError: true,
      content: [{ type: "text", text: "The requested account is unavailable." }],
      structuredContent: {
        error: {
          code: "account_not_found",
          message: "The requested account is unavailable.",
          retryable: false,
        },
      },
    },
  },
  unknownMethodError: {
    jsonrpc: "2.0",
    id: 5,
    error: { code: -32601, message: "Method not found" },
  },
  authenticationFailure: {
    status: 401,
    headers: { "www-authenticate": "Bearer" },
    body: {
      error: {
        code: "authentication_required",
        message: "MCP authentication is required.",
        retryable: false,
      },
    },
  },
  sessionDelete: {
    method: "DELETE",
    path: "/mcp",
    headers: { "mcp-session-id": "fixture-session-id" },
    expectedStatus: 200,
  },
  unsupportedCapability: {
    request: { jsonrpc: "2.0", id: 6, method: "resources/list", params: {} },
    response: {
      jsonrpc: "2.0",
      id: 6,
      error: { code: -32601, message: "Method not found" },
    },
  },
});
