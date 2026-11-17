/**
 * Per-account workspace composition (Route C / WP J).
 *
 * Owns the per-account `WorkspaceFileSystem` + `WorkspaceContextLoader`
 * + `WorkspaceFeedbackSink` triple. Built once at boot, the cache lives
 * for the process lifetime (cleared per-account on logout). Three
 * consumers wire through it:
 *
 *   - `composeIntelligence`: passes the {@link WorkspaceComposition.routingSink}
 *     into the SHARED-singleton feedback repos (`TagFeedbackRuleRepository`,
 *     `TodoRepository`). The routing sink reads `event.accountId` from the
 *     event payload to pick the right per-account JSONL file.
 *   - `createPerAccountIntelligence`: pulls a `forAccount(account.id)`
 *     handle and gives the resulting `contextLoader` to the
 *     `IntelligenceOrchestrator`, which hydrates each capability's
 *     `workspaceInputs` into the `ProcessorContext.workspace`.
 *   - The lifecycle teardown calls `clearForAccount(account.id)` on
 *     logout so a stale handle doesn't keep the per-account dir cached
 *     across re-logins under a different account.
 *
 * Future Route C batches (J.5–J.6 / J.7) will extend this composition
 * with the CuratorAgentRuntime and a workspace HTTP API.
 */

import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { createWorkspacePathPolicy } from "../../workspace/WorkspacePathPolicy.js";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.js";
import { WorkspaceContextLoader } from "../../workspace/WorkspaceContextLoader.js";
import {
  createJsonlFeedbackSink,
  type WorkspaceFeedbackSink,
  type WorkspaceFeedbackEventType,
} from "../../workspace/WorkspaceFeedbackSink.js";

export interface AccountWorkspace {
  fs: WorkspaceFileSystem;
  contextLoader: WorkspaceContextLoader;
  feedbackSink: WorkspaceFeedbackSink;
}

/**
 * Thrown when a caller passes an `accountId` that could escape the
 * per-account workspace root (e.g. `..`, an absolute path, or anything
 * containing path separators). The id is used as a directory name; if
 * a malicious value were accepted the path policy would be initialized
 * at an arbitrary directory.
 */
export class InvalidAccountIdError extends Error {
  override readonly name = "InvalidAccountIdError";
  constructor(message: string) {
    super(message);
  }
}

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Validate that `accountId` is safe to use as a directory segment under
 * the workspace root. Throws {@link InvalidAccountIdError} otherwise.
 */
export function assertValidAccountId(accountId: unknown): asserts accountId is string {
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new InvalidAccountIdError("accountId must be a non-empty string");
  }
  if (accountId === "." || accountId === "..") {
    throw new InvalidAccountIdError(`accountId must not be "${accountId}"`);
  }
  if (accountId.startsWith(".")) {
    throw new InvalidAccountIdError("accountId must not start with '.'");
  }
  if (accountId.includes("/") || accountId.includes("\\")) {
    throw new InvalidAccountIdError("accountId must not contain path separators");
  }
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new InvalidAccountIdError(
      "accountId must match /^[A-Za-z0-9_.-]+$/",
    );
  }
}

export interface WorkspaceComposition {
  /**
   * Build per-account workspace handles. Cached on first call per
   * accountId so the underlying ContextLoader cache survives across
   * dispatches in the same login.
   */
  forAccount(accountId: string): AccountWorkspace;
  /** Drop cached handles for an accountId (on logout). */
  clearForAccount(accountId: string): void;
  /**
   * Routing sink for the SHARED-singleton feedback repositories. Reads
   * `event.accountId` to pick the right per-account sink. Emits with
   * unknown / missing accountId are dropped (logged via `logger`).
   */
  routingSink: WorkspaceFeedbackSink;
  /**
   * Register an after-append observer (Route C / WP J.8). Invoked once
   * per successful feedback emission with the resolved accountId.
   * Used to bump the Curator scheduler's `feedback-event` counter.
   * Only one observer slot is supported; the most recent caller wins.
   */
  setFeedbackObserver(
    observer: ((accountId: string, eventType: WorkspaceFeedbackEventType) => void) | undefined,
  ): void;
}

export interface ComposeWorkspaceOptions {
  /**
   * Application data directory; the workspace tree lives at
   * `<dataDir>/agent-workspace/<accountId>/`.
   */
  dataDir: string;
  /** Body-free structured log sink. Defaults to a no-op. */
  logger?: (event: string, fields: Record<string, unknown>) => void;
}

export function composeWorkspace(
  opts: ComposeWorkspaceOptions,
): WorkspaceComposition {
  const root = path.join(opts.dataDir, "agent-workspace");
  const cache = new Map<string, AccountWorkspace>();
  const logger = opts.logger ?? (() => {});

  function forAccount(accountId: string): AccountWorkspace {
    assertValidAccountId(accountId);
    const cached = cache.get(accountId);
    if (cached) return cached;
    const accountRoot = path.join(root, accountId);
    // Best-effort: ensure the account workspace dir exists so the path
    // policy / FileSystem can lazily create files inside it without a
    // chicken-and-egg moment on first write. Sync mkdir is fine here —
    // it runs once per login, not in a hot path.
    try {
      mkdirSync(accountRoot, { recursive: true });
    } catch (err) {
      logger("workspace.mkdir-failed", {
        accountId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    const policy = createWorkspacePathPolicy({ root: accountRoot });
    const wsFs = new WorkspaceFileSystem({ policy });
    const contextLoader = new WorkspaceContextLoader({ fs: wsFs });
    const feedbackSink = createJsonlFeedbackSink({ fs: wsFs });
    const entry: AccountWorkspace = {
      fs: wsFs,
      contextLoader,
      feedbackSink,
    };
    cache.set(accountId, entry);
    return entry;
  }

  function clearForAccount(accountId: string): void {
    cache.delete(accountId);
  }

  let feedbackObserver:
    | ((accountId: string, eventType: WorkspaceFeedbackEventType) => void)
    | undefined;

  const routingSink: WorkspaceFeedbackSink = {
    async append(
      eventType: WorkspaceFeedbackEventType,
      event: Record<string, unknown>,
    ): Promise<void> {
      const accountId =
        typeof event.accountId === "string" ? event.accountId : undefined;
      if (!accountId) {
        logger("workspace.feedback.missing-accountId", { eventType });
        return;
      }
      try {
        assertValidAccountId(accountId);
      } catch (err) {
        logger("workspace.feedback.invalid-accountId", {
          eventType,
          err: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const w = forAccount(accountId);
      await w.feedbackSink.append(eventType, event);
      // Notify any registered observer (e.g. Curator scheduler) AFTER
      // the JSONL append succeeds — observers are best-effort and must
      // never see an event whose underlying file write failed.
      if (feedbackObserver) {
        try {
          feedbackObserver(accountId, eventType);
        } catch (err) {
          logger("workspace.feedback.observer-failed", {
            eventType,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };

  function setFeedbackObserver(
    observer: ((accountId: string, eventType: WorkspaceFeedbackEventType) => void) | undefined,
  ): void {
    feedbackObserver = observer;
  }

  return { forAccount, clearForAccount, routingSink, setFeedbackObserver };
}
