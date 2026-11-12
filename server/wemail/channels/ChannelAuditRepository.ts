import { randomUUID } from "node:crypto";
import type { MailDatabase } from "../database/Database.js";

export interface ChannelAuditEvent {
  id: string;
  eventType: string;
  actor: string;
  connectionId?: string;
  profileId?: string;
  accountId?: string;
  scope: Record<string, unknown>;
  result: string;
  createdAt: string;
}

export class ChannelAuditRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(
    input: Omit<ChannelAuditEvent, "id" | "createdAt">,
  ): ChannelAuditEvent {
    const event: ChannelAuditEvent = {
      ...input,
      id: randomUUID(),
      createdAt: this.now().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO channel_audit_events (
          id, event_type, actor, connection_id, profile_id, account_id,
          scope_json, result, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.eventType,
        event.actor,
        event.connectionId ?? null,
        event.profileId ?? null,
        event.accountId ?? null,
        JSON.stringify(event.scope),
        event.result,
        event.createdAt,
      );
    return event;
  }
}
