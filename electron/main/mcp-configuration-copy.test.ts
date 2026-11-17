import { describe, expect, it, vi } from "vitest";
import { copyMcpConfigurationWith } from "./mcp-configuration-copy.js";

describe("copyMcpConfigurationWith", () => {
  it("writes the secret configuration but returns only safe metadata", () => {
    const secret = "Bearer wmcp_private";
    const writeText = vi.fn();
    const result = copyMcpConfigurationWith({
      target: "codex",
      controller: {
        configuration: () => JSON.stringify({ Authorization: secret }),
      } as never,
      writeText,
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(secret));
    expect(result).toEqual({ ok: true, target: "codex" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects unsupported targets without reading configuration", () => {
    const configuration = vi.fn();
    const result = copyMcpConfigurationWith({
      target: "unknown",
      controller: { configuration } as never,
      writeText: vi.fn(),
    });
    expect(result).toEqual({
      ok: false,
      target: "codex",
      error: "unsupported_target",
    });
    expect(configuration).not.toHaveBeenCalled();
  });

  it.each([
    ["mcp-credential-unavailable", "credential_unavailable"],
    ["mcp-credential-corrupt", "credential_corrupt"],
    ["mcp-not-ready", "mcp_not_ready"],
  ])("maps %s to a safe error", (message, expected) => {
    const result = copyMcpConfigurationWith({
      target: "claude",
      controller: {
        configuration: () => {
          throw new Error(message);
        },
      } as never,
      writeText: vi.fn(),
    });
    expect(result).toEqual({
      ok: false,
      target: "claude",
      error: expected,
    });
  });
});
