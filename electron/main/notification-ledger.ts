import fs from "node:fs";
import path from "node:path";

interface StoredLedger {
  entries: Record<string, number>;
}

export class NotificationDeliveryLedger {
  private entries: Record<string, number>;
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: {
    filePath: string;
    now?: () => number;
    ttlMs?: number;
    maxEntries?: number;
  }) {
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1_000;
    this.maxEntries = Math.max(1, options.maxEntries ?? 2_000);
    this.entries = this.read();
    this.prune(false);
  }

  has(key: string): boolean {
    this.prune(true);
    return this.entries[key] !== undefined;
  }

  record(key: string): void {
    this.entries[key] = this.now();
    this.prune(false);
    this.persist();
  }

  private read(): Record<string, number> {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as Partial<StoredLedger>;
      if (!parsed.entries || typeof parsed.entries !== "object") return {};
      return Object.fromEntries(
        Object.entries(parsed.entries).filter(
          ([key, timestamp]) =>
            key.length > 0 &&
            typeof timestamp === "number" &&
            Number.isFinite(timestamp),
        ),
      );
    } catch {
      return {};
    }
  }

  private prune(persistWhenChanged: boolean): void {
    const cutoff = this.now() - this.ttlMs;
    const retained = Object.entries(this.entries)
      .filter(([, timestamp]) => timestamp >= cutoff)
      .sort((left, right) => right[1] - left[1])
      .slice(0, this.maxEntries);
    const changed = retained.length !== Object.keys(this.entries).length;
    this.entries = Object.fromEntries(retained);
    if (changed && persistWhenChanged) this.persist();
  }

  private persist(): void {
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        tempPath,
        JSON.stringify({ entries: this.entries } satisfies StoredLedger),
        "utf8",
      );
      fs.renameSync(tempPath, this.filePath);
    } catch {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Delivery must not fail because the best-effort ledger is unavailable.
      }
    }
  }
}
