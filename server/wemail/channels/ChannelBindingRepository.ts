import { randomUUID } from "node:crypto";
import type {
  ChannelBinding,
  ChannelChatKind,
  ChannelPlatform,
} from "../../../shared/wemail/channels.js";
import type { MailDatabase } from "../database/Database.js";

interface BindingRow {
  id: string;
  connection_id: string;
  profile_id: string;
  bot_uuid: string;
  platform: ChannelPlatform;
  chat_kind: ChannelChatKind;
  chat_id: string;
  sender_id: string;
  account_id: string;
  conversation_id: string;
  enabled: number;
  require_mention: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

const fromRow = (row: BindingRow): ChannelBinding => ({
  id: row.id,
  connectionId: row.connection_id,
  profileId: row.profile_id,
  botUuid: row.bot_uuid,
  platform: row.platform,
  chatKind: row.chat_kind,
  chatId: row.chat_id,
  senderId: row.sender_id,
  accountId: row.account_id,
  conversationId: row.conversation_id,
  enabled: row.enabled === 1,
  requireMention: row.require_mention === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
});

export class ChannelBindingRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  save(input: Omit<ChannelBinding, "id" | "createdAt" | "updatedAt"> & {
    id?: string;
  }): ChannelBinding {
    const id = input.id ?? randomUUID();
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO channel_bindings (
          id, connection_id, profile_id, bot_uuid, platform, chat_kind,
          chat_id, sender_id, account_id, conversation_id, enabled,
          require_mention, created_at, updated_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id, bot_uuid, platform, chat_kind, chat_id, sender_id)
        DO UPDATE SET
          profile_id = excluded.profile_id,
          account_id = excluded.account_id,
          conversation_id = excluded.conversation_id,
          enabled = excluded.enabled,
          require_mention = excluded.require_mention,
          updated_at = excluded.updated_at,
          revoked_at = excluded.revoked_at`,
      )
      .run(
        id,
        input.connectionId,
        input.profileId,
        input.botUuid,
        input.platform,
        input.chatKind,
        input.chatId,
        input.senderId,
        input.accountId,
        input.conversationId,
        input.enabled ? 1 : 0,
        input.requireMention ? 1 : 0,
        now,
        now,
        input.revokedAt ?? null,
      );
    return this.resolve({
      connectionId: input.connectionId,
      botUuid: input.botUuid,
      platform: input.platform,
      chatKind: input.chatKind,
      chatId: input.chatId,
      senderId: input.senderId,
      includeDisabled: true,
    })!;
  }

  resolve(input: {
    connectionId: string;
    botUuid: string;
    platform: ChannelPlatform;
    chatKind: ChannelChatKind;
    chatId: string;
    senderId: string;
    includeDisabled?: boolean;
  }): ChannelBinding | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM channel_bindings
         WHERE connection_id = ? AND bot_uuid = ? AND platform = ?
           AND chat_kind = ? AND chat_id = ? AND sender_id = ?
           ${input.includeDisabled ? "" : "AND enabled = 1 AND revoked_at IS NULL"}`,
      )
      .get(
        input.connectionId,
        input.botUuid,
        input.platform,
        input.chatKind,
        input.chatId,
        input.senderId,
      ) as BindingRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  revoke(id: string): boolean {
    const now = this.now().toISOString();
    return (
      this.db
        .prepare(
          `UPDATE channel_bindings
           SET enabled = 0, revoked_at = ?, updated_at = ?
           WHERE id = ? AND revoked_at IS NULL`,
        )
        .run(now, now, id).changes > 0
    );
  }

  revokeByProfile(profileId: string): number {
    const now = this.now().toISOString();
    return this.db
      .prepare(
        `UPDATE channel_bindings
         SET enabled = 0, revoked_at = COALESCE(revoked_at, ?), updated_at = ?
         WHERE profile_id = ? AND enabled = 1`,
      )
      .run(now, now, profileId).changes;
  }

  invalidateAccount(accountId: string): number {
    const now = this.now().toISOString();
    return this.db
      .prepare(
        `UPDATE channel_bindings
         SET enabled = 0, revoked_at = COALESCE(revoked_at, ?), updated_at = ?
         WHERE account_id = ? AND enabled = 1`,
      )
      .run(now, now, accountId).changes;
  }

  listByAccount(accountId: string): ChannelBinding[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM channel_bindings WHERE account_id = ? ORDER BY created_at",
        )
        .all(accountId) as BindingRow[]
    ).map(fromRow);
  }

  listByProfile(profileId: string): ChannelBinding[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM channel_bindings WHERE profile_id = ? ORDER BY created_at",
        )
        .all(profileId) as BindingRow[]
    ).map(fromRow);
  }

  findActiveOwner(profileId: string, senderId: string): ChannelBinding | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM channel_bindings
         WHERE profile_id = ?
           AND chat_kind = 'person'
           AND sender_id = ?
           AND enabled = 1
           AND revoked_at IS NULL
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(profileId, senderId) as BindingRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const now = this.now().toISOString();
    return (
      this.db
        .prepare(
          `UPDATE channel_bindings
           SET enabled = ?, updated_at = ?
           WHERE id = ? AND revoked_at IS NULL`,
        )
        .run(enabled ? 1 : 0, now, id).changes > 0
    );
  }
}
