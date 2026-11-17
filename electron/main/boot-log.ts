import type fs from "node:fs";
import { safeStreamWrite, type SafeWritable } from "./safe-stream-write.js";
import { formatProcessLog, type ProcessLogLevel } from "./process-log.js";

export interface BootLogger {
  setPath(path: string | null): void;
  log(phase: string, extra?: Record<string, unknown>): void;
}

export function createBootLogger({
  pid,
  stderr,
  fs: fileSystem,
}: {
  pid: number;
  stderr: SafeWritable;
  fs: Pick<typeof fs, "appendFileSync">;
}): BootLogger {
  let bootLogPath: string | null = null;

  return {
    setPath(path) {
      bootLogPath = path;
    },
    log(phase, extra) {
      const level = inferBootLogLevel(phase, extra);
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        phase,
        pid,
        ...withoutLevel(extra),
      });
      safeStreamWrite(stderr, `${formatProcessLog("[wemail-boot]", line, level)}\n`);
      if (bootLogPath) {
        try {
          fileSystem.appendFileSync(
            bootLogPath,
            `${formatProcessLog("[wemail-boot]", line, level, { color: false })}\n`,
          );
        } catch {
          // best-effort
        }
      }
    },
  };
}

function withoutLevel(extra?: Record<string, unknown>): Record<string, unknown> {
  if (!extra) return {};
  const { level: _level, ...body } = extra;
  return body;
}

function inferBootLogLevel(phase: string, extra?: Record<string, unknown>): ProcessLogLevel {
  if (extra?.level === "debug" || extra?.level === "info" || extra?.level === "warn" || extra?.level === "error") {
    return extra.level;
  }
  if (phase.endsWith("-exit") && typeof extra?.code === "number" && extra.code !== 0) {
    return "error";
  }
  if (phase.includes("failed") || phase.includes("error") || phase.includes("timeout")) return "error";
  if (phase === "mail-database-request" && extra?.outcome === "success") return "debug";
  if (phase === "mail-database-request" && extra?.outcome) return "error";
  if (phase === "mail-core-stdout") return "debug";
  return "info";
}
