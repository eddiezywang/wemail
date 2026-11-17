import { createHash } from "node:crypto";

/** Short-lived, schema-specific hints for providers that return invalid native JSON. */
export class StructuredOutputPreference {
  private readonly entries = new Map<string, { failures: number; expiresAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 128,
  ) {}

  key(model: string, schema: unknown): string {
    const serialized = JSON.stringify(schema);
    if (serialized === undefined) throw new Error("invalid-structured-output-schema");
    return `${model}:${createHash("sha256").update(serialized).digest("hex")}`;
  }

  preferJsonObject(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return false;
    }
    return entry.failures >= 2;
  }

  recordNativeSuccess(key: string): void {
    this.entries.delete(key);
  }

  recordValidatedFallback(key: string): void {
    const existing = this.entries.get(key);
    const failures = existing && existing.expiresAt > this.now() ? existing.failures + 1 : 1;
    this.entries.delete(key);
    this.entries.set(key, { failures, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
