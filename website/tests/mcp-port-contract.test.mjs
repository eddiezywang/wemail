import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const websiteRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(websiteRoot, "..");
const staleDefaultPort = String(3_000 + 129);

async function readSharedMcpDefaultPort() {
  const source = await readFile(
    path.join(repositoryRoot, "shared", "wemail", "mcp.ts"),
    "utf8",
  );
  const match = source.match(
    /export const WEMAIL_MCP_DEFAULT_PORT\s*=\s*(\d+)\s+as const;/,
  );
  assert.ok(match, "shared/wemail/mcp.ts must declare WEMAIL_MCP_DEFAULT_PORT");
  return Number(match[1]);
}

test("website MCP sources use the shared default port", async () => {
  const defaultPort = await readSharedMcpDefaultPort();
  const sources = [
    ["src/content/docs/features/mcp.mdx", 2],
    ["src/components/demos/McpDemo.astro", 1],
    ["src/content/docs/help/troubleshooting.md", 1],
  ];

  for (const [relativePath, expectedReferences] of sources) {
    const content = await readFile(path.join(websiteRoot, relativePath), "utf8");
    assert.equal(
      (content.match(new RegExp(`\\b${defaultPort}\\b`, "g")) ?? []).length,
      expectedReferences,
      `${relativePath} must use shared MCP default port ${defaultPort}`,
    );
    assert.doesNotMatch(
      content,
      new RegExp(`\\b${staleDefaultPort}\\b`),
      `${relativePath} contains stale MCP port ${staleDefaultPort}`,
    );
  }
});
