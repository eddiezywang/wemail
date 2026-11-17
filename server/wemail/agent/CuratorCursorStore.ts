/**
 * Persisted cursor state for the Curator scheduler (Route C / WP J.6).
 *
 * The scheduler decides whether to run based on:
 *   - lastRunAt(accountId): time-based 24h cooldown
 *   - counters(accountId): event-based fan-out (mail-arrived ≥ 50,
 *     feedback-event ≥ 20)
 *
 * State is intentionally tiny — one JSON file per account at
 * `curator-cursor.json`. The store serializes through the same
 * sandboxed WorkspaceFileSystem as everything else under the workspace.
 */

import type { WorkspaceFileSystem } from "../workspace/WorkspaceFileSystem.js";

export type CuratorEventCounter = "mail-arrived" | "feedback-event";

export interface CuratorCounters {
  "mail-arrived": number;
  "feedback-event": number;
}

export interface CuratorCursorState {
  lastRunAt: string | null;
  counters: CuratorCounters;
}

export interface CuratorCursorStore {
  /** Returns the persisted lastRunAt for this account, or null when never run. */
  getLastRunAt(accountId: string): Promise<Date | null>;
  setLastRunAt(accountId: string, when: Date): Promise<void>;
  getCounters(accountId: string): Promise<CuratorCounters>;
  setCounters(accountId: string, counters: CuratorCounters): Promise<void>;
}

const CURSOR_FILE = "curator-cursor.json";

export const ZERO_COUNTERS: CuratorCounters = {
  "mail-arrived": 0,
  "feedback-event": 0,
};

function emptyState(): CuratorCursorState {
  return { lastRunAt: null, counters: { ...ZERO_COUNTERS } };
}

function normalizeState(raw: unknown): CuratorCursorState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyState();
  const r = raw as Record<string, unknown>;
  const lastRunAt = typeof r.lastRunAt === "string" ? r.lastRunAt : null;
  const counters = (r.counters && typeof r.counters === "object" && !Array.isArray(r.counters)
    ? (r.counters as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  return {
    lastRunAt,
    counters: {
      "mail-arrived":
        typeof counters["mail-arrived"] === "number"
          ? Math.max(0, Math.floor(counters["mail-arrived"] as number))
          : 0,
      "feedback-event":
        typeof counters["feedback-event"] === "number"
          ? Math.max(0, Math.floor(counters["feedback-event"] as number))
          : 0,
    },
  };
}

export interface JsonCuratorCursorStoreOptions {
  /**
   * Resolves to a per-account WorkspaceFileSystem. The store does not
   * cache the handle so that workspace teardown (logout) takes effect
   * on the next call without explicit invalidation.
   */
  fsForAccount: (accountId: string) => WorkspaceFileSystem;
}

export class JsonCuratorCursorStore implements CuratorCursorStore {
  private readonly fsForAccount: (accountId: string) => WorkspaceFileSystem;

  constructor(options: JsonCuratorCursorStoreOptions) {
    this.fsForAccount = options.fsForAccount;
  }

  private async readState(accountId: string): Promise<CuratorCursorState> {
    const fs = this.fsForAccount(accountId);
    const raw = await fs.readFile(CURSOR_FILE);
    if (!raw) return emptyState();
    try {
      return normalizeState(JSON.parse(raw));
    } catch {
      return emptyState();
    }
  }

  private async writeState(accountId: string, state: CuratorCursorState): Promise<void> {
    const fs = this.fsForAccount(accountId);
    await fs.writeFile(CURSOR_FILE, JSON.stringify(state, null, 2));
  }

  async getLastRunAt(accountId: string): Promise<Date | null> {
    const s = await this.readState(accountId);
    if (!s.lastRunAt) return null;
    const ms = Date.parse(s.lastRunAt);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }

  async setLastRunAt(accountId: string, when: Date): Promise<void> {
    const s = await this.readState(accountId);
    s.lastRunAt = when.toISOString();
    await this.writeState(accountId, s);
  }

  async getCounters(accountId: string): Promise<CuratorCounters> {
    const s = await this.readState(accountId);
    return s.counters;
  }

  async setCounters(accountId: string, counters: CuratorCounters): Promise<void> {
    const s = await this.readState(accountId);
    s.counters = {
      "mail-arrived": Math.max(0, Math.floor(counters["mail-arrived"])),
      "feedback-event": Math.max(0, Math.floor(counters["feedback-event"])),
    };
    await this.writeState(accountId, s);
  }
}

/**
 * In-memory cursor store for tests + scenarios where persistence is
 * not desired. Not exported to production wiring.
 */
export class InMemoryCuratorCursorStore implements CuratorCursorStore {
  private readonly state = new Map<string, CuratorCursorState>();

  private get(accountId: string): CuratorCursorState {
    let s = this.state.get(accountId);
    if (!s) {
      s = emptyState();
      this.state.set(accountId, s);
    }
    return s;
  }

  async getLastRunAt(accountId: string): Promise<Date | null> {
    const s = this.get(accountId);
    if (!s.lastRunAt) return null;
    const ms = Date.parse(s.lastRunAt);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }

  async setLastRunAt(accountId: string, when: Date): Promise<void> {
    this.get(accountId).lastRunAt = when.toISOString();
  }

  async getCounters(accountId: string): Promise<CuratorCounters> {
    return { ...this.get(accountId).counters };
  }

  async setCounters(accountId: string, counters: CuratorCounters): Promise<void> {
    this.get(accountId).counters = {
      "mail-arrived": Math.max(0, Math.floor(counters["mail-arrived"])),
      "feedback-event": Math.max(0, Math.floor(counters["feedback-event"])),
    };
  }
}
