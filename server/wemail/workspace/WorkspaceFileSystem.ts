/**
 * Sandboxed file-system facade for the per-account agent workspace.
 *
 * All read/write/list/delete operations route through a
 * {@link WorkspacePathPolicy}; clients cannot bypass the sandbox by
 * passing odd relative paths because the policy rejects `..`, absolute
 * paths, and symlink escape.
 *
 * Per-file size limits (`maxFileBytes`, default 64 KiB) protect the
 * workspace from runaway prompt-fed writes. The limit is enforced on
 * both `writeFile` (the new content) and `appendFile` (the resulting
 * file size after the append).
 *
 * Writes are atomic via a temp-file + rename pattern so concurrent
 * readers always see either the old content or the new content, never
 * a partially-written file.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import type { WorkspacePathPolicy } from "./WorkspacePathPolicy.js";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024;

export interface WorkspaceFileSystemOptions {
  policy: WorkspacePathPolicy;
  /** Max bytes per individual file write/append. Default 64 * 1024. */
  maxFileBytes?: number;
  /** Optional clock for tests. */
  now?: () => number;
}

export interface WorkspaceFileEntry {
  /** Path relative to workspace root, with '/' separators. */
  path: string;
  /** Bytes from fs.stat.size (0 for directories). */
  size: number;
  /** ISO-8601 mtime. */
  mtime: string;
  type: "file" | "directory";
}

export class WorkspaceFileTooLargeError extends Error {
  override readonly name = "WorkspaceFileTooLargeError";
  constructor(message: string) {
    super(message);
  }
}

function toForwardSlash(p: string): string {
  return p.split(path.sep).join("/");
}

function relativeFromRoot(root: string, absolute: string): string {
  const rel = path.relative(root, absolute);
  return toForwardSlash(rel);
}

export class WorkspaceFileSystem {
  private readonly policy: WorkspacePathPolicy;
  private readonly maxFileBytes: number;
  private readonly now: () => number;

  constructor(options: WorkspaceFileSystemOptions) {
    this.policy = options.policy;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.now = options.now ?? Date.now;
  }

  /** Returns the file's text contents, or null when the file does not exist. */
  async readFile(relPath: string): Promise<string | null> {
    const abs = this.policy.resolve(relPath);
    try {
      return await fs.readFile(abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") return null;
      throw err;
    }
  }

  /**
   * Atomically writes `content` to `relPath`. Creates parent
   * directories as needed. Throws WorkspaceFileTooLargeError if
   * content exceeds `maxFileBytes`.
   */
  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = this.policy.resolve(relPath);
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > this.maxFileBytes) {
      throw new WorkspaceFileTooLargeError(
        `WorkspaceFileSystem: writeFile '${relPath}' size ${byteLength} > maxFileBytes ${this.maxFileBytes}`,
      );
    }
    const dir = path.dirname(abs);
    await fs.mkdir(dir, { recursive: true });
    // Use a unique temp filename to keep concurrent writes safe even if
    // two callers race on the same logical path.
    const tmp = `${abs}.tmp.${process.pid}.${this.now()}.${Math.floor(Math.random() * 1e9)}`;
    try {
      await fs.writeFile(tmp, content, { encoding: "utf8" });
      // Windows can return EPERM/EBUSY/EACCES on rename when the target
      // is briefly held open by an antivirus / concurrent reader. Retry
      // a few times with a tiny backoff before giving up. POSIX rename
      // is atomic and won't see these codes, so this is a no-op there.
      let lastErr: unknown;
      let renamed = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          await fs.rename(tmp, abs);
          renamed = true;
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (
            code !== "EPERM" &&
            code !== "EBUSY" &&
            code !== "EACCES" &&
            code !== "ENOTEMPTY"
          ) {
            throw err;
          }
          lastErr = err;
          await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
        }
      }
      if (!renamed) {
        throw lastErr;
      }
    } catch (err) {
      // Best-effort cleanup of orphan temp file; swallow ENOENT.
      try {
        await fs.unlink(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /**
   * Appends `content` to `relPath` (creating the file if missing).
   * Refuses if the resulting file size would exceed `maxFileBytes`.
   */
  async appendFile(relPath: string, content: string): Promise<void> {
    const abs = this.policy.resolve(relPath);
    const addBytes = Buffer.byteLength(content, "utf8");
    let existingBytes = 0;
    try {
      const st = await fs.stat(abs);
      existingBytes = st.size;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    if (existingBytes + addBytes > this.maxFileBytes) {
      throw new WorkspaceFileTooLargeError(
        `WorkspaceFileSystem: appendFile '${relPath}' would exceed maxFileBytes (${existingBytes}+${addBytes} > ${this.maxFileBytes})`,
      );
    }
    const dir = path.dirname(abs);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(abs, content, { encoding: "utf8" });
  }

  /** Shallow listing of the directory at `relDir`. */
  async list(relDir: string): Promise<WorkspaceFileEntry[]> {
    const abs = this.policy.resolve(relDir);
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw err;
    }
    const entries: WorkspaceFileEntry[] = [];
    for (const dirent of dirents) {
      const childAbs = path.join(abs, dirent.name);
      try {
        // lstat (not stat) so symlinks inside the workspace are observed
        // as themselves rather than as their targets — the path policy
        // sandboxes resolve(), but list() walks the directory directly,
        // so without this check a symlink that points outside the
        // workspace would be reported as a regular file/directory.
        const lst = await fs.lstat(childAbs);
        if (lst.isSymbolicLink()) continue;
        entries.push({
          path: relativeFromRoot(this.policy.root, childAbs),
          size: lst.isFile() ? lst.size : 0,
          mtime: lst.mtime.toISOString(),
          type: lst.isDirectory() ? "directory" : "file",
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        throw err;
      }
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return entries;
  }

  /** True iff the file or directory exists. */
  async exists(relPath: string): Promise<boolean> {
    const abs = this.policy.resolve(relPath);
    try {
      await fs.stat(abs);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      throw err;
    }
  }

  /** Returns metadata for a single path, or null when missing. */
  async stat(relPath: string): Promise<WorkspaceFileEntry | null> {
    const abs = this.policy.resolve(relPath);
    try {
      const st = await fs.stat(abs);
      return {
        path: relativeFromRoot(this.policy.root, abs),
        size: st.isFile() ? st.size : 0,
        mtime: st.mtime.toISOString(),
        type: st.isDirectory() ? "directory" : "file",
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw err;
    }
  }

  /** Deletes the file at `relPath`. Returns true when removed, false when missing. */
  async delete(relPath: string): Promise<boolean> {
    const abs = this.policy.resolve(relPath);
    try {
      await fs.unlink(abs);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      throw err;
    }
  }

  /** Workspace root, exposed for tests/diagnostics. */
  get root(): string {
    return this.policy.root;
  }

  /** Configured max file size in bytes. */
  get maxBytes(): number {
    return this.maxFileBytes;
  }
}
