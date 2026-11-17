/**
 * A bounded in-memory index for transient work keyed by an ID.
 *
 * The values deliberately contain no mail payload. Timestamps are only
 * bookkeeping used to expire entries and keep the index bounded.
 */
export class BoundedIdSet {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("bounded-id-set-invalid-capacity");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("bounded-id-set-invalid-ttl");
    }
  }

  has(id: string): boolean {
    this.pruneExpired();
    return this.entries.has(id);
  }

  add(id: string): string[] {
    this.pruneExpired();
    this.entries.delete(id);
    this.entries.set(id, this.now());
    const evicted: string[] = [];
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
      evicted.push(oldest);
    }
    return evicted;
  }

  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, touchedAt] of this.entries) {
      if (touchedAt <= cutoff) this.entries.delete(id);
    }
  }
}
