/**
 * Feature F3 — Task Agent state machine.
 *
 * The upstream automatically labels every active to-do with a coarse "where in
 * the conversation are we?" status and updates the label as the email
 * thread evolves. A user override (the lock flag) freezes the label so
 * the recompute loop must leave it alone.
 *
 * This service is intentionally narrow: it owns the LLM call and the
 * write-back to TodoRepository. It does NOT subscribe to mail events
 * directly — the orchestrator (or any caller) invokes
 * `recomputeForThread(threadId)` whenever the thread changes.
 */

import type { LlmClient } from "../ai/LlmClient.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type { TodoRepository } from "./TodoRepository.js";
import {
  TASK_AGENT_STATUSES,
  type TaskAgentStatus,
} from "../../../shared/wemail/intelligence.js";

export interface TaskAgentStatusUpdaterOptions {
  todos: TodoRepository;
  mail: CanonicalMailRepository;
  llm: LlmClient;
  /** Override the model used for the classification call. */
  model?: string;
  /** Optional log sink. MUST NOT receive bodies — only ids/counts. */
  logger?: (event: string, fields: Record<string, unknown>) => void;
}

/** Hard cap on snippet/body characters fed into the prompt. */
const SNIPPET_LIMIT = 320;
/** Number of trailing thread messages we feed into the prompt. */
const HISTORY_LIMIT = 3;
/** Default model — overridden by composition root via options.model. */
const DEFAULT_MODEL = "gpt-4o-mini";

const STATUS_SET = new Set<string>(TASK_AGENT_STATUSES);

/**
 * JSON schema for the Task Agent classification response. Route C / WP G
 * upgraded the contract from a single status word to a structured object
 * carrying the rationale, model confidence, and the message ids the LLM
 * leaned on. The fields are surfaced in the workspace UI and persisted on
 * the `todos.task_agent_*` columns by `TodoRepository.setAgentStatus`.
 */
export const TASK_AGENT_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: [...TASK_AGENT_STATUSES],
    },
    reason: { type: "string", maxLength: 240 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidenceMessageIds: {
      type: "array",
      maxItems: 3,
      items: { type: "string" },
    },
  },
}) as Record<string, unknown>;

/**
 * The exact prompt template sent to the LLM. Kept short on purpose;
 * the entire payload is the 6 status names + the last 3 messages of
 * the thread + the todo title. The LLM must respond with a JSON object
 * matching `TASK_AGENT_JSON_SCHEMA`.
 */
export function buildTaskAgentPrompt(input: {
  todoTitle: string;
  messages: Array<{ id: string; from: string; subject: string; snippet: string }>;
}): string {
  const lines: string[] = [];
  lines.push(
    "You label an open to-do with one of these statuses based on the latest email thread:",
  );
  lines.push("- to-respond     : the user owes the next reply");
  lines.push("- awaiting-reply : the user is waiting on someone else");
  lines.push("- review-needed  : something needs the user's review");
  lines.push("- approval-needed: something needs the user's approval");
  lines.push("- meeting-update : the thread updates a meeting/schedule");
  lines.push("- suggested-done : the to-do appears already resolved");
  lines.push("");
  lines.push(`Todo: ${input.todoTitle}`);
  lines.push("Last messages (oldest first):");
  for (const msg of input.messages) {
    lines.push(
      `- id=${msg.id} from=${msg.from} subject="${msg.subject}" snippet="${msg.snippet}"`,
    );
  }
  lines.push("");
  lines.push(
    'Respond with a JSON object: {"status":"<one-of-the-six>","reason":"<one sentence>","confidence":<0..1>,"evidenceMessageIds":["<id>", ...]}.',
  );
  lines.push(
    "Cite up to 3 message ids from the list above in `evidenceMessageIds` (omit or use [] if none apply).",
  );
  lines.push("Do not include any text outside the JSON object.");
  return lines.join("\n");
}

/**
 * Parsed shape of the LLM's structured response. `status` is required;
 * the other fields are best-effort and may be omitted when the model
 * declines to provide them.
 */
export interface TaskAgentResponse {
  status: TaskAgentStatus;
  reason?: string;
  confidence?: number;
  evidenceMessageIds?: string[];
}

/**
 * Parse and validate the LLM JSON response. Returns `null` when the
 * input is unparseable or the status is unknown — caller leaves the
 * todo untouched and emits the existing "unrecognized" log.
 */
export function parseTaskAgentResponse(raw: string): TaskAgentResponse | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const statusRaw = typeof obj.status === "string" ? obj.status.trim().toLowerCase() : "";
  if (!STATUS_SET.has(statusRaw)) return null;
  const status = statusRaw as TaskAgentStatus;

  const reason =
    typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim().slice(0, 240)
      : undefined;

  const confidence =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(1, obj.confidence))
      : undefined;

  let evidenceMessageIds: string[] | undefined;
  if (Array.isArray(obj.evidenceMessageIds)) {
    const ids: string[] = [];
    for (const item of obj.evidenceMessageIds) {
      if (typeof item !== "string") continue;
      const trimmed = item.trim();
      if (!trimmed) continue;
      ids.push(trimmed);
      if (ids.length >= 3) break;
    }
    evidenceMessageIds = ids.length > 0 ? ids : undefined;
  }

  return { status, reason, confidence, evidenceMessageIds };
}

export class TaskAgentStatusUpdater {
  private readonly todos: TodoRepository;
  private readonly mail: CanonicalMailRepository;
  private readonly llm: LlmClient;
  private readonly model: string;
  private readonly log: NonNullable<TaskAgentStatusUpdaterOptions["logger"]>;

  constructor(options: TaskAgentStatusUpdaterOptions) {
    this.todos = options.todos;
    this.mail = options.mail;
    this.llm = options.llm;
    this.model = options.model ?? DEFAULT_MODEL;
    this.log = options.logger ?? (() => {});
  }

  /**
   * Recompute the agent status for every open, non-locked todo whose
   * source message belongs to `threadId`. If the LLM call fails we log
   * and leave the existing status untouched.
   */
  async recomputeForThread(threadId: string): Promise<void> {
    if (!threadId) return;

    const allOpen = this.todos.listOpenByThread(threadId);
    const targets = allOpen.filter((t) => !t.agentStatusLocked);
    if (targets.length === 0) return;

    const messages = this.mail.getMessagesByThreadId(threadId);
    if (messages.length === 0) return;
    const tail = messages.slice(-HISTORY_LIMIT).map((m) => ({
      id: m.id,
      from: m.from?.email ?? m.from?.name ?? "unknown",
      subject: m.subject ?? "",
      snippet: ((m.snippet ?? m.bodyText ?? "") as string).slice(0, SNIPPET_LIMIT),
    }));

    for (const todo of targets) {
      const prompt = buildTaskAgentPrompt({
        todoTitle: todo.title,
        messages: tail,
      });
      try {
        const response = await this.llm.generate({
          model: this.model,
          temperature: 0,
          // Route C / WP G: structured response carries status + rationale +
          // confidence + evidence message ids. Bumped from 16 to 200 tokens
          // to accommodate the JSON envelope and one-sentence reason.
          maxTokens: 200,
          jsonSchema: TASK_AGENT_JSON_SCHEMA,
          messages: [{ role: "user", content: prompt }],
        });
        const parsed = parseTaskAgentResponse(response.text ?? "");
        if (!parsed) {
          this.log("task-agent.unrecognized", {
            todoId: todo.id,
            raw: (response.text ?? "").slice(0, 64),
          });
          continue;
        }

        // Only forward optional rationale fields when the model emitted
        // them — omitting a key tells the repository to leave that column
        // unchanged (vs. `null` which explicitly clears it).
        const update: Parameters<TodoRepository["setAgentStatus"]>[0] = {
          id: todo.id,
          status: parsed.status,
        };
        if (parsed.reason !== undefined) update.reason = parsed.reason;
        if (parsed.confidence !== undefined) update.confidence = parsed.confidence;
        if (parsed.evidenceMessageIds !== undefined) {
          update.evidenceMessageIds = parsed.evidenceMessageIds;
        }
        this.todos.setAgentStatus(update);
        this.log("task-agent.updated", {
          todoId: todo.id,
          threadId,
          status: parsed.status,
          hasReason: parsed.reason !== undefined ? 1 : 0,
          hasConfidence: parsed.confidence !== undefined ? 1 : 0,
          evidenceCount: parsed.evidenceMessageIds?.length ?? 0,
        });
      } catch (err) {
        // Constraint: leave the existing status unchanged on failure.
        this.log("task-agent.failed", {
          todoId: todo.id,
          threadId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
