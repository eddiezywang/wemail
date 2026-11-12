import { randomUUID } from "node:crypto";
import type { WemailAgentMessagePart } from "../../../shared/wemail/agentProtocol.js";
import type { MailDatabase } from "../database/Database.js";

export interface AgentConversationRecord {
  id: string;
  accountId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  pinnedAt?: string;
  /**
   * Originating channel platform when this conversation was started from a bot
   * channel (e.g. "wecom" / "feishu"). Derived from the messages' stored
   * channelPlatform so the sidebar can badge channel conversations apart from
   * normal in-app agent chats. Undefined for plain agent conversations.
   */
  channelPlatform?: string;
}

export interface AgentMessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  body: Record<string, unknown>;
  createdAt: string;
}

interface ConversationRow {
  id: string;
  account_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  pinned_at: string | null;
  channel_platform: string | null;
}

// Derives a conversation's originating bot-channel platform (wecom/feishu)
// from the first message that carries one, so channel conversations can be
// badged in the UI without a schema change. Append to any agent_conversations
// SELECT aliased as `c`.
const CHANNEL_PLATFORM_SELECT = `,
  (SELECT m.body_json ->> '$.channelPlatform'
   FROM agent_messages m
   WHERE m.conversation_id = c.id
     AND m.body_json ->> '$.channelPlatform' IS NOT NULL
   ORDER BY m.created_at ASC
   LIMIT 1) AS channel_platform`;

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  body_json: string;
  created_at: string;
}

export interface ListConversationsOptions {
  /** When true, includes archived rows; otherwise they are excluded. */
  includeArchived?: boolean;
  /**
   * Case-insensitive substring filter on the `title` column. When provided,
   * the SQL adds `title LIKE ? COLLATE NOCASE` and rows with NULL titles
   * are excluded. The literal is wrapped with `%…%`; SQL LIKE wildcards in
   * the input are NOT escaped — callers should sanitize if untrusted.
   */
  search?: string;
  /** Filter by originating mailbox account. */
  accountId?: string;
}

/** Hard cap on rows returned to keep the LIKE scan bounded. */
const LIST_RESULT_CAP = 200;

export class AgentConversationRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  ensureConversation(input: {
    id?: string;
    accountId?: string;
    title?: string;
  }): AgentConversationRecord {
    if (input.id) {
      const existing = this.get(input.id);
      if (existing) return existing;
    }
    const now = this.now();
    const id = input.id ?? `conv-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO agent_conversations (id, account_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.accountId ?? "local", input.title ?? null, now, now);
    return this.get(id)!;
  }

  get(id: string): AgentConversationRecord | null {
    const row = this.db
      .prepare(
        `SELECT c.* ${CHANNEL_PLATFORM_SELECT}
         FROM agent_conversations c
         WHERE c.id = ?`,
      )
      .get(id) as ConversationRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  /**
   * List conversations sorted by most recently updated first. Archived
   * rows are excluded by default; pass `{ includeArchived: true }` to
   * include them. Callers needing a separate "archived" group should
   * partition the result on `archivedAt`. Supports optional case-insensitive
   * title search and per-account filtering. Returns at most
   * {@link LIST_RESULT_CAP} rows.
   */
  list(options: ListConversationsOptions = {}): AgentConversationRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!options.includeArchived) {
      where.push("c.archived_at IS NULL");
    }
    if (options.accountId) {
      where.push("c.account_id = ?");
      params.push(options.accountId);
    }
    const search = options.search?.trim();
    if (search) {
      where.push("c.title IS NOT NULL AND c.title LIKE ? COLLATE NOCASE");
      params.push(`%${search}%`);
    }
    const sql = [
      `SELECT c.* ${CHANNEL_PLATFORM_SELECT} FROM agent_conversations c`,
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY c.updated_at DESC",
      `LIMIT ${LIST_RESULT_CAP}`,
    ]
      .filter(Boolean)
      .join(" ");
    const rows = this.db.prepare(sql).all(...params) as ConversationRow[];
    return rows.map(rowToConversation);
  }

  /**
   * Update the conversation title. Pass `null` to clear the title.
   * Returns true if a row was updated.
   */
  setTitle(id: string, title: string | null): boolean {
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE agent_conversations
         SET title = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(title, now, id);
    return result.changes > 0;
  }

  /**
   * Soft-delete a conversation by stamping `archived_at`. Idempotent:
   * already-archived rows keep their original `archived_at` timestamp
   * and the call returns false.
   */
  archive(id: string): boolean {
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE agent_conversations
         SET archived_at = ?
         WHERE id = ? AND archived_at IS NULL`,
      )
      .run(now, id);
    return result.changes > 0;
  }

  /** Clear `archived_at`, restoring the conversation to the main list. */
  unarchive(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_conversations
         SET archived_at = NULL
         WHERE id = ? AND archived_at IS NOT NULL`,
      )
      .run(id);
    return result.changes > 0;
  }

  /**
   * Stamp `pinned_at` on the conversation. Idempotent: a pin call on an
   * already-pinned row keeps the original timestamp and returns false.
   * Does not modify `updated_at` so pinning doesn't reorder the time-bucket
   * fallback view.
   */
  pin(id: string): boolean {
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE agent_conversations
         SET pinned_at = ?
         WHERE id = ? AND pinned_at IS NULL`,
      )
      .run(now, id);
    return result.changes > 0;
  }

  /** Clear `pinned_at`. Idempotent on already-unpinned rows. */
  unpin(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_conversations
         SET pinned_at = NULL
         WHERE id = ? AND pinned_at IS NOT NULL`,
      )
      .run(id);
    return result.changes > 0;
  }

  addMessage(input: {
    conversationId: string;
    role: "user" | "assistant";
    body: Record<string, unknown>;
  }): AgentMessageRecord {
    const now = this.now();
    const id = `msg-${randomUUID()}`;
    const text = typeof input.body.text === "string" ? input.body.text : "";
    const parts: WemailAgentMessagePart[] = text.trim()
      ? [{
          id: `text:${id}`,
          type: "text",
          markdown: text,
          state: "completed",
          citationIds: [],
        }]
      : [];
    this.db
      .prepare(
        `INSERT INTO agent_messages (
           id, conversation_id, role, body_json, created_at,
           parts_json, markdown_source, attachment_ids_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.role,
        JSON.stringify(input.body),
        now,
        JSON.stringify(parts),
        text,
        JSON.stringify(Array.isArray(input.body.attachmentIds) ? input.body.attachmentIds : []),
        now,
      );
    this.db
      .prepare("UPDATE agent_conversations SET updated_at = ? WHERE id = ?")
      .run(now, input.conversationId);
    return this.listMessages(input.conversationId).at(-1)!;
  }

  listMessages(conversationId: string): AgentMessageRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY created_at ASC")
      .all(conversationId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * Hard-delete every conversation row. By design this also removes
   * archived rows — "Clear all" is the user's explicit nuclear option,
   * matching the existing `window.confirm` prompt in AgentSidebar.
   * Per-conversation archive is the soft-delete path.
   */
  clear(): void {
    this.db.prepare("DELETE FROM agent_conversations").run();
  }
}

function rowToConversation(row: ConversationRow): AgentConversationRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
    pinnedAt: row.pinned_at ?? undefined,
    channelPlatform: row.channel_platform ?? undefined,
  };
}

function rowToMessage(row: MessageRow): AgentMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    body: JSON.parse(row.body_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}
