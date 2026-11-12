import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  WorkspaceFileSystem,
  WorkspaceFileTooLargeError,
} from "./WorkspaceFileSystem.js";
import {
  WorkspacePathEscape,
  createWorkspacePathPolicy,
} from "./WorkspacePathPolicy.js";

function freshFs(opts: { maxFileBytes?: number } = {}): {
  fs: WorkspaceFileSystem;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-wfs-"));
  const policy = createWorkspacePathPolicy({ root });
  const fsys = new WorkspaceFileSystem({
    policy,
    maxFileBytes: opts.maxFileBytes,
  });
  return { fs: fsys, root };
}

test("WorkspaceFileSystem.writeFile + readFile round-trips text", async () => {
  const { fs: w } = freshFs();
  await w.writeFile("style/voice.md", "tone: terse\n");
  assert.equal(await w.readFile("style/voice.md"), "tone: terse\n");
});

test("WorkspaceFileSystem.readFile of missing file returns null", async () => {
  const { fs: w } = freshFs();
  assert.equal(await w.readFile("missing.md"), null);
});

test("WorkspaceFileSystem.writeFile creates parent directories", async () => {
  const { fs: w, root } = freshFs();
  await w.writeFile("deep/nested/path/file.md", "x");
  assert.ok(fs.existsSync(path.join(root, "deep", "nested", "path", "file.md")));
});

test("WorkspaceFileSystem.writeFile beyond maxFileBytes throws", async () => {
  const { fs: w } = freshFs({ maxFileBytes: 16 });
  await assert.rejects(
    () => w.writeFile("big.md", "x".repeat(17)),
    WorkspaceFileTooLargeError,
  );
});

test("WorkspaceFileSystem.appendFile appends with cumulative size check", async () => {
  const { fs: w } = freshFs({ maxFileBytes: 10 });
  await w.appendFile("log.jsonl", "abcde\n"); // 6 bytes
  await w.appendFile("log.jsonl", "fg\n"); // 9 bytes total — fits
  await assert.rejects(
    () => w.appendFile("log.jsonl", "hijkl\n"),
    WorkspaceFileTooLargeError,
  );
  assert.equal(await w.readFile("log.jsonl"), "abcde\nfg\n");
});

test("WorkspaceFileSystem.writeFile is atomic (no partial reads)", async () => {
  const { fs: w } = freshFs();
  await w.writeFile("race.md", "INITIAL");
  // Kick off a long-ish write while interleaving reads. Even if a write
  // is in-flight, readFile should always return either old or new full
  // content — never a partial buffer.
  const writes: Array<Promise<void>> = [];
  for (let i = 0; i < 5; i++) {
    writes.push(w.writeFile("race.md", `payload-${i}-${"X".repeat(2000)}`));
  }
  const reads: Array<Promise<string | null>> = [];
  for (let i = 0; i < 10; i++) {
    reads.push(w.readFile("race.md"));
  }
  await Promise.all(writes);
  const observed = await Promise.all(reads);
  for (const seen of observed) {
    if (seen === null) continue;
    // Either the original or one of the new payloads.
    const isInitial = seen === "INITIAL";
    const isPayload =
      seen.startsWith("payload-") && seen.endsWith("X".repeat(2000));
    assert.ok(
      isInitial || isPayload,
      `partial read observed (length=${seen.length})`,
    );
  }
});

test("WorkspaceFileSystem.list returns files sorted by name", async () => {
  const { fs: w } = freshFs();
  await w.writeFile("data/c.md", "c");
  await w.writeFile("data/a.md", "a");
  await w.writeFile("data/b.md", "b");
  const entries = await w.list("data");
  assert.deepEqual(
    entries.map((e) => e.path),
    ["data/a.md", "data/b.md", "data/c.md"],
  );
  for (const e of entries) {
    assert.equal(e.type, "file");
    assert.ok(typeof e.size === "number");
    assert.ok(typeof e.mtime === "string");
  }
});

test("WorkspaceFileSystem.list returns empty array for missing directory", async () => {
  const { fs: w } = freshFs();
  const entries = await w.list("nonexistent");
  assert.deepEqual(entries, []);
});

test("WorkspaceFileSystem.list shallow only", async () => {
  const { fs: w } = freshFs();
  await w.writeFile("data/sub/deep.md", "x");
  await w.writeFile("data/top.md", "y");
  const entries = await w.list("data");
  // Should see "data/sub" (directory) and "data/top.md" (file). NOT data/sub/deep.md.
  const paths = entries.map((e) => e.path).sort();
  assert.deepEqual(paths, ["data/sub", "data/top.md"]);
  const subEntry = entries.find((e) => e.path === "data/sub");
  assert.equal(subEntry?.type, "directory");
});

test("WorkspaceFileSystem.stat returns mtime + size for existing file", async () => {
  const { fs: w } = freshFs();
  await w.writeFile("a.md", "hello");
  const st = await w.stat("a.md");
  assert.ok(st);
  assert.equal(st.size, 5);
  assert.equal(st.type, "file");
  assert.ok(typeof st.mtime === "string");
});

test("WorkspaceFileSystem.stat returns null for missing path", async () => {
  const { fs: w } = freshFs();
  assert.equal(await w.stat("missing.md"), null);
});

test("WorkspaceFileSystem.exists reflects file presence", async () => {
  const { fs: w } = freshFs();
  assert.equal(await w.exists("a.md"), false);
  await w.writeFile("a.md", "x");
  assert.equal(await w.exists("a.md"), true);
});

test("WorkspaceFileSystem.delete returns true when file existed, false otherwise", async () => {
  const { fs: w } = freshFs();
  await w.writeFile("a.md", "x");
  assert.equal(await w.delete("a.md"), true);
  assert.equal(await w.delete("a.md"), false);
});

test("WorkspaceFileSystem: writeFile rejects path-policy escape", async () => {
  const { fs: w } = freshFs();
  await assert.rejects(
    () => w.writeFile("../escape.md", "x"),
    (err) => err instanceof WorkspacePathEscape,
  );
});

test("WorkspaceFileSystem: readFile rejects path-policy escape", async () => {
  const { fs: w } = freshFs();
  await assert.rejects(
    () => w.readFile("../escape.md"),
    (err) => err instanceof WorkspacePathEscape,
  );
});

test("WorkspaceFileSystem: appendFile rejects path-policy escape", async () => {
  const { fs: w } = freshFs();
  await assert.rejects(
    () => w.appendFile("../escape.md", "x"),
    (err) => err instanceof WorkspacePathEscape,
  );
});

test("WorkspaceFileSystem: list emits forward-slash paths even on Windows", async () => {
  const { fs: w } = freshFs();
  await w.writeFile("nested/dir/file.md", "x");
  const entries = await w.list("nested/dir");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.path, "nested/dir/file.md");
});

test("WorkspaceFileSystem: appendFile creates new file when missing", async () => {
  const { fs: w } = freshFs();
  await w.appendFile("feedback/log.jsonl", "first\n");
  assert.equal(await w.readFile("feedback/log.jsonl"), "first\n");
});

test("WorkspaceFileSystem.list skips symlinks (does not follow them outside the workspace)", async (t) => {
  const { fs: w, root } = freshFs();
  await w.writeFile("subdir/normal.md", "ok\n");

  // Create a symlink target OUTSIDE the workspace and then a symlink
  // inside subdir/ pointing at it. Symlink creation requires either
  // admin privileges on Windows or developer mode; if it fails, skip
  // the test instead of failing CI on locked-down boxes.
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-wfs-outside-"));
  const outsideTarget = path.join(outsideDir, "secret.md");
  fs.writeFileSync(outsideTarget, "OUT-OF-SANDBOX\n");
  const linkPath = path.join(root, "subdir", "link.md");
  try {
    fs.symlinkSync(outsideTarget, linkPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "ENOENT" || code === "EACCES") {
      t.skip(`symlink not permitted on this host (${code})`);
      return;
    }
    throw err;
  }

  const entries = await w.list("subdir");
  const paths = entries.map((e) => e.path);
  assert.deepEqual(paths, ["subdir/normal.md"]);
});

// Cleanup helper — Node's tmpdir cleanup is good enough for ephemeral tests, but
// guard against leaving large amounts behind.
test("WorkspaceFileSystem teardown leaves no stray .tmp files", async () => {
  const { fs: w, root } = freshFs();
  await w.writeFile("a.md", "1");
  await w.writeFile("a.md", "2");
  const remaining = await fsp.readdir(root);
  for (const name of remaining) {
    assert.ok(
      !name.includes(".tmp."),
      `unexpected temp file left over: ${name}`,
    );
  }
});
