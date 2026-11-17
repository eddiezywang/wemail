import fs from "node:fs";
import path from "node:path";
import { redact } from "./AppLogger.js";

export interface MailSyncErrorLogEntry {
  errorId: string;
  stage: string;
  name: string;
  message: string;
  detail: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export interface MailSyncErrorLogOptions {
  baseDir: string;
  now?: () => Date;
}

export class MailSyncErrorLog {
  readonly filePath: string;
  private readonly now: () => Date;

  constructor(options: MailSyncErrorLogOptions) {
    this.filePath = path.join(options.baseDir, "mail-sync-errors.log");
    this.now = options.now ?? (() => new Date());
  }

  record(entry: MailSyncErrorLogEntry): void {
    const line = JSON.stringify(
      redact({
        ts: this.now().toISOString(),
        ...entry,
      }),
    );
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
    } catch {
      // Logging must not make the original sync failure worse.
    }
  }
}
