import fs from "node:fs";
import path from "node:path";
import {
  APP_LOG_FILE_PATTERN,
  APP_LOG_MAX_TOTAL_BYTES,
} from "../telemetry/AppLogger.js";

export function purgeMailCoreAppLogs(logsDir: string, cutoffMs: number): number {
  if (!fs.existsSync(logsDir)) return 0;
  const removed: string[] = [];
  const candidates: Array<{ full: string; mtimeMs: number; size: number }> = [];
  for (const name of fs.readdirSync(logsDir)) {
    if (!APP_LOG_FILE_PATTERN.test(name)) continue;
    const full = path.join(logsDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoffMs) {
      try {
        fs.unlinkSync(full);
        removed.push(full);
      } catch {}
      continue;
    }
    candidates.push({ full, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
  const protectedCurrent = candidates.at(-1)?.full;
  let totalBytes = candidates.reduce((sum, entry) => sum + entry.size, 0);
  for (const candidate of candidates) {
    if (totalBytes <= APP_LOG_MAX_TOTAL_BYTES) break;
    if (candidate.full === protectedCurrent) continue;
    try {
      fs.unlinkSync(candidate.full);
      removed.push(candidate.full);
      totalBytes -= candidate.size;
    } catch {}
  }
  return removed.length;
}
