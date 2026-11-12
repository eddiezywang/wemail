import { randomUUID } from "node:crypto";
import type {
  ChannelDelivery,
  ChannelDeliveryFallbackTarget,
  ChannelInboundEvent,
  LeasedChannelInbound as LeasedInbound,
} from "../../../shared/wemail/channels.js";
import type { MailDatabase } from "../database/Database.js";

interface InboundRow {
  id: string;
  normalized_json: string;
  status: "pending" | "leased" | "completed" | "ignored" | "failed";
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
}

interface DeliveryRow {
  id: string;
  connection_id: string;
  profile_id: string;
  bot_uuid: string;
  platform: ChannelDelivery["platform"];
  target_type: ChannelDelivery["targetType"];
  target_id: string;
  purpose: ChannelDelivery["purpose"];
  text: string;
  state: ChannelDelivery["state"];
  sequence: number;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  correlation_key: string | null;
  automation_rule_id: string | null;
  automation_run_id: string | null;
  automation_action_index: number | null;
  owner_binding_version: number | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  error_code: string | null;
  fallback_targets_json: string | null;
}

export type { LeasedChannelInbound as LeasedInbound } from "../../../shared/wemail/channels.js";

export class ChannelInboundRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  accept(event: ChannelInboundEvent, profileId?: string): {
    id: string;
    duplicate: boolean;
  } {
    const id = randomUUID();
    const now = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_inbound_events (
          id, connection_id, profile_id, event_uuid, bot_uuid, platform,
          chat_kind, chat_id, sender_id, peer_key, normalized_json, status,
          attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        id,
        event.connectionId,
        profileId ?? null,
        event.eventId,
        event.botUuid,
        event.platform,
        event.chatKind,
        event.chatId,
        event.senderId,
        event.peerKey,
        JSON.stringify(event),
        now,
        now,
      );
    if (result.changes > 0) return { id, duplicate: false };
    const existing = this.db
      .prepare(
        "SELECT id FROM channel_inbound_events WHERE connection_id = ? AND event_uuid = ?",
      )
      .get(event.connectionId, event.eventId) as { id: string };
    return { id: existing.id, duplicate: true };
  }

  leaseNext(workerId: string, leaseMs = 60_000): LeasedInbound | undefined {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT id, normalized_json, status, attempts, lease_owner, lease_expires_at
         FROM channel_inbound_events
         WHERE (
           status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ) OR (
           status = 'leased' AND lease_expires_at <= ?
         )
         ORDER BY created_at
         LIMIT 1`,
      )
      .get(now, now) as InboundRow | undefined;
    if (!row) return undefined;
    const transaction = this.db.transaction(() => {
      const claimed = this.db
        .prepare(
          `UPDATE channel_inbound_events
           SET status = 'leased', attempts = attempts + 1, lease_owner = ?,
               lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND (
             (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
             OR (status = 'leased' AND lease_expires_at <= ?)
           )`,
        )
        .run(workerId, leaseExpiresAt, now, row.id, now, now);
      if (claimed.changes !== 1) return undefined;
      return {
        id: row.id,
        event: JSON.parse(row.normalized_json) as ChannelInboundEvent,
        attempts: Number(row.attempts) + 1,
      };
    });
    return transaction.immediate();
  }

  complete(id: string): void {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE channel_inbound_events SET
          status = 'completed', completed_at = ?, updated_at = ?,
          lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL
         WHERE id = ?`,
      )
      .run(now, now, id);
  }

  ignore(id: string, reason: string): void {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE channel_inbound_events SET
          status = 'ignored', completed_at = ?, updated_at = ?,
          lease_owner = NULL, lease_expires_at = NULL, last_error_code = ?
         WHERE id = ?`,
      )
      .run(now, now, reason, id);
  }

  retry(id: string, errorCode: string, nextAttemptAt: string): void {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE channel_inbound_events SET
          status = 'pending', next_attempt_at = ?, updated_at = ?,
          lease_owner = NULL, lease_expires_at = NULL, last_error_code = ?
         WHERE id = ?`,
      )
      .run(nextAttemptAt, now, errorCode, id);
  }

  fail(id: string, errorCode: string): void {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE channel_inbound_events SET
          status = 'failed', updated_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, last_error_code = ?
         WHERE id = ?`,
      )
      .run(now, errorCode, id);
  }

  retryFailed(id: string): boolean {
    const now = this.now().toISOString();
    return (
      this.db
        .prepare(
          `UPDATE channel_inbound_events SET
            status = 'pending', next_attempt_at = NULL, updated_at = ?,
            last_error_code = NULL
           WHERE id = ? AND status = 'failed'`,
        )
        .run(now, id).changes > 0
    );
  }
}

const deliveryFromRow = (row: DeliveryRow): ChannelDelivery => ({
  id: row.id,
  connectionId: row.connection_id,
  profileId: row.profile_id,
  botUuid: row.bot_uuid,
  platform: row.platform,
  targetType: row.target_type,
  targetId: row.target_id,
  purpose: row.purpose,
  text: row.text,
  state: row.state,
  sequence: Number(row.sequence),
  attempts: Number(row.attempts),
  maxAttempts: Number(row.max_attempts),
  ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
  ...(row.correlation_key ? { correlationKey: row.correlation_key } : {}),
  ...(row.fallback_targets_json
    ? { fallbackTargets: parseFallbackTargets(row.fallback_targets_json) }
    : {}),
  ...(row.automation_rule_id
    ? { automationRuleId: row.automation_rule_id }
    : {}),
  ...(row.automation_run_id ? { automationRunId: row.automation_run_id } : {}),
  ...(row.automation_action_index !== null
    ? { automationActionIndex: Number(row.automation_action_index) }
    : {}),
  ...(row.owner_binding_version !== null
    ? { ownerBindingVersion: Number(row.owner_binding_version) }
    : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.sent_at ? { sentAt: row.sent_at } : {}),
  ...(row.error_code ? { errorCode: row.error_code } : {}),
});

export class ChannelDeliveryRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  enqueue(
    input: Omit<
      ChannelDelivery,
      "id" | "state" | "attempts" | "createdAt" | "updatedAt"
    > & { id?: string },
  ): ChannelDelivery {
    const id = input.id ?? randomUUID();
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_deliveries (
          id, connection_id, profile_id, bot_uuid, platform, target_type,
          target_id, purpose, text, state, sequence, attempts, max_attempts,
          next_attempt_at, correlation_key, automation_rule_id,
          automation_run_id, automation_action_index, owner_binding_version,
          fallback_targets_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.connectionId,
        input.profileId,
        input.botUuid,
        input.platform,
        input.targetType,
        input.targetId,
        input.purpose,
        input.text,
        input.sequence,
        input.maxAttempts,
        input.nextAttemptAt ?? null,
        input.correlationKey ?? null,
        input.automationRuleId ?? null,
        input.automationRunId ?? null,
        input.automationActionIndex ?? null,
        input.ownerBindingVersion ?? null,
        input.fallbackTargets?.length
          ? JSON.stringify(input.fallbackTargets)
          : null,
        now,
        now,
      );
    if (input.correlationKey) {
      return this.db
        .prepare(
          "SELECT * FROM channel_deliveries WHERE correlation_key = ? AND sequence = ?",
        )
        .get(input.correlationKey, input.sequence)
        ? deliveryFromRow(
            this.db
              .prepare(
                "SELECT * FROM channel_deliveries WHERE correlation_key = ? AND sequence = ?",
              )
              .get(input.correlationKey, input.sequence) as DeliveryRow,
          )
        : this.get(id)!;
    }
    return this.get(id)!;
  }

  activateNextFallback(delivery: ChannelDelivery): ChannelDelivery | undefined {
    const [next, ...remaining] = delivery.fallbackTargets ?? [];
    if (!next || !delivery.correlationKey) return undefined;
    return this.enqueue({
      ...next,
      purpose: delivery.purpose,
      text: delivery.text,
      sequence: delivery.sequence + 1,
      maxAttempts: delivery.maxAttempts,
      correlationKey: delivery.correlationKey,
      ...(delivery.automationRuleId
        ? { automationRuleId: delivery.automationRuleId }
        : {}),
      ...(delivery.automationRunId
        ? { automationRunId: delivery.automationRunId }
        : {}),
      automationActionIndex:
        (delivery.automationActionIndex ?? delivery.sequence) + 1,
      ...(remaining.length > 0 ? { fallbackTargets: remaining } : {}),
    });
  }

  markTerminalAndActivateFallback(
    delivery: ChannelDelivery,
    errorCode: string,
    state: "failed" | "ambiguous" | "needs_reauthorization",
  ): ChannelDelivery | undefined {
    return this.db.transaction(() => {
      this.markFailed(delivery.id, errorCode, state);
      return this.activateNextFallback(delivery);
    })();
  }

  markRetryAndActivateFallback(
    delivery: ChannelDelivery,
    errorCode: string,
    nextAttemptAt: string,
  ): { terminal: boolean; fallback?: ChannelDelivery } {
    return this.db.transaction(() => {
      this.markRetry(delivery.id, errorCode, nextAttemptAt);
      const terminal = delivery.attempts >= delivery.maxAttempts;
      const fallback = terminal
        ? this.activateNextFallback(delivery)
        : undefined;
      return {
        terminal,
        ...(fallback ? { fallback } : {}),
      };
    })();
  }

  reconcileTerminalFallbacks(): number {
    const rows = this.db.prepare(`
      SELECT * FROM channel_deliveries
      WHERE state IN ('failed', 'ambiguous', 'needs_reauthorization')
        AND fallback_targets_json IS NOT NULL
    `).all() as DeliveryRow[];
    let activated = 0;
    for (const row of rows) {
      if (this.activateNextFallback(deliveryFromRow(row))) activated += 1;
    }
    return activated;
  }

  get(id: string): ChannelDelivery | undefined {
    const row = this.db
      .prepare("SELECT * FROM channel_deliveries WHERE id = ?")
      .get(id) as DeliveryRow | undefined;
    return row ? deliveryFromRow(row) : undefined;
  }

  leaseNext(workerId: string, leaseMs = 60_000): ChannelDelivery | undefined {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT * FROM channel_deliveries
         WHERE (
           state IN ('pending', 'retrying')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ) OR (
           state = 'leased' AND lease_expires_at <= ?
         )
         ORDER BY created_at, sequence
         LIMIT 1`,
      )
      .get(now, now) as DeliveryRow | undefined;
    if (!row) return undefined;
    const transaction = this.db.transaction(() => {
      const claimed = this.db
        .prepare(
          `UPDATE channel_deliveries SET
            state = 'leased', attempts = attempts + 1, lease_owner = ?,
            lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND (
             (state IN ('pending', 'retrying')
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
             OR (state = 'leased' AND lease_expires_at <= ?)
           )`,
        )
        .run(workerId, leaseExpiresAt, now, row.id, now, now);
      if (claimed.changes !== 1) return undefined;
      return this.get(row.id);
    });
    return transaction.immediate();
  }

  markSent(id: string, responseId?: string): void {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE channel_deliveries SET
          state = 'sent', sent_at = ?, updated_at = ?, response_id = ?,
          lease_owner = NULL, lease_expires_at = NULL, error_code = NULL
         WHERE id = ?`,
      )
      .run(now, now, responseId ?? null, id);
  }

  markInitializationSent(deliveryId: string): void {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE channel_initializations
         SET sent_at = COALESCE(sent_at, ?)
         WHERE delivery_id = ?`,
      )
      .run(now, deliveryId);
  }

  markRetry(id: string, errorCode: string, nextAttemptAt: string): void {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE channel_deliveries SET
          state = CASE WHEN attempts >= max_attempts THEN 'ambiguous' ELSE 'retrying' END,
          next_attempt_at = CASE WHEN attempts >= max_attempts THEN NULL ELSE ? END,
          error_code = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ?`,
      )
      .run(nextAttemptAt, errorCode, now, id);
  }

  markFailed(
    id: string,
    errorCode: string,
    state: "failed" | "ambiguous" | "needs_reauthorization" = "failed",
  ): void {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE channel_deliveries SET
          state = ?, error_code = ?, updated_at = ?, next_attempt_at = NULL,
          lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ?`,
      )
      .run(state, errorCode, now, id);
  }

  retryTerminal(id: string): boolean {
    const now = this.now().toISOString();
    return (
      this.db
        .prepare(
          `UPDATE channel_deliveries SET
            state = 'pending', attempts = 0, next_attempt_at = NULL,
            error_code = NULL, updated_at = ?, lease_owner = NULL,
            lease_expires_at = NULL
           WHERE id = ?
             AND state IN ('failed', 'ambiguous', 'needs_reauthorization')`,
        )
        .run(now, id).changes > 0
    );
  }

  counts(profileId: string): { pending: number; failed: number } {
    const rows = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN state IN ('pending', 'leased', 'retrying') THEN 1 ELSE 0 END) pending,
          SUM(CASE WHEN state IN ('failed', 'ambiguous', 'needs_reauthorization') THEN 1 ELSE 0 END) failed
         FROM channel_deliveries WHERE profile_id = ?`,
      )
      .get(profileId) as { pending: number | null; failed: number | null };
    return { pending: rows.pending ?? 0, failed: rows.failed ?? 0 };
  }
}

function parseFallbackTargets(value: string): ChannelDeliveryFallbackTarget[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is ChannelDeliveryFallbackTarget =>
          !!item && typeof item === "object" &&
          typeof (item as ChannelDeliveryFallbackTarget).connectionId === "string" &&
          typeof (item as ChannelDeliveryFallbackTarget).profileId === "string")
      : [];
  } catch {
    return [];
  }
}
