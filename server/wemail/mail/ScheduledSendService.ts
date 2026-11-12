import { randomUUID } from "node:crypto";
import type { WemailDraftInput } from "../../../shared/wemail/mail.js";
import type { MailDatabaseScheduledSendRecord } from "../../../shared/wemail/mailDatabaseProtocol.js";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";

export type ScheduledDraftStatus = "pending" | "sent" | "failed" | "cancelled";
export type ScheduledDraftRecord = MailDatabaseScheduledSendRecord;

export interface ScheduledSendServiceOptions {
  mailDatabase: MailDatabaseClient;
  now?: () => Date;
}

/** Typed adapter over canonical outbox scheduling; it never opens SQLite. */
export class ScheduledSendService {
  private readonly now: () => Date;

  constructor(private readonly options: ScheduledSendServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async schedule(payload: WemailDraftInput, sendAt: string): Promise<ScheduledDraftRecord> {
    if (!payload.accountId) throw new Error("schedule: payload.accountId is required");
    const at = new Date(sendAt);
    if (Number.isNaN(at.getTime())) throw new Error("schedule: sendAt must be a valid ISO timestamp");
    if (at.getTime() <= this.now().getTime()) throw new Error("schedule: sendAt must be in the future");
    if (payload.attachments?.length) {
      throw new Error("schedule: attachments must be staged in managed blob storage");
    }
    const result = await this.options.mailDatabase.enqueueSend({
      ...payload,
      attachments: [],
      scheduledAt: at.toISOString(),
      idempotencyKey: `scheduled:${payload.accountId}:${randomUUID()}`,
    });
    const records = await this.options.mailDatabase.listScheduled(payload.accountId);
    const scheduled = records.find((record) => record.id === result.value.outboxId);
    if (!scheduled) throw new Error("scheduled-send-commit-not-readable");
    return scheduled;
  }

  async cancel(id: string, accountId: string): Promise<boolean> {
    return (await this.options.mailDatabase.cancelScheduled(accountId, id)).value;
  }

  async delete(id: string, accountId: string): Promise<boolean> {
    return (await this.options.mailDatabase.deleteScheduled(accountId, id)).value;
  }

  listScheduled(accountId: string): Promise<ScheduledDraftRecord[]> {
    return this.options.mailDatabase.listScheduled(accountId);
  }
}
