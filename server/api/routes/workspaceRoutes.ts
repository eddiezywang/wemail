/**
 * Read-only workspace HTTP API (Route C / WP 3J.7).
 *
 * Exposes the per-account agent workspace tree the Curator authors
 * (style/, senders/, categories/, learnings/, etc.). v1 is read-only:
 * a recursive listing endpoint and a single-file read endpoint. All
 * sandboxing is delegated to the existing `WorkspacePathPolicy` — this
 * router never validates paths itself.
 *
 * Privacy: handlers MUST NOT log file content. Callers may pass
 * arbitrary relative paths; path-policy escapes surface as 400.
 */

import * as fs from "node:fs/promises";
import { lstatSync } from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";
import type { WorkspaceComposition } from "../../wemail/bootstrap/composition/workspace.js";
import type {
  WorkspaceFileEntry,
  WorkspaceFileSystem,
} from "../../wemail/workspace/WorkspaceFileSystem.js";
import { WorkspacePathEscape } from "../../wemail/workspace/WorkspacePathPolicy.js";

export interface WorkspaceRoutesDeps {
  workspace: WorkspaceComposition;
  /** Returns the active account id, or null if no account is logged in. */
  getActiveAccountId: () => string | null;
}

type WorkspacePresentationKind =
  | "writing-style"
  | "sender-preference"
  | "category-rule"
  | "learning-note";

const PRESENTABLE_WORKSPACE_PATHS: Array<{
  kind: WorkspacePresentationKind;
  pattern: RegExp;
}> = [
  { kind: "writing-style", pattern: /^style\/[a-z0-9][a-z0-9-]*\.md$/i },
  { kind: "sender-preference", pattern: /^senders\/[a-z0-9][a-z0-9-]*\.md$/i },
  { kind: "category-rule", pattern: /^categories\/[a-z0-9][a-z0-9-]*\.md$/i },
  { kind: "learning-note", pattern: /^learnings\/[a-z0-9][a-z0-9-]*\.md$/i },
];

function presentationKind(relPath: string): WorkspacePresentationKind | null {
  const normalized = relPath.replaceAll("\\", "/");
  return PRESENTABLE_WORKSPACE_PATHS.find(({ pattern }) => pattern.test(normalized))?.kind ?? null;
}

function projectWorkspaceContent(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:prompt|reasoning|tool|debug|trace|command|path|call[-_ ]?id)\s*:/i.test(line))
    .join("\n")
    .replace(/(?:[A-Za-z]:\\[^\s]+|\/(?:Users|home|tmp|var)\/[^\s]+)/g, "[本地路径已隐藏]")
    .replace(/\b(token|password|secret|authorization|cookie)\s*[:=]\s*\S+/gi, "$1: [已隐藏]")
    .trim()
    .slice(0, 100_000);
}

/**
 * Recursive depth-first walk of the per-account workspace.
 *
 * `WorkspaceFileSystem.list(rel)` is shallow and rejects the empty / `.`
 * path because the underlying path policy disallows naming the root
 * itself. So the top-level listing reads through `node:fs` against
 * `wsFs.root` (which the policy has already resolved to an absolute,
 * normalized path); recursive descent into named subdirectories then
 * goes back through the policy-bound `list()` so any future symlink /
 * junction inside the tree is sandbox-checked.
 */
async function listAllFiles(
  wsFs: WorkspaceFileSystem,
): Promise<WorkspaceFileEntry[]> {
  const out: WorkspaceFileEntry[] = [];
  const rootEntries = await readRoot(wsFs.root);
  for (const entry of rootEntries) {
    out.push(entry);
    if (entry.type === "directory") {
      const children = await descend(wsFs, entry.path);
      for (const c of children) out.push(c);
    }
  }
  return out;
}

async function readRoot(absRoot: string): Promise<WorkspaceFileEntry[]> {
  // Defense in depth: confirm the workspace root itself isn't a symlink
  // pointing somewhere else. The policy only validates ancestors of the
  // requested *relative* path; the absolute root is the trust anchor.
  try {
    if (lstatSync(absRoot).isSymbolicLink()) {
      throw new WorkspacePathEscape(
        "WorkspacePathPolicy: workspace root must not be a symlink",
      );
    }
  } catch (err) {
    if (err instanceof WorkspacePathEscape) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(absRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries: WorkspaceFileEntry[] = [];
  for (const dirent of dirents) {
    // Skip symlinks at the root level entirely. Following them via
    // fs.stat would leak target metadata; the policy-bound descend()
    // also rejects them when nested deeper.
    if (dirent.isSymbolicLink()) continue;
    const childAbs = path.join(absRoot, dirent.name);
    try {
      const st = await fs.lstat(childAbs);
      if (st.isSymbolicLink()) continue;
      entries.push({
        path: dirent.name,
        size: st.isFile() ? st.size : 0,
        mtime: st.mtime.toISOString(),
        type: st.isDirectory() ? "directory" : "file",
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  return entries;
}

async function descend(
  wsFs: WorkspaceFileSystem,
  relDir: string,
): Promise<WorkspaceFileEntry[]> {
  const out: WorkspaceFileEntry[] = [];
  const here = await wsFs.list(relDir);
  for (const entry of here) {
    out.push(entry);
    if (entry.type === "directory") {
      const children = await descend(wsFs, entry.path);
      for (const c of children) out.push(c);
    }
  }
  return out;
}

export function buildWorkspaceRoutes(deps: WorkspaceRoutesDeps) {
  const app = new Hono();

  app.get("/files", async (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) {
      return c.json({ ok: false, error: "no-active-account" }, 401);
    }
    const ws = deps.workspace.forAccount(accountId);
    try {
      const files = await listAllFiles(ws.fs);
      const sorted = files
        .flatMap((entry) => {
          if (entry.type !== "file") return [];
          const kind = presentationKind(entry.path);
          return kind ? [{ ...entry, kind }] : [];
        })
        .sort((a, b) => a.path.localeCompare(b.path));
      return c.json({ ok: true, files: sorted });
    } catch (err) {
      if (err instanceof WorkspacePathEscape) {
        return c.json({ ok: false, error: "invalid-path" }, 400);
      }
      // Generic code only — raw error messages can leak absolute filesystem
      // paths from the host. The detail belongs in server logs, not in
      // the response body.
      return c.json({ ok: false, error: "list-failed" }, 500);
    }
  });

  // GET /api/workspace/files/* — read a specific file. The path policy
  // enforces sandboxing; we only translate its WorkspacePathEscape into
  // a 400 invalid-path response.
  app.get("/files/*", async (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) {
      return c.json({ ok: false, error: "no-active-account" }, 401);
    }
    // Hono's wildcard `*` parameter only captures a single path segment, so
    // we extract the relative path from the resolved request path. The mount
    // point is fixed (`/api/workspace`) by the composition root; everything
    // after `/files/` is the user-supplied workspace-relative path.
    const reqPath = c.req.path;
    const marker = "/files/";
    const idx = reqPath.indexOf(marker);
    const after = idx >= 0 ? reqPath.slice(idx + marker.length) : "";
    let rel = "";
    try {
      rel = decodeURIComponent(after);
    } catch {
      return c.json({ ok: false, error: "invalid-path" }, 400);
    }
    if (!rel) return c.json({ ok: false, error: "missing-path" }, 400);
    if (rel.split(/[\\/]/u).some((segment) => segment === "..")) {
      return c.json({ ok: false, error: "invalid-path" }, 400);
    }
    const kind = presentationKind(rel);
    if (!kind) return c.json({ ok: false, error: "not-found" }, 404);

    const ws = deps.workspace.forAccount(accountId);
    try {
      const content = await ws.fs.readFile(rel);
      if (content === null) {
        return c.json({ ok: false, error: "not-found" }, 404);
      }
      return c.json({
        ok: true,
        path: rel,
        kind,
        content: projectWorkspaceContent(content),
      });
    } catch (err) {
      if (err instanceof WorkspacePathEscape) {
        return c.json({ ok: false, error: "invalid-path" }, 400);
      }
      return c.json({ ok: false, error: "read-failed" }, 500);
    }
  });

  return app;
}
