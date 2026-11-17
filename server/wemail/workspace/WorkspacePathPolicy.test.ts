import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  WorkspacePathEscape,
  createWorkspacePathPolicy,
} from "./WorkspacePathPolicy.js";

function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wemail-wpp-"));
}

test("WorkspacePathPolicy.resolve returns absolute path under root", () => {
  const root = freshRoot();
  const policy = createWorkspacePathPolicy({ root });
  const resolved = policy.resolve("style/voice.md");
  assert.equal(resolved, path.normalize(path.join(root, "style/voice.md")));
});

test("WorkspacePathPolicy.resolve rejects ../escape", () => {
  const root = freshRoot();
  const policy = createWorkspacePathPolicy({ root });
  assert.throws(() => policy.resolve("../escape"), WorkspacePathEscape);
  assert.throws(() => policy.resolve("style/../../escape"), WorkspacePathEscape);
  assert.throws(() => policy.resolve("..\\escape"), WorkspacePathEscape);
});

test("WorkspacePathPolicy.resolve rejects absolute paths", () => {
  const root = freshRoot();
  const policy = createWorkspacePathPolicy({ root });
  assert.throws(() => policy.resolve("/etc/passwd"), WorkspacePathEscape);
  if (process.platform === "win32") {
    assert.throws(() => policy.resolve("C:\\Windows\\system32"), WorkspacePathEscape);
  }
});

test("WorkspacePathPolicy.resolve rejects empty path", () => {
  const root = freshRoot();
  const policy = createWorkspacePathPolicy({ root });
  assert.throws(() => policy.resolve(""), WorkspacePathEscape);
});

test("WorkspacePathPolicy.resolve rejects path with null byte", () => {
  const root = freshRoot();
  const policy = createWorkspacePathPolicy({ root });
  assert.throws(() => policy.resolve("style/voice\0.md"), WorkspacePathEscape);
});

test("WorkspacePathPolicy.resolve rejects root itself", () => {
  const root = freshRoot();
  const policy = createWorkspacePathPolicy({ root });
  assert.throws(() => policy.resolve("."), WorkspacePathEscape);
});

test("WorkspacePathPolicy.tryResolve returns null on escape", () => {
  const root = freshRoot();
  const policy = createWorkspacePathPolicy({ root });
  assert.equal(policy.tryResolve("../escape"), null);
  assert.equal(policy.tryResolve(""), null);
  // Valid path still resolves
  assert.equal(
    policy.tryResolve("ok.md"),
    path.normalize(path.join(root, "ok.md")),
  );
});

test("WorkspacePathPolicy: symlink target outside root is rejected", async () => {
  const root = freshRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-wpp-out-"));
  await fsp.writeFile(path.join(outside, "secret.txt"), "secret");
  const linkAt = path.join(root, "leak.md");
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), linkAt, "file");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Windows non-admin can't create symlinks; skip.
    if (code === "EPERM" || code === "ENOSYS" || code === "EACCES") return;
    throw err;
  }
  const policy = createWorkspacePathPolicy({ root });
  assert.throws(() => policy.resolve("leak.md"), WorkspacePathEscape);
});

test("WorkspacePathPolicy: symlink target inside root is allowed", async () => {
  const root = freshRoot();
  await fsp.mkdir(path.join(root, "sub"), { recursive: true });
  await fsp.writeFile(path.join(root, "sub", "real.md"), "ok");
  const linkAt = path.join(root, "alias.md");
  try {
    fs.symlinkSync(path.join(root, "sub", "real.md"), linkAt, "file");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "ENOSYS" || code === "EACCES") return;
    throw err;
  }
  const policy = createWorkspacePathPolicy({ root });
  // Should not throw — realpath stays under root.
  const resolved = policy.resolve("alias.md");
  assert.equal(resolved, path.normalize(path.join(root, "alias.md")));
});

test("WorkspacePathPolicy: symlinked workspace root is rejected", () => {
  const base = freshRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-wpp-out-"));
  const rootLink = path.join(base, "root-link");
  try {
    fs.symlinkSync(outside, rootLink, "junction");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "ENOSYS" || code === "EACCES") return;
    throw err;
  }
  const policy = createWorkspacePathPolicy({ root: rootLink });
  assert.throws(() => policy.resolve("escape.md"), WorkspacePathEscape);
});

test("WorkspacePathPolicy: requires absolute root", () => {
  assert.throws(() => createWorkspacePathPolicy({ root: "" }));
  assert.throws(() => createWorkspacePathPolicy({ root: "relative/dir" }));
});

test("WorkspacePathPolicy: ancestor symlink targeting outside root is rejected (leaf missing)", async () => {
  const root = freshRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-wpp-out-"));
  // Symlink/junction inside the workspace pointing OUTSIDE the workspace.
  const linkAt = path.join(root, "link");
  let symlinkSupported = true;
  try {
    // 'junction' is a Windows-friendly equivalent for directory targets;
    // on POSIX node uses 'dir' regardless when the target is a directory.
    fs.symlinkSync(outside, linkAt, "junction");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "ENOSYS" || code === "EACCES") {
      symlinkSupported = false;
    } else {
      throw err;
    }
  }
  if (!symlinkSupported) return;
  const policy = createWorkspacePathPolicy({ root });
  // Leaf does not exist — pre-fix this passed silently.
  assert.throws(
    () => policy.resolve("link/file.txt"),
    WorkspacePathEscape,
  );
});

test("WorkspacePathPolicy: ancestor symlink pointing back inside root is allowed", async () => {
  const root = freshRoot();
  await fsp.mkdir(path.join(root, "sub"), { recursive: true });
  const linkAt = path.join(root, "link");
  let symlinkSupported = true;
  try {
    fs.symlinkSync(path.join(root, "sub"), linkAt, "junction");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "ENOSYS" || code === "EACCES") {
      symlinkSupported = false;
    } else {
      throw err;
    }
  }
  if (!symlinkSupported) return;
  const policy = createWorkspacePathPolicy({ root });
  // realpath stays under root — should not throw, even though leaf is
  // missing.
  const resolved = policy.resolve("link/file.txt");
  assert.equal(
    resolved,
    path.normalize(path.join(root, "link", "file.txt")),
  );
});

test("WorkspacePathPolicy: ancestor symlink one level deep is rejected", async () => {
  const root = freshRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-wpp-out-"));
  await fsp.mkdir(path.join(root, "style"), { recursive: true });
  const linkAt = path.join(root, "style", "link");
  let symlinkSupported = true;
  try {
    fs.symlinkSync(outside, linkAt, "junction");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "ENOSYS" || code === "EACCES") {
      symlinkSupported = false;
    } else {
      throw err;
    }
  }
  if (!symlinkSupported) return;
  const policy = createWorkspacePathPolicy({ root });
  assert.throws(
    () => policy.resolve("style/link/file.txt"),
    WorkspacePathEscape,
  );
});

test("WorkspacePathPolicy: deep non-symlinked path still resolves", () => {
  const root = freshRoot();
  fs.mkdirSync(path.join(root, "style"), { recursive: true });
  const policy = createWorkspacePathPolicy({ root });
  assert.equal(
    policy.resolve("style/voice.md"),
    path.normalize(path.join(root, "style", "voice.md")),
  );
});
