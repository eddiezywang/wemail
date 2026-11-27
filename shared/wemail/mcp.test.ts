import { describe, expect, it } from "vitest";
import {
  WEMAIL_MCP_CONFIGURATION_HINTS,
  WEMAIL_MCP_CONFIGURATION_LABELS,
  WEMAIL_MCP_CONFIGURATION_TARGETS,
  WEMAIL_MCP_SERVER_NAME,
  formatWemailMcpConfiguration,
} from "./mcp.js";

describe("formatWemailMcpConfiguration", () => {
  it("formats the Codex/generic server entry deterministically", () => {
    expect(
      JSON.parse(
        formatWemailMcpConfiguration({
          target: "codex",
          endpoint: "http://127.0.0.1:43129/mcp",
          token: "wmcp_test.secret",
        }),
      ),
    ).toEqual({
      "wemail-mail-mcp": {
        type: "streamablehttp",
        url: "http://127.0.0.1:43129/mcp",
        headers: { Authorization: "Bearer wmcp_test.secret" },
      },
    });
  });

  it("formats the Claude wrapper with the same endpoint and credential", () => {
    expect(
      JSON.parse(
        formatWemailMcpConfiguration({
          target: "claude",
          endpoint: "http://127.0.0.1:43129/mcp",
          token: "wmcp_test.secret",
        }),
      ),
    ).toEqual({
      mcpServers: {
        "wemail-mail-mcp": {
          type: "http",
          url: "http://127.0.0.1:43129/mcp",
          headers: { Authorization: "Bearer wmcp_test.secret" },
        },
      },
    });
  });
});

describe("formatWemailMcpConfiguration — all agent targets", () => {
  const endpoint = "http://127.0.0.1:43129/mcp";
  const token = "wmcp_test.secret";
  const headers = { Authorization: "Bearer wmcp_test.secret" };

  it("covers every advertised agent with a parseable config", () => {
    expect(WEMAIL_MCP_CONFIGURATION_TARGETS).toEqual([
      "claude", "cursor", "trae", "vscode", "windsurf",
      "codex", "opencode", "pi", "cherrystudio",
    ]);
    for (const target of WEMAIL_MCP_CONFIGURATION_TARGETS) {
      const parsed = JSON.parse(formatWemailMcpConfiguration({ target, endpoint, token }));
      expect(JSON.stringify(parsed)).toContain(WEMAIL_MCP_SERVER_NAME);
      expect(JSON.stringify(parsed)).toContain(endpoint);
    }
  });

  it("claude and pi declare type http inside mcpServers", () => {
    for (const target of ["claude", "pi"] as const) {
      const parsed = JSON.parse(formatWemailMcpConfiguration({ target, endpoint, token }));
      expect(parsed.mcpServers[WEMAIL_MCP_SERVER_NAME]).toEqual({
        type: "http", url: endpoint, headers,
      });
    }
  });

  it("cursor/trae/cherrystudio use bare url+headers inside mcpServers", () => {
    for (const target of ["cursor", "trae", "cherrystudio"] as const) {
      const parsed = JSON.parse(formatWemailMcpConfiguration({ target, endpoint, token }));
      expect(parsed.mcpServers[WEMAIL_MCP_SERVER_NAME]).toEqual({ url: endpoint, headers });
      expect(parsed.mcpServers[WEMAIL_MCP_SERVER_NAME].type).toBeUndefined();
    }
  });

  it("windsurf uses serverUrl", () => {
    const parsed = JSON.parse(formatWemailMcpConfiguration({ target: "windsurf", endpoint, token }));
    expect(parsed.mcpServers[WEMAIL_MCP_SERVER_NAME]).toEqual({ serverUrl: endpoint, headers });
  });

  it("vscode uses the servers container", () => {
    const parsed = JSON.parse(formatWemailMcpConfiguration({ target: "vscode", endpoint, token }));
    expect(parsed.servers[WEMAIL_MCP_SERVER_NAME]).toEqual({ type: "http", url: endpoint, headers });
  });

  it("opencode uses the mcp container with type remote", () => {
    const parsed = JSON.parse(formatWemailMcpConfiguration({ target: "opencode", endpoint, token }));
    expect(parsed.mcp[WEMAIL_MCP_SERVER_NAME]).toEqual({ type: "remote", url: endpoint, headers });
  });

  it("every target has a label and a hint", () => {
    for (const target of WEMAIL_MCP_CONFIGURATION_TARGETS) {
      expect(WEMAIL_MCP_CONFIGURATION_LABELS[target].length).toBeGreaterThan(0);
      expect(WEMAIL_MCP_CONFIGURATION_HINTS[target].length).toBeGreaterThan(0);
    }
  });
});
