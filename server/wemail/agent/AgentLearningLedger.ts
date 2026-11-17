import { randomUUID } from "node:crypto";
import type { MailDatabase } from "../database/Database.js";
import type {
  AgentJsonValue,
  PersistedAgentBehaviorEvent,
  PersistedAgentPreference,
} from "../../../shared/wemail/agentProtocol.js";

const BEHAVIOR_TYPES = new Set<PersistedAgentBehaviorEvent["type"]>([
  "user_input", "user_edit", "user_confirmed", "user_rejected", "mail_action",
]);
const SECRET_KEY = /(password|passwd|verification.?code|otp|token|cookie|authorization|secret|api.?key)/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /((?:验证码|校验码|verification\s*code|otp)\D{0,12})\d{4,8}/gi,
];

interface BehaviorRow {
  id: string;
  account_id: string;
  type: PersistedAgentBehaviorEvent["type"];
  conversation_id: string | null;
  run_id: string | null;
  payload_json: string;
  created_at: string;
}

interface PreferenceRow {
  id: string;
  account_id: string;
  preference_key: string;
  value_json: string;
  provenance_event_ids_json: string;
  confidence: number;
  last_confirmed_at: string;
  updated_at: string;
}

export class AgentLearningLedger {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(input: {
    accountId: string;
    type: string;
    payload: Record<string, unknown>;
    conversationId?: string;
    runId?: string;
  }): PersistedAgentBehaviorEvent | undefined {
    if (!BEHAVIOR_TYPES.has(input.type as PersistedAgentBehaviorEvent["type"])) {
      return undefined;
    }
    const event: PersistedAgentBehaviorEvent = {
      id: `behavior-${randomUUID()}`,
      accountId: input.accountId,
      type: input.type as PersistedAgentBehaviorEvent["type"],
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      payload: filterSecrets(input.payload) as Record<string, AgentJsonValue>,
      createdAt: this.now().toISOString(),
    };
    this.db.prepare(
      `INSERT INTO agent_user_behavior_events
       (id, account_id, type, conversation_id, run_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id, event.accountId, event.type, event.conversationId ?? null,
      event.runId ?? null, JSON.stringify(event.payload), event.createdAt,
    );
    return event;
  }

  listBehavior(accountId: string): PersistedAgentBehaviorEvent[] {
    return (this.db.prepare(
      "SELECT * FROM agent_user_behavior_events WHERE account_id = ? ORDER BY created_at DESC",
    ).all(accountId) as BehaviorRow[]).map((row) => ({
      id: row.id,
      accountId: row.account_id,
      type: row.type,
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}),
      payload: JSON.parse(row.payload_json) as Record<string, AgentJsonValue>,
      createdAt: row.created_at,
    }));
  }

  observePreference(input: {
    accountId: string;
    key: string;
    value: AgentJsonValue;
    provenanceEventId: string;
    confirmed?: boolean;
  }): PersistedAgentPreference {
    const existing = this.getPreferenceRow(input.accountId, input.key);
    const same = existing && existing.value_json === JSON.stringify(input.value);
    const confidence = input.confirmed
      ? 1
      : same
        ? Math.min(0.95, existing.confidence + 0.1)
        : existing
          ? Math.max(0.2, existing.confidence - 0.25)
          : 0.5;
    const provenance = existing
      ? [...new Set([
          ...(JSON.parse(existing.provenance_event_ids_json) as string[]),
          input.provenanceEventId,
        ])].slice(-50)
      : [input.provenanceEventId];
    const timestamp = this.now().toISOString();
    const value = input.confirmed || !existing || same
      ? input.value
      : JSON.parse(existing.value_json) as AgentJsonValue;
    this.db.prepare(
      `INSERT INTO agent_user_preferences
       (id, account_id, preference_key, value_json, provenance_event_ids_json,
        confidence, last_confirmed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, preference_key) DO UPDATE SET
         value_json = excluded.value_json,
         provenance_event_ids_json = excluded.provenance_event_ids_json,
         confidence = excluded.confidence,
         last_confirmed_at = excluded.last_confirmed_at,
         updated_at = excluded.updated_at`,
    ).run(
      existing?.id ?? `preference-${randomUUID()}`, input.accountId, input.key,
      JSON.stringify(value), JSON.stringify(provenance), confidence,
      input.confirmed ? timestamp : existing?.last_confirmed_at ?? timestamp,
      timestamp,
    );
    return this.getPreference(input.accountId, input.key)!;
  }

  correctPreference(
    accountId: string,
    key: string,
    value: AgentJsonValue,
  ): PersistedAgentPreference {
    const event = this.record({
      accountId,
      type: "user_edit",
      payload: { target: "preference", key, value },
    })!;
    return this.observePreference({
      accountId,
      key,
      value,
      provenanceEventId: event.id,
      confirmed: true,
    });
  }

  deletePreference(accountId: string, key: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM agent_user_preferences WHERE account_id = ? AND preference_key = ?",
    ).run(accountId, key);
    if (result.changes > 0) {
      this.record({
        accountId,
        type: "user_rejected",
        payload: { target: "preference", key },
      });
    }
    return result.changes > 0;
  }

  listPreferences(accountId: string): PersistedAgentPreference[] {
    return (this.db.prepare(
      "SELECT * FROM agent_user_preferences WHERE account_id = ? ORDER BY preference_key",
    ).all(accountId) as PreferenceRow[]).map((row) => this.preferenceFromRow(row));
  }

  cleanupRawBehavior(): number {
    const cutoff = new Date(this.now().getTime() - 180 * 24 * 60 * 60_000).toISOString();
    return this.db.prepare(
      "DELETE FROM agent_user_behavior_events WHERE created_at < ?",
    ).run(cutoff).changes;
  }

  clearLearning(accountId: string): { events: number; preferences: number } {
    return this.db.transaction(() => ({
      events: this.db.prepare("DELETE FROM agent_user_behavior_events WHERE account_id = ?").run(accountId).changes,
      preferences: this.db.prepare("DELETE FROM agent_user_preferences WHERE account_id = ?").run(accountId).changes,
    }))();
  }

  private getPreference(accountId: string, key: string): PersistedAgentPreference | undefined {
    const row = this.getPreferenceRow(accountId, key);
    return row ? this.preferenceFromRow(row) : undefined;
  }

  private getPreferenceRow(accountId: string, key: string): PreferenceRow | undefined {
    return this.db.prepare(
      "SELECT * FROM agent_user_preferences WHERE account_id = ? AND preference_key = ?",
    ).get(accountId, key) as PreferenceRow | undefined;
  }

  private preferenceFromRow(row: PreferenceRow): PersistedAgentPreference {
    const ageDays = Math.max(0, (this.now().getTime() - Date.parse(row.updated_at)) / 86_400_000);
    const decayedConfidence = Math.max(0.05, row.confidence * Math.pow(0.995, ageDays));
    return {
      id: row.id,
      accountId: row.account_id,
      key: row.preference_key,
      value: JSON.parse(row.value_json) as AgentJsonValue,
      provenanceEventIds: JSON.parse(row.provenance_event_ids_json) as string[],
      confidence: Number(decayedConfidence.toFixed(4)),
      lastConfirmedAt: row.last_confirmed_at,
      updatedAt: row.updated_at,
    };
  }
}

export function filterSecrets(value: unknown, key?: string): AgentJsonValue {
  if (key && SECRET_KEY.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERNS.reduce(
      (text, pattern) => text.replace(pattern, (match, prefix?: string) =>
        prefix ? `${prefix}[REDACTED]` : "[REDACTED]"),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => filterSecrets(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, child]) => [childKey, filterSecrets(child, childKey)]),
    );
  }
  return null;
}
