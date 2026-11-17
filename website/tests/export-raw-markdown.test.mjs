import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertUniqueDestinations,
  exportRawMarkdown,
  resolveRawDestination,
} from "../scripts/export-raw-markdown.mjs";

test("exports md and mdx byte-for-byte while preserving nested paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wemail-docs-raw-"));
  const sourceDir = path.join(root, "src");
  const distDir = path.join(root, "dist");
  await mkdir(path.join(sourceDir, "features"), { recursive: true });
  await mkdir(distDir, { recursive: true });
  const markdown = Buffer.from("---\ntitle: 安装\n---\n\n# 安装\n", "utf8");
  const mdx = Buffer.from("---\ntitle: MCP\n---\n\n<McpDemo />\n", "utf8");
  await writeFile(path.join(sourceDir, "install.md"), markdown);
  await writeFile(path.join(sourceDir, "features", "mcp.mdx"), mdx);
  await writeFile(path.join(sourceDir, "ignore.txt"), "ignore");

  const result = await exportRawMarkdown({ sourceDir, distDir });

  assert.equal(result.count, 2);
  assert.deepEqual(
    await readFile(path.join(distDir, "raw", "install.md")),
    markdown,
  );
  assert.deepEqual(
    await readFile(path.join(distDir, "raw", "features", "mcp.mdx")),
    mdx,
  );
});

test("fails when the Astro dist directory does not exist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wemail-docs-raw-"));
  const sourceDir = path.join(root, "src");
  await mkdir(sourceDir, { recursive: true });
  await assert.rejects(
    exportRawMarkdown({ sourceDir, distDir: path.join(root, "missing") }),
    /Astro output directory does not exist/,
  );
});

test("rejects sources outside the public content root", () => {
  const sourceDir = path.resolve("site", "docs");
  const outDir = path.resolve("site", "dist", "raw");
  const outside = path.resolve("private.md");
  assert.throws(
    () => resolveRawDestination(sourceDir, outDir, outside),
    /outside the public content root/,
  );
});

test("rejects case-insensitive destination collisions", () => {
  assert.throws(
    () => assertUniqueDestinations([
      path.resolve("raw", "MCP.md"),
      path.resolve("raw", "mcp.md"),
    ]),
    /Raw Markdown destination collision/,
  );
});
