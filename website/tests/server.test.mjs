import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
    await run({ origin: `http://127.0.0.1:${address.port}`, port: address.port, rootDir });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(rootDir, { recursive: true, force: true });
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

test("rejects links that resolve outside the site root", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "wemail-docs-outside-"));
  try {
    await writeFile(path.join(outside, "private.txt"), "private content");
    await withServer(async ({ port, rootDir }) => {
      await symlink(outside, path.join(rootDir, "external"), "junction");
      const result = await rawRequest(port, "/external/private.txt");
      assert.equal(result.status, 403);
      assert.doesNotMatch(result.body, /private content/);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
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
