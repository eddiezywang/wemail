import { randomUUID } from "node:crypto";
import type { TaskAgentStatus } from "../../../shared/wemail/intelligence.js";
import type { MailDatabase } from "../database/Database.js";
import type { WorkspaceFeedbackSink } from "../workspace/WorkspaceFeedbackSink.js";

export type TodoPriority = "high" | "medium" | "low";

export interface TodoRecord {
  id: string;
  emailId: string;
  accountId: string;
  title: string;
  description?: string;
  dueDate?: string;
  startTime?: string;
  /** Optional end time (ISO). Paired with `startTime` for ranged todos. */
  endTime?: string;
  /** IANA timezone, e.g. "Asia/Shanghai". */
  timezone?: string;
  /**
   * Priority bucket. Always populated when read from the DB
   * (defaults to "medium" via the migration); optional in the TS shape so
   * test fixtures and TodoExtractionProcessor results don't have to set it.
   */
  priority?: TodoPriority;
  done: boolean;
  doneDate?: string;
  status: "suggested" | "confirmed";
  source: "ai" | "user" | "agent" | "mcp";
  createdAt: string;
  updatedAt: string;
  /** Task Agent state machine (F3). */
  agentStatus?: TaskAgentStatus | null;
  agentStatusLocked?: boolean;
  agentStatusUpdatedAt?: string;
  /**
   * Route C / WP A: AI extraction provenance. Populated by Batch 2G;
   * Batch 1A only opens the channel.
   */
  evidence?: string[];
  extractionReason?: string;
  extractionConfidence?: number;
  /** Latest TaskAgent rationale + score + supporting message ids. */
  taskAgentReason?: string;
  taskAgentConfidence?: number;
  taskAgentEvidenceMessageIds?: string[];
}

export interface TodoPage {
  todos: TodoRecord[];
  totalCount: number;
  hasMore: boolean;
}

interface TodoRow {
  id: string;
  email_id: string | null;
  account_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  start_time: string | null;
  end_time: string | null;
  timezone: string | null;
  priority: string | null;
  done: number;
  done_date: string | null;
  status: "suggested" | "confirmed";
  source: "ai" | "user" | "agent" | "mcp";
  created_at: string;
  updated_at: string;
  agent_status: string | null;
  agent_status_locked: number;
  agent_status_updated_at: string | null;
  evidence_json: string | null;
  extraction_reason: string | null;
  extraction_confidence: number | null;
  task_agent_reason: string | null;
  task_agent_confidence: number | null;
  task_agent_evidence_json: string | null;
}

const TODO_SELECT = `SELECT todos.public_id AS id,
  messages.public_id AS email_id, accounts.public_id AS account_id,
  todos.title, todos.description,
  CASE WHEN todos.due_at_ms IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', todos.due_at_ms / 1000.0, 'unixepoch') END AS due_date,
  CASE WHEN todos.start_at_ms IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', todos.start_at_ms / 1000.0, 'unixepoch') END AS start_time,
  CASE WHEN todos.end_at_ms IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', todos.end_at_ms / 1000.0, 'unixepoch') END AS end_time,
  todos.timezone, todos.priority,
  CASE WHEN todos.completed_at_ms IS NULL THEN 0 ELSE 1 END AS done,
  CASE WHEN todos.completed_at_ms IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', todos.completed_at_ms / 1000.0, 'unixepoch') END AS done_date,
  todos.status, todos.source,
  strftime('%Y-%m-%dT%H:%M:%fZ', todos.created_at_ms / 1000.0, 'unixepoch') AS created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', todos.updated_at_ms / 1000.0, 'unixepoch') AS updated_at,
  todos.agent_status, todos.agent_status_locked,
  CASE WHEN todos.agent_status_updated_at_ms IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', todos.agent_status_updated_at_ms / 1000.0, 'unixepoch') END AS agent_status_updated_at,
  todos.extraction_evidence_json AS evidence_json,
  todos.extraction_reason, todos.extraction_confidence,
  todos.task_agent_reason, todos.task_agent_confidence,
  todos.task_agent_evidence_json
  FROM mail_todos todos
  JOIN mail_accounts accounts ON accounts.id = todos.account_id
  LEFT JOIN mail_messages messages ON messages.id = todos.message_id`;

/**
 * Normalize a title for deduplication and suppression matching.
 * Collapses whitespace, trims, and lowercases.
 */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

export class TodoRepository {
  /**
   * Optional workspace feedback sink. When present, complete and
   * recordSuppression emit JSONL events so the Curator runtime can
   * learn from the user's todo lifecycle. Wired by AppComposition in
   * a later Route C batch; today repos run with sink === undefined.
   */
  private readonly feedbackSink?: WorkspaceFeedbackSink;

  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
    feedbackSink?: WorkspaceFeedbackSink,
  ) {
    this.feedbackSink = feedbackSink;
  }

  /**
   * Fire-and-forget feedback emission. Errors swallowed so a failed
   * JSONL append never blocks the user's todo lifecycle — the SQL row
   * is the source of truth.
   */
  private emitFeedback(
    eventType: "todo-complete" | "todo-delete" | "todo-suppress",
    event: Record<string, unknown>,
  ): void {
    if (!this.feedbackSink) return;
    void this.feedbackSink.append(eventType, event).catch(() => {
      /* swallow — JSONL is best-effort */
    });
  }

  upsertSuggested(input: {
    emailId: string;
    accountId: string;
    title: string;
    description?: string;
    dueDate?: string;
    startTime?: string;
    source?: "ai" | "user" | "agent";
    /**
     * Route C / WP A: optional AI extraction provenance. When provided
     * on a brand-new row they are persisted; on conflict the existing
     * row's values are preserved (we don't overwrite established
     * provenance on a re-run with weaker evidence).
     */
    evidence?: string[];
    extractionReason?: string;
    extractionConfidence?: number;
  }): TodoRecord {
    const now = this.now();
    const nowMs = parseTime(now);
    const id = `todo-${randomUUID()}`;
    const params = {
        id,
        emailId: input.emailId,
        accountId: input.accountId,
        title: input.title,
        normalizedTitle: normalizeTitle(input.title),
        description: input.description ?? null,
        dueAtMs: optionalTime(input.dueDate),
        startAtMs: optionalTime(input.startTime),
        source: input.source ?? "ai",
        nowMs,
        evidenceJson:
          input.evidence !== undefined ? JSON.stringify(input.evidence) : null,
        extractionReason: input.extractionReason ?? null,
        extractionConfidence: input.extractionConfidence ?? null,
      };
    const existing = this.findSuggestedIdentity(params.emailId, params.normalizedTitle, params.dueAtMs);
    if (existing) {
      this.db.prepare(`UPDATE mail_todos SET
        description = COALESCE(@description, description),
        start_at_ms = COALESCE(@startAtMs, start_at_ms),
        updated_at_ms = @nowMs, row_version = row_version + 1
        WHERE public_id = @existingId`).run({ ...params, existingId: existing.id });
      return this.getById(existing.id)!;
    }
    this.db.prepare(`INSERT INTO mail_todos (
      public_id, account_id, message_id, title, normalized_title, description,
      due_at_ms, start_at_ms, priority, status, source,
      extraction_evidence_json, extraction_reason, extraction_confidence,
      created_at_ms, updated_at_ms, row_version
    ) SELECT @id, accounts.id, messages.id, @title, @normalizedTitle, @description,
      @dueAtMs, @startAtMs, 'medium', 'suggested', @source,
      @evidenceJson, @extractionReason, @extractionConfidence, @nowMs, @nowMs, 1
      FROM mail_accounts accounts JOIN mail_messages messages ON messages.account_id = accounts.id
      WHERE accounts.public_id = @accountId AND messages.public_id = @emailId`).run(params);
    const row = this.db
      .prepare(
        `${TODO_SELECT} WHERE todos.public_id = ? AND todos.deleted_at_ms IS NULL`,
      )
      .get(id) as TodoRow;
    if (!row) throw new Error("todo-upsert-missing");
    return rowToTodo(row);
  }

  listByEmail(emailId: string): TodoRecord[] {
    const rows = this.db
      .prepare(`${TODO_SELECT} WHERE messages.public_id = ? AND todos.deleted_at_ms IS NULL ORDER BY todos.created_at_ms ASC`)
      .all(emailId) as TodoRow[];
    return rows.map(rowToTodo);
  }

  listByEmailIds(accountId: string, emailIds: string[]): Map<string, TodoRecord[]> {
    const unique = [...new Set(emailIds.filter(Boolean))];
    const result = new Map<string, TodoRecord[]>(unique.map((emailId) => [emailId, []]));
    for (let offset = 0; offset < unique.length; offset += 400) {
      const chunk = unique.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db.prepare(
        `${TODO_SELECT}
          WHERE accounts.public_id = ? AND messages.public_id IN (${placeholders})
            AND todos.deleted_at_ms IS NULL
          ORDER BY todos.created_at_ms ASC`,
      ).all(accountId, ...chunk) as TodoRow[];
      for (const row of rows) {
        if (!row.email_id) continue;
        const existing = result.get(row.email_id) ?? [];
        existing.push(rowToTodo(row));
        result.set(row.email_id, existing);
      }
    }
    return result;
  }

  listOpenByAccount(accountId: string): TodoRecord[] {
    const rows = this.db
      .prepare(
        `${TODO_SELECT} WHERE accounts.public_id = ? AND todos.completed_at_ms IS NULL
          AND todos.deleted_at_ms IS NULL ORDER BY COALESCE(todos.due_at_ms, todos.created_at_ms) ASC`,
      )
      .all(accountId) as TodoRow[];
    return rows.map(rowToTodo);
  }

  list(query: {
    accountId: string;
    status?: "open" | "completed";
    emailId?: string;
  }): TodoRecord[] {
    return this.listAccountPage(query).todos;
  }

  listAccountPage(query: {
    accountId: string;
    status?: "open" | "completed";
    emailId?: string;
    page?: number;
    limit?: number;
  }): TodoPage {
    const clauses = ["accounts.public_id = @accountId", "todos.deleted_at_ms IS NULL"];
    const params: Record<string, unknown> = { accountId: query.accountId };
    if (query.status === "open") clauses.push("todos.completed_at_ms IS NULL");
    if (query.status === "completed") clauses.push("todos.completed_at_ms IS NOT NULL");
    if (query.emailId) {
      clauses.push("messages.public_id = @emailId");
      params.emailId = query.emailId;
    }
    const limit = Math.min(50, Math.max(1, Math.floor(query.limit ?? 50)));
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM mail_todos todos
      JOIN mail_accounts accounts ON accounts.id = todos.account_id
      LEFT JOIN mail_messages messages ON messages.id = todos.message_id
      WHERE ${clauses.join(" AND ")}
    `).get(params) as { total: bigint };
    const rows = this.db
      .prepare(
        `${TODO_SELECT}
          WHERE ${clauses.join(" AND ")}
          ORDER BY COALESCE(todos.due_at_ms, todos.created_at_ms) ASC, todos.created_at_ms ASC
          LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset: (page - 1) * limit }) as TodoRow[];
    return {
      todos: rows.map(rowToTodo),
      totalCount: Number(totalRow.total),
      hasMore: page * limit < Number(totalRow.total),
    };
  }

  createManual(input: {
    accountId: string;
    emailId?: string;
    title: string;
    description?: string;
    dueDate?: string;
    startTime?: string;
    endTime?: string;
    timezone?: string;
    priority?: TodoPriority;
    source?: "user" | "agent" | "mcp";
    /**
     * Initial Task Agent status (F3). When provided, the row is created
     * with `agent_status_locked = 1` so the auto-updater leaves the
     * user's choice alone.
     */
    agentStatus?: TaskAgentStatus | null;
  }): TodoRecord {
    const now = this.now();
    const nowMs = parseTime(now);
    const id = `todo-${randomUUID()}`;
    const initialStatus = input.agentStatus ?? null;
    const initialLocked = initialStatus ? 1 : 0;
    this.db
      .prepare(`
        INSERT INTO mail_todos (
          public_id, account_id, message_id, title, normalized_title, description,
          due_at_ms, start_at_ms, end_at_ms, timezone, priority,
          status, source, created_at_ms, updated_at_ms,
          agent_status, agent_status_locked, agent_status_updated_at_ms, row_version
        ) SELECT @id, accounts.id, messages.id, @title, @normalizedTitle, @description,
          @dueAtMs, @startAtMs, @endAtMs, @timezone, @priority,
          'confirmed', @source, @nowMs, @nowMs,
          @agentStatus, @agentLocked, @agentUpdatedAtMs, 1
        FROM mail_accounts accounts
        LEFT JOIN mail_messages messages ON messages.account_id = accounts.id
          AND messages.public_id = @emailId
        WHERE accounts.public_id = @accountId
          AND (@emailId IS NULL OR messages.id IS NOT NULL)
      `)
      .run({
        id,
        emailId: input.emailId ?? null,
        accountId: input.accountId,
        title: input.title,
        normalizedTitle: normalizeTitle(input.title),
        description: input.description ?? null,
        dueAtMs: optionalTime(input.dueDate),
        startAtMs: optionalTime(input.startTime),
        endAtMs: optionalTime(input.endTime),
        timezone: input.timezone ?? null,
        priority: input.priority ?? "medium",
        source: input.source ?? "user",
        nowMs,
        agentStatus: initialStatus,
        agentLocked: initialLocked,
        agentUpdatedAtMs: initialStatus ? nowMs : null,
      });
    const row = this.db.prepare(`${TODO_SELECT} WHERE todos.public_id = ?`).get(id) as TodoRow;
    if (!row) throw new Error("todo-create-missing");
    return rowToTodo(row);
  }

  updateManual(input: {
    id: string;
    accountId: string;
    title?: string;
    description?: string | null;
    dueDate?: string | null;
    startTime?: string | null;
    endTime?: string | null;
    timezone?: string | null;
    priority?: TodoPriority;
  }): TodoRecord | null {
    const existing = this.getById(input.id);
    if (!existing || existing.accountId !== input.accountId) return null;
    this.db.prepare(`UPDATE mail_todos SET
      title = @title, normalized_title = @normalizedTitle,
      description = @description, due_at_ms = @dueAtMs,
      start_at_ms = @startAtMs, end_at_ms = @endAtMs,
      timezone = @timezone, priority = @priority,
      updated_at_ms = @updatedAtMs, row_version = row_version + 1
      WHERE public_id = @id AND account_id =
        (SELECT id FROM mail_accounts WHERE public_id = @accountId)`).run({
        id: input.id,
        accountId: input.accountId,
        title: input.title ?? existing.title,
        normalizedTitle: normalizeTitle(input.title ?? existing.title),
        description: input.description === undefined ? existing.description ?? null : input.description,
        dueAtMs: optionalTime(input.dueDate === undefined ? existing.dueDate : input.dueDate),
        startAtMs: optionalTime(input.startTime === undefined ? existing.startTime : input.startTime),
        endAtMs: optionalTime(input.endTime === undefined ? existing.endTime : input.endTime),
        timezone: input.timezone === undefined ? existing.timezone ?? null : input.timezone,
        priority: input.priority ?? existing.priority ?? "medium",
        updatedAtMs: parseTime(this.now()),
      });
    return this.getById(input.id);
  }

  listPage(query: {
    accountId: string;
    status?: "suggested" | "confirmed" | "completed";
    priority?: TodoPriority;
    dueAfter?: string;
    dueBefore?: string;
    emailId?: string;
    limit: number;
    offset?: number;
  }): TodoRecord[] {
    const clauses = ["accounts.public_id = @accountId", "todos.deleted_at_ms IS NULL"];
    const params: Record<string, unknown> = { accountId: query.accountId, limit: query.limit, offset: query.offset ?? 0 };
    if (query.status === "completed") clauses.push("todos.completed_at_ms IS NOT NULL");
    else if (query.status) { clauses.push("todos.completed_at_ms IS NULL", "todos.status = @status"); params.status = query.status; }
    if (query.priority) { clauses.push("todos.priority = @priority"); params.priority = query.priority; }
    if (query.dueAfter) { clauses.push("todos.due_at_ms >= @dueAfter"); params.dueAfter = parseTime(query.dueAfter); }
    if (query.dueBefore) { clauses.push("todos.due_at_ms <= @dueBefore"); params.dueBefore = parseTime(query.dueBefore); }
    if (query.emailId) { clauses.push("messages.public_id = @emailId"); params.emailId = query.emailId; }
    const rows = this.db.prepare(`${TODO_SELECT} WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(todos.due_at_ms, todos.created_at_ms) ASC,
        todos.created_at_ms ASC, todos.id ASC LIMIT @limit OFFSET @offset`).all(params) as TodoRow[];
    return rows.map(rowToTodo);
  }

  confirm(id: string): TodoRecord | null {
    const nowMs = parseTime(this.now());
    this.db
      .prepare(
        "UPDATE mail_todos SET status = 'confirmed', updated_at_ms = ?, row_version = row_version + 1 WHERE public_id = ?",
      )
      .run(nowMs, id);
    const row = this.db
      .prepare(`${TODO_SELECT} WHERE todos.public_id = ? AND todos.deleted_at_ms IS NULL`)
      .get(id) as TodoRow | undefined;
    return row ? rowToTodo(row) : null;
  }

  complete(id: string): TodoRecord | null {
    const nowMs = parseTime(this.now());
    const result = this.db
      .prepare(
        "UPDATE mail_todos SET completed_at_ms = ?, status = 'confirmed', updated_at_ms = ?, row_version = row_version + 1 WHERE public_id = ? AND completed_at_ms IS NULL AND deleted_at_ms IS NULL",
      )
      .run(nowMs, nowMs, id);
    const row = this.db
      .prepare(`${TODO_SELECT} WHERE todos.public_id = ? AND todos.deleted_at_ms IS NULL`)
      .get(id) as TodoRow | undefined;
    if (row && Number(result.changes) > 0) {
      this.emitFeedback("todo-complete", {
        todoId: row.id,
        emailId: row.email_id,
        accountId: row.account_id,
        source: row.source,
      });
    }
    return row ? rowToTodo(row) : null;
  }

  restore(id: string): TodoRecord | null {
    const nowMs = parseTime(this.now());
    this.db
      .prepare(
        "UPDATE mail_todos SET completed_at_ms = NULL, updated_at_ms = ?, row_version = row_version + 1 WHERE public_id = ?",
      )
      .run(nowMs, id);
    const row = this.db
      .prepare(`${TODO_SELECT} WHERE todos.public_id = ? AND todos.deleted_at_ms IS NULL`)
      .get(id) as TodoRow | undefined;
    return row ? rowToTodo(row) : null;
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM mail_todos WHERE public_id = ?").run(id);
    return result.changes > 0;
  }

  /**
   * Get a todo by id. Returns null if not found.
   */
  getById(id: string): TodoRecord | null {
    const row = this.db
      .prepare(`${TODO_SELECT} WHERE todos.public_id = ? AND todos.deleted_at_ms IS NULL`)
      .get(id) as TodoRow | undefined;
    return row ? rowToTodo(row) : null;
  }

  // ── Task Agent status (Feature F3) ────────────────────────────────

  /**
   * List open (not-done) todos whose source email belongs to the given
   * thread. Used by TaskAgentStatusUpdater.recomputeForThread.
   */
  listOpenByThread(threadId: string): TodoRecord[] {
    const rows = this.db
      .prepare(`
        ${TODO_SELECT}
        INNER JOIN mail_threads threads ON threads.id = messages.thread_id
        WHERE threads.public_id = ? AND todos.completed_at_ms IS NULL
          AND todos.deleted_at_ms IS NULL
        ORDER BY todos.created_at_ms ASC
      `)
      .all(threadId) as TodoRow[];
    return rows.map(rowToTodo);
  }

  /**
   * Set the Task Agent status for a todo. When `lock` is true, the
   * status is locked and future auto-recompute calls must skip this row.
   * Pass `lock: false` to explicitly unlock without changing the status
   * (useful when toggling overrides off via the API).
   */
  setAgentStatus(input: {
    id: string;
    status: TaskAgentStatus | null;
    lock?: boolean;
    /**
     * Route C / WP A: optional rationale for the new status. When any
     * of these fields is omitted the corresponding column is left
     * unchanged. Pass `null` to explicitly clear a column.
     */
    reason?: string | null;
    confidence?: number | null;
    evidenceMessageIds?: string[] | null;
  }): TodoRecord | null {
    const now = this.now();
    const lockedValue =
      input.lock === undefined ? undefined : input.lock ? 1 : 0;
    const reasonProvided = input.reason !== undefined;
    const confidenceProvided = input.confidence !== undefined;
    const evidenceProvided = input.evidenceMessageIds !== undefined;
    const evidenceJson =
      input.evidenceMessageIds === null
        ? null
        : input.evidenceMessageIds !== undefined
          ? JSON.stringify(input.evidenceMessageIds)
          : undefined;

    // Build SQL + params dynamically so we only bind keys we reference.
    // better-sqlite3 rejects `undefined` values for named params that
    // appear in the statement.
    const setFragments: string[] = [
      "agent_status = @status",
      "agent_status_updated_at_ms = @updatedAtMs",
      "updated_at_ms = @updatedAtMs",
      "row_version = row_version + 1",
    ];
    const params: Record<string, unknown> = {
      id: input.id,
      status: input.status,
      updatedAtMs: parseTime(now),
    };
    if (lockedValue !== undefined) {
      setFragments.push("agent_status_locked = @locked");
      params.locked = lockedValue;
    }
    if (reasonProvided) {
      setFragments.push("task_agent_reason = @reason");
      params.reason = input.reason;
    }
    if (confidenceProvided) {
      setFragments.push("task_agent_confidence = @confidence");
      params.confidence = input.confidence;
    }
    if (evidenceProvided) {
      setFragments.push("task_agent_evidence_json = @evidenceJson");
      params.evidenceJson = evidenceJson ?? null;
    }

    this.db
      .prepare(
        `UPDATE mail_todos SET ${setFragments.join(", ")} WHERE public_id = @id`,
      )
      .run(params);
    const row = this.db
      .prepare(`${TODO_SELECT} WHERE todos.public_id = ? AND todos.deleted_at_ms IS NULL`)
      .get(input.id) as TodoRow | undefined;
    return row ? rowToTodo(row) : null;
  }

  // ── Deletion suppression ──────────────────────────────────────────

  /**
   * Record that a user deleted an AI-suggested todo for a specific email.
   * This prevents the same suggestion from reappearing on rerun.
   */
  recordSuppression(input: {
    emailId: string;
    accountId: string;
    normalizedTitle: string;
    dueDate?: string;
  }): void {
    const nowMs = parseTime(this.now());
    const id = `tsup-${randomUUID()}`;
    this.db
      .prepare(`
        INSERT INTO mail_todo_suppressions (
          public_id, account_id, message_id, normalized_title, due_key, created_at_ms
        ) SELECT @id, accounts.id, messages.id, @normalizedTitle, @dueKey, @nowMs
        FROM mail_accounts accounts
        JOIN mail_messages messages ON messages.account_id = accounts.id
        WHERE accounts.public_id = @accountId AND messages.public_id = @emailId
        ON CONFLICT(message_id, normalized_title, due_key) DO UPDATE SET
          created_at_ms = excluded.created_at_ms
      `)
      .run({
        id,
        emailId: input.emailId,
        accountId: input.accountId,
        normalizedTitle: input.normalizedTitle,
        dueKey: input.dueDate ?? "",
        nowMs,
      });
    this.emitFeedback("todo-suppress", {
      emailId: input.emailId,
      accountId: input.accountId,
      normalizedTitle: input.normalizedTitle,
      dueDate: input.dueDate,
    });
  }

  /**
   * Check whether a todo with the given title (and optional dueDate) has been
   * suppressed for this email+account combination.
   */
  isSuppressed(
    emailId: string,
    accountId: string,
    title: string,
    dueDate?: string,
  ): boolean {
    const normalized = normalizeTitle(title);
    const row = this.db
      .prepare(
        `SELECT 1 FROM mail_todo_suppressions suppressions
         JOIN mail_accounts accounts ON accounts.id = suppressions.account_id
         JOIN mail_messages messages ON messages.id = suppressions.message_id
         WHERE messages.public_id = ? AND accounts.public_id = ?
         AND suppressions.normalized_title = ? AND suppressions.due_key = ?
         LIMIT 1`,
      )
      .get(emailId, accountId, normalized, dueDate ?? "");
    return row !== undefined;
  }

  /**
   * Convenience method: delete a todo and record suppression if it was
   * an AI-suggested todo. Returns true if the todo was found and deleted.
   */
  deleteAndSuppress(id: string): boolean {
    const todo = this.getById(id);
    if (!todo) return false;

    const deleted = this.delete(id);
    if (!deleted) return false;

    // Only suppress AI-sourced todos
    if (todo.source === "ai" && todo.emailId) {
      this.recordSuppression({
        emailId: todo.emailId,
        accountId: todo.accountId,
        normalizedTitle: normalizeTitle(todo.title),
        dueDate: todo.dueDate,
      });
    }

    return true;
  }

  private findSuggestedIdentity(
    emailId: string,
    normalizedTitle: string,
    dueAtMs: number | null,
  ): TodoRecord | null {
    const row = this.db.prepare(`${TODO_SELECT}
      WHERE messages.public_id = @emailId
        AND todos.normalized_title = @normalizedTitle
        AND COALESCE(todos.due_at_ms, -1) = COALESCE(@dueAtMs, -1)
        AND todos.deleted_at_ms IS NULL LIMIT 1`).get({
      emailId,
      normalizedTitle,
      dueAtMs,
    }) as TodoRow | undefined;
    return row ? rowToTodo(row) : null;
  }
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid-todo-time");
  return parsed;
}

function optionalTime(value: string | null | undefined): number | null {
  return value ? parseTime(value) : null;
}

function parseStringArray(json: string | null): string[] | undefined {
  if (json === null) return undefined;
  try {
    const parsed = JSON.parse(json);
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed;
    }
  } catch {
    // Malformed JSON or unexpected shape — treat as missing rather than
    // crashing the read path. The AI write path goes through
    // `JSON.stringify(string[])` so this should never trigger in practice.
  }
  return undefined;
}

function rowToTodo(row: TodoRow): TodoRecord {
  const priority: TodoPriority =
    row.priority === "high" || row.priority === "low" ? row.priority : "medium";
  return {
    id: row.id,
    emailId: row.email_id ?? "",
    accountId: row.account_id,
    title: row.title,
    description: row.description ?? undefined,
    dueDate: row.due_date ?? undefined,
    startTime: row.start_time ?? undefined,
    endTime: row.end_time ?? undefined,
    timezone: row.timezone ?? undefined,
    priority,
    done: !!row.done,
    doneDate: row.done_date ?? undefined,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    agentStatus: (row.agent_status as TaskAgentStatus | null) ?? null,
    agentStatusLocked: !!row.agent_status_locked,
    agentStatusUpdatedAt: row.agent_status_updated_at ?? undefined,
    evidence: parseStringArray(row.evidence_json),
    extractionReason: row.extraction_reason ?? undefined,
    extractionConfidence: row.extraction_confidence ?? undefined,
    taskAgentReason: row.task_agent_reason ?? undefined,
    taskAgentConfidence: row.task_agent_confidence ?? undefined,
    taskAgentEvidenceMessageIds: parseStringArray(row.task_agent_evidence_json),
  };
}
