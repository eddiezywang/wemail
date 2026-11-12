import type { MailDatabase } from "../database/Database.js";
import type { UserTag } from "./UserTagRepository.js";

export type EmailSmartTagSource = "ai" | "user";

export interface EmailSmartTagRelation {
  accountId: string;
  emailId: string;
  userTagId: string;
  source: EmailSmartTagSource;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  account_id: string;
  email_id: string;
  user_tag_id: string;
  source: string;
  confidence: number | null;
  created_at: string;
  updated_at: string;
}

const RELATION_SELECT = `SELECT accounts.public_id AS account_id,
  messages.public_id AS email_id, tags.public_id AS user_tag_id,
  relations.source, relations.confidence,
  datetime(relations.received_at_ms / 1000, 'unixepoch') AS created_at,
  datetime(relations.received_at_ms / 1000, 'unixepoch') AS updated_at
  FROM mail_message_user_tags relations
  JOIN mail_accounts accounts ON accounts.id = relations.account_id
  JOIN mail_messages messages ON messages.id = relations.message_id
  JOIN mail_user_tags tags ON tags.id = relations.tag_id`;

function rowToRelation(row: Row): EmailSmartTagRelation {
  return {
    accountId: row.account_id,
    emailId: row.email_id,
    userTagId: row.user_tag_id,
    source: row.source === "user" ? "user" : "ai",
    confidence: row.confidence ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class EmailSmartTagRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  upsert(input: {
    accountId: string;
    emailId: string;
    userTagId: string;
    source: EmailSmartTagSource;
    confidence?: number;
  }): EmailSmartTagRelation {
    this.now();
    this.db
      .prepare(
        `INSERT INTO mail_message_user_tags (
           account_id, tag_id, message_id, received_at_ms,
           is_seen, is_flagged, has_attachments, source, confidence, row_version
         ) SELECT accounts.id, tags.id, messages.id, messages.received_at_ms,
           messages.is_seen, messages.is_flagged, messages.has_attachments,
           @source, @confidence, 1
         FROM mail_accounts accounts
         JOIN mail_messages messages ON messages.account_id = accounts.id
         JOIN mail_user_tags tags ON tags.account_id = accounts.id
         WHERE accounts.public_id = @accountId AND messages.public_id = @emailId
           AND tags.public_id = @userTagId
         ON CONFLICT(account_id, tag_id, message_id) DO UPDATE SET
           source = CASE
             WHEN mail_message_user_tags.source = 'user' AND excluded.source = 'ai'
               THEN 'user'
             ELSE excluded.source
           END,
           confidence = CASE
             WHEN mail_message_user_tags.source = 'user' AND excluded.source = 'ai'
               THEN mail_message_user_tags.confidence
             ELSE excluded.confidence
           END,
           row_version = mail_message_user_tags.row_version + 1`,
      )
      .run({
        ...input,
        confidence: input.confidence ?? null,
      });
    return this.get(input.emailId, input.userTagId)!;
  }

  get(emailId: string, userTagId: string): EmailSmartTagRelation | null {
    const row = this.db
      .prepare(
        `${RELATION_SELECT}
          WHERE messages.public_id = @emailId AND tags.public_id = @userTagId`,
      )
      .get({ emailId, userTagId }) as Row | undefined;
    return row ? rowToRelation(row) : null;
  }

  listForMessage(emailId: string): EmailSmartTagRelation[] {
    const rows = this.db
      .prepare(
        `${RELATION_SELECT}
          WHERE messages.public_id = ?
          ORDER BY relations.received_at_ms ASC, tags.public_id ASC`,
      )
      .all(emailId) as Row[];
    return rows.map(rowToRelation);
  }

  countByTag(accountId: string, userTagId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM mail_message_user_tags relations
         JOIN mail_accounts accounts ON accounts.id = relations.account_id
         JOIN mail_user_tags tags ON tags.id = relations.tag_id
         WHERE accounts.public_id = @accountId AND tags.public_id = @userTagId`,
      )
      .get({ accountId, userTagId }) as { count: number };
    return row.count;
  }

  listRelationsByTag(
    accountId: string,
    userTagId: string,
  ): EmailSmartTagRelation[] {
    const rows = this.db
      .prepare(
        `${RELATION_SELECT}
          WHERE accounts.public_id = @accountId AND tags.public_id = @userTagId
          ORDER BY relations.received_at_ms ASC, messages.public_id ASC`,
      )
      .all({ accountId, userTagId }) as Row[];
    return rows.map(rowToRelation);
  }

  remove(emailId: string, userTagId: string): boolean {
    const info = this.db
      .prepare(
        `DELETE FROM mail_message_user_tags
         WHERE message_id = (SELECT id FROM mail_messages WHERE public_id = @emailId)
           AND tag_id = (SELECT id FROM mail_user_tags WHERE public_id = @userTagId)`,
      )
      .run({ emailId, userTagId });
    return info.changes > 0;
  }

  removeByTag(userTagId: string): number {
    return this.db
      .prepare(`DELETE FROM mail_message_user_tags WHERE tag_id =
        (SELECT id FROM mail_user_tags WHERE public_id = ?)`)
      .run(userTagId).changes;
  }

  syncAiRelations(input: {
    accountId: string;
    emailId: string;
    userTags: readonly UserTag[];
    tags: ReadonlyArray<{ name: string; confidence: number }>;
  }): void {
    const definitions = new Map(input.userTags.map((tag) => [tag.name, tag]));
    const matchedIds = new Set<string>();
    for (const resultTag of input.tags) {
      const definition = definitions.get(resultTag.name);
      if (!definition) continue;
      matchedIds.add(definition.id);
      this.upsert({
        accountId: input.accountId,
        emailId: input.emailId,
        userTagId: definition.id,
        source: "ai",
        confidence: resultTag.confidence,
      });
    }

    const existingAi = this.db
      .prepare(
        `SELECT tags.public_id AS user_tag_id FROM mail_message_user_tags relations
         JOIN mail_accounts accounts ON accounts.id = relations.account_id
         JOIN mail_messages messages ON messages.id = relations.message_id
         JOIN mail_user_tags tags ON tags.id = relations.tag_id
         WHERE accounts.public_id = @accountId AND messages.public_id = @emailId
           AND relations.source = 'ai'`,
      )
      .all({ accountId: input.accountId, emailId: input.emailId }) as Array<{
        user_tag_id: string;
      }>;
    const remove = this.db.prepare(
      `DELETE FROM mail_message_user_tags
       WHERE message_id = (SELECT id FROM mail_messages WHERE public_id = @emailId)
         AND tag_id = (SELECT id FROM mail_user_tags WHERE public_id = @userTagId)
         AND source = 'ai'`,
    );
    for (const relation of existingAi) {
      if (matchedIds.has(relation.user_tag_id)) continue;
      remove.run({ emailId: input.emailId, userTagId: relation.user_tag_id });
    }
  }
}
