import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(projectRoot, "..");
const staleMcpDefaultPort = String(3_000 + 129);

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

async function readBuiltPageStyles(route) {
  const html = await readFile(
    path.join(projectRoot, "dist", route, "index.html"),
    "utf8",
  );
  const stylesheetHrefs = [...html.matchAll(/<link\b[^>]*>/g)]
    .map(([tag]) => {
      if (!/\brel="stylesheet"/.test(tag)) return null;
      return tag.match(/\bhref="([^"]+\.css)"/)?.[1] ?? null;
    })
    .filter(Boolean);

  assert.ok(stylesheetHrefs.length > 0, `no stylesheets found for ${route}`);
  return (await Promise.all(stylesheetHrefs.map((href) => readFile(
    path.join(projectRoot, "dist", href.replace(/^\/+/, "")),
    "utf8",
  )))).join("\n");
}

test("landing page contains one real-app invoice hero and no product demo grid", async () => {
  const html = await readFile(path.join(projectRoot, "dist", "index.html"), "utf8");
  assert.match(html, /<html[^>]+lang="zh-CN"/);
  assert.match(html, /让邮件里的工作，自动向前一步/);
  assert.equal((html.match(/<figure[^>]+data-invoice-hero/g) ?? []).length, 1);
  assert.match(html, /WeMail AI/);
  assert.match(html, /上传 1 个 PDF 发票附件到发票平台/);
  assert.match(html, /上传完成：成功 1 个，失败 0 个/);
  assert.doesNotMatch(html, /id="highlights"/);
  assert.doesNotMatch(html, /产品亮点/);
  assert.equal((html.match(/<figure[^>]+data-feature-demo/g) ?? []).length, 0);
  assert.match(html, /探索能力/);
  assert.match(html, /本地优先，边界清晰/);
  // No vetted release yet: the landing page offers no installer link and the
  // zero-byte placeholder is no longer part of the built output.
  assert.equal(
    (html.match(/href="\/downloads\/WeMail-Setup\.exe"/g) ?? []).length,
    0,
  );
  await assert.rejects(
    stat(path.join(projectRoot, "dist", "downloads", "WeMail-Setup.exe")),
    { code: "ENOENT" },
  );
});

test("invoice and MCP documentation pages retain their feature demos", async () => {
  const routes = ["features/invoices", "features/mcp"];
  for (const route of routes) {
    const html = await readFile(path.join(projectRoot, "dist", route, "index.html"), "utf8");
    assert.equal((html.match(/<figure[^>]+data-feature-demo/g) ?? []).length, 1, route);
    assert.equal((html.match(/<button[^>]+data-demo-pause/g) ?? []).length, 0, route);
    assert.equal((html.match(/<button[^>]+data-demo-replay/g) ?? []).length, 0, route);
  }
});

test("built MCP guidance uses the shared default port", async () => {
  const defaultPort = await readSharedMcpDefaultPort();
  const pages = [
    "features/mcp",
    "help/troubleshooting",
  ];

  for (const route of pages) {
    const html = await readFile(
      path.join(projectRoot, "dist", route, "index.html"),
      "utf8",
    );
    assert.match(
      html,
      new RegExp(`\\b${defaultPort}\\b`),
      `${route} must render shared MCP default port ${defaultPort}`,
    );
    assert.doesNotMatch(
      html,
      new RegExp(`\\b${staleMcpDefaultPort}\\b`),
      `${route} renders stale MCP port ${staleMcpDefaultPort}`,
    );
  }
});

async function collectExtensions(directory, extensions) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectExtensions(absolute, extensions));
    } else if (extensions.has(path.extname(entry.name))) {
      result.push(absolute);
    }
  }
  return result.sort();
}

test("every curated source has rendered and byte-identical raw output", async () => {
  const sourceRoot = path.join(projectRoot, "src", "content", "docs");
  const rawRoot = path.join(projectRoot, "dist", "raw");
  const sources = await collectExtensions(sourceRoot, new Set([".md", ".mdx"]));
  const rawFiles = await collectExtensions(rawRoot, new Set([".md", ".mdx"]));
  assert.equal(sources.length, 11);
  assert.equal(rawFiles.length, sources.length);
  for (const source of sources) {
    const relative = path.relative(sourceRoot, source);
    assert.deepEqual(
      await readFile(path.join(rawRoot, relative)),
      await readFile(source),
      relative,
    );
  }
});

test("all declared documentation routes are rendered", async () => {
  const routes = [
    "getting-started/overview",
    "getting-started/install",
    "getting-started/connect-mailbox",
    "getting-started/configure-ai",
    "features/ai",
    "features/invoices",
    "features/mcp",
    "features/agent-automation",
    "security/privacy",
    "help/troubleshooting",
    "help/faq",
  ];
  for (const route of routes) {
    const html = await readFile(path.join(projectRoot, "dist", route, "index.html"), "utf8");
    assert.match(html, /lang="zh-CN"/);
  }
});

test("built documentation CSS resolves headings to the compact scale", async () => {
  const css = await readBuiltPageStyles("getting-started/connect-mailbox");
  const expectedScale = [
    ["h1", "--sl-text-h1", "1.5rem"],
    ["h2", "--sl-text-h2", "1.25rem"],
    ["h3", "--sl-text-h3", "1.125rem"],
  ];

  for (const [heading, variable, value] of expectedScale) {
    assert.match(
      css,
      new RegExp(`html:root\\{[^}]*${variable}:\\s*${value}\\s*!important(?:;|\\})`, "s"),
      `${heading} must resolve to ${value} at every viewport width`,
    );
    assert.match(
      css,
      new RegExp(`\\.sl-markdown-content ${heading}[^{}]*\\{[^}]*font-size:var\\(${variable}\\)`, "s"),
      `${heading} must consume ${variable}`,
    );
  }
});
