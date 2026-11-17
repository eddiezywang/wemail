import { randomUUID } from "node:crypto";
import type { MailDatabase } from "../database/Database.js";

export type SmartTagActionType = "apply" | "remove";
export type SmartTagFeedbackType = "positive" | "negative";

export interface SmartTagActionRecord {
  id: string;
  accountId: string;
  emailId: string;
  tagId?: string;
  tagName: string;
  actionType: SmartTagActionType;
  feedbackType: SmartTagFeedbackType;
  reason?: string;
  processedAt?: string;
  createdAt: string;
}

interface Row {
  id: string;
  account_id: string;
  email_id: string;
  tag_id: string;
  tag_name: string;
  action_type: string;
  feedback_type: string;
  reason: string | null;
  processed_at_ms: number | null;
  created_at_ms: number;
}

const ACTION_SELECT = `SELECT actions.public_id AS id,
  accounts.public_id AS account_id, messages.public_id AS email_id,
  tags.public_id AS tag_id, tags.name AS tag_name,
  actions.action_type, actions.feedback_type, actions.reason,
  actions.processed_at_ms, actions.created_at_ms
  FROM mail_smart_tag_actions actions
  JOIN mail_accounts accounts ON accounts.id = actions.account_id
  JOIN mail_messages messages ON messages.id = actions.message_id
  JOIN mail_user_tags tags ON tags.id = actions.tag_id`;

export class SmartTagActionRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  record(input: {
    accountId: string;
    emailId: string;
    tagId?: string;
    tagName: string;
    actionType: SmartTagActionType;
    feedbackType?: SmartTagFeedbackType;
    reason?: string;
  }): SmartTagActionRecord {
    const id = `sta-${randomUUID()}`;
    const nowMs = parseTime(this.now());
    const tagName = input.tagName.trim();
    const tagNorm = tagName.toLocaleLowerCase();
    const feedbackType = input.feedbackType ?? (input.actionType === "remove" ? "negative" : "positive");
    this.db.transaction(() => {
      if (!input.tagId) {
        this.db.prepare(`INSERT INTO mail_user_tags (
          public_id, account_id, name, name_norm, creation_source, created_at_ms, updated_at_ms
        ) SELECT @publicId, accounts.id, @tagName, @tagNorm, 'manual', @nowMs, @nowMs
          FROM mail_accounts accounts WHERE accounts.public_id = @accountId
          ON CONFLICT(account_id, name_norm) DO NOTHING`).run({
          publicId: `tag-${randomUUID()}`,
          accountId: input.accountId,
          tagName,
          tagNorm,
          nowMs,
        });
      }
      this.db.prepare(`INSERT INTO mail_smart_tag_actions (
        public_id, account_id, message_id, tag_id, action_type,
        feedback_type, reason, created_at_ms
      ) SELECT @id, accounts.id, messages.id, tags.id, @actionType,
        @feedbackType, @reason, @nowMs
        FROM mail_accounts accounts
        JOIN mail_messages messages ON messages.account_id = accounts.id
        JOIN mail_user_tags tags ON tags.account_id = accounts.id
          AND ((@tagId IS NOT NULL AND tags.public_id = @tagId)
            OR (@tagId IS NULL AND tags.name_norm = @tagNorm))
        WHERE accounts.public_id = @accountId AND messages.public_id = @emailId`).run({
        id,
        ...input,
        tagNorm,
        feedbackType,
        reason: input.reason?.trim() || null,
        nowMs,
      });
    })();
    const action = this.getById(id);
    if (!action) throw new Error("smart-tag-action-target-missing");
    return action;
  }

  getById(id: string): SmartTagActionRecord | null {
    const row = this.db.prepare(`${ACTION_SELECT} WHERE actions.public_id = ?`).get(id) as Row | undefined;
    return row ? rowToAction(row) : null;
  }

  listRecent(accountId: string, limit = 20): SmartTagActionRecord[] {
    const rows = this.db.prepare(`${ACTION_SELECT}
      WHERE accounts.public_id = @accountId
      ORDER BY actions.created_at_ms DESC, actions.id DESC LIMIT @limit`).all({
      accountId,
      limit: Math.max(1, Math.min(500, limit)),
    }) as Row[];
    return rows.map(rowToAction);
  }

  listUnprocessed(accountId: string, limit = 100): SmartTagActionRecord[] {
    const rows = this.db.prepare(`${ACTION_SELECT}
      WHERE accounts.public_id = @accountId AND actions.processed_at_ms IS NULL
      ORDER BY actions.created_at_ms ASC, actions.id ASC LIMIT @limit`).all({
      accountId,
      limit: Math.max(1, Math.min(500, limit)),
    }) as Row[];
    return rows.map(rowToAction);
  }

  listUnprocessedByTag(input: {
    accountId: string;
    tagId: string;
    limit?: number;
  }): SmartTagActionRecord[] {
    const rows = this.db.prepare(`${ACTION_SELECT}
      WHERE accounts.public_id = @accountId
        AND tags.public_id = @tagId
        AND actions.processed_at_ms IS NULL
      ORDER BY actions.created_at_ms ASC, actions.id ASC
      LIMIT @limit`).all({
      ...input,
      limit: Math.max(1, Math.min(500, input.limit ?? 200)),
    }) as Row[];
    return rows.map(rowToAction);
  }

  listLatestByTag(input: { accountId: string; tagId: string; limit?: number }): SmartTagActionRecord[] {
    const rows = this.db.prepare(`SELECT * FROM (${ACTION_SELECT.replace("SELECT ", "SELECT ROW_NUMBER() OVER (PARTITION BY actions.message_id ORDER BY actions.created_at_ms DESC, actions.id DESC) AS row_rank, ")}
      WHERE accounts.public_id = @accountId AND tags.public_id = @tagId) ranked
      WHERE row_rank = 1 ORDER BY created_at_ms DESC LIMIT @limit`).all({
      ...input,
      limit: Math.max(1, Math.min(500, input.limit ?? 200)),
    }) as Array<Row & { row_rank: number }>;
    return rows.map(rowToAction);
  }

  hasActionAfter(input: { accountId: string; tagId: string; after?: string }): boolean {
    const row = this.db.prepare(`SELECT 1 FROM mail_smart_tag_actions actions
      JOIN mail_accounts accounts ON accounts.id = actions.account_id
      JOIN mail_user_tags tags ON tags.id = actions.tag_id
      WHERE accounts.public_id = @accountId AND tags.public_id = @tagId
        AND (@afterMs IS NULL OR actions.created_at_ms > @afterMs) LIMIT 1`).get({
      ...input,
      afterMs: input.after ? parseTime(input.after) : null,
    });
    return row !== undefined;
  }

  markProcessed(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const nowMs = parseTime(this.now());
    return this.db.transaction((actionIds: readonly string[]) => {
      const statement = this.db.prepare(`UPDATE mail_smart_tag_actions
        SET processed_at_ms = @nowMs WHERE public_id = @id AND processed_at_ms IS NULL`);
      let changed = 0;
      for (const id of actionIds) changed += statement.run({ id, nowMs }).changes;
      return changed;
    })(ids) as number;
  }
}

function rowToAction(row: Row): SmartTagActionRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    emailId: row.email_id,
    tagId: row.tag_id,
    tagName: row.tag_name,
    actionType: row.action_type === "remove" ? "remove" : "apply",
    feedbackType: row.feedback_type === "negative" ? "negative" : "positive",
    reason: row.reason ?? undefined,
    processedAt: row.processed_at_ms == null ? undefined : new Date(row.processed_at_ms).toISOString(),
    createdAt: new Date(row.created_at_ms).toISOString(),
  };
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid-smart-tag-action-time");
  return parsed;
}
