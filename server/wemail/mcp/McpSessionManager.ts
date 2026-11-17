import { createHash, randomUUID } from "node:crypto";
import type { WemailMcpProtocolVersion } from "../../../shared/wemail/mcp.js";

export interface McpSessionSnapshot {
  id: string;
  sessionHash: string;
  tokenId: string;
  protocolVersion: WemailMcpProtocolVersion;
  initialized: boolean;
  createdAt: string;
  lastUsedAt: string;
  inFlightCalls: number;
}
interface SessionState extends McpSessionSnapshot {
  calls: Map<string, AbortController>;
}

export interface McpSessionManagerOptions {
  now?: () => Date;
  idleTimeoutMs?: number;
  maxConcurrentCalls?: number;
  onTerminated?: (session: McpSessionSnapshot, reason: string) => void;
}

function snapshot(state: SessionState): McpSessionSnapshot {
  const { calls: _calls, ...value } = state;
  return { ...value, inFlightCalls: state.calls.size };
}

export class McpSessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly now: () => Date;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrentCalls: number;
  private readonly onTerminated: (session: McpSessionSnapshot, reason: string) => void;

  constructor(options: McpSessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1000;
    this.maxConcurrentCalls = options.maxConcurrentCalls ?? 4;
    this.onTerminated = options.onTerminated ?? (() => {});
  }

  create(
    tokenId: string,
    protocolVersion: WemailMcpProtocolVersion,
  ): McpSessionSnapshot {
    const id = randomUUID();
    const at = this.now().toISOString();
    const state: SessionState = {
      id,
      sessionHash: McpSessionManager.hashSessionId(id),
      tokenId,
      protocolVersion,
      initialized: false,
      createdAt: at,
      lastUsedAt: at,
      inFlightCalls: 0,
      calls: new Map(),
    };
    this.sessions.set(id, state);
    return snapshot(state);
  }

  get(id: string, tokenId: string): McpSessionSnapshot | null {
    const state = this.sessions.get(id);
    if (!state || state.tokenId !== tokenId) return null;
    if (this.isExpired(state)) {
      this.terminate(id, "idle-timeout");
      return null;
    }
    state.lastUsedAt = this.now().toISOString();
    return snapshot(state);
  }

  markInitialized(id: string, tokenId: string): McpSessionSnapshot {
    const state = this.requireState(id, tokenId);
    state.initialized = true;
    state.lastUsedAt = this.now().toISOString();
    return snapshot(state);
  }

  beginCall(
    id: string,
    tokenId: string,
    callId: string,
  ): { signal: AbortSignal; session: McpSessionSnapshot } {
    const state = this.requireState(id, tokenId);
    if (!state.initialized) throw new Error("mcp-session-not-initialized");
    if (state.calls.has(callId)) throw new Error("mcp-duplicate-call-id");
    if (state.calls.size >= this.maxConcurrentCalls) {
      throw new Error("mcp-session-concurrency-limit");
    }
    const controller = new AbortController();
    state.calls.set(callId, controller);
    state.lastUsedAt = this.now().toISOString();
    return { signal: controller.signal, session: snapshot(state) };
  }

  endCall(id: string, callId: string): void {
    const state = this.sessions.get(id);
    if (!state) return;
    state.calls.delete(callId);
    state.lastUsedAt = this.now().toISOString();
  }

  cancelCall(id: string, tokenId: string, callId: string, reason = "client-cancelled"): boolean {
    const state = this.sessions.get(id);
    if (!state || state.tokenId !== tokenId) return false;
    const controller = state.calls.get(callId);
    if (!controller) return false;
    controller.abort(reason);
    // Cancellation is cooperative. Keep the call and its concurrency slot
    // until the handler actually settles and endCall runs; otherwise a slow
    // handler can be replaced by the same id and later delete the new call.
    state.lastUsedAt = this.now().toISOString();
    return true;
  }

  terminate(id: string, reason = "client-delete"): boolean {
    const state = this.sessions.get(id);
    if (!state) return false;
    this.sessions.delete(id);
    for (const controller of state.calls.values()) controller.abort(reason);
    state.calls.clear();
    this.onTerminated(snapshot(state), reason);
    return true;
  }

  terminateForToken(tokenId: string, reason = "token-revoked"): number {
    const ids = [...this.sessions.values()]
      .filter((state) => state.tokenId === tokenId)
      .map((state) => state.id);
    for (const id of ids) this.terminate(id, reason);
    return ids.length;
  }

  terminateByHash(sessionHash: string, reason = "user-terminated"): boolean {
    const state = [...this.sessions.values()].find((candidate) => candidate.sessionHash === sessionHash);
    return state ? this.terminate(state.id, reason) : false;
  }

  cleanupExpired(): number {
    const ids = [...this.sessions.values()]
      .filter((state) => this.isExpired(state))
      .map((state) => state.id);
    for (const id of ids) this.terminate(id, "idle-timeout");
    return ids.length;
  }

  closeAll(reason = "server-shutdown"): number {
    const ids = [...this.sessions.keys()];
    for (const id of ids) this.terminate(id, reason);
    return ids.length;
  }

  list(): McpSessionSnapshot[] {
    this.cleanupExpired();
    return [...this.sessions.values()].map(snapshot);
  }

  static hashSessionId(id: string): string {
    return createHash("sha256").update(id).digest("hex").slice(0, 24);
  }

  private requireState(id: string, tokenId: string): SessionState {
    const state = this.sessions.get(id);
    if (!state || state.tokenId !== tokenId) throw new Error("mcp-session-not-found");
    if (this.isExpired(state)) {
      this.terminate(id, "idle-timeout");
      throw new Error("mcp-session-expired");
    }
    return state;
  }

  private isExpired(state: SessionState): boolean {
    return this.now().getTime() - Date.parse(state.lastUsedAt) >= this.idleTimeoutMs;
  }
}
