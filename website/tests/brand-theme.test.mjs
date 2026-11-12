import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const websiteRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(websiteRoot, "..");

async function read(relativeToWebsite) {
  const content = await readFile(path.join(websiteRoot, relativeToWebsite), "utf8");
  return content.replace(/\r\n/g, "\n");
}

test("website SVG brand assets match each other", async () => {
  const starlightLogo = await read("src/assets/wemail-logo.svg");
  const favicon = await read("public/favicon.svg");
  assert.equal(favicon, starlightLogo);
});

test("website SVG brand assets match the canonical desktop logo when available", async () => {
  const canonicalPath = path.join(repositoryRoot, "electron/assets/wemail-icon.svg");
  if (!existsSync(canonicalPath)) return;

  const canonical = (await readFile(canonicalPath, "utf8")).replace(/\r\n/g, "\n");
  const starlightLogo = await read("src/assets/wemail-logo.svg");
  const favicon = await read("public/favicon.svg");
  assert.equal(starlightLogo, canonical);
  assert.equal(favicon, canonical);
});

test("light theme uses a dark heading foreground and readable sidebar groups", async () => {
  const css = await read("src/styles/custom.css");
  assert.match(css, /--sl-color-white:\s*#2d2825;/);
  assert.match(css, /--sl-color-black:\s*#fffdfb;/);
  assert.match(css, /\.sidebar-content \.group-label \.large\s*\{[^}]*color:\s*var\(--sl-color-gray-2\);[^}]*opacity:\s*1;/s);
});

test("dark theme retains a light heading foreground", async () => {
  const css = await read("src/styles/custom.css");
  assert.match(css, /:root\[data-theme="dark"\][\s\S]*--sl-color-white:\s*#f7f1ee;/);
});

test("documentation headings use an order-independent compact scale", async () => {
  const css = await read("src/styles/custom.css");
  assert.match(css, /html:root\s*\{[^}]*--sl-text-h1:\s*1\.5rem\s*!important;[^}]*--sl-text-h2:\s*1\.25rem\s*!important;[^}]*--sl-text-h3:\s*1\.125rem\s*!important;/s);
});
