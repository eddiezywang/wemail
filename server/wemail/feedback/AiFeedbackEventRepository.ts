import { randomUUID } from "node:crypto";
import type {
  AiFeedbackEvent,
  AiFeedbackEventType,
  IntelligenceJobType,
} from "../../../shared/wemail/intelligence.js";
import type { MailDatabase } from "../database/Database.js";

/**
 * Keys that MUST NOT appear in feedback event payloads.
 * These correspond to sensitive data that should never be persisted
 * alongside feedback: mail body content, prompt text, raw LLM response.
 */
export const FORBIDDEN_PAYLOAD_KEYS = new Set<string>([
  "bodyText",
  "bodyHtml",
  "prompt",
  "rawResponse",
  "promptBody",
  "rawLlmResponse",
  "llmResponse",
  "password",
  "token",
  "apiKey",
  "secret",
]);

/**
 * Recursively remove forbidden keys from a payload object.
 * Returns a new object; does not mutate the input.
 */
export function sanitizeFeedbackPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key)) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = sanitizeFeedbackPayload(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

interface FeedbackRow {
  public_id: string;
  account_public_id: string;
  feature: string;
  event_type: string;
  target_kind: string | null;
  target_public_id: string | null;
  payload_json: string;
  created_at_ms: bigint;
}

function rowToEvent(row: FeedbackRow): AiFeedbackEvent {
  return {
    id: row.public_id,
    accountId: row.account_public_id,
    feature: row.feature as IntelligenceJobType,
    eventType: row.event_type as AiFeedbackEventType,
    emailId: row.target_kind === "message" ? row.target_public_id ?? undefined : undefined,
    threadId: feedbackThreadId(row.payload_json),
    payload: feedbackPayload(row.payload_json),
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
  };
}

export interface AiFeedbackEventRepositoryDeps {
  db: MailDatabase;
  now?: () => string;
}

/**
 * Repository for persisting and querying AI feedback events.
 *
 * Feedback events capture user actions on AI outputs (accept, reject,
 * edit, etc.) WITHOUT storing full mail body, prompt, or raw LLM response.
 * The `save` method automatically sanitizes payloads by stripping
 * forbidden keys.
 */
export class AiFeedbackEventRepository {
  private readonly db: MailDatabase;
  private readonly now: () => string;

  constructor(deps: AiFeedbackEventRepositoryDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Save a feedback event. The payload is automatically sanitized to
   * remove any forbidden keys (bodyText, bodyHtml, prompt, rawResponse, etc.).
   */
  save(input: {
    accountId: string;
    feature: IntelligenceJobType;
    eventType: AiFeedbackEventType;
    emailId?: string;
    threadId?: string;
    payload: Record<string, unknown>;
  }): void {
    const id = `fb-${randomUUID()}`;
    const sanitized = sanitizeFeedbackPayload(input.payload);
    const createdAtMs = Date.parse(this.now());
    if (!Number.isFinite(createdAtMs)) throw new Error("invalid-feedback-time");
    const payload = input.threadId
      ? { ...sanitized, __threadPublicId: input.threadId }
      : sanitized;
    this.db
      .prepare(`
        INSERT INTO mail_ai_feedback_events (
          public_id, account_id, message_id, thread_id, artifact_id,
          feature, event_type, target_kind, target_public_id,
          payload_json, created_at_ms
        )
        SELECT @id, accounts.id,
          (SELECT id FROM mail_messages WHERE public_id = @emailId),
          (SELECT id FROM mail_threads WHERE public_id = @threadId),
          NULL, @feature, @eventType,
          CASE WHEN @emailId IS NULL THEN NULL ELSE 'message' END,
          @emailId, @payloadJson, @createdAtMs
        FROM mail_accounts accounts WHERE accounts.public_id = @accountId
      `)
      .run({
        id,
        accountId: input.accountId,
        feature: input.feature,
        eventType: input.eventType,
        emailId: input.emailId ?? null,
        threadId: input.threadId ?? null,
        payloadJson: JSON.stringify(payload),
        createdAtMs,
      });
  }

  /**
   * Query feedback events by account, with optional filters.
   */
  findByAccount(
    accountId: string,
    filters?: { feature?: IntelligenceJobType; emailId?: string },
  ): AiFeedbackEvent[] {
    const conditions: string[] = ["accounts.public_id = @accountId"];
    const params: Record<string, unknown> = { accountId };

    if (filters?.feature) {
      conditions.push("feedback.feature = @feature");
      params.feature = filters.feature;
    }
    if (filters?.emailId) {
      conditions.push("feedback.target_kind = 'message' AND feedback.target_public_id = @emailId");
      params.emailId = filters.emailId;
    }

    const rows = this.db
      .prepare(
        `${feedbackSelect()} WHERE ${conditions.join(" AND ")}
         ORDER BY feedback.created_at_ms DESC, feedback.id DESC`,
      )
      .all(params) as FeedbackRow[];

    return rows.map(rowToEvent);
  }

  /**
   * Find feedback events for a specific email.
   */
  findByEmailId(emailId: string): AiFeedbackEvent[] {
    const rows = this.db
      .prepare(
        `${feedbackSelect()} WHERE feedback.target_kind = 'message'
           AND feedback.target_public_id = @emailId
         ORDER BY feedback.created_at_ms DESC, feedback.id DESC`,
      )
      .all({ emailId }) as FeedbackRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Query feedback events by account and feature.
   * Returns all matching events for the given account+feature combination.
   */
  findByAccountAndFeature(
    accountId: string,
    feature: IntelligenceJobType,
  ): AiFeedbackEvent[] {
    const rows = this.db
      .prepare(
        `${feedbackSelect()}
         WHERE accounts.public_id = @accountId AND feedback.feature = @feature
         ORDER BY feedback.created_at_ms DESC, feedback.id DESC`,
      )
      .all({ accountId, feature }) as FeedbackRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Count feedback events by type for a given account and feature.
   * Returns a map of eventType -> count.
   */
  countByEventType(
    accountId: string,
    feature: IntelligenceJobType,
  ): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT event_type, COUNT(*) as count
         FROM mail_ai_feedback_events feedback
         JOIN mail_accounts accounts ON accounts.id = feedback.account_id
         WHERE accounts.public_id = @accountId AND feedback.feature = @feature
         GROUP BY event_type`,
      )
      .all({ accountId, feature }) as Array<{ event_type: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.event_type] = row.count;
    }
    return result;
  }
}

function feedbackSelect(): string {
  return `SELECT feedback.public_id, accounts.public_id AS account_public_id,
    feedback.feature, feedback.event_type, feedback.target_kind,
    feedback.target_public_id, feedback.payload_json, feedback.created_at_ms
    FROM mail_ai_feedback_events feedback
    JOIN mail_accounts accounts ON accounts.id = feedback.account_id`;
}

function feedbackPayload(value: string): Record<string, unknown> {
  const payload = JSON.parse(value) as Record<string, unknown>;
  delete payload.__threadPublicId;
  return payload;
}

function feedbackThreadId(value: string): string | undefined {
  const payload = JSON.parse(value) as Record<string, unknown>;
  return typeof payload.__threadPublicId === "string"
    ? payload.__threadPublicId
    : undefined;
}
