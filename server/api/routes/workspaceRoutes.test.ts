import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { composeWorkspace } from "../../wemail/bootstrap/composition/workspace.js";
import { buildWorkspaceRoutes } from "./workspaceRoutes.js";

interface Harness {
  app: Hono;
  dataDir: string;
  workspace: ReturnType<typeof composeWorkspace>;
  setActiveAccountId: (id: string | null) => void;
}

function makeHarness(opts: { initialAccountId?: string | null } = {}): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-ws-routes-"));
  const workspace = composeWorkspace({ dataDir });
  let activeId: string | null = opts.initialAccountId ?? null;
  const app = new Hono();
  app.route(
    "/api/workspace",
    buildWorkspaceRoutes({
      workspace,
      getActiveAccountId: () => activeId,
    }),
  );
  return {
    app,
    dataDir,
    workspace,
    setActiveAccountId: (id) => {
      activeId = id;
    },
  };
}

test("GET /files returns 401 when no active account", async () => {
  const { app } = makeHarness({ initialAccountId: null });
  const res = await app.request("/api/workspace/files");
  assert.equal(res.status, 401);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "no-active-account");
});

test("GET /files returns empty list for fresh workspace", async () => {
  const { app, workspace } = makeHarness({ initialAccountId: "acct-1" });
  // Touch the account workspace so its dir exists, but write nothing.
  workspace.forAccount("acct-1");
  const res = await app.request("/api/workspace/files");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; files: unknown[] };
  assert.equal(body.ok, true);
  assert.deepEqual(body.files, []);
});

test("GET /files returns nested files sorted by path", async () => {
  const { app, workspace } = makeHarness({ initialAccountId: "acct-1" });
  const ws = workspace.forAccount("acct-1");
  await ws.fs.writeFile("style/voice.md", "# voice\n");
  await ws.fs.writeFile("categories/custom.md", "# cats\n");
  const res = await app.request("/api/workspace/files");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    files: Array<{ path: string; size: number; mtime: string; type: string }>;
  };
  assert.equal(body.ok, true);
  // Both files + their parent dirs should be present.
  const paths = body.files.map((f) => f.path);
  assert.ok(paths.includes("style/voice.md"), `missing style/voice.md: ${paths.join(",")}`);
  assert.ok(paths.includes("categories/custom.md"), `missing categories/custom.md: ${paths.join(",")}`);
  // Sorted ascending.
  for (let i = 1; i < paths.length; i++) {
    assert.ok(
      paths[i - 1]!.localeCompare(paths[i]!) <= 0,
      `not sorted at ${i}: ${paths[i - 1]} vs ${paths[i]}`,
    );
  }
  // Files carry expected fields.
  const voice = body.files.find((f) => f.path === "style/voice.md");
  assert.ok(voice);
  assert.equal(voice.type, "file");
  assert.ok(voice.size > 0);
  assert.match(voice.mtime, /^\d{4}-\d{2}-\d{2}T/);
});

test("GET /files/<path> returns the file content", async () => {
  const { app, workspace } = makeHarness({ initialAccountId: "acct-1" });
  const ws = workspace.forAccount("acct-1");
  await ws.fs.writeFile("categories/custom.md", "## hello\n");
  const res = await app.request("/api/workspace/files/categories/custom.md");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    path: string;
    content: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.path, "categories/custom.md");
  assert.equal(body.content, "## hello");
});

test("GET /files/missing.md returns 404", async () => {
  const { app, workspace } = makeHarness({ initialAccountId: "acct-1" });
  workspace.forAccount("acct-1");
  const res = await app.request("/api/workspace/files/missing.md");
  assert.equal(res.status, 404);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "not-found");
});

test("GET /files/<encoded ../escape> returns 400 invalid-path", async () => {
  const { app, workspace } = makeHarness({ initialAccountId: "acct-1" });
  workspace.forAccount("acct-1");
  // %2F = '/' so the wildcard captures '../escape.md' after decoding.
  const res = await app.request("/api/workspace/files/..%2Fescape.md");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "invalid-path");
});

test("GET /files/ (empty path after prefix) returns 400 missing-path", async () => {
  const { app, workspace } = makeHarness({ initialAccountId: "acct-1" });
  workspace.forAccount("acct-1");
  const res = await app.request("/api/workspace/files/");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "missing-path");
});

test("GET /files/<path> returns 401 when no active account", async () => {
  const { app, workspace } = makeHarness({ initialAccountId: null });
  workspace.forAccount("acct-1");
  const res = await app.request("/api/workspace/files/style/voice.md");
  assert.equal(res.status, 401);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "no-active-account");
});
