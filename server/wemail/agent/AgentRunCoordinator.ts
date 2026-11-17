import type { AgentRunRepository } from "./AgentRunRepository.js";

export interface AgentRunLease {
  conversationId: string;
  runId: string;
  signal: AbortSignal;
  waited: boolean;
  release(): void;
}

interface ActiveLease {
  conversationId: string;
  runId: string;
  abort: AbortController;
}

interface WaitingLease {
  conversationId: string;
  runId: string;
  signal?: AbortSignal;
  resolve: (lease: AgentRunLease) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

export class AgentRunCoordinator {
  private readonly active = new Map<string, ActiveLease>();
  private readonly waiting: WaitingLease[] = [];

  constructor(
    private readonly repository: AgentRunRepository,
    private readonly maxActiveRuns = 2,
  ) {
    if (!Number.isSafeInteger(maxActiveRuns) || maxActiveRuns < 1) {
      throw new Error("maxActiveRuns must be a positive integer");
    }
  }

  reconcileStartup() {
    return this.repository.reconcileStartup();
  }

  isConversationActive(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  activeCount(): number {
    return this.active.size;
  }

  activeRunId(conversationId: string): string | undefined {
    return this.active.get(conversationId)?.runId;
  }

  waitingCount(): number {
    return this.waiting.length;
  }

  acquire(input: {
    conversationId: string;
    runId: string;
    signal?: AbortSignal;
  }): Promise<AgentRunLease> {
    if (input.signal?.aborted) {
      return Promise.reject(new Error("agent run acquisition aborted"));
    }
    if (this.canGrant(input.conversationId)) {
      return Promise.resolve(this.grant(input.conversationId, input.runId, false, input.signal));
    }
    return new Promise<AgentRunLease>((resolve, reject) => {
      const waiting: WaitingLease = { ...input, resolve, reject };
      if (input.signal) {
        waiting.onAbort = () => {
          const index = this.waiting.indexOf(waiting);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new Error("agent run acquisition aborted"));
        };
        input.signal.addEventListener("abort", waiting.onAbort, { once: true });
      }
      this.waiting.push(waiting);
    });
  }

  stop(conversationId: string): boolean {
    const lease = this.active.get(conversationId);
    if (!lease) return false;
    lease.abort.abort();
    this.repository.pauseFollowups(conversationId, "user_stopped");
    return true;
  }

  private canGrant(conversationId: string): boolean {
    return this.active.size < this.maxActiveRuns && !this.active.has(conversationId);
  }

  private grant(
    conversationId: string,
    runId: string,
    waited: boolean,
    callerSignal?: AbortSignal,
  ): AgentRunLease {
    const abort = new AbortController();
    const onCallerAbort = () => abort.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    this.active.set(conversationId, { conversationId, runId, abort });
    let released = false;
    return {
      conversationId,
      runId,
      signal: abort.signal,
      waited,
      release: () => {
        if (released) return;
        released = true;
        callerSignal?.removeEventListener("abort", onCallerAbort);
        const current = this.active.get(conversationId);
        if (current?.runId === runId) this.active.delete(conversationId);
        this.drain();
      },
    };
  }

  private drain(): void {
    for (let index = 0; index < this.waiting.length;) {
      if (this.active.size >= this.maxActiveRuns) return;
      const waiting = this.waiting[index]!;
      if (!this.canGrant(waiting.conversationId)) {
        index += 1;
        continue;
      }
      this.waiting.splice(index, 1);
      if (waiting.onAbort) {
        waiting.signal?.removeEventListener("abort", waiting.onAbort);
      }
      waiting.resolve(this.grant(
        waiting.conversationId,
        waiting.runId,
        true,
        waiting.signal,
      ));
    }
  }
}

export type RetryCapability = "model" | "idempotent_read" | "unsafe_mutation";

export interface RetryNotice {
  type: "scheduled" | "started" | "completed" | "failed";
  attempt: number;
  maxAttempts: number;
  delayMs?: number;
  message?: string;
}

function abortError(): Error {
  const error = new Error("agent retry aborted");
  error.name = "AbortError";
  return error;
}

async function cancellableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function retryAgentOperation<T>(input: {
  capability: RetryCapability;
  operation: (attempt: number) => Promise<T>;
  isTransient: (error: unknown) => boolean;
  signal?: AbortSignal;
  maxAttempts?: number;
  baseDelayMs?: number;
  onNotice?: (notice: RetryNotice) => void;
}): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? 2, 2));
  const retryAllowed = input.capability !== "unsafe_mutation";
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (input.signal?.aborted) throw abortError();
    if (attempt > 1) {
      input.onNotice?.({ type: "started", attempt, maxAttempts });
    }
    try {
      const result = await input.operation(attempt);
      if (attempt > 1) {
        input.onNotice?.({ type: "completed", attempt, maxAttempts });
      }
      return result;
    } catch (error) {
      lastError = error;
      const canRetry = retryAllowed && input.isTransient(error) && attempt < maxAttempts;
      if (!canRetry) {
        if (attempt > 1) {
          input.onNotice?.({
            type: "failed",
            attempt,
            maxAttempts,
            message: "重试未能完成。",
          });
        }
        throw error;
      }
      const delayMs = (input.baseDelayMs ?? 250) * (2 ** (attempt - 1));
      input.onNotice?.({
        type: "scheduled",
        attempt: attempt + 1,
        maxAttempts,
        delayMs,
        message: "操作暂时失败，正在重试。",
      });
      await cancellableDelay(delayMs, input.signal);
    }
  }
  throw lastError;
}
