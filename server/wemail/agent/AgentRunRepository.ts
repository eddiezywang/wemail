import { randomUUID } from "node:crypto";
import { normalizeAgentMessageContext } from "../../../shared/wemail/agent.js";
import type {
  AgentJsonValue,
  PersistedAgentFollowup,
  PersistedAgentMessage,
  PersistedAgentRun,
  PersistedAgentToolExecution,
  WemailAgentEvent,
  WemailAgentMessagePart,
  WemailAgentRunState,
} from "../../../shared/wemail/agentProtocol.js";
import {
  createConversationState,
  type ConversationMessageState,
  type ConversationState,
} from "../../../shared/wemail/conversationState.js";
import type { MailDatabase } from "../database/Database.js";

const ACTIVE_STATES: WemailAgentRunState[] = [
  "queued",
  "running",
  "retrying",
  "stopping",
];

interface RunRow {
  id: string;
  conversation_id: string;
  state: WemailAgentRunState;
  last_sequence: number;
  started_at: string | null;
  settled_at: string | null;
  interrupted_at: string | null;
  error_code: string | null;
}

interface ToolRow {
  tool_call_id: string;
  run_id: string;
  tool_name: string;
  input_json: string | null;
  output_json: string | null;
  state: PersistedAgentToolExecution["state"];
  summary: string | null;
  error_code: string | null;
  started_at: string | null;
  ended_at: string | null;
}

interface FollowupRow {
  id: string;
  conversation_id: string;
  text: string;
  attachment_ids_json: string;
  position: number;
  state: PersistedAgentFollowup["state"];
  created_at: string;
  updated_at: string;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function runFromRow(row: RunRow): PersistedAgentRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    state: row.state,
    lastSequence: Number(row.last_sequence),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.settled_at ? { settledAt: row.settled_at } : {}),
    ...(row.interrupted_at ? { interruptedAt: row.interrupted_at } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  };
}

function toolFromRow(row: ToolRow): PersistedAgentToolExecution {
  return {
    toolCallId: row.tool_call_id,
    runId: row.run_id,
    toolName: row.tool_name,
    ...(row.input_json
      ? { input: parseJson<Record<string, AgentJsonValue>>(row.input_json, {}) }
      : {}),
    ...(row.output_json
      ? { output: parseJson<AgentJsonValue>(row.output_json, null) }
      : {}),
    state: row.state,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
  };
}

function followupFromRow(row: FollowupRow): PersistedAgentFollowup {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    text: row.text,
    attachmentIds: parseJson<string[]>(row.attachment_ids_json, []),
    position: Number(row.position),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AgentRunRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  createRun(input: {
    id: string;
    conversationId: string;
    messageId: string;
    state?: WemailAgentRunState;
  }): PersistedAgentRun {
    const now = this.now();
    const state = input.state ?? "queued";
    this.ensureAssistantMessage(input.messageId, input.conversationId, input.id, now);
    this.db.prepare(
      `INSERT INTO agent_runs (
        id, conversation_id, message_id, state, last_sequence,
        started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, -1, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`,
    ).run(
      input.id,
      input.conversationId,
      input.messageId,
      state,
      state === "running" ? now : null,
      now,
      now,
    );
    return this.getRun(input.id)!;
  }

  getRun(id: string): PersistedAgentRun | null {
    const row = this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as
      | RunRow
      | undefined;
    return row ? runFromRow(row) : null;
  }

  listActiveRuns(): PersistedAgentRun[] {
    const placeholders = ACTIVE_STATES.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT * FROM agent_runs WHERE state IN (${placeholders}) ORDER BY created_at`,
    ).all(...ACTIVE_STATES) as RunRow[];
    return rows.map(runFromRow);
  }

  listAttention(accountId: string, failureSince: string): {
    active: PersistedAgentRun[];
    failed: PersistedAgentRun[];
    pausedConversationIds: string[];
  } {
    const activePlaceholders = ACTIVE_STATES.map(() => "?").join(", ");
    const active = (this.db.prepare(
      `SELECT r.* FROM agent_runs r
       JOIN agent_conversations c ON c.id = r.conversation_id
       WHERE c.account_id = ? AND r.state IN (${activePlaceholders})
       ORDER BY r.updated_at DESC`,
    ).all(accountId, ...ACTIVE_STATES) as RunRow[]).map(runFromRow);
    const failed = (this.db.prepare(
      `SELECT r.* FROM agent_runs r
       JOIN agent_conversations c ON c.id = r.conversation_id
       WHERE c.account_id = ? AND r.state IN ('failed', 'interrupted')
         AND r.updated_at >= ?
       ORDER BY r.updated_at DESC`,
    ).all(accountId, failureSince) as RunRow[]).map(runFromRow);
    const paused = this.db.prepare(
      `SELECT DISTINCT q.conversation_id
       FROM agent_followup_queue q
       JOIN agent_conversations c ON c.id = q.conversation_id
       WHERE c.account_id = ? AND q.state = 'paused'
       ORDER BY q.updated_at DESC`,
    ).all(accountId) as Array<{ conversation_id: string }>;
    return { active, failed, pausedConversationIds: paused.map((row) => row.conversation_id) };
  }

  loadConversationState(conversationId: string): ConversationState {
    const state = createConversationState(conversationId);
    const messages = this.db.prepare(
      `SELECT id, run_id, role, body_json, parts_json, created_at,
              COALESCE(updated_at, created_at) AS updated_at
         FROM agent_messages
        WHERE conversation_id = ?
        ORDER BY created_at, id`,
    ).all(conversationId) as Array<{
      id: string;
      run_id: string | null;
      role: ConversationMessageState["role"];
      body_json: string;
      parts_json: string;
      created_at: string;
      updated_at: string;
    }>;
    for (const row of messages) {
      const body = parseJson<Record<string, unknown>>(row.body_json, {});
      const messageContext = normalizeAgentMessageContext(body.messageContext);
      state.messageOrder.push(row.id);
      state.messages[row.id] = {
        id: row.id,
        ...(row.run_id ? { runId: row.run_id } : {}),
        role: row.role,
        state: "completed",
        parts: parseJson(row.parts_json, []),
        ...(messageContext ? { messageContext } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }
    const runs = this.db.prepare(
      "SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY created_at, id",
    ).all(conversationId) as RunRow[];
    for (const row of runs) {
      const run = runFromRow(row);
      state.runs[run.id] = {
        id: run.id,
        state: run.state,
        lastSequence: run.lastSequence,
        ...(run.startedAt ? { startedAt: run.startedAt } : {}),
        ...(run.settledAt ? { settledAt: run.settledAt } : {}),
        ...(run.errorCode
          ? { error: { code: run.errorCode, message: run.errorCode, retryable: false } }
          : {}),
      };
    }
    for (const message of Object.values(state.messages)) {
      if (!message.runId) continue;
      const run = state.runs[message.runId];
      if (!run) continue;
      message.state = run.state === "failed"
        ? "failed"
        : run.state === "stopped"
          ? "stopped"
          : ["queued", "running", "retrying", "stopping"].includes(run.state)
            ? "streaming"
            : "completed";
    }
    const tools = this.db.prepare(
      `SELECT t.* FROM agent_tool_executions t
       JOIN agent_runs r ON r.id = t.run_id
       WHERE r.conversation_id = ? ORDER BY t.updated_at, t.tool_call_id`,
    ).all(conversationId) as ToolRow[];
    for (const row of tools) {
      const tool = toolFromRow(row);
      state.tools[tool.toolCallId] = {
        toolCallId: tool.toolCallId,
        runId: tool.runId,
        toolName: tool.toolName,
        argsText: tool.input ? JSON.stringify(tool.input) : "",
        ...(tool.input ? { input: tool.input } : {}),
        ...(tool.output !== undefined ? { output: tool.output } : {}),
        ...(tool.summary ? { summary: tool.summary } : {}),
        state: tool.state,
        ...(tool.errorCode
          ? { error: { code: tool.errorCode, message: tool.summary ?? tool.errorCode } }
          : {}),
      };
    }
    const citations = this.db.prepare(
      `SELECT id, source_json FROM agent_citations
       WHERE message_id IN (SELECT id FROM agent_messages WHERE conversation_id = ?)
       ORDER BY created_at, id`,
    ).all(conversationId) as Array<{ id: string; source_json: string }>;
    for (const row of citations) {
      state.citations[row.id] = { id: row.id, source: parseJson(row.source_json, { kind: "record", recordType: "unavailable", recordId: row.id }) };
    }
    for (const followup of this.listFollowups(conversationId)) {
      state.followupOrder.push(followup.id);
      state.followups[followup.id] = {
        id: followup.id,
        text: followup.text,
        position: followup.position,
        state:
          followup.state === "paused"
            ? "paused"
            : followup.state === "removed" || followup.state === "completed"
              ? "removed"
              : "queued",
      };
    }
    const attachments = this.db.prepare(
      `SELECT DISTINCT a.id, a.name, a.relative_path, a.parse_state, a.parse_error
       FROM agent_attachments a
       JOIN agent_attachment_refs refs ON refs.attachment_id = a.id
       JOIN agent_messages m ON m.id = refs.message_id
       WHERE m.conversation_id = ?
       ORDER BY a.created_at, a.id`,
    ).all(conversationId) as Array<{
      id: string;
      name: string;
      relative_path: string;
      parse_state: string;
      parse_error: string | null;
    }>;
    for (const attachment of attachments) {
      const failed = attachment.parse_state === "failed";
      state.attachments[attachment.id] = {
        id: attachment.id,
        name: attachment.name,
        relativePath: attachment.relative_path,
        state: failed ? "failed" : "ready",
        ...(failed
          ? { error: { code: "attachment_parse_failed", message: attachment.parse_error ?? "Attachment unavailable" } }
          : {}),
      };
    }
    return state;
  }

  hasActiveRun(conversationId: string): boolean {
    const placeholders = ACTIVE_STATES.map(() => "?").join(", ");
    return !!this.db.prepare(
      `SELECT 1 FROM agent_runs
       WHERE conversation_id = ? AND state IN (${placeholders}) LIMIT 1`,
    ).get(conversationId, ...ACTIVE_STATES);
  }

  reconcileStartup(): { interruptedRunIds: string[]; pausedFollowupIds: string[] } {
    const now = this.now();
    // This transaction reads the active set before updating it. Start with a
    // RESERVED write lock so another database connection cannot commit between
    // the read snapshot and the write-lock upgrade.
    return this.db.transaction(() => {
      const active = this.listActiveRuns();
      if (active.length > 0) {
        const placeholders = active.map(() => "?").join(", ");
        this.db.prepare(
          `UPDATE agent_runs
           SET state = 'interrupted', interrupted_at = ?, updated_at = ?
           WHERE id IN (${placeholders})`,
        ).run(now, now, ...active.map((run) => run.id));
      }
      const queued = this.db.prepare(
        "SELECT id FROM agent_followup_queue WHERE state IN ('queued', 'running')",
      ).all() as Array<{ id: string }>;
      this.db.prepare(
        `UPDATE agent_followup_queue
         SET state = 'paused', pause_reason = 'application_restarted', updated_at = ?
         WHERE state IN ('queued', 'running')`,
      ).run(now);
      return {
        interruptedRunIds: active.map((run) => run.id),
        pausedFollowupIds: queued.map((row) => row.id),
      };
    }).immediate();
  }

  recordEvent(event: WemailAgentEvent): boolean {
    // The desktop database service writes through a separate SQLite connection.
    // A deferred transaction would read the run first and then attempt to
    // upgrade its snapshot to a writer; SQLite can reject that upgrade with
    // SQLITE_BUSY without honoring busy_timeout. BEGIN IMMEDIATE obtains the
    // write reservation before getRun(), so ordinary writer contention waits at
    // the transaction boundary instead of aborting the Agent stream.
    return this.db.transaction(() => {
      const run = this.getRun(event.runId);
      if (!run) {
        this.createRun({
          id: event.runId,
          conversationId: event.conversationId,
          messageId: event.messageId ?? `agent-message-${event.runId}`,
          state: event.type === "run_state_changed" ? event.state : "running",
        });
      }
      const result = this.db.prepare(
        `UPDATE agent_runs SET last_sequence = ?, updated_at = ?
         WHERE id = ? AND last_sequence < ?`,
      ).run(event.sequence, event.timestamp, event.runId, event.sequence);
      if (result.changes === 0) return false;
      this.projectRunState(event);
      this.projectTool(event);
      this.projectCitation(event);
      return true;
    }).immediate();
  }

  persistMessageSnapshot(message: ConversationMessageState): void {
    const parts = message.parts as WemailAgentMessagePart[];
    const markdown = parts
      .filter((part): part is Extract<WemailAgentMessagePart, { type: "text" }> =>
        part.type === "text")
      .map((part) => part.markdown)
      .join("\n\n");
    const body = { text: markdown };
    this.db.prepare(
      `UPDATE agent_messages SET
        body_json = ?, parts_json = ?, markdown_source = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify(body),
      JSON.stringify(parts),
      markdown,
      message.updatedAt,
      message.id,
    );
  }

  getMessage(id: string): PersistedAgentMessage | null {
    const row = this.db.prepare(
      `SELECT id, conversation_id, run_id, role, parts_json,
              attachment_ids_json, created_at, COALESCE(updated_at, created_at) AS updated_at
       FROM agent_messages WHERE id = ?`,
    ).get(id) as {
      id: string;
      conversation_id: string;
      run_id: string | null;
      role: PersistedAgentMessage["role"];
      parts_json: string;
      attachment_ids_json: string;
      created_at: string;
      updated_at: string;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      ...(row.run_id ? { runId: row.run_id } : {}),
      role: row.role,
      parts: parseJson<WemailAgentMessagePart[]>(row.parts_json, []),
      attachmentIds: parseJson<string[]>(row.attachment_ids_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  enqueueFollowup(input: {
    conversationId: string;
    text: string;
    attachmentIds?: string[];
  }): PersistedAgentFollowup {
    const now = this.now();
    const positionRow = this.db.prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS position
       FROM agent_followup_queue
       WHERE conversation_id = ? AND state != 'removed'`,
    ).get(input.conversationId) as { position: number };
    const id = `followup-${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO agent_followup_queue (
        id, conversation_id, text, attachment_ids_json, position,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(
      id,
      input.conversationId,
      input.text,
      JSON.stringify(input.attachmentIds ?? []),
      Number(positionRow.position),
      now,
      now,
    );
    return this.getFollowup(id)!;
  }

  getFollowup(id: string): PersistedAgentFollowup | null {
    const row = this.db.prepare("SELECT * FROM agent_followup_queue WHERE id = ?").get(id) as
      | FollowupRow
      | undefined;
    return row ? followupFromRow(row) : null;
  }

  listFollowups(conversationId: string): PersistedAgentFollowup[] {
    return (this.db.prepare(
      `SELECT * FROM agent_followup_queue
       WHERE conversation_id = ? AND state != 'removed'
       ORDER BY position`,
    ).all(conversationId) as FollowupRow[]).map(followupFromRow);
  }

  updateFollowupText(id: string, text: string): PersistedAgentFollowup | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const result = this.db.prepare(
      `UPDATE agent_followup_queue
       SET text = ?, updated_at = ?
       WHERE id = ? AND state IN ('queued', 'paused')`,
    ).run(trimmed, this.now(), id);
    return result.changes > 0 ? this.getFollowup(id) : null;
  }

  moveFollowup(id: string, position: number): PersistedAgentFollowup[] | null {
    const followup = this.getFollowup(id);
    if (!followup || !["queued", "paused"].includes(followup.state)) return null;
    const items = this.listFollowups(followup.conversationId).filter((item) =>
      ["queued", "paused"].includes(item.state),
    );
    const currentIndex = items.findIndex((item) => item.id === id);
    if (currentIndex < 0) return null;
    const targetIndex = Math.max(0, Math.min(Math.trunc(position), items.length - 1));
    const reordered = [...items];
    const [moved] = reordered.splice(currentIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    const positions = items.map((item) => item.position).sort((a, b) => a - b);
    const now = this.now();
    this.db.transaction(() => {
      const update = this.db.prepare(
        "UPDATE agent_followup_queue SET position = ?, updated_at = ? WHERE id = ?",
      );
      reordered.forEach((item, index) => update.run(-1_000_000 - index, now, item.id));
      reordered.forEach((item, index) => update.run(positions[index], now, item.id));
    })();
    return this.listFollowups(followup.conversationId);
  }

  nextQueuedFollowup(conversationId: string): PersistedAgentFollowup | null {
    const row = this.db.prepare(
      `SELECT * FROM agent_followup_queue
       WHERE conversation_id = ? AND state = 'queued'
       ORDER BY position LIMIT 1`,
    ).get(conversationId) as FollowupRow | undefined;
    return row ? followupFromRow(row) : null;
  }

  setFollowupState(
    id: string,
    state: PersistedAgentFollowup["state"],
    pauseReason?: "user_stopped" | "application_restarted" | "manual",
  ): boolean {
    return this.db.prepare(
      `UPDATE agent_followup_queue
       SET state = ?, pause_reason = ?, updated_at = ? WHERE id = ?`,
    ).run(state, pauseReason ?? null, this.now(), id).changes > 0;
  }

  pauseFollowups(
    conversationId: string,
    reason: "user_stopped" | "application_restarted" | "manual",
  ): string[] {
    const rows = this.db.prepare(
      `SELECT id FROM agent_followup_queue
       WHERE conversation_id = ? AND state IN ('queued', 'running')`,
    ).all(conversationId) as Array<{ id: string }>;
    this.db.prepare(
      `UPDATE agent_followup_queue
       SET state = 'paused', pause_reason = ?, updated_at = ?
       WHERE conversation_id = ? AND state IN ('queued', 'running')`,
    ).run(reason, this.now(), conversationId);
    return rows.map((row) => row.id);
  }

  resumeFollowups(conversationId: string): number {
    return this.db.prepare(
      `UPDATE agent_followup_queue
       SET state = 'queued', pause_reason = NULL, updated_at = ?
       WHERE conversation_id = ? AND state = 'paused'`,
    ).run(this.now(), conversationId).changes;
  }

  private ensureAssistantMessage(
    messageId: string,
    conversationId: string,
    runId: string,
    now: string,
  ): void {
    this.db.prepare(
      `INSERT INTO agent_messages (
        id, conversation_id, role, body_json, created_at, run_id,
        parts_json, markdown_source, attachment_ids_json, updated_at
      ) VALUES (?, ?, 'assistant', ?, ?, ?, '[]', '', '[]', ?)
      ON CONFLICT(id) DO NOTHING`,
    ).run(messageId, conversationId, JSON.stringify({ text: "" }), now, runId, now);
  }

  private projectRunState(event: WemailAgentEvent): void {
    let state: WemailAgentRunState | undefined;
    let errorCode: string | undefined;
    if (event.type === "run_state_changed") state = event.state;
    if (event.type === "run_settled") state = "settled";
    if (event.type === "run_stopped") state = "stopped";
    if (event.type === "run_failed") {
      state = "failed";
      errorCode = event.code;
    }
    if (!state) return;
    const terminal = ["settled", "stopped", "failed", "interrupted"].includes(state);
    this.db.prepare(
      `UPDATE agent_runs SET state = ?,
        started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
        settled_at = CASE WHEN ? THEN ? ELSE settled_at END,
        error_code = COALESCE(?, error_code), updated_at = ?
       WHERE id = ?`,
    ).run(
      state,
      state,
      event.timestamp,
      terminal ? 1 : 0,
      event.timestamp,
      errorCode ?? null,
      event.timestamp,
      event.runId,
    );
    if (terminal) {
      const completed = state === "settled";
      const failureMessage = event.type === "run_failed"
        ? event.message
        : event.type === "run_stopped"
          ? event.reason
          : "操作未能完成";
      this.db.prepare(
        `UPDATE agent_tool_executions
         SET state = ?, error_code = ?, summary = COALESCE(summary, ?),
             ended_at = COALESCE(ended_at, ?), updated_at = ?
         WHERE run_id = ? AND state IN ('receiving_args', 'ready', 'running')`,
      ).run(
        completed ? "completed" : "failed",
        completed ? null : errorCode ?? state,
        completed ? null : failureMessage,
        event.timestamp,
        event.timestamp,
        event.runId,
      );
    }
  }

  private projectTool(event: WemailAgentEvent): void {
    if (event.type === "tool_call_started") {
      this.db.prepare(
        `INSERT INTO agent_tool_executions (
          tool_call_id, run_id, tool_name, state, updated_at
        ) VALUES (?, ?, ?, 'receiving_args', ?)
        ON CONFLICT(tool_call_id) DO NOTHING`,
      ).run(event.toolCallId, event.runId, event.toolName, event.timestamp);
      return;
    }
    if (!("toolCallId" in event)) return;
    if (event.type === "tool_args_completed") {
      this.db.prepare(
        `UPDATE agent_tool_executions
         SET input_json = ?, state = 'ready', updated_at = ? WHERE tool_call_id = ?`,
      ).run(JSON.stringify(event.input), event.timestamp, event.toolCallId);
    } else if (event.type === "tool_execution_started") {
      this.db.prepare(
        `UPDATE agent_tool_executions
         SET state = 'running', started_at = ?, updated_at = ? WHERE tool_call_id = ?`,
      ).run(event.timestamp, event.timestamp, event.toolCallId);
    } else if (event.type === "tool_execution_updated") {
      this.db.prepare(
        `UPDATE agent_tool_executions
         SET output_json = COALESCE(?, output_json), summary = COALESCE(?, summary), updated_at = ?
         WHERE tool_call_id = ?`,
      ).run(
        event.output === undefined ? null : JSON.stringify(event.output),
        event.summary ?? null,
        event.timestamp,
        event.toolCallId,
      );
    } else if (event.type === "tool_execution_completed") {
      this.db.prepare(
        `UPDATE agent_tool_executions SET state = 'completed', output_json = ?,
         summary = ?, ended_at = ?, updated_at = ? WHERE tool_call_id = ?`,
      ).run(
        event.output === undefined ? null : JSON.stringify(event.output),
        event.summary ?? null,
        event.timestamp,
        event.timestamp,
        event.toolCallId,
      );
    } else if (event.type === "tool_execution_failed") {
      this.db.prepare(
        `UPDATE agent_tool_executions SET state = 'failed', error_code = ?,
         summary = ?, ended_at = ?, updated_at = ? WHERE tool_call_id = ?`,
      ).run(event.code, event.message, event.timestamp, event.timestamp, event.toolCallId);
    }
  }

  private projectCitation(event: WemailAgentEvent): void {
    if (event.type !== "citation_added" || !event.messageId) return;
    this.db.prepare(
      `INSERT INTO agent_citations (
        id, message_id, run_id, part_id, source_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        message_id = excluded.message_id,
        run_id = excluded.run_id,
        part_id = excluded.part_id,
        source_json = excluded.source_json`,
    ).run(
      event.citation.id,
      event.messageId,
      event.runId,
      event.partId ?? null,
      JSON.stringify(event.citation.source),
      event.timestamp,
    );
  }
}

export function toolExecutionById(
  db: MailDatabase,
  toolCallId: string,
): PersistedAgentToolExecution | null {
  const row = db.prepare("SELECT * FROM agent_tool_executions WHERE tool_call_id = ?")
    .get(toolCallId) as ToolRow | undefined;
  return row ? toolFromRow(row) : null;
}
