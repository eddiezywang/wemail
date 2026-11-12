# WeMail Official Documentation Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independent `website/` project that uses Astro 5 and Starlight to publish curated Simplified Chinese WeMail documentation, accessible product animations, byte-preserved raw Markdown/MDX, and a Node 22 Docker runtime.

**Architecture:** Starlight owns Markdown/MDX routing, navigation, search, and documentation layout, while a custom Astro landing page owns the product narrative and three feature demonstrations. The build remains fully static; a post-build exporter copies public sources to `dist/raw/`, and a dependency-free Node 22 server serves only `dist/` with safe path resolution and explicit MIME/cache behavior.

**Tech Stack:** Node 22, Astro 5.18.2, Starlight 0.37.7, TypeScript 5.8.3, Node `node:test`, HTML/CSS, native browser APIs, Docker Node 22 Alpine.

## Global Constraints

- `website/` must install, test, build, and run independently from the root desktop application.
- Lock Astro to exactly `5.18.2` and Starlight to exactly `0.37.7`; Starlight `0.38.x` and newer are outside the Astro 5 compatibility boundary.
- Publish Simplified Chinese as the root locale with `lang="zh-CN"` and no locale path prefix.
- Do not traverse or copy the repository-level `docs/` directory into the site.
- Preserve every public `.md` and `.mdx` source byte-for-byte under `dist/raw/` with the same relative path and extension.
- Keep Astro output static; do not add `@astrojs/node`, SSR, a database, analytics, a CMS, or a runtime Markdown renderer.
- Use no GIF, video, external CDN, frontend framework island, or application Tailwind dependency for demonstrations.
- Animations must autoplay only while visible, expose pause/replay controls, honor `prefers-reduced-motion`, and leave a useful static completed state without JavaScript.
- MCP and other write-oriented scenes must show an explicit human-confirmation boundary.
- The Node runtime must serve only `dist/`, reject traversal, return correct Markdown/MDX MIME types, expose `/healthz`, and run as a non-root user in Docker.
- Preserve unrelated worktree changes, including `.codegraph/daemon.pid` and `.tmp-package-lock.json`.

---

## File Map

- Modify `.gitignore`: allow the independent website lockfile to be committed.
- Create `website/package.json`: independent commands and exact dependency versions.
- Create `website/package-lock.json`: npm-generated dependency lock.
- Create `website/astro.config.mjs`: static Astro/Starlight configuration, Chinese locale, sidebar, logo, and custom CSS.
- Create `website/tsconfig.json`: Astro strict TypeScript configuration.
- Create `website/src/content.config.ts`: Starlight docs collection.
- Create `website/src/assets/wemail-logo.svg`: brand mark for Starlight.
- Create `website/public/favicon.svg`: public favicon.
- Create `website/src/styles/custom.css`: Starlight brand tokens and documentation refinements.
- Create `website/src/styles/landing.css`: custom landing-page layout and responsive design.
- Create `website/src/styles/feature-demos.css`: shared demonstration scenes and timelines.
- Create `website/src/layouts/LandingLayout.astro`: standalone product landing-page shell.
- Create `website/src/components/landing/SiteHeader.astro`: landing header and navigation.
- Create `website/src/components/landing/Hero.astro`: product positioning and calls to action.
- Create `website/src/components/landing/FeatureCard.astro`: reusable static capability card.
- Create `website/src/components/demos/FeatureDemo.astro`: accessible demo frame, caption, pause, and replay controls.
- Create `website/src/components/demos/InvoiceDemo.astro`: invoice processing scene.
- Create `website/src/components/demos/McpDemo.astro`: local MCP connection and confirmation scene.
- Create `website/src/components/demos/ActionLoopDemo.astro`: summary-to-todo-to-draft scene.
- Create `website/src/components/demos/SmartTagMiniDemo.astro`: smaller smart-tag feedback scene for the AI page.
- Create `website/src/scripts/feature-demo.mjs`: pure state reducer plus DOM enhancement.
- Create `website/src/pages/index.astro`: custom official landing page.
- Create `website/scripts/export-raw-markdown.mjs`: safe raw-source exporter.
- Create `website/server.mjs`: dependency-free Node 22 static server.
- Create `website/src/content/docs/**`: curated public Markdown/MDX.
- Create `website/tests/export-raw-markdown.test.mjs`: raw export tests.
- Create `website/tests/server.test.mjs`: static server tests.
- Create `website/tests/feature-demo.test.mjs`: animation state tests.
- Create `website/tests/build-output.test.mjs`: rendered/raw production output tests.
- Create `website/Dockerfile`: multi-stage Node 22 image.
- Create `website/.dockerignore`: minimal Docker context.
- Create `website/README.md`: local, raw, server, and Docker usage.

### Task 1: Scaffold the Independent Astro 5 + Starlight Project

**Files:**
- Modify: `.gitignore`
- Create: `website/package.json`
- Generate: `website/package-lock.json`
- Create: `website/astro.config.mjs`
- Create: `website/tsconfig.json`
- Create: `website/src/content.config.ts`
- Create: `website/src/assets/wemail-logo.svg`
- Create: `website/public/favicon.svg`
- Create: `website/src/styles/custom.css`
- Create: `website/src/content/docs/getting-started/overview.md`

**Interfaces:**
- Produces an independently installable Starlight site with static directory-format output.
- Produces scripts used by later tasks: `check`, `build:site`, `export:raw`, `build`, `test`, `test:build`, `test:all`, and `start`.
- Establishes public content root `website/src/content/docs/` and output root `website/dist/`.

- [ ] **Step 1: Allow only the website npm lockfile through the root ignore rule**

Add this immediately after the existing `package-lock.json` ignore entry:

```gitignore
package-lock.json
!website/package-lock.json
```

- [ ] **Step 2: Create the independent package manifest**

Create `website/package.json`:

```json
{
  "name": "@wemail/website",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": "22.x"
  },
  "scripts": {
    "dev": "astro dev",
    "check": "astro check",
    "build:site": "astro build",
    "export:raw": "node scripts/export-raw-markdown.mjs",
    "build": "npm run build:site && npm run export:raw",
    "test": "node --test tests/export-raw-markdown.test.mjs tests/server.test.mjs tests/feature-demo.test.mjs",
    "test:build": "npm run build && node --test tests/build-output.test.mjs",
    "test:all": "npm run test && npm run check && npm run test:build",
    "start": "node server.mjs"
  },
  "dependencies": {
    "@astrojs/starlight": "0.37.7",
    "astro": "5.18.2"
  },
  "devDependencies": {
    "@astrojs/check": "0.9.9",
    "typescript": "5.8.3"
  }
}
```

- [ ] **Step 3: Create the static Starlight configuration**

Create `website/astro.config.mjs`:

```js
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: process.env.SITE_URL ?? "http://localhost:4321",
  output: "static",
  trailingSlash: "always",
  build: {
    format: "directory",
  },
  integrations: [
    starlight({
      title: "WeMail 文档",
      description: "WeMail 本地优先智能邮件客户端官方文档",
      logo: {
        src: "./src/assets/wemail-logo.svg",
        alt: "WeMail",
      },
      locales: {
        root: {
          label: "简体中文",
          lang: "zh-CN",
        },
      },
      customCss: ["./src/styles/custom.css"],
      head: [
        {
          tag: "link",
          attrs: { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
        },
      ],
      sidebar: [
        {
          label: "开始使用",
          items: [
            { label: "认识 WeMail", link: "/getting-started/overview/" },
            { label: "安装 WeMail", link: "/getting-started/install/" },
            { label: "连接邮箱", link: "/getting-started/connect-mailbox/" },
            { label: "配置 AI", link: "/getting-started/configure-ai/" },
          ],
        },
        {
          label: "核心功能",
          items: [
            { label: "WeMail AI", link: "/features/ai/" },
            { label: "发票助手", link: "/features/invoices/" },
            { label: "本地 MCP", link: "/features/mcp/" },
            { label: "Agent 与自动化", link: "/features/agent-automation/" },
          ],
        },
        {
          label: "安全与帮助",
          items: [
            { label: "安全与隐私", link: "/security/privacy/" },
            { label: "故障排查", link: "/help/troubleshooting/" },
            { label: "常见问题", link: "/help/faq/" },
          ],
        },
      ],
    }),
  ],
});
```

Create `website/tsconfig.json`:

```json
{
  "extends": "astro/tsconfigs/strict"
}
```

Create `website/src/content.config.ts`:

```ts
import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
```

- [ ] **Step 4: Add the initial brand assets and theme tokens**

Create both `website/src/assets/wemail-logo.svg` and `website/public/favicon.svg` with this SVG:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="WeMail">
  <rect width="64" height="64" rx="18" fill="#e8654f"/>
  <path d="M15 19h8l5 23h-7zm13 0h8l7 23h-7zm13 0h8l-5 23h-7z" fill="#fff8f5"/>
</svg>
```

Create `website/src/styles/custom.css`:

```css
:root {
  --sl-color-accent-low: #fff0ec;
  --sl-color-accent: #d85b46;
  --sl-color-accent-high: #642417;
  --sl-color-white: #fffaf7;
  --sl-color-gray-1: #2d2825;
  --sl-color-gray-2: #514943;
  --sl-color-gray-3: #756a63;
  --sl-color-gray-4: #a69a92;
  --sl-color-gray-5: #ded5cf;
  --sl-color-gray-6: #eee8e4;
  --sl-color-black: #fffdfb;
  --sl-font: Inter, "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;
  --sl-content-width: 52rem;
}

:root[data-theme="dark"] {
  --sl-color-accent-low: #43221d;
  --sl-color-accent: #ff8f79;
  --sl-color-accent-high: #ffe0d8;
  --sl-color-white: #f7f1ee;
  --sl-color-gray-1: #e8dfda;
  --sl-color-gray-2: #c9bdb6;
  --sl-color-gray-3: #a99c94;
  --sl-color-gray-4: #786d67;
  --sl-color-gray-5: #443c38;
  --sl-color-gray-6: #2d2826;
  --sl-color-black: #1b1817;
}

body {
  letter-spacing: 0.005em;
}

.site-title {
  font-weight: 750;
  letter-spacing: -0.02em;
}

.sl-markdown-content :is(h1, h2, h3) {
  letter-spacing: -0.025em;
}

.sl-markdown-content a:not([class]) {
  text-underline-offset: 0.2em;
}
```

- [ ] **Step 5: Add one valid document so the initial collection can build**

Create `website/src/content/docs/getting-started/overview.md`:

```md
---
title: 认识 WeMail
description: 了解 WeMail 的本地优先邮件、AI 与自动化能力。
---

WeMail 是面向 Windows 的本地优先智能邮件客户端。它连接你的 IMAP/SMTP 邮箱，在本地保存工作数据，并在你配置 AI 服务后提供摘要、行动项、智能草稿、智能标签和 Agent 能力。

## 核心能力

- 在一个桌面工作台中阅读、搜索、撰写和管理邮件。
- 对单封邮件或会话生成摘要，并提取待处理事项。
- 识别发票邮件，显示附件处理与平台状态。
- 通过仅监听本机回环地址的 MCP 服务连接兼容 AI 客户端。
- 对发送、移动、删除等高风险操作保留确认边界。

## 下一步

从[安装 WeMail](/getting-started/install/)开始，随后连接邮箱并配置你选择的 AI 服务。
```

- [ ] **Step 6: Install exact dependencies and generate the independent lockfile**

Run:

```powershell
Set-Location website
npm install
npm run check
npm run build:site
```

Expected:

- `website/package-lock.json` is created and records Astro `5.18.2` and Starlight `0.37.7`.
- `npm run check` exits 0.
- `npm run build:site` exits 0 and creates `website/dist/`.

- [ ] **Step 7: Commit the independent scaffold**

```powershell
Set-Location ..
git add .gitignore website/package.json website/package-lock.json website/astro.config.mjs website/tsconfig.json website/src/content.config.ts website/src/assets/wemail-logo.svg website/public/favicon.svg website/src/styles/custom.css website/src/content/docs/getting-started/overview.md
git commit -m "feat: scaffold official documentation site"
```

### Task 2: Export Original Markdown and MDX Safely

**Files:**
- Create: `website/scripts/export-raw-markdown.mjs`
- Create: `website/tests/export-raw-markdown.test.mjs`

**Interfaces:**
- Produces `collectMarkdownSources(sourceDir): Promise<string[]>`.
- Produces `resolveRawDestination(sourceDir, outDir, sourceFile): string`.
- Produces `assertUniqueDestinations(destinations): void`.
- Produces `exportRawMarkdown({ sourceDir, distDir }): Promise<{ count: number; files: string[] }>`.
- The package `build` script already consumes the CLI entry point after Astro output exists.

- [ ] **Step 1: Write the failing raw-export tests**

Create `website/tests/export-raw-markdown.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the raw-export test and confirm RED**

```powershell
Set-Location website
node --test tests/export-raw-markdown.test.mjs
```

Expected: FAIL because `scripts/export-raw-markdown.mjs` does not exist.

- [ ] **Step 3: Implement the exporter**

Create `website/scripts/export-raw-markdown.mjs`:

```js
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);

export async function collectMarkdownSources(sourceDir) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(absolute);
      }
    }
  }

  await visit(path.resolve(sourceDir));
  return files;
}

export function resolveRawDestination(sourceDir, outDir, sourceFile) {
  const sourceRoot = path.resolve(sourceDir);
  const source = path.resolve(sourceFile);
  const relative = path.relative(sourceRoot, source);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Source is outside the public content root: ${sourceFile}`);
  }

  const outputRoot = path.resolve(outDir);
  const destination = path.resolve(outputRoot, relative);
  if (!destination.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error(`Raw destination escaped output root: ${sourceFile}`);
  }
  return destination;
}

export function assertUniqueDestinations(destinations) {
  const seen = new Set();
  for (const destination of destinations) {
    const key = path.resolve(destination).toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Raw Markdown destination collision: ${destination}`);
    }
    seen.add(key);
  }
}

export async function exportRawMarkdown({ sourceDir, distDir }) {
  const outputStats = await stat(distDir).catch(() => null);
  if (!outputStats?.isDirectory()) {
    throw new Error(`Astro output directory does not exist: ${distDir}`);
  }

  const outDir = path.join(distDir, "raw");
  const sources = await collectMarkdownSources(sourceDir);
  const destinations = sources.map((source) =>
    resolveRawDestination(sourceDir, outDir, source),
  );
  assertUniqueDestinations(destinations);

  for (let index = 0; index < sources.length; index += 1) {
    await mkdir(path.dirname(destinations[index]), { recursive: true });
    await copyFile(sources[index], destinations[index]);
  }

  return {
    count: sources.length,
    files: destinations.map((destination) => path.relative(distDir, destination)),
  };
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === currentFile) {
  const projectRoot = path.resolve(path.dirname(currentFile), "..");
  const result = await exportRawMarkdown({
    sourceDir: path.join(projectRoot, "src", "content", "docs"),
    distDir: path.join(projectRoot, "dist"),
  });
  process.stdout.write(`Exported ${result.count} raw Markdown/MDX files.\n`);
}
```

- [ ] **Step 4: Run RED-to-GREEN verification**

```powershell
node --test tests/export-raw-markdown.test.mjs
npm run build
```

Expected: 4 tests pass; the build prints `Exported 1 raw Markdown/MDX files.` and creates `dist/raw/getting-started/overview.md`.

- [ ] **Step 5: Commit the raw source mirror**

```powershell
Set-Location ..
git add website/scripts/export-raw-markdown.mjs website/tests/export-raw-markdown.test.mjs
git commit -m "feat: export raw documentation sources"
```

### Task 3: Implement the Safe Node 22 Static Server

**Files:**
- Create: `website/server.mjs`
- Create: `website/tests/server.test.mjs`

**Interfaces:**
- Produces `contentTypeFor(filePath): string`.
- Produces `cacheControlFor(requestPath): string`.
- Produces `resolveRequestFile(rootDir, requestUrl): Promise<string | null>`.
- Produces `createStaticServer({ rootDir }): http.Server`.
- CLI consumes `PORT` and `DIST_DIR`, defaults to `4321` and `website/dist/`.

- [ ] **Step 1: Write failing server behavior and security tests**

Create `website/tests/server.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStaticServer } from "../server.mjs";

async function withServer(run) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "wemail-docs-server-"));
  await mkdir(path.join(rootDir, "guide"), { recursive: true });
  await mkdir(path.join(rootDir, "raw"), { recursive: true });
  await mkdir(path.join(rootDir, "_astro"), { recursive: true });
  await writeFile(path.join(rootDir, "index.html"), "<h1>首页</h1>");
  await writeFile(path.join(rootDir, "guide", "index.html"), "<h1>指南</h1>");
  await writeFile(path.join(rootDir, "raw", "guide.md"), "# 指南\n");
  await writeFile(path.join(rootDir, "_astro", "app.abc123.js"), "export {};\n");
  const server = createStaticServer({ rootDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run({ origin: `http://127.0.0.1:${address.port}`, port: address.port });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function rawRequest(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: requestPath, method: "GET" },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("serves directory indexes, raw Markdown, assets, and health", async () => {
  await withServer(async ({ origin }) => {
    const home = await fetch(`${origin}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /首页/);

    const guide = await fetch(`${origin}/guide/`);
    assert.equal(guide.status, 200);

    const raw = await fetch(`${origin}/raw/guide.md`);
    assert.equal(raw.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(raw.headers.get("content-disposition"), "inline");

    const asset = await fetch(`${origin}/_astro/app.abc123.js`);
    assert.match(asset.headers.get("cache-control"), /immutable/);

    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok\n");
  });
});

test("returns bounded responses for missing and unsafe paths", async () => {
  await withServer(async ({ origin, port }) => {
    const missing = await fetch(`${origin}/missing/`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "Not Found\n");

    const traversal = await rawRequest(port, "/%2e%2e/secret.txt");
    assert.equal(traversal.status, 403);
    assert.equal(traversal.body, "Forbidden\n");

    const encodedBackslash = await rawRequest(port, "/..%5csecret.txt");
    assert.equal(encodedBackslash.status, 403);
  });
});
```

- [ ] **Step 2: Run the server tests and confirm RED**

```powershell
Set-Location website
node --test tests/server.test.mjs
```

Expected: FAIL because `server.mjs` does not exist.

- [ ] **Step 3: Implement the dependency-free server**

Create `website/server.mjs`:

```js
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".md", "text/markdown; charset=utf-8"],
  [".mdx", "text/markdown; charset=utf-8"],
]);

export function contentTypeFor(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase())
    ?? "application/octet-stream";
}

export function cacheControlFor(requestPath) {
  if (requestPath.startsWith("/_astro/")) {
    return "public, max-age=31536000, immutable";
  }
  if (/\.(?:html|md|mdx)$/i.test(requestPath) || requestPath.endsWith("/")) {
    return "public, max-age=0, must-revalidate";
  }
  return "public, max-age=3600";
}

function responseHeaders(filePath, requestPath) {
  const headers = {
    "Content-Type": contentTypeFor(filePath),
    "Cache-Control": cacheControlFor(requestPath),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
  if (/\.(?:md|mdx)$/i.test(filePath)) {
    headers["Content-Disposition"] = "inline";
  }
  return headers;
}

function safeRequestSegments(requestUrl) {
  const rawPath = (requestUrl ?? "/").split(/[?#]/, 1)[0] || "/";
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    const error = new Error("Malformed request path");
    error.statusCode = 400;
    throw error;
  }
  if (decoded.includes("\0")) {
    const error = new Error("Forbidden path");
    error.statusCode = 403;
    throw error;
  }
  const normalized = decoded.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    const error = new Error("Forbidden path");
    error.statusCode = 403;
    throw error;
  }
  return { rawPath, segments };
}

export async function resolveRequestFile(rootDir, requestUrl) {
  const root = path.resolve(rootDir);
  const { segments } = safeRequestSegments(requestUrl);
  let candidate = path.resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    const error = new Error("Forbidden path");
    error.statusCode = 403;
    throw error;
  }

  let candidateStats = await stat(candidate).catch(() => null);
  if (candidateStats?.isDirectory()) {
    candidate = path.join(candidate, "index.html");
    candidateStats = await stat(candidate).catch(() => null);
  }
  return candidateStats?.isFile() ? candidate : null;
}

export function createStaticServer({ rootDir }) {
  const root = path.resolve(rootDir);
  return http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end("Method Not Allowed\n");
      return;
    }

    const requestPath = (request.url ?? "/").split(/[?#]/, 1)[0] || "/";
    if (requestPath === "/healthz") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : "ok\n");
      return;
    }

    try {
      const filePath = await resolveRequestFile(root, request.url);
      if (!filePath) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : "Not Found\n");
        return;
      }
      response.writeHead(200, responseHeaders(filePath, requestPath));
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(filePath).pipe(response);
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      const body = statusCode === 400 ? "Bad Request\n"
        : statusCode === 403 ? "Forbidden\n"
          : "Internal Server Error\n";
      response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : body);
    }
  });
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === currentFile) {
  const rootDir = path.resolve(process.env.DIST_DIR ?? path.join(path.dirname(currentFile), "dist"));
  const port = Number.parseInt(process.env.PORT ?? "4321", 10);
  const server = createStaticServer({ rootDir });
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`WeMail docs listening on http://0.0.0.0:${port}\n`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
```

- [ ] **Step 4: Run server tests and a built-site smoke request**

```powershell
node --test tests/server.test.mjs
npm run build
$process = Start-Process node -ArgumentList 'server.mjs' -WindowStyle Hidden -PassThru
try {
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4321/healthz
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4321/raw/getting-started/overview.md
} finally {
  Stop-Process -Id $process.Id
}
```

Expected: 2 tests pass; both HTTP requests return 200.

- [ ] **Step 5: Commit the runtime server**

```powershell
Set-Location ..
git add website/server.mjs website/tests/server.test.mjs
git commit -m "feat: serve documentation from Node 22"
```

### Task 4: Build the Accessible Feature Demo System

**Files:**
- Modify: `website/astro.config.mjs`
- Create: `website/src/scripts/feature-demo.mjs`
- Create: `website/tests/feature-demo.test.mjs`
- Create: `website/src/components/demos/FeatureDemo.astro`
- Create: `website/src/components/demos/InvoiceDemo.astro`
- Create: `website/src/components/demos/McpDemo.astro`
- Create: `website/src/components/demos/ActionLoopDemo.astro`
- Create: `website/src/components/demos/SmartTagMiniDemo.astro`
- Create: `website/src/styles/feature-demos.css`

**Interfaces:**
- Produces `initialDemoState(reducedMotion): DemoState`.
- Produces `reduceDemoState(state, event): DemoState`.
- Produces `demoPhase(state): "complete" | "paused" | "playing"`.
- Produces `enhanceFeatureDemos(scope = document): void`.
- `FeatureDemo.astro` accepts `title`, `description`, and `label`, and renders the default scene slot.

- [ ] **Step 1: Write the failing pure animation-state tests**

Create `website/tests/feature-demo.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  demoPhase,
  initialDemoState,
  reduceDemoState,
} from "../src/scripts/feature-demo.mjs";

test("plays only while visible and not manually paused", () => {
  let state = initialDemoState(false);
  assert.equal(demoPhase(state), "paused");
  state = reduceDemoState(state, { type: "VISIBILITY", visible: true });
  assert.equal(demoPhase(state), "playing");
  state = reduceDemoState(state, { type: "TOGGLE_PAUSE" });
  assert.equal(demoPhase(state), "paused");
});

test("reduced motion always presents the completed state", () => {
  let state = initialDemoState(true);
  state = reduceDemoState(state, { type: "VISIBILITY", visible: true });
  assert.equal(demoPhase(state), "complete");
});

test("replay clears manual pause and increments the replay key", () => {
  let state = initialDemoState(false);
  state = reduceDemoState(state, { type: "VISIBILITY", visible: true });
  state = reduceDemoState(state, { type: "TOGGLE_PAUSE" });
  state = reduceDemoState(state, { type: "REPLAY" });
  assert.equal(state.manualPaused, false);
  assert.equal(state.replayKey, 1);
  assert.equal(demoPhase(state), "playing");
});
```

- [ ] **Step 2: Run the animation tests and confirm RED**

```powershell
Set-Location website
node --test tests/feature-demo.test.mjs
```

Expected: FAIL because `src/scripts/feature-demo.mjs` does not exist.

- [ ] **Step 3: Implement the pure reducer and DOM enhancement**

Create `website/src/scripts/feature-demo.mjs`:

```js
export function initialDemoState(reducedMotion) {
  return {
    visible: false,
    manualPaused: false,
    reducedMotion: Boolean(reducedMotion),
    replayKey: 0,
  };
}

export function reduceDemoState(state, event) {
  switch (event.type) {
    case "VISIBILITY":
      return { ...state, visible: Boolean(event.visible) };
    case "TOGGLE_PAUSE":
      return { ...state, manualPaused: !state.manualPaused };
    case "REDUCED_MOTION":
      return { ...state, reducedMotion: Boolean(event.matches) };
    case "REPLAY":
      return { ...state, manualPaused: false, replayKey: state.replayKey + 1 };
    default:
      return state;
  }
}

export function demoPhase(state) {
  if (state.reducedMotion) return "complete";
  if (state.visible && !state.manualPaused) return "playing";
  return "paused";
}

function applyState(root, state) {
  const phase = demoPhase(state);
  root.dataset.demoState = phase;
  root.dataset.replayKey = String(state.replayKey);
  const pauseButton = root.querySelector("[data-demo-pause]");
  const pauseLabel = root.querySelector("[data-demo-pause-label]");
  if (pauseButton) pauseButton.setAttribute("aria-pressed", String(state.manualPaused));
  if (pauseLabel) pauseLabel.textContent = phase === "playing" ? "暂停" : "继续";
}

function enhanceFeatureDemo(root) {
  if (root.dataset.demoEnhanced === "true") return;
  root.dataset.demoEnhanced = "true";
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let state = initialDemoState(media.matches);
  const render = () => applyState(root, state);

  const observer = new IntersectionObserver(
    ([entry]) => {
      state = reduceDemoState(state, { type: "VISIBILITY", visible: entry.isIntersecting });
      render();
    },
    { threshold: 0.35 },
  );
  observer.observe(root);

  root.querySelector("[data-demo-pause]")?.addEventListener("click", () => {
    state = reduceDemoState(state, { type: "TOGGLE_PAUSE" });
    render();
  });
  root.querySelector("[data-demo-replay]")?.addEventListener("click", () => {
    state = reduceDemoState(state, { type: "REPLAY" });
    root.classList.remove("is-replaying");
    void root.offsetWidth;
    root.classList.add("is-replaying");
    render();
  });
  media.addEventListener("change", (event) => {
    state = reduceDemoState(state, { type: "REDUCED_MOTION", matches: event.matches });
    render();
  });
  render();
}

export function enhanceFeatureDemos(scope = document) {
  scope.querySelectorAll("[data-feature-demo]").forEach(enhanceFeatureDemo);
}
```

- [ ] **Step 4: Create the shared demo frame**

Create `website/src/components/demos/FeatureDemo.astro`:

```astro
---
interface Props {
  title: string;
  description: string;
  label: string;
}

const { title, description, label } = Astro.props;
---

<figure class="feature-demo" data-feature-demo data-demo-state="complete" aria-label={label}>
  <div class="feature-demo__toolbar">
    <span class="feature-demo__eyebrow">产品演示</span>
    <div class="feature-demo__controls" aria-label={`${title}动画控制`}>
      <button type="button" data-demo-pause aria-pressed="false">
        <span aria-hidden="true">Ⅱ</span>
        <span data-demo-pause-label>暂停</span>
      </button>
      <button type="button" data-demo-replay>
        <span aria-hidden="true">↻</span>
        <span>重播</span>
      </button>
    </div>
  </div>
  <div class="feature-demo__stage" aria-hidden="true">
    <slot />
  </div>
  <figcaption>
    <h3>{title}</h3>
    <p>{description}</p>
  </figcaption>
</figure>

<script>
  import { enhanceFeatureDemos } from "../../scripts/feature-demo.mjs";
  enhanceFeatureDemos();
</script>
```

- [ ] **Step 5: Create the three landing scenes and one inline scene**

Create `website/src/components/demos/InvoiceDemo.astro`:

```astro
<div class="demo-window demo-window--invoice">
  <div class="demo-window__header"><span>差旅报销邮件</span><span>AI 发票助手</span></div>
  <div class="demo-mail">
    <div class="demo-mail__copy"><b>7 月差旅电子发票</b><span></span><span></span></div>
    <ol class="demo-steps">
      <li data-scene-step="1"><strong>发现附件</strong><small>差旅电子发票.pdf</small></li>
      <li data-scene-step="2"><strong>解析信息</strong><small>¥ 1,286.00 · 上海某酒店</small></li>
      <li data-scene-step="3"><strong>核验状态</strong><small>未上传平台</small></li>
      <li data-scene-step="4"><strong>用户确认</strong><small>确认后上传</small></li>
      <li data-scene-step="5"><strong>上传完成</strong><small>状态已更新</small></li>
    </ol>
  </div>
</div>
```

Create `website/src/components/demos/McpDemo.astro`:

```astro
<div class="demo-window demo-window--mcp">
  <div class="demo-window__header"><span>设置 → MCP</span><span>127.0.0.1:3129</span></div>
  <ol class="demo-steps demo-steps--horizontal">
    <li data-scene-step="1"><strong>启用本地 MCP</strong><small>默认关闭，仅监听本机</small></li>
    <li data-scene-step="2"><strong>创建一次性 Token</strong><small>明文仅显示一次</small></li>
    <li data-scene-step="3"><strong>搜索邮件</strong><small>返回有界信封信息</small></li>
    <li class="demo-step--confirm" data-scene-step="4"><strong>人工确认</strong><small>发送草稿前明确停顿</small></li>
    <li data-scene-step="5"><strong>完成操作</strong><small>会话可随时终止</small></li>
  </ol>
</div>
```

Create `website/src/components/demos/ActionLoopDemo.astro`:

```astro
<div class="demo-window demo-window--action">
  <div class="demo-window__header"><span>项目交付会话</span><span>WeMail AI</span></div>
  <div class="demo-action-grid">
    <div data-scene-step="1"><small>长邮件会话</small><strong>12 封往来邮件</strong></div>
    <div data-scene-step="2"><small>摘要</small><strong>确认上线时间与负责人</strong></div>
    <div data-scene-step="3"><small>行动项</small><strong>周三前提交验收清单</strong></div>
    <div data-scene-step="4"><small>待办</small><strong>已加入工作台</strong></div>
    <div data-scene-step="5"><small>回复草稿</small><strong>等待你的审阅</strong></div>
  </div>
</div>
```

Create `website/src/components/demos/SmartTagMiniDemo.astro`:

```astro
<div class="smart-tag-demo" aria-label="智能标签反馈示意">
  <span class="smart-tag-demo__mail">供应商报价更新</span>
  <span class="smart-tag-demo__arrow" aria-hidden="true">→</span>
  <span class="smart-tag-demo__tag">采购</span>
  <span class="smart-tag-demo__feedback">确认 ✓</span>
  <span class="smart-tag-demo__result">匹配规则得到优化</span>
</div>
```

- [ ] **Step 6: Add complete demo styling and timelines**

Create `website/src/styles/feature-demos.css`:

```css
.feature-demo {
  --demo-accent: #e8654f;
  margin: 0;
  overflow: hidden;
  border: 1px solid rgba(99, 73, 61, 0.16);
  border-radius: 1.25rem;
  background: #fffdfb;
  box-shadow: 0 1.5rem 4rem rgba(77, 50, 37, 0.12);
}

.feature-demo__toolbar,
.demo-window__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.feature-demo__toolbar {
  min-height: 3rem;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid #eee6e1;
}

.feature-demo__eyebrow {
  color: #b94c39;
  font-size: 0.72rem;
  font-weight: 750;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}

.feature-demo__controls { display: none; gap: 0.4rem; }
[data-demo-enhanced="true"] .feature-demo__controls { display: flex; }
.feature-demo__controls button {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  min-height: 2rem;
  padding: 0.35rem 0.55rem;
  border: 1px solid #ded4ce;
  border-radius: 0.55rem;
  background: #fff;
  color: #514943;
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}
.feature-demo__controls button:focus-visible { outline: 3px solid #f6b6a8; outline-offset: 2px; }

.feature-demo__stage {
  min-height: 19rem;
  padding: clamp(1rem, 3vw, 2rem);
  background: linear-gradient(145deg, #fff8f5, #f2ebe6);
}

.feature-demo figcaption { padding: 1rem 1.1rem 1.2rem; }
.feature-demo figcaption h3 { margin: 0 0 0.35rem; color: #2d2825; font-size: 1.05rem; }
.feature-demo figcaption p { margin: 0; color: #756a63; line-height: 1.6; }

.demo-window {
  min-height: 15rem;
  overflow: hidden;
  border: 1px solid #e5dbd5;
  border-radius: 1rem;
  background: #fff;
  box-shadow: 0 1rem 2.5rem rgba(82, 57, 45, 0.12);
}
.demo-window__header { min-height: 2.5rem; padding: 0 0.85rem; border-bottom: 1px solid #eee6e1; color: #756a63; font-size: 0.72rem; }
.demo-mail { display: grid; grid-template-columns: 0.85fr 1.6fr; gap: 1rem; padding: 1rem; }
.demo-mail__copy { display: grid; align-content: start; gap: 0.65rem; padding: 0.85rem; border-radius: 0.75rem; background: #f8f4f1; color: #514943; }
.demo-mail__copy span { height: 0.35rem; border-radius: 999px; background: #ded4ce; }
.demo-mail__copy span:last-child { width: 65%; }
.demo-steps { display: grid; gap: 0.55rem; margin: 0; padding: 0; list-style: none; }
.demo-steps li,
.demo-action-grid > div {
  padding: 0.7rem 0.8rem;
  border: 1px solid #eadfd9;
  border-radius: 0.7rem;
  background: #fff;
  color: #514943;
}
.demo-steps strong,
.demo-steps small,
.demo-action-grid strong,
.demo-action-grid small { display: block; }
.demo-steps small,
.demo-action-grid small { margin-top: 0.2rem; color: #8c7f77; }
.demo-step--confirm { border-color: #e8654f !important; background: #fff1ed !important; }
.demo-steps--horizontal { grid-template-columns: repeat(5, minmax(0, 1fr)); align-items: stretch; padding: 1rem; }
.demo-action-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.65rem; padding: 1rem; }
.demo-action-grid > div:last-child { grid-column: 1 / -1; background: #fff1ed; }

[data-scene-step] { opacity: 1; transform: none; }
[data-demo-state="playing"] [data-scene-step],
.is-replaying[data-demo-state="playing"] [data-scene-step] {
  animation: demo-step 6s ease-in-out infinite both;
}
[data-demo-state="playing"] [data-scene-step="1"] { animation-delay: 0s; }
[data-demo-state="playing"] [data-scene-step="2"] { animation-delay: 0.7s; }
[data-demo-state="playing"] [data-scene-step="3"] { animation-delay: 1.4s; }
[data-demo-state="playing"] [data-scene-step="4"] { animation-delay: 2.1s; }
[data-demo-state="playing"] [data-scene-step="5"] { animation-delay: 2.8s; }

@keyframes demo-step {
  0%, 8% { opacity: 0.35; transform: translateY(0.45rem); }
  18%, 72% { opacity: 1; transform: translateY(0); box-shadow: 0 0 0 3px rgba(232, 101, 79, 0.13); }
  86%, 100% { opacity: 0.65; transform: translateY(0); box-shadow: none; }
}

.smart-tag-demo { display: flex; flex-wrap: wrap; align-items: center; gap: 0.65rem; margin-block: 1rem; padding: 1rem; border: 1px solid #eadfd9; border-radius: 0.9rem; background: #fff8f5; }
.smart-tag-demo__tag,
.smart-tag-demo__feedback { padding: 0.35rem 0.55rem; border-radius: 999px; font-weight: 700; }
.smart-tag-demo__tag { background: #ffe2da; color: #a93f2d; }
.smart-tag-demo__feedback { background: #e6f6ed; color: #28734f; }
.smart-tag-demo__result { color: #756a63; }

@media (max-width: 48rem) {
  .demo-mail { grid-template-columns: 1fr; }
  .demo-steps--horizontal { grid-template-columns: 1fr; }
  .feature-demo__stage { min-height: auto; }
}

@media (prefers-reduced-motion: reduce) {
  [data-scene-step] { animation: none !important; opacity: 1 !important; transform: none !important; }
}
```

- [ ] **Step 7: Load demo styles on Starlight feature pages**

Change the `customCss` array in `website/astro.config.mjs` to:

```js
customCss: [
  "./src/styles/custom.css",
  "./src/styles/feature-demos.css",
],
```

- [ ] **Step 8: Run the demo tests and commit**

```powershell
node --test tests/feature-demo.test.mjs
Set-Location ..
git add website/astro.config.mjs website/src/scripts/feature-demo.mjs website/tests/feature-demo.test.mjs website/src/components/demos website/src/styles/feature-demos.css
git commit -m "feat: add accessible product demonstrations"
```

Expected: 3 tests pass.

### Task 5: Build the Product-Led Landing Page

**Files:**
- Create: `website/src/layouts/LandingLayout.astro`
- Create: `website/src/components/landing/SiteHeader.astro`
- Create: `website/src/components/landing/Hero.astro`
- Create: `website/src/components/landing/FeatureCard.astro`
- Create: `website/src/styles/landing.css`
- Create: `website/src/pages/index.astro`
- Create: `website/tests/build-output.test.mjs`

**Interfaces:**
- Consumes Task 4 demo components.
- Produces `/` with exactly three major `[data-feature-demo]` figures.
- Produces shared landing component props: `FeatureCard` accepts `eyebrow`, `title`, `description`, and `href`.

- [ ] **Step 1: Write a failing production-output assertion**

Create `website/tests/build-output.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("landing page is Chinese, product-led, and contains three accessible demos", async () => {
  const html = await readFile(path.join(projectRoot, "dist", "index.html"), "utf8");
  assert.match(html, /<html[^>]+lang="zh-CN"/);
  assert.match(html, /让邮件里的工作，自动向前一步/);
  assert.equal((html.match(/<figure[^>]+data-feature-demo/g) ?? []).length, 3);
  assert.equal((html.match(/<button[^>]+data-demo-pause/g) ?? []).length, 3);
  assert.equal((html.match(/<button[^>]+data-demo-replay/g) ?? []).length, 3);
});
```

- [ ] **Step 2: Run the build assertion and confirm RED**

```powershell
Set-Location website
npm run build
node --test tests/build-output.test.mjs
```

Expected: FAIL because the custom landing page does not exist.

- [ ] **Step 3: Create the landing shell and reusable components**

Create `website/src/layouts/LandingLayout.astro`:

```astro
---
import "../styles/landing.css";
import "../styles/feature-demos.css";

interface Props {
  title: string;
  description: string;
}

const { title, description } = Astro.props;
---

<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <meta name="description" content={description} />
    <meta name="theme-color" content="#fffaf7" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <title>{title}</title>
  </head>
  <body>
    <slot />
  </body>
</html>
```

Create `website/src/components/landing/SiteHeader.astro`:

```astro
<header class="site-header">
  <a class="site-header__brand" href="/" aria-label="WeMail 首页">
    <img src="/favicon.svg" width="32" height="32" alt="" />
    <span>WeMail</span>
  </a>
  <nav aria-label="主要导航">
    <a href="#highlights">产品亮点</a>
    <a href="/getting-started/overview/">使用指南</a>
    <a href="/features/mcp/">MCP</a>
    <a class="site-header__button" href="/getting-started/install/">开始使用</a>
  </nav>
</header>
```

Create `website/src/components/landing/Hero.astro`:

```astro
<section class="hero">
  <p class="hero__eyebrow">Local-first AI Mail</p>
  <h1>让邮件里的工作，自动向前一步</h1>
  <p class="hero__copy">WeMail 在一个本地优先的 Windows 工作台中理解邮件、整理发票，并通过安全的本地 MCP 连接你的 AI 工具。</p>
  <div class="hero__actions">
    <a class="button button--primary" href="/getting-started/install/">安装 WeMail</a>
    <a class="button button--secondary" href="/getting-started/overview/">阅读文档</a>
  </div>
  <div class="hero__window" aria-hidden="true">
    <div class="hero__rail"><i></i><i class="active"></i><i></i><i></i></div>
    <div class="hero__list"><span></span><span></span><span></span><span></span></div>
    <div class="hero__message"><b>项目交付确认</b><span></span><span></span><div>AI 摘要 · 3 个行动项 · 回复草稿已就绪</div></div>
  </div>
</section>
```

Create `website/src/components/landing/FeatureCard.astro`:

```astro
---
interface Props {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
}
const { eyebrow, title, description, href } = Astro.props;
---

<a class="feature-card" href={href}>
  <span>{eyebrow}</span>
  <h3>{title}</h3>
  <p>{description}</p>
  <strong>了解更多 →</strong>
</a>
```

- [ ] **Step 4: Create the approved warm visual system**

Create `website/src/styles/landing.css`:

```css
:root { color-scheme: light; font-family: Inter, "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif; color: #2d2825; background: #fffaf7; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: radial-gradient(circle at 50% 0, #fff 0, #fffaf7 35rem, #f7f0eb 100%); }
a { color: inherit; }
.site-header { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; width: min(72rem, calc(100% - 2rem)); margin: 0 auto; padding: 0.85rem 0; background: rgba(255, 250, 247, 0.88); backdrop-filter: blur(16px); }
.site-header__brand { display: inline-flex; align-items: center; gap: 0.6rem; font-weight: 800; text-decoration: none; }
.site-header nav { display: flex; align-items: center; gap: 1rem; }
.site-header nav a { color: #625750; font-size: 0.9rem; text-decoration: none; }
.site-header__button { padding: 0.55rem 0.8rem; border-radius: 0.65rem; background: #2d2825; color: #fff !important; }
.hero { width: min(72rem, calc(100% - 2rem)); margin: 0 auto; padding: clamp(4rem, 8vw, 7rem) 0 0; text-align: center; }
.hero__eyebrow { color: #cc543f; font-size: 0.78rem; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
.hero h1 { max-width: 13ch; margin: 0.65rem auto 1rem; font-size: clamp(2.8rem, 7vw, 5.8rem); line-height: 0.98; letter-spacing: -0.06em; }
.hero__copy { max-width: 43rem; margin: 0 auto; color: #756a63; font-size: clamp(1rem, 2vw, 1.25rem); line-height: 1.75; }
.hero__actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.75rem; margin-top: 1.5rem; }
.button { display: inline-flex; padding: 0.8rem 1rem; border-radius: 0.75rem; font-weight: 750; text-decoration: none; }
.button--primary { background: #2d2825; color: #fff; }
.button--secondary { border: 1px solid #d9cdc6; background: #fff; }
.hero__window { display: grid; grid-template-columns: 4rem 14rem 1fr; min-height: 23rem; margin: 3rem auto 0; overflow: hidden; border: 1px solid #ded4ce; border-radius: 1.3rem 1.3rem 0 0; background: #fff; text-align: left; box-shadow: 0 2rem 6rem rgba(75, 47, 34, 0.16); }
.hero__rail { display: grid; align-content: start; justify-items: center; gap: 0.85rem; padding: 1rem 0; border-right: 1px solid #e9e1dc; background: #f3eeea; }
.hero__rail i { width: 1.6rem; height: 1.6rem; border-radius: 0.45rem; background: #d9cfc9; }
.hero__rail i.active { background: #e8654f; }
.hero__list { display: grid; align-content: start; gap: 0.65rem; padding: 1rem; border-right: 1px solid #eee6e1; }
.hero__list span { height: 3.2rem; border-radius: 0.65rem; background: #f6f2ef; }
.hero__list span:first-child { background: #fff0ec; }
.hero__message { display: grid; align-content: start; gap: 0.7rem; padding: 2rem; }
.hero__message > span { height: 0.5rem; border-radius: 999px; background: #e6ded9; }
.hero__message > span:nth-child(3) { width: 65%; }
.hero__message > div { margin-top: 1rem; padding: 1rem; border: 1px solid #f0c9bf; border-radius: 0.85rem; background: #fff8f5; color: #b74b37; }
.section { width: min(72rem, calc(100% - 2rem)); margin: 0 auto; padding: clamp(4rem, 8vw, 7rem) 0; }
.section__heading { max-width: 45rem; margin-bottom: 2rem; }
.section__heading span { color: #c9513d; font-weight: 800; }
.section__heading h2 { margin: 0.5rem 0; font-size: clamp(2rem, 4vw, 3.5rem); letter-spacing: -0.045em; }
.section__heading p { color: #756a63; line-height: 1.7; }
.demo-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.2rem; }
.feature-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
.feature-card { display: block; padding: 1.35rem; border: 1px solid #e5dbd5; border-radius: 1rem; background: rgba(255,255,255,0.78); text-decoration: none; }
.feature-card > span { color: #c9513d; font-size: 0.75rem; font-weight: 800; text-transform: uppercase; }
.feature-card h3 { margin: 0.55rem 0; }
.feature-card p { min-height: 4.5rem; color: #756a63; line-height: 1.6; }
.feature-card strong { color: #b44835; }
.security-callout { display: flex; align-items: center; justify-content: space-between; gap: 2rem; padding: 2rem; border-radius: 1.2rem; background: #2d2825; color: #fff; }
.security-callout p { color: #d9cec8; }
.site-footer { padding: 2rem 1rem; border-top: 1px solid #e5dbd5; color: #756a63; text-align: center; }
@media (max-width: 62rem) { .demo-grid, .feature-grid { grid-template-columns: 1fr; } .hero__window { grid-template-columns: 3.5rem 10rem 1fr; } }
@media (max-width: 42rem) { .site-header nav a:not(.site-header__button) { display: none; } .hero__window { grid-template-columns: 3rem 1fr; } .hero__list { display: none; } .security-callout { align-items: flex-start; flex-direction: column; } }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
```

- [ ] **Step 5: Compose the landing page from real product capabilities**

Create `website/src/pages/index.astro`:

```astro
---
import ActionLoopDemo from "../components/demos/ActionLoopDemo.astro";
import FeatureDemo from "../components/demos/FeatureDemo.astro";
import InvoiceDemo from "../components/demos/InvoiceDemo.astro";
import McpDemo from "../components/demos/McpDemo.astro";
import FeatureCard from "../components/landing/FeatureCard.astro";
import Hero from "../components/landing/Hero.astro";
import SiteHeader from "../components/landing/SiteHeader.astro";
import LandingLayout from "../layouts/LandingLayout.astro";
---

<LandingLayout title="WeMail 官方文档" description="WeMail 本地优先智能邮件客户端官方文档">
  <SiteHeader />
  <main>
    <Hero />
    <section class="section" id="highlights">
      <div class="section__heading">
        <span>产品亮点</span>
        <h2>从理解邮件，到安全完成工作</h2>
        <p>这些演示使用匿名示例数据，展示 WeMail 已有的发票、MCP 与 AI 工作流。</p>
      </div>
      <div class="demo-grid">
        <FeatureDemo title="AI 发票处理" description="识别附件、解析关键字段、核验状态，并在用户确认后完成上传。" label="AI 发票处理动画">
          <InvoiceDemo />
        </FeatureDemo>
        <FeatureDemo title="本地 MCP" description="通过回环地址和一次性 Token 连接 AI 客户端，在写操作前保留确认边界。" label="MCP 使用动画">
          <McpDemo />
        </FeatureDemo>
        <FeatureDemo title="邮件到行动闭环" description="把长会话转化为摘要、行动项、待办与可审阅的回复草稿。" label="邮件到行动闭环动画">
          <ActionLoopDemo />
        </FeatureDemo>
      </div>
    </section>
    <section class="section">
      <div class="section__heading"><span>探索能力</span><h2>按你的工作方式进入 WeMail</h2></div>
      <div class="feature-grid">
        <FeatureCard eyebrow="AI" title="摘要、草稿与智能标签" description="理解单封邮件和完整会话，把重要信息变成可以继续处理的结果。" href="/features/ai/" />
        <FeatureCard eyebrow="Invoice" title="发票邮件工作流" description="集中查看发票附件及其上传、失败或关联状态。" href="/features/invoices/" />
        <FeatureCard eyebrow="MCP" title="让本地 AI 工具调用邮箱" description="通过可撤销 Token、有界结果和确认策略控制能力边界。" href="/features/mcp/" />
      </div>
    </section>
    <section class="section">
      <div class="security-callout">
        <div><h2>本地优先，边界清晰</h2><p>邮箱凭据、MCP Token 和真实邮件内容不应出现在文档、日志、截图或测试示例中。</p></div>
        <a class="button button--secondary" href="/security/privacy/">查看安全模型</a>
      </div>
    </section>
  </main>
  <footer class="site-footer">WeMail 官方文档 · Apache-2.0</footer>
</LandingLayout>
```

- [ ] **Step 6: Run production output test and commit**

```powershell
npm run build
node --test tests/build-output.test.mjs
Set-Location ..
git add website/src/layouts website/src/components/landing website/src/styles/landing.css website/src/pages/index.astro website/tests/build-output.test.mjs
git commit -m "feat: add product-led documentation landing page"
```

Expected: the build test passes with three demos and Chinese page metadata.

### Task 6: Author the Curated Public Documentation

**Files:**
- Create: `website/src/content/docs/getting-started/install.md`
- Create: `website/src/content/docs/getting-started/connect-mailbox.md`
- Create: `website/src/content/docs/getting-started/configure-ai.md`
- Create: `website/src/content/docs/features/ai.mdx`
- Create: `website/src/content/docs/features/invoices.mdx`
- Create: `website/src/content/docs/features/mcp.mdx`
- Create: `website/src/content/docs/features/agent-automation.md`
- Create: `website/src/content/docs/security/privacy.md`
- Create: `website/src/content/docs/help/troubleshooting.md`
- Create: `website/src/content/docs/help/faq.md`
- Modify: `website/tests/build-output.test.mjs`

**Interfaces:**
- Consumes Task 4 scene components in MDX pages.
- Produces every route declared in Task 1's sidebar.
- Produces 11 total public content sources, including the overview from Task 1.

- [ ] **Step 1: Add installation and initial setup guides**

Create `website/src/content/docs/getting-started/install.md`:

```md
---
title: 安装 WeMail
description: 在 Windows 上安装并首次启动 WeMail。
---

## 系统要求

当前桌面安装包面向 64 位 Windows。安装前请确保你可以访问目标邮箱的 IMAP/SMTP 服务，并准备好邮箱服务商要求的应用专用密码或授权码。

## 安装步骤

1. 从你信任的 WeMail 发布渠道获取安装包。
2. 启动安装程序并选择安装位置。
3. 完成安装后启动 WeMail。
4. 按引导连接邮箱；暂时不配置 AI 也可以先使用基础邮件功能。

:::caution
只运行来源可信的安装包。如果 Windows 显示来源或发布者警告，请先核对下载渠道，不要为了继续安装而忽略未知文件的风险。
:::

## 更新与卸载

更新安装包会保留当前用户数据。卸载程序默认不应被当作安全擦除工具；如果设备需要移交，请先退出账号并按组织的数据清理流程处理本地数据目录。
```

Create `website/src/content/docs/getting-started/connect-mailbox.md`:

```md
---
title: 连接邮箱
description: 使用 IMAP 与 SMTP 将邮箱连接到 WeMail。
---

WeMail 使用 IMAP 同步邮件，使用 SMTP 发送邮件。

## 准备信息

- 邮箱地址和显示名称。
- IMAP 主机、端口与加密方式。
- SMTP 主机、端口与加密方式。
- 邮箱密码、应用专用密码或服务商授权码。

## 连接步骤

1. 打开账号设置并选择添加邮箱。
2. 输入邮箱地址与服务器信息。
3. 使用服务商推荐的 TLS 配置。
4. 保存后等待首次同步完成。
5. 发送一封测试邮件，确认收取与发送均可用。

:::danger
不要把真实邮箱密码、授权码、服务器日志或完整配置截图粘贴到问题反馈、AI 对话或代码仓库中。
:::

如果认证失败，请先确认服务商是否要求开启 IMAP/SMTP、二次验证或应用专用密码。
```

Create `website/src/content/docs/getting-started/configure-ai.md`:

```md
---
title: 配置 AI
description: 选择 AI 服务、模型与数据边界。
---

WeMail 的基础邮件功能不依赖 AI。摘要、智能标签、草稿和 Agent 功能需要你配置兼容的 AI 服务与模型。

## 配置步骤

1. 打开设置中的 AI 或模型配置。
2. 选择服务类型并填写 API 地址、密钥和模型名称。
3. 保存后运行连接测试。
4. 先用不含敏感信息的邮件验证摘要和草稿效果。

## 数据边界

WeMail 以本地优先方式保存工作数据，但你配置的 AI 服务会接收完成所选任务所需的有界上下文。使用前请确认服务商的数据保留、地域和组织合规要求。

:::tip
为不同任务选择合适的模型，并在启用自动化前先观察摘要、标签和草稿质量。
:::
```

- [ ] **Step 2: Add the AI, invoice, and MCP feature pages**

Create `website/src/content/docs/features/ai.mdx`:

```mdx
---
title: WeMail AI
description: 使用摘要、行动项、智能草稿和智能标签处理邮件。
---

import SmartTagMiniDemo from "../../../components/demos/SmartTagMiniDemo.astro";

WeMail AI 把邮件内容转换成可以继续处理的结构化结果。所有结果都应作为辅助信息，由你结合原邮件确认。

## 邮件与会话摘要

摘要帮助你快速了解主题、关键结论、风险、未决问题和行动项。会话摘要会按时间顺序读取有界内容，而不是把整个邮箱交给模型。

## 行动项与待办

识别出的行动项可以转成 WeMail 待办。创建后请检查负责人、截止时间和原始邮件引用。

## 智能草稿

智能草稿根据当前邮件、会话和你的写作偏好生成可编辑内容。草稿不会因为生成成功就自动发送。

## 智能标签

智能标签根据用户定义和反馈识别邮件。确认或拒绝标签可以形成优化证据，但优化结果仍需要可解释、可调整。

<SmartTagMiniDemo />

:::caution
摘要和分类可能遗漏上下文。涉及合同、付款、账号安全或外部承诺时，请回到原邮件核对。
:::
```

Create `website/src/content/docs/features/invoices.mdx`:

```mdx
---
title: 发票助手
description: 识别发票邮件、查看平台状态并完成用户授权的上传。
---

import FeatureDemo from "../../../components/demos/FeatureDemo.astro";
import InvoiceDemo from "../../../components/demos/InvoiceDemo.astro";

<FeatureDemo title="AI 发票处理" description="从附件识别到平台状态更新的示意流程。" label="AI 发票处理动画">
  <InvoiceDemo />
</FeatureDemo>

## 工作方式

WeMail 根据邮件主题、正文上下文、附件文件名与类型发现发票候选项。候选附件可以显示发票号码、销售方、金额、费用类型和平台处理状态等信息。

## 状态说明

- **未上传**：尚未在平台中完成上传。
- **上传失败**：最近一次上传没有成功，可查看错误并重试。
- **已上传**：当前附件已经完成上传。
- **本人已关联**：发票已关联到当前用户。
- **已被他人关联**：发票已被其他人员关联，不应重复处理。
- **状态未知**：暂时无法确认平台状态，可稍后刷新。

## 上传流程

1. 打开发票邮件并检查附件。
2. 刷新平台状态，避免重复上传。
3. 核对金额、抬头和发票号码。
4. 明确发起或确认上传。
5. 查看最终状态；失败时保留原附件并按提示重试。

:::danger
不要在文档截图、测试数据或问题报告中使用真实发票号码、税号、金额、报销账号或平台凭据。
:::
```

Create `website/src/content/docs/features/mcp.mdx`:

```mdx
---
title: 本地 MCP
description: 将当前登录邮箱安全地连接到兼容的本地 AI 客户端。
---

import FeatureDemo from "../../../components/demos/FeatureDemo.astro";
import McpDemo from "../../../components/demos/McpDemo.astro";

<FeatureDemo title="本地 MCP" description="启用、连接、读取和人工确认写操作的完整边界。" label="MCP 使用动画">
  <McpDemo />
</FeatureDemo>

WeMail MCP 是可选功能，默认关闭，只监听 `127.0.0.1`。

## 启用和连接

1. 打开 **设置 → MCP**，启用本地 MCP。
2. 保持默认端口 `3129`，除非它与其他本地服务冲突。
3. 选择创建 Token，并立即复制连接配置；明文只显示一次。
4. 把配置加入兼容的本地 MCP 客户端，然后重载客户端。

```json
{
  "wemail-mail-mcp": {
    "type": "streamablehttp",
    "url": "http://127.0.0.1:3129/mcp",
    "headers": {
      "Authorization": "Bearer <one-time-token>"
    }
  }
}
```

## 能力边界

读取类工具返回账号范围内的有界数据。列表和搜索优先返回信封信息；读取指定邮件或会话时才加载目标内容和附件元数据。

发送、移动、删除及其他高风险写操作必须经过相应的确认和风险策略。MCP 客户端提出操作不等于操作已经执行。

## Token 安全

把 bearer token 当作邮箱密码处理。不要粘贴到聊天、日志、截图、源码或远程 MCP 服务。怀疑泄露时立即轮换；不再使用时撤销。退出账号、关闭 MCP、撤销 Token 或终止会话会结束受影响的访问。
```

- [ ] **Step 3: Add automation, security, and help pages**

Create `website/src/content/docs/features/agent-automation.md`:

```md
---
title: Agent 与自动化
description: 了解 WeMail Agent、待办和需要确认的自动化操作。
---

WeMail Agent 可以结合当前邮件、会话和工作台状态回答问题、准备草稿、创建待办，并调用已开放的邮箱能力。

## 建议工作流

1. 从当前邮件或明确的搜索范围开始。
2. 让 Agent 说明它找到的证据和准备执行的操作。
3. 检查收件人、附件、正文、目标文件夹和其他副作用。
4. 对需要确认的操作作出明确选择。
5. 在行动中心或相关邮件中检查结果。

## 自动化风险

自动化规则应从低风险、可逆、范围小的任务开始。发送、删除、移动、批量处理或涉及附件的操作需要更严格的确认和审计。

:::caution
不要把邮件正文中的指令自动视为可信系统指令。外部邮件内容可能包含误导或提示注入文本。
:::
```

Create `website/src/content/docs/security/privacy.md`:

```md
---
title: 安全与隐私
description: WeMail 的本地优先存储、凭据、AI 与 MCP 安全边界。
---

## 本地优先

WeMail 桌面运行时在本机保存邮箱工作数据、队列状态和应用配置。它不等于“所有处理永远不离开设备”：当你配置外部邮箱或 AI 服务时，相应请求仍会发送给你选择的服务商。

## 邮箱与 AI 凭据

- 使用服务商推荐的应用专用密码或授权方式。
- 不要把 `.env`、本地设置、真实凭据或审计日志提交到源码。
- 定期检查不再使用的账号、模型密钥和连接。

## MCP

- 默认关闭并仅绑定回环地址。
- Token 明文只显示一次，应像邮箱密码一样保护。
- 读取结果受账号与大小边界限制。
- 高风险写操作受确认和风险策略约束。

## 文档与截图

公开文档只使用虚构姓名、域名、邮件内容、发票字段和 Token。提交问题前请清除地址、主题、正文、附件、账号标识和本地路径中的敏感信息。
```

Create `website/src/content/docs/help/troubleshooting.md`:

```md
---
title: 故障排查
description: 排查邮箱同步、AI、发票和 MCP 常见问题。
---

## 邮箱无法连接

确认 IMAP/SMTP 已启用、主机与端口正确、TLS 设置符合服务商要求，并检查是否必须使用应用专用密码。

## 邮件没有更新

检查网络和账号状态，等待当前同步结束后再手动刷新。不要在同步进行时反复修改同一账号配置。

## AI 功能不可用

检查 API 地址、密钥、模型名称和配额。用不含敏感信息的短邮件测试，并查看是否只有某一种处理器失败。

## 发票状态不更新

确认附件仍可访问，然后刷新平台状态。上传失败时先阅读错误信息；不要通过重复点击制造并发上传。

## MCP 客户端无法连接

确认本地 MCP 已启用、端口是 `3129` 或当前设置值、客户端 URL 使用 `127.0.0.1`，并检查 Token 是否已经撤销或轮换。修改配置后重载 MCP 客户端。

## 反馈问题

记录 WeMail 版本、操作步骤和经过脱敏的错误信息。不要附带真实密码、Token、邮件正文、附件或发票数据。
```

Create `website/src/content/docs/help/faq.md`:

```md
---
title: 常见问题
description: WeMail 安装、AI、数据与 MCP 的常见问题。
---

## 不配置 AI 可以使用 WeMail 吗？

可以。基础邮箱连接、同步、阅读和撰写不要求配置 AI；摘要、智能标签、草稿和 Agent 等能力需要兼容的 AI 服务。

## WeMail 会自动发送 AI 草稿吗？

生成草稿不等于发送。发送和其他高风险操作应保留清晰的用户确认边界。

## 文档中的动画是真实应用录像吗？

不是。它们是根据真实功能制作的匿名 HTML/CSS 界面示意，不包含真实邮箱、发票、Token 或账号信息。

## MCP 可以从其他设备访问吗？

默认不可以。WeMail MCP 只监听本机回环地址 `127.0.0.1`，用于当前设备上的兼容客户端。

## 如何获取原始 Markdown？

把文档页面的源路径放到 `/raw/` 下，并保留 `.md` 或 `.mdx` 扩展名。例如：`/raw/features/mcp.mdx`。

## 卸载会自动安全擦除数据吗？

不要作此假设。设备移交或报废时，应先退出账号，并使用组织认可的数据清理流程处理本地数据。
```

- [ ] **Step 4: Extend production assertions for every public route and raw source**

Append to `website/tests/build-output.test.mjs`:

```js
import { readdir } from "node:fs/promises";

async function collectExtensions(directory, extensions) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectExtensions(absolute, extensions));
    else if (extensions.has(path.extname(entry.name))) result.push(absolute);
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
```

- [ ] **Step 5: Run content, link, raw, and build verification**

```powershell
Set-Location website
npm run check
npm run test:build
```

Expected: Astro check exits 0; build-output tests confirm 11 rendered and 11 raw public documents.

- [ ] **Step 6: Commit curated official documentation**

```powershell
Set-Location ..
git add website/src/content/docs website/tests/build-output.test.mjs
git commit -m "docs: add curated WeMail user guides"
```

### Task 7: Package and Document the Node 22 Docker Image

**Files:**
- Create: `website/Dockerfile`
- Create: `website/.dockerignore`
- Create: `website/README.md`

**Interfaces:**
- Produces an image built with `docker build -t wemail-docs website`.
- Runtime exposes `4321`, runs `node server.mjs`, and contains only `dist/` plus the server entry point.

- [ ] **Step 1: Create the Docker context exclusions**

Create `website/.dockerignore`:

```dockerignore
.git
.astro
coverage
dist
node_modules
npm-debug.log*
```

- [ ] **Step 2: Create the multi-stage Node 22 image**

Create `website/Dockerfile`:

```dockerfile
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run test
RUN npm run check
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=4321
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs ./server.mjs

USER node
EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
```

- [ ] **Step 3: Document independent local and container workflows**

Create `website/README.md`:

````md
# WeMail 官方文档站

该目录是独立的 Astro 5 + Starlight 静态文档项目。

## 本地开发

```powershell
npm install
npm run dev
```

## 检查与构建

```powershell
npm run test:all
```

构建结果位于 `dist/`。渲染页面按路由输出为 `index.html`，原始 Markdown/MDX 位于 `dist/raw/`。

## 使用 Node 22 运行

```powershell
npm run build
$env:PORT = "4321"
npm start
```

健康检查：`http://127.0.0.1:4321/healthz`

## Docker

从仓库根目录执行：

```powershell
docker build -t wemail-docs website
docker run --rm -p 4321:4321 wemail-docs
```

然后访问 `http://127.0.0.1:4321/`。原始 MCP 文档示例位于 `http://127.0.0.1:4321/raw/features/mcp.mdx`。

运行时镜像只包含 `dist/` 与 `server.mjs`，并使用非 root 的 `node` 用户。
````

- [ ] **Step 4: Build and inspect the image**

Run from the repository root:

```powershell
docker build -t wemail-docs website
docker run --rm --name wemail-docs-smoke -d -p 4321:4321 wemail-docs
try {
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4321/healthz
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4321/
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4321/raw/features/mcp.mdx
  docker exec wemail-docs-smoke sh -lc 'test "$(id -u)" != 0 && test -d /app/dist && test -f /app/server.mjs && test ! -d /app/src && test ! -d /app/node_modules'
} finally {
  docker stop wemail-docs-smoke
}
```

Expected: all three requests return 200; the runtime runs non-root and contains no source tree or `node_modules`.

- [ ] **Step 5: Commit Docker packaging and operator documentation**

```powershell
git add website/Dockerfile website/.dockerignore website/README.md
git commit -m "build: package documentation in Node 22 image"
```

### Task 8: Full Verification, Review, and Push

**Files:**
- No source changes expected unless verification reveals a defect.
- Generated `website/dist/` remains ignored.

**Interfaces:**
- Consumes all previous tasks.
- Produces fresh evidence for unit tests, Astro checks, static build, raw source parity, runtime HTTP behavior, Docker contents, and repository scope.

- [ ] **Step 1: Run the complete independent website suite**

```powershell
Set-Location website
npm ci
npm run test:all
```

Expected: all Node tests pass, Astro check exits 0, and the production build succeeds.

- [ ] **Step 2: Verify representative output and absence of internal docs**

```powershell
Get-Item dist\index.html
Get-Item dist\features\mcp\index.html
Get-Item dist\raw\features\mcp.mdx
rg -n "reverse-engineering|prompt-polish|eval-rig" dist
```

Expected: the three files exist; `rg` returns no matches from internal repository documentation.

- [ ] **Step 3: Run the Node runtime smoke test**

```powershell
$process = Start-Process node -ArgumentList 'server.mjs' -WindowStyle Hidden -PassThru
try {
  (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4321/healthz).StatusCode
  (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4321/features/invoices/).StatusCode
  (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4321/raw/features/invoices.mdx).Headers.'Content-Type'
} finally {
  Stop-Process -Id $process.Id
}
```

Expected: status codes are 200 and raw MDX content type is `text/markdown; charset=utf-8`.

- [ ] **Step 4: Re-run Docker verification**

```powershell
Set-Location ..
docker build -t wemail-docs website
docker run --rm --name wemail-docs-final -d -p 4321:4321 wemail-docs
try {
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4321/healthz
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4321/raw/getting-started/overview.md
} finally {
  docker stop wemail-docs-final
}
```

Expected: image build exits 0 and both container requests return 200.

- [ ] **Step 5: Review the diff and preserve unrelated changes**

```powershell
git status --short
git diff --check HEAD~7..HEAD
git log -8 --oneline
```

Expected: only planned website files, `.gitignore`, the design spec, and this plan belong to the documentation work. `.codegraph/daemon.pid` and `.tmp-package-lock.json` remain outside commits unless the user separately requests them.

- [ ] **Step 6: Push the completed branch**

```powershell
git push origin feature_fangfangliu
```

Expected: the implementation commits are present on `origin/feature_fangfangliu`.

## Official References Consulted

- Astro configuration reference: static output, `build.format`, `site`, and `outDir`.
- Starlight pages guide: Markdown/MDX under `src/content/docs/` and custom Astro pages under `src/pages/`.
- Starlight CSS guide: `customCss` and supported theme variables.
- Starlight i18n guide: monolingual root locale with `lang: "zh-CN"`.
- npm registry metadata: Starlight `0.37.7` declares peer dependency `astro: ^5.5.0`; Starlight `0.38.x` declares Astro 6.
