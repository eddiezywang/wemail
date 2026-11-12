/**
 * Append-only audit channel for the Mail Curator (Route C / WP J.5).
 *
 * Spec §安全模型 #5 requires "one line per run to <dataDir>/audit.log".
 * We carve out a dedicated file (not the SQLite-backed wecli audit log
 * or the email-scoped intelligence_audit_log) because the Curator runs
 * are per-account-process events with no email_id, and a flat JSONL
 * file is the simplest format for an offline reviewer to scan.
 *
 * The default file-backed implementation creates `<dataDir>/audit.log`
 * lazily on first append. Tests inject an in-memory implementation to
 * assert the shape of each line without touching disk.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

export interface CuratorAuditLogger {
  /**
   * Append one structured event as a single newline-terminated JSON
   * object. Implementations MUST NOT throw; failures should be swallowed
   * (audit is best-effort and never blocks a run).
   */
  append(event: Record<string, unknown>): Promise<void>;
}

/**
 * Default file-backed logger. Writes JSONL to `<dataDir>/audit.log`.
 */
export class FileCuratorAuditLogger implements CuratorAuditLogger {
  private readonly logPath: string;

  constructor(opts: { dataDir: string }) {
    this.logPath = path.join(opts.dataDir, "audit.log");
  }

  async append(event: Record<string, unknown>): Promise<void> {
    try {
      const dir = path.dirname(this.logPath);
      await fsp.mkdir(dir, { recursive: true });
      const line = `${JSON.stringify(event)}\n`;
      await fsp.appendFile(this.logPath, line, { encoding: "utf8" });
    } catch {
      // Audit is best-effort — never propagate an error to the caller.
    }
  }

  /** Used by tests to read back the JSONL file. */
  get path(): string {
    return this.logPath;
  }
}

/** No-op logger used when audit is not wired. */
export const noopCuratorAuditLogger: CuratorAuditLogger = {
  async append() {
    /* drop */
  },
};
