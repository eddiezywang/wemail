import { RETENTION_DAYS, runDatabaseRetentionBatch } from "./DatabaseRetention.js";
import type { DatabaseRetentionBatchParams, DatabaseRetentionBatchResult } from "../../../shared/wemail/retention.js";
export { RETENTION_DAYS } from "./DatabaseRetention.js";
import fs from "node:fs";
import path from "node:path";
import type { MailDatabase } from "../database/Database.js";
import {
  APP_LOG_FILE_PATTERN,
  APP_LOG_MAX_TOTAL_BYTES,
  type AppLogger,
} from "../telemetry/AppLogger.js";

/**
 * Retention windows for Package H.
 *
 * Handoff §5.H mandates:
 *   - 邮件正文缓存: 长期保留，除非未来用户在设置中明确开启清理
 *   - 附件缓存: 长期保留 (phase one is metadata only; blobs are a future concern)
 *   - App logs: 7 天，并受目录总容量限制
 *   - WeCLI 审计日志: 30 天
 *   - 标签反馈: 长期
 *   - 草稿反馈 Markdown: 长期
 */
export interface RetentionReport {
  ranAt: string;
  mailBodiesPurged: number;
  wecliAuditLogsDeleted: number;
  appLogFilesDeleted: number;
  /** File paths actually removed, for audit/telemetry. */
  appLogFilesRemoved: string[];
  diagnosticPackagesDeleted: number;
  applicationMessagesDeleted: number;
  automationPreviewsDeleted: number;
  automationManifestItemsDeleted: number;
  automationResultsExpired: number;
  automationStepDetailsExpired: number;
}

export interface DataRetentionServiceDeps {
  databaseRetention?: (params: DatabaseRetentionBatchParams) => Promise<DatabaseRetentionBatchResult>;
  db: MailDatabase;
  /** Directory where AppLogger rotates daily logs. */
  logsBaseDir: string;
  logger?: AppLogger;
  /** Clock injection for tests. */
  now?: () => Date;
  /** FS injection for tests. */
  fsAdapter?: RetentionFsAdapter;
}

export interface RetentionFsAdapter {
  readdirSync: (dir: string) => string[];
  statSync: (file: string) => { mtimeMs: number; size?: number };
  unlinkSync: (file: string) => void;
  existsSync: (dir: string) => boolean;
}

const defaultFs: RetentionFsAdapter = {
  readdirSync: (dir) => fs.readdirSync(dir),
  statSync: (file) => fs.statSync(file),
  unlinkSync: (file) => fs.unlinkSync(file),
  existsSync: (dir) => fs.existsSync(dir),
};

/**
 * Time-based retention job.
 *
 * Invariants (Handoff §2 / §6):
 *   - Logout MUST NOT call this service. Retention is time-based only.
 *   - Never prune tag-feedback rules or draft-feedback Markdown.
 *   - Preserves canonical mail metadata, cached bodies and attachments.
 */
export class DataRetentionService {
  private readonly deps: DataRetentionServiceDeps & { now: () => Date; fsAdapter: RetentionFsAdapter };
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<RetentionReport> | null = null;
  private generation = 0;

  constructor(deps: DataRetentionServiceDeps) {
    this.deps = {
      db: deps.db,
      databaseRetention: deps.databaseRetention,
      logsBaseDir: deps.logsBaseDir,
      now: deps.now ?? (() => new Date()),
      fsAdapter: deps.fsAdapter ?? defaultFs,
      logger: deps.logger,
    };
  }

  /**
   * Run the full retention pass. Safe to call concurrently with normal app
   * traffic — bounded batches yield between transactions. Idempotent: re-running
   * on already-pruned data produces a report with zero counts.
   */
  runRetention(nowOverride?: Date): Promise<RetentionReport> {
    this.running ??= this.runRetentionPass(nowOverride).finally(() => { this.running = null; });
    return this.running;
  }

  private async runRetentionPass(nowOverride?: Date): Promise<RetentionReport> {
    const generation = this.generation;
    const now = nowOverride ?? this.deps.now();
    const ranAt = now.toISOString();
    const logCutoffMs = now.getTime() - RETENTION_DAYS.appLogs * 86_400_000;
    const counts = {
      wecliAuditLogsDeleted: 0, applicationMessagesDeleted: 0, automationPreviewsDeleted: 0,
      automationManifestItemsDeleted: 0, automationResultsExpired: 0, automationStepDetailsExpired: 0,
    };
    while (generation === this.generation) {
      const params = { now: ranAt, limit: 100 };
      const batch = this.deps.databaseRetention
        ? await this.deps.databaseRetention(params)
        : this.deps.db.transaction(() => runDatabaseRetentionBatch(this.deps.db, params)).immediate();
      for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] += batch[key];
      if (!batch.hasMore) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const { wecliAuditLogsDeleted, applicationMessagesDeleted, automationPreviewsDeleted,
      automationManifestItemsDeleted, automationResultsExpired, automationStepDetailsExpired } = counts;
    const mailBodiesPurged = 0;
    const removed = this.purgeAppLogs(logCutoffMs);
    const diagnosticPackagesDeleted = this.purgeDiagnosticPackages(logCutoffMs);

    const report: RetentionReport = {
      ranAt,
      mailBodiesPurged,
      wecliAuditLogsDeleted,
      appLogFilesDeleted: removed.length,
      appLogFilesRemoved: removed,
      diagnosticPackagesDeleted,
      applicationMessagesDeleted,
      automationPreviewsDeleted,
      automationManifestItemsDeleted,
      automationResultsExpired,
      automationStepDetailsExpired,
    };

    this.deps.logger?.info("retention.run", {
      ranAt,
      mailBodiesPurged,
      wecliAuditLogsDeleted,
      appLogFilesDeleted: removed.length,
      diagnosticPackagesDeleted,
      applicationMessagesDeleted,
      automationPreviewsDeleted,
      automationManifestItemsDeleted,
      automationResultsExpired,
      automationStepDetailsExpired,
    });

    return report;
  }

  /**
   * Start a daily timer. Executes once immediately, then every
   * `intervalMs` (default 24h). Safe to call when already started: the
   * existing timer is preserved.
   */
  start(options: { intervalMs?: number } = {}): void {
    if (this.timer) return;
    const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
    const run = () => {
      void this.runRetention().catch((err) => {
        this.deps.logger?.error("retention.run.failed", { err: asError(err) });
      });
    };
    run();
    this.timer = setInterval(run, intervalMs);
    // Do not keep the event loop alive just for retention.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    this.generation += 1;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private purgeDiagnosticPackages(cutoffMs: number): number {
    const directory = path.join(this.deps.logsBaseDir, "diagnostic-packages");
    if (!this.deps.fsAdapter.existsSync(directory)) return 0;
    let removed = 0;
    for (const name of this.deps.fsAdapter.readdirSync(directory)) {
      if (!/^wemail-diagnostics-.*\.json$/.test(name)) continue;
      const full = path.join(directory, name);
      try {
        if (this.deps.fsAdapter.statSync(full).mtimeMs < cutoffMs) {
          this.deps.fsAdapter.unlinkSync(full);
          removed += 1;
        }
      } catch {
        // Best effort. Another run will try again tomorrow.
      }
    }
    return removed;
  }

  private purgeAppLogs(cutoffMs: number): string[] {
    const { logsBaseDir, fsAdapter } = this.deps;
    if (!fsAdapter.existsSync(logsBaseDir)) return [];
    const entries = fsAdapter.readdirSync(logsBaseDir);
    const removed: string[] = [];
    const candidates: Array<{ full: string; mtimeMs: number; size: number }> = [];
    for (const name of entries) {
      // Only touch files produced by AppLogger's rotation.
      if (!APP_LOG_FILE_PATTERN.test(name)) continue;
      const full = path.join(logsBaseDir, name);
      let stat: { mtimeMs: number; size?: number };
      try {
        stat = fsAdapter.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoffMs) {
        try {
          fsAdapter.unlinkSync(full);
          removed.push(full);
        } catch {
          // Best effort. Another run will try again tomorrow.
        }
        continue;
      }
      candidates.push({ full, mtimeMs: stat.mtimeMs, size: stat.size ?? 0 });
    }

    candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
    const protectedCurrent = candidates.at(-1)?.full;
    let totalBytes = candidates.reduce((sum, entry) => sum + entry.size, 0);
    for (const candidate of candidates) {
      if (totalBytes <= APP_LOG_MAX_TOTAL_BYTES) break;
      if (candidate.full === protectedCurrent) continue;
      try {
        fsAdapter.unlinkSync(candidate.full);
        removed.push(candidate.full);
        totalBytes -= candidate.size;
      } catch {
        // Best effort. Another run will try again tomorrow.
      }
    }
    return removed;
  }
}

function asError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "Error", message: String(err) };
}
