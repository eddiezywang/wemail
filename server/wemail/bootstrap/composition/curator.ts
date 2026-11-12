/**
 * Curator-domain composition (Route C / WP J.5/J.6).
 *
 * Owns the per-account CuratorAgentRuntime cache and the singleton
 * scheduler that drives it. The cache is keyed by accountId; the
 * scheduler reads `accountIds()` from this composition so login/logout
 * is observed without re-instantiating the scheduler.
 *
 * Wiring lives outside `composeApp` because the Curator graph depends
 * on already-composed pieces (workspace, mail repo, intel results) and
 * we want clean teardown in the lifecycle layer (see `clearForAccount`).
 *
 * The scheduler does NOT mount any HTTP route — triggers are exposed
 * only through the typed handle, intentionally. (J.7 will add a route.)
 */

import { CuratorAgentRuntime } from "../../agent/CuratorAgentRuntime.js";
import {
  FileCuratorAuditLogger,
  type CuratorAuditLogger,
} from "../../agent/CuratorAuditLogger.js";
import {
  JsonCuratorCursorStore,
  type CuratorCursorStore,
} from "../../agent/CuratorCursorStore.js";
import { CuratorScheduler } from "../../agent/CuratorScheduler.js";
import type { LlmRuntime } from "../../ai/LlmRuntime.js";
import type { IntelligenceResultRepository } from "../../intelligence/IntelligenceResultRepository.js";
import type { CanonicalMailRepository } from "../../mail/CanonicalMailRepository.js";
import type { AppLogger } from "../../telemetry/AppLogger.js";
import type { WorkspaceComposition } from "./workspace.js";

export interface CuratorComposition {
  scheduler: CuratorScheduler;
  /**
   * Returns a memoized CuratorAgentRuntime for this account, or
   * undefined when no LLM client / planner is available yet.
   */
  runtimeFor(accountId: string): CuratorAgentRuntime | undefined;
  /** Drop the cached per-account runtime (logout). */
  clearForAccount(accountId: string): void;
  /** Discard future-runtime cache entries after a configuration switch. */
  clearAll(): void;
}

export interface ComposeCuratorOptions {
  workspace: WorkspaceComposition;
  intelligenceResults: IntelligenceResultRepository;
  mailRepository: CanonicalMailRepository;
  logger: AppLogger;
  /**
   * Returns the live set of account ids the scheduler should consider
   * for time-based ticks. Typically wired to the per-account state
   * holder so logout removes the account from the scheduler's view.
   */
  accountIds: () => string[];
  llmRuntime: LlmRuntime;
  /**
   * Application data directory; the default audit logger writes
   * `<dataDir>/audit.log`. Required for production wiring; tests may
   * supply `auditLogger` directly and omit this.
   */
  dataDir?: string;
  /**
   * Override the curator audit channel (tests). When omitted and
   * `dataDir` is provided, a {@link FileCuratorAuditLogger} is created.
   */
  auditLogger?: CuratorAuditLogger;
}

export function composeCurator(
  options: ComposeCuratorOptions,
): CuratorComposition {
  const cache = new Map<string, CuratorAgentRuntime>();
  const cursorStore: CuratorCursorStore = new JsonCuratorCursorStore({
    fsForAccount: (accountId: string) =>
      options.workspace.forAccount(accountId).fs,
  });

  const auditLogger: CuratorAuditLogger | undefined =
    options.auditLogger ??
    (options.dataDir ? new FileCuratorAuditLogger({ dataDir: options.dataDir }) : undefined);

  function runtimeFor(accountId: string): CuratorAgentRuntime | undefined {
    const llm = options.llmRuntime.snapshot();
    const model = llm.modelFor("agent");
    if (!llm.client || !model) return undefined;
    const cached = cache.get(accountId);
    if (cached) return cached;
    const accountWs = options.workspace.forAccount(accountId);
    const runtime = new CuratorAgentRuntime({
      accountId,
      fs: accountWs.fs,
      intelligenceResults: options.intelligenceResults,
      mailRepo: options.mailRepository,
      llmClient: llm.client,
      model,
      ...(auditLogger ? { auditLogger } : {}),
    });
    cache.set(accountId, runtime);
    return runtime;
  }

  function clearForAccount(accountId: string): void {
    cache.delete(accountId);
  }

  function clearAll(): void {
    cache.clear();
  }

  const scheduler = new CuratorScheduler({
    runtimeFor: (accountId) => runtimeFor(accountId),
    accountIds: options.accountIds,
    persistedCursors: cursorStore,
    onError: (accountId, err) => {
      options.logger.error("curator.run.failed", {
        accountId,
        err: err instanceof Error ? err.message : String(err),
      });
    },
  });

  return { scheduler, runtimeFor, clearForAccount, clearAll };
}
