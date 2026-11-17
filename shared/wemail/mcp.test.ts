import { describe, expect, it } from "vitest";
import { formatWemailMcpConfiguration } from "./mcp.js";

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
