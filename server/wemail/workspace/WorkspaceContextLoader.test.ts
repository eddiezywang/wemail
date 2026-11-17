import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { WorkspaceFileSystem } from "./WorkspaceFileSystem.js";
import { WorkspaceContextLoader } from "./WorkspaceContextLoader.js";
import { createWorkspacePathPolicy } from "./WorkspacePathPolicy.js";

function freshLoader(opts: { maxTokenBudget?: number } = {}): {
  fs: WorkspaceFileSystem;
  loader: WorkspaceContextLoader;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-wcl-"));
  const policy = createWorkspacePathPolicy({ root });
  const fsys = new WorkspaceFileSystem({ policy });
  const loader = new WorkspaceContextLoader({
    fs: fsys,
    maxTokenBudget: opts.maxTokenBudget,
  });
  return { fs: fsys, loader, root };
}

test("WorkspaceContextLoader: empty workspaceInputs returns empty context", async () => {
  const { loader } = freshLoader();
  const ctx = await loader.loadFor({
    descriptor: { workspaceInputs: [] },
    accountId: "acct-1",
  });
  assert.deepEqual(ctx.sections, []);
  assert.equal(ctx.totalTokenEstimate, 0);
  assert.equal(ctx.truncated, false);
});

test("WorkspaceContextLoader: existing path returns content + non-zero token estimate", async () => {
  const { fs: w, loader } = freshLoader();
  await w.writeFile("style/voice.md", "Be terse and friendly.");
  const ctx = await loader.loadFor({
    descriptor: { workspaceInputs: ["style/voice.md"] },
    accountId: "acct-1",
  });
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0]!.path, "style/voice.md");
  assert.equal(ctx.sections[0]!.content, "Be terse and friendly.");
  assert.ok(ctx.totalTokenEstimate > 0);
  assert.equal(ctx.truncated, false);
});

test("WorkspaceContextLoader: missing path yields empty section", async () => {
  const { loader } = freshLoader();
  const ctx = await loader.loadFor({
    descriptor: { workspaceInputs: ["style/voice.md"] },
    accountId: "acct-1",
  });
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0]!.path, "style/voice.md");
  assert.equal(ctx.sections[0]!.content, "");
  assert.equal(ctx.totalTokenEstimate, 0);
});

test("WorkspaceContextLoader: cache hit avoids re-reading the file", async () => {
  const { fs: w, loader } = freshLoader();
  await w.writeFile("style/voice.md", "voice content");

  // Spy on fs.readFile by wrapping.
  let readCount = 0;
  const origRead = w.readFile.bind(w);
  (w as unknown as { readFile: (p: string) => Promise<string | null> }).readFile =
    async (p: string) => {
      readCount += 1;
      return origRead(p);
    };

  await loader.loadFor({
    descriptor: { workspaceInputs: ["style/voice.md"] },
    accountId: "acct-1",
  });
  assert.equal(readCount, 1);

  await loader.loadFor({
    descriptor: { workspaceInputs: ["style/voice.md"] },
    accountId: "acct-1",
  });
  // Cache hit — readFile must not be called a second time.
  assert.equal(readCount, 1);
});

test("WorkspaceContextLoader: cache miss when mtime changes", async () => {
  const { fs: w, loader } = freshLoader();
  await w.writeFile("style/voice.md", "v1");
  const first = await loader.loadFor({
    descriptor: { workspaceInputs: ["style/voice.md"] },
    accountId: "acct-1",
  });
  assert.equal(first.sections[0]!.content, "v1");

  // Force an mtime advance — Windows clocks have ~1s resolution for
  // some filesystems, so wait briefly.
  await new Promise((r) => setTimeout(r, 50));
  await w.writeFile("style/voice.md", "v2-updated");
  // Bump mtime to ensure resolution-related ties don't matter.
  const absPath = path.join(
    (w as unknown as { root: string }).root,
    "style",
    "voice.md",
  );
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(absPath, future, future);

  const second = await loader.loadFor({
    descriptor: { workspaceInputs: ["style/voice.md"] },
    accountId: "acct-1",
  });
  assert.equal(second.sections[0]!.content, "v2-updated");
});

test("WorkspaceContextLoader: truncates last section when over budget", async () => {
  // budget = 5 tokens => 20 char limit overall
  const { fs: w, loader } = freshLoader({ maxTokenBudget: 5 });
  await w.writeFile("a.md", "AAAA"); // 1 token
  await w.writeFile("b.md", "B".repeat(80)); // 20 tokens → too big
  const ctx = await loader.loadFor({
    descriptor: { workspaceInputs: ["a.md", "b.md"] },
    accountId: "acct-1",
  });
  assert.equal(ctx.truncated, true);
  assert.equal(ctx.sections.length, 2);
  assert.equal(ctx.sections[0]!.content, "AAAA");
  assert.ok(ctx.sections[1]!.content.length < 80);
  assert.ok(ctx.totalTokenEstimate <= 5);
});

test("WorkspaceContextLoader: truncates whole later section when earlier section already at budget", async () => {
  const { fs: w, loader } = freshLoader({ maxTokenBudget: 2 });
  await w.writeFile("first.md", "X".repeat(40)); // 10 tokens — already exceeds budget
  await w.writeFile("second.md", "YY"); // 1 token
  const ctx = await loader.loadFor({
    descriptor: { workspaceInputs: ["first.md", "second.md"] },
    accountId: "acct-1",
  });
  assert.equal(ctx.truncated, true);
  assert.ok(ctx.totalTokenEstimate <= 2);
  // first.md got tail-truncated; second.md emptied entirely.
  assert.equal(ctx.sections[1]!.content, "");
});

test("WorkspaceContextLoader: invalidate(accountId) drops cached entries for that account", async () => {
  const { fs: w, loader } = freshLoader();
  await w.writeFile("style/voice.md", "shared content");

  let readCount = 0;
  const origRead = w.readFile.bind(w);
  (w as unknown as { readFile: (p: string) => Promise<string | null> }).readFile =
    async (p: string) => {
      readCount += 1;
      return origRead(p);
    };

  await loader.loadFor({
    descriptor: { workspaceInputs: ["style/voice.md"] },
    accountId: "acct-A",
  });
  await loader.loadFor({
    descriptor: { workspaceInputs: ["style/voice.md"] },
    accountId: "acct-B",
  });
  assert.equal(readCount, 2);

  // Cache hits — neither read.
  await loader.loadFor({
    descriptor: { workspaceInputs: ["style/voice.md"] },
    accountId: "acct-A",
  });
  await loader.loadFor({
    descriptor: { workspaceInputs: ["style/voice.md"] },
    accountId: "acct-B",
  });
  assert.equal(readCount, 2);

  loader.invalidate("acct-A");

  await loader.loadFor({
    descriptor: { workspaceInputs: ["style/voice.md"] },
    accountId: "acct-A",
  });
  assert.equal(readCount, 3);
  // acct-B still cached.
  await loader.loadFor({
    descriptor: { workspaceInputs: ["style/voice.md"] },
    accountId: "acct-B",
  });
  assert.equal(readCount, 3);
});

test("WorkspaceContextLoader: each section preserves declaration order", async () => {
  const { fs: w, loader } = freshLoader();
  await w.writeFile("c.md", "see");
  await w.writeFile("a.md", "alpha");
  await w.writeFile("b.md", "beta");
  const ctx = await loader.loadFor({
    descriptor: { workspaceInputs: ["c.md", "a.md", "b.md"] },
    accountId: "acct-1",
  });
  assert.deepEqual(
    ctx.sections.map((s) => s.path),
    ["c.md", "a.md", "b.md"],
  );
});
