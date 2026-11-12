/**
 * Sandboxed path policy for the per-account workspace.
 *
 * The workspace lives at `<dataDir>/agent-workspace/<accountId>/` and
 * holds Curator-authored / user-curated context files (style guides,
 * sender notes, custom categories, feedback jsonl logs). The policy
 * exists because future Curator runs author files inside this tree —
 * an escape vulnerability would let the agent write outside its
 * sandbox.
 *
 * Rules enforced:
 *   - relative paths only (no absolute paths)
 *   - no `..` segments
 *   - no null bytes
 *   - the resolved path must be a strict descendant of `root`
 *     (root itself is rejected — only sub-paths are allowed)
 *   - every existing ancestor segment of the resolved path is checked
 *     for a symlink/junction; any link whose realpath escapes the
 *     workspace root is rejected. This closes a TOCTOU-shaped escape
 *     where an attacker could plant `link/` as a junction pointing
 *     outside the workspace and address `link/file.txt` — naïvely
 *     `lstat`ing only the leaf would return ENOENT for the missing
 *     file and miss the link in the parent.
 */

import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";

export class WorkspacePathEscape extends Error {
  override readonly name = "WorkspacePathEscape";
  constructor(message: string) {
    super(message);
  }
}

export interface WorkspacePathPolicy {
  /** Resolve a relative workspace-internal path to an absolute path. Throws on escape attempts. */
  resolve(relativePath: string): string;
  /** Same as resolve but returns null instead of throwing — used by guarded reads. */
  tryResolve(relativePath: string): string | null;
  /** The absolute root directory, normalized. */
  readonly root: string;
}

export interface WorkspacePathPolicyOptions {
  /** Absolute root, e.g. <dataDir>/agent-workspace/<accountId>/. */
  root: string;
}

function withSeparator(p: string): string {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

export function createWorkspacePathPolicy(
  options: WorkspacePathPolicyOptions,
): WorkspacePathPolicy {
  if (!options.root || options.root.length === 0) {
    throw new Error("WorkspacePathPolicy: root must be a non-empty path");
  }
  if (!path.isAbsolute(options.root)) {
    throw new Error(
      `WorkspacePathPolicy: root must be absolute, got '${options.root}'`,
    );
  }
  const normalizedRoot = path.normalize(path.resolve(options.root));
  const normalizedRootWithSep = withSeparator(normalizedRoot);

  function realRoot(): string {
    try {
      return path.normalize(realpathSync(normalizedRoot));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return normalizedRoot;
      throw err;
    }
  }

  function isWithinRoot(p: string): boolean {
    const normalizedPath = path.normalize(p);
    const root = realRoot();
    const rootWithSep = withSeparator(root);
    return normalizedPath === root || normalizedPath.startsWith(rootWithSep);
  }

  function resolve(relativePath: string): string {
    if (typeof relativePath !== "string") {
      throw new WorkspacePathEscape(
        `WorkspacePathPolicy: relativePath must be a string`,
      );
    }
    if (relativePath.length === 0) {
      throw new WorkspacePathEscape(
        "WorkspacePathPolicy: empty path is not allowed",
      );
    }
    if (relativePath.includes("\0")) {
      throw new WorkspacePathEscape(
        "WorkspacePathPolicy: null bytes are not allowed in paths",
      );
    }
    if (path.isAbsolute(relativePath)) {
      throw new WorkspacePathEscape(
        `WorkspacePathPolicy: absolute path '${relativePath}' is not allowed`,
      );
    }
    // Reject any explicit `..` segment up-front, even if normalize would
    // happen to keep it inside root. Defense-in-depth.
    const segments = relativePath.split(/[\\/]/);
    if (segments.some((s) => s === "..")) {
      throw new WorkspacePathEscape(
        `WorkspacePathPolicy: '..' segments are not allowed in '${relativePath}'`,
      );
    }

    const joined = path.normalize(path.resolve(normalizedRoot, relativePath));

    if (joined === normalizedRoot) {
      throw new WorkspacePathEscape(
        "WorkspacePathPolicy: cannot operate on the workspace root itself",
      );
    }
    if (!joined.startsWith(normalizedRootWithSep)) {
      throw new WorkspacePathEscape(
        `WorkspacePathPolicy: '${relativePath}' resolves outside workspace root`,
      );
    }

    checkRootAnchor();
    checkAncestorChain(joined, relativePath);

    return joined;
  }

  function checkRootAnchor(): void {
    try {
      const lst = lstatSync(normalizedRoot);
      if (lst.isSymbolicLink()) {
        throw new WorkspacePathEscape(
          "WorkspacePathPolicy: workspace root must not be a symlink",
        );
      }
    } catch (err) {
      if (err instanceof WorkspacePathEscape) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw err;
    }
  }

  /**
   * Walk every existing ancestor segment from `normalizedRoot` toward
   * `joined`. For each, lstat — if it is a symlink (or, on Windows, a
   * directory junction, which lstat reports as a symlink) require its
   * realpath to stay under `normalizedRoot`. ENOENT for the leaf is
   * fine (creating a new file) and ENOENT for any non-leaf ancestor
   * implies all later ancestors are also missing, so we can stop early.
   */
  function checkAncestorChain(joined: string, relativePath: string): void {
    const rel = path.relative(normalizedRoot, joined);
    const parts = rel.split(path.sep).filter((p) => p.length > 0);
    let cursor = normalizedRoot;
    for (let i = 0; i < parts.length; i++) {
      cursor = path.join(cursor, parts[i]!);
      let lst: import("node:fs").Stats;
      try {
        lst = lstatSync(cursor);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return; // no further existing ancestors
        // For permission errors etc., let the caller see the failure
        // when it actually performs the I/O. Path-shape is fine.
        return;
      }
      if (lst.isSymbolicLink()) {
        let real: string;
        try {
          real = path.normalize(realpathSync(cursor));
        } catch {
          // Dangling symlink; treat as escape because we cannot
          // verify the target is under root.
          throw new WorkspacePathEscape(
            `WorkspacePathPolicy: ancestor '${parts.slice(0, i + 1).join("/")}' of '${relativePath}' is a dangling symlink`,
          );
        }
        if (!isWithinRoot(real)) {
          throw new WorkspacePathEscape(
            `WorkspacePathPolicy: ancestor '${parts.slice(0, i + 1).join("/")}' of '${relativePath}' is a symlink targeting outside workspace root`,
          );
        }
      }
    }
  }

  function tryResolve(relativePath: string): string | null {
    try {
      return resolve(relativePath);
    } catch (err) {
      if (err instanceof WorkspacePathEscape) return null;
      throw err;
    }
  }

  return {
    resolve,
    tryResolve,
    root: normalizedRoot,
  };
}
