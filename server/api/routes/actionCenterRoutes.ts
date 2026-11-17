// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Aggregation endpoint for the Action Center page (Route C / WP 3H).
 *
 * The Action Center surfaces three orthogonal signals on a single
 * screen:
 *   - high-risk agent actions waiting for confirmation (from the
 *     `agent_pending_actions` table)
 *   - open todos for the active account (from canonical `mail_todos` via
 *     `TodoRepository.listOpenByAccount`)
 *   - the most recent Curator-authored daily learnings file (from the
 *     per-account workspace, `learnings/YYYY-MM-DD.md`)
 *
 * Returning all three in one response keeps the renderer's polling
 * cycle to a single round-trip. The endpoint is intentionally cheap:
 * two SQL reads + at most 7 file-existence probes (today + 6 days
 * back) before giving up and returning `null` for `curatorInsights`.
 *
 * Privacy: handlers MUST NOT log file content. The Curator's learnings
 * file is the only filesystem artifact this route touches; we read its
 * full body and return it verbatim, but never mirror it into structured
 * logs (the workspace path policy already sandboxes the read).
 */

import { Hono } from "hono";
import type { AgentPendingActionRepository } from "../../wemail/agent/AgentPendingActionRepository.js";
import type { TodoRepository, TodoRecord } from "../../wemail/todos/TodoRepository.js";
import type { WorkspaceComposition } from "../../wemail/bootstrap/composition/workspace.js";
import type { SmartTagActionRepository } from "../../wemail/intelligence/SmartTagActionRepository.js";
import type { SmartTagPromptRevisionRepository } from "../../wemail/intelligence/SmartTagPromptRevisionRepository.js";
import type { SmartTagLearningRunRepository } from "../../wemail/intelligence/SmartTagLearningRunRepository.js";
import type {
  ActionCenterPayload,
  TodoItem,
} from "../../../shared/wemail/intelligence.js";

export interface ActionCenterRoutesDeps {
  pendingActions: AgentPendingActionRepository;
  smartTagActions?: SmartTagActionRepository;
  smartTagPromptRevisions?: SmartTagPromptRevisionRepository;
  smartTagLearningRuns?: SmartTagLearningRunRepository;
  todos: TodoRepository;
  workspace: WorkspaceComposition;
  /** Returns the active account id, or null if no account is logged in. */
  getActiveAccountId: () => string | null;
  /**
   * Optional clock override for tests. Defaults to `Date.now()`. The
   * resulting `Date` is used to compute the `learnings/YYYY-MM-DD.md`
   * fallback chain (today, then 6 days back).
   */
  now?: () => Date;
}

/** How many days back we look for the most recent learnings file. */
const LEARNINGS_LOOKBACK_DAYS = 7;

/**
 * Strip TodoRepository internals (`agentStatusLocked`, taskAgent
 * provenance, evidence, etc.) the Action Center doesn't need to ship to
 * the renderer right now. The shared `TodoItem` shape only carries the
 * UI-facing fields; surfacing the rest would couple the API to the
 * server-side row shape.
 *
 * `agentStatus` is preserved because the Action Center renders it as a
 * badge on each todo row.
 */
function todoRecordToItem(record: TodoRecord): TodoItem {
  return {
    id: record.id,
    emailId: record.emailId,
    accountId: record.accountId,
    title: record.title,
    description: record.description,
    dueDate: record.dueDate,
    startTime: record.startTime,
    done: record.done,
    doneDate: record.doneDate,
    status: record.status,
    source: record.source,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    agentStatus: record.agentStatus ?? null,
    agentStatusLocked: record.agentStatusLocked,
    agentStatusUpdatedAt: record.agentStatusUpdatedAt,
  };
}

/**
 * Format a Date as `YYYY-MM-DD` in UTC. Matches the Curator's file-naming
 * convention (`learnings/YYYY-MM-DD.md`).
 */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function buildActionCenterRoutes(deps: ActionCenterRoutesDeps) {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());

  app.get("/", async (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) {
      return c.json({ ok: false, error: "no-active-account" }, 401);
    }

    const todoRecords = deps.todos.listOpenByAccount(accountId);
    const todos = todoRecords.map(todoRecordToItem);
    const smartTagActions =
      deps.smartTagActions?.listRecent(accountId, 20) ?? [];
    const smartTagPromptRevisions =
      deps.smartTagPromptRevisions?.listRecent(accountId, 10) ?? [];
    const smartTagLearningRuns =
      deps.smartTagLearningRuns?.listByAccount(accountId, 10) ?? [];

    // Curator insights: walk back from today up to LEARNINGS_LOOKBACK_DAYS
    // days probing `learnings/YYYY-MM-DD.md`. Stop on the first hit. If
    // nothing exists, return null — the renderer surfaces a placeholder.
    let curatorInsights: { date: string; content: string } | null = null;
    const ws = deps.workspace.forAccount(accountId);
    const today = now();
    for (let i = 0; i < LEARNINGS_LOOKBACK_DAYS; i++) {
      const probe = new Date(today);
      probe.setUTCDate(probe.getUTCDate() - i);
      const iso = isoDate(probe);
      const relPath = `learnings/${iso}.md`;
      try {
        const content = await ws.fs.readFile(relPath);
        if (content !== null) {
          curatorInsights = { date: iso, content };
          break;
        }
      } catch {
        // The probe path is fixed and known-good, so any failure here
        // (path-policy escape, fs error) is treated as "no insights for
        // this day" rather than bubbling a 500 — the user still gets
        // pending actions and todos.
      }
    }

    const payload: ActionCenterPayload = {
      todos,
      smartTagActions,
      smartTagPromptRevisions,
      smartTagLearningRuns,
      curatorInsights,
      generatedAt: new Date().toISOString(),
    };
    return c.json({ ok: true, ...payload });
  });

  return app;
}
