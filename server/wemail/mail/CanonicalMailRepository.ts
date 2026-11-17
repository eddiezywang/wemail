import { randomUUID } from "node:crypto";
import type {
  MailDraftRecord,
  MailFlagsPatch,
  MailListCounts,
  MailMessage,
  MailSearchQuery,
  WemailDraftSaveInput,
} from "../../../shared/wemail/mail.js";
import type { MailDatabase } from "../database/Database.js";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import { MailDatabaseQueryRepository, type MailDatabaseQueryRepositoryOptions } from "../database/MailDatabaseQueryRepository.js";
import { isDefaultSearchExcludedFolder } from "../../../shared/folders.js";

export interface CanonicalMailRepositoryOptions {
  db: MailDatabase;
  mailDatabase: MailDatabaseClient;
  queryOptions?: MailDatabaseQueryRepositoryOptions;
}

export interface AccountMessagePageCursor {
  receivedAt: string;
  id: string;
}

export interface ListMessagesQuery {
  accountId?: string;
  folder?: string;
  limit?: number;
  smartTagId?: string;
  category?: string;
  tag?: string;
  cursor?: AccountMessagePageCursor;
  before?: string;
  unread?: boolean;
  toMe?: string;
  ccMe?: string;
  hasAttachment?: boolean;
  receivedBefore?: string;
  excludedFolders?: string[];
}

export interface ListMessageIdsQuery {
  accountId: string;
  limit?: number;
  before?: AccountMessagePageCursor;
}

export interface MailFolderSummary {
  id: string;
  name: string;
  unreadCount: number;
  totalCount: number;
}

export interface RepositorySearchQuery extends MailSearchQuery {
  accountId?: string;
  toMe?: string;
  ccMe?: string;
  receivedBefore?: string;
}

export interface MailAttachmentFetchDescriptor {
  accountId: string;
  messageId: string;
  attachmentId: string;
  remoteEmailId: string;
  partPath: string;
  filename: string;
  mediaType: string;
  disposition: "inline" | "attachment";
  byteSize: number;
}

/**
 * Canonical read facade for server-side product features that have not yet
 * moved into a dedicated DB Service protocol method. Every query targets the
 * final mail_* schema. Every mutation is delegated to DB Service so this
 * process never becomes a second mail writer.
 */
export class CanonicalMailRepository {
  private readonly queries: MailDatabaseQueryRepository;

  constructor(private readonly options: CanonicalMailRepositoryOptions) {
    this.queries = new MailDatabaseQueryRepository(options.db, options.queryOptions);
  }

  getAccountEmail(accountId: string): string | undefined {
    return this.queries.listAccounts()
      .find((record) => record.account.id === accountId)?.account.emailAddress;
  }

  getMessageById(id: string, accountId?: string): MailMessage | null {
    const message = this.queries.getSnapshot(id).message;
    if (!message || (accountId && message.accountId !== accountId)) return null;
    return message;
  }

  getAttachmentFetchDescriptor(
    messageId: string,
    attachmentId: string,
  ): MailAttachmentFetchDescriptor | null {
    const row = this.options.db.prepare(`
      SELECT
        accounts.public_id AS account_id,
        messages.public_id AS message_id,
        attachments.public_id AS attachment_id,
        attachments.part_path,
        attachments.filename,
        attachments.media_type,
        attachments.disposition,
        attachments.is_inline,
        attachments.byte_size,
        folders.remote_path AS folder_path,
        instances.uid_validity,
        instances.remote_uid
      FROM mail_attachments attachments
      JOIN mail_messages messages ON messages.id = attachments.message_id
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      LEFT JOIN mail_message_instances instances
        ON instances.id = messages.primary_instance_id
      LEFT JOIN mail_folders folders ON folders.id = instances.folder_id
      WHERE messages.public_id = ?
        AND attachments.public_id = ?
        AND messages.deleted_at_ms IS NULL
      LIMIT 1
    `).get(messageId, attachmentId) as {
      account_id: string;
      message_id: string;
      attachment_id: string;
      part_path: string;
      filename: string | null;
      media_type: string;
      disposition: string | null;
      is_inline: bigint;
      byte_size: bigint;
      folder_path: string | null;
      uid_validity: bigint | null;
      remote_uid: bigint | null;
    } | undefined;
    if (
      !row ||
      !row.folder_path ||
      row.uid_validity === null ||
      row.remote_uid === null
    ) {
      return null;
    }
    return {
      accountId: row.account_id,
      messageId: row.message_id,
      attachmentId: row.attachment_id,
      remoteEmailId:
        `${row.account_id}:${row.folder_path}:${Number(row.uid_validity)}:${Number(row.remote_uid)}`,
      partPath: row.part_path,
      filename: row.filename ?? "attachment",
      mediaType: row.media_type || "application/octet-stream",
      disposition:
        row.disposition === "inline" || Number(row.is_inline) === 1
          ? "inline"
          : "attachment",
      byteSize: Number(row.byte_size),
    };
  }

  getMessagesByThreadId(threadId: string, accountId?: string): MailMessage[] {
    const rows = this.options.db.prepare(`
      SELECT messages.public_id
      FROM mail_messages messages
      JOIN mail_threads threads ON threads.id = messages.thread_id
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      WHERE threads.public_id = ? AND messages.deleted_at_ms IS NULL
        AND (? IS NULL OR accounts.public_id = ?)
      ORDER BY messages.received_at_ms ASC, messages.id ASC
    `).all(threadId, accountId ?? null, accountId ?? null) as Array<{ public_id: string }>;
    return this.snapshots(rows.map((row) => row.public_id));
  }

  listMessages(query: ListMessagesQuery = {}): MailMessage[] {
    if (!query.accountId) return [];
    const result = this.queries.list({
      accountId: query.accountId,
      ...(query.folder ? { folder: query.folder } : { allMail: true }),
      limit: Math.min(100, Math.max(1, query.limit ?? 50)),
      ...(query.before ? { before: query.before } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.smartTagId ? { smartTagId: query.smartTagId } : {}),
      ...(query.unread ? { unread: true } : {}),
      ...(query.toMe ? { toMe: true, accountEmail: query.toMe } : {}),
      ...(query.ccMe ? { ccMe: true, accountEmail: query.ccMe } : {}),
      ...(query.hasAttachment ? { hasAttachment: true } : {}),
    });
    return this.snapshots(result.messages.map((message) => message.id))
      .filter((message) => !query.receivedBefore || message.receivedAt < query.receivedBefore)
      .filter((message) => !(query.excludedFolders ?? [])
        .some((folder) => folder.toLowerCase() === message.folder.toLowerCase()))
      .filter((message) => !query.tag || this.hasAiTag(message.id, query.tag));
  }

  listAllMessagesByAccount(accountId: string, limit = 5000): MailMessage[] {
    return this.listCanonicalPage({ accountId, limit });
  }

  listAllMessagesByAccountPage(input: {
    accountId: string;
    limit?: number;
    cursor?: AccountMessagePageCursor;
  }): MailMessage[] {
    return this.listCanonicalPage({ ...input, limit: input.limit ?? 5000 });
  }

  async requestSmartTagBackfill(emailId: string, runId: string): Promise<number> {
    const result = await this.options.mailDatabase.requestIntelligence({
      emailId,
      kinds: ["tags"],
      revive: true,
      context: { smartTagBackfillRunId: runId },
    }, 5_000);
    return result.value.jobIds.length;
  }

  listMessageIds(query: ListMessageIdsQuery): Array<{ id: string; receivedAt: string }> {
    return this.listCanonicalPage({
      accountId: query.accountId,
      limit: query.limit ?? 500,
      cursor: query.before,
    }).map((message) => ({ id: message.id, receivedAt: message.receivedAt }));
  }

  searchMessages(query: RepositorySearchQuery = {}): MailMessage[] {
    return this.searchMessagesWithCount(query).messages;
  }

  searchMessagesWithCount(query: RepositorySearchQuery = {}): {
    messages: MailMessage[];
    counts: MailListCounts;
  } {
    if (!query.accountId) return { messages: [], counts: { totalCount: 0, unreadCount: 0 } };
    const result = this.queries.search({
      accountId: query.accountId,
      query: query.q,
      folder: query.folder,
      from: query.from,
      to: query.to,
      subject: query.subject,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      read: query.read,
      unread: query.unread,
      starred: query.starred,
      hasAttachment: query.hasAttachment,
      toMe: Boolean(query.toMe),
      ccMe: Boolean(query.ccMe),
      limit: Math.min(100, Math.max(1, query.limit ?? 50)),
    });
    // Global search (no folder scope): exclude default-hidden folders so a
    // mail moved to Trash (e.g. via a bot "delete") stops appearing. The SQL
    // layer catches the common English paths; this JS filter is the canonical
    // check (mirrors the semantic-search path) and also covers localized
    // folder names (已删除 / 回收站 / 垃圾邮件 …).
    const excludeDefaultFolders = !query.folder;
    const messages = this.snapshots(result.messages.map((message) => message.id))
      .filter((message) => !query.receivedBefore || message.receivedAt < query.receivedBefore)
      .filter((message) => !excludeDefaultFolders || !isDefaultSearchExcludedFolder(message.folder));
    return {
      messages,
      counts: {
        totalCount: messages.length,
        unreadCount: messages.filter((message) => !message.flags.seen).length,
      },
    };
  }

  hasMessages(query: ListMessagesQuery = {}): boolean {
    return this.listMessages({ ...query, limit: 1 }).length > 0;
  }

  countMessages(query: ListMessagesQuery = {}): MailListCounts {
    const messages = this.listMessages({ ...query, limit: 100 });
    return {
      totalCount: messages.length,
      unreadCount: messages.filter((message) => !message.flags.seen).length,
    };
  }

  listFolders(accountId: string): MailFolderSummary[] {
    return this.queries.listFolders(accountId);
  }

  listDigestCandidates(query: {
    accountId: string;
    windowStart: string;
    windowEnd: string;
    excludedFolders: string[];
    scope?: { scopeKind: "folder" | "view"; scopeKey: string };
    limit: number;
  }): MailMessage[] {
    const start = Date.parse(query.windowStart);
    const end = Date.parse(query.windowEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new Error("invalid-digest-window");
    }
    return this.listCanonicalPage({ accountId: query.accountId, limit: query.limit })
      .filter((message) => {
        const received = Date.parse(message.receivedAt);
        return received > start && received <= end;
      })
      .filter((message) => !query.excludedFolders
        .some((folder) => folder.toLowerCase() === message.folder.toLowerCase()))
      .filter((message) => query.scope?.scopeKind !== "folder" || message.folder === query.scope.scopeKey);
  }

  getDraftById(id: string): MailDraftRecord | null {
    const row = this.options.db.prepare(`
      SELECT accounts.public_id AS account_id
      FROM mail_drafts drafts
      JOIN mail_accounts accounts ON accounts.id = drafts.account_id
      WHERE drafts.public_id = ?
    `).get(id) as { account_id: string } | undefined;
    return row ? this.queries.getDraft(row.account_id, id) : null;
  }

  listDrafts(input: { accountId: string; limit?: number; before?: string }): MailDraftRecord[] {
    return this.queries.listDrafts(input.accountId, input.limit ?? 100)
      .filter((draft) => !input.before || draft.updatedAt < input.before);
  }

  countDrafts(accountId: string): number {
    return this.queries.listDrafts(accountId, 200).length;
  }

  listSnoozed(accountId: string): MailMessage[] {
    return this.queries.listSnoozed(accountId);
  }

  async setSnoozedUntil(id: string, untilIso: string | null): Promise<MailMessage | null> {
    const message = this.getMessageById(id);
    if (!message) return null;
    return (await this.options.mailDatabase.setSnooze({
      accountId: message.accountId,
      emailId: id,
      ...(untilIso ? { until: untilIso } : {}),
    })).value;
  }

  async updateFlags(id: string, patch: MailFlagsPatch): Promise<MailMessage | null> {
    const message = this.getMessageById(id);
    if (!message) return null;
    const result = await this.options.mailDatabase.mutateMail(
      { accountId: message.accountId, emailId: id, mutation: { type: "flags", patch } },
      `canonical-flags:${id}:${randomUUID()}`,
    );
    return result.value.message;
  }

  async moveMessage(id: string, folder: string): Promise<MailMessage | null> {
    return this.mutate(id, { type: "move", folder });
  }

  async trashMessage(id: string): Promise<MailMessage | null> {
    return this.mutate(id, { type: "trash" });
  }

  async deleteMessage(id: string): Promise<boolean> {
    const message = this.getMessageById(id);
    if (!message) return false;
    return (await this.options.mailDatabase.mutateMail(
      { accountId: message.accountId, emailId: id, mutation: { type: "delete" } },
      `canonical-delete:${id}:${randomUUID()}`,
    )).value.deleted;
  }

  async deleteDraft(id: string): Promise<boolean> {
    const draft = this.getDraftById(id);
    if (!draft) return false;
    return (await this.options.mailDatabase.deleteDraft({ accountId: draft.accountId, id })).value;
  }

  async saveDraft(input: WemailDraftSaveInput): Promise<MailDraftRecord> {
    if ((input.attachments?.length ?? 0) > 0) {
      throw new Error("draft-attachments-must-be-staged");
    }
    return (await this.options.mailDatabase.saveDraft({
      ...input,
      attachments: [],
    })).value;
  }

  async updateDraft(input: WemailDraftSaveInput & { id: string }): Promise<MailDraftRecord | null> {
    if (!this.getDraftById(input.id)) return null;
    return this.saveDraft(input);
  }

  getMcpThreadPage(input: {
    accountId: string;
    threadId: string;
    offset: number;
    limit: number;
  }): MailMessage[] {
    return this.getMessagesByThreadId(input.threadId, input.accountId)
      .slice(Math.max(0, input.offset), Math.max(0, input.offset) + Math.max(1, input.limit));
  }

  getMessagesByMessageId(accountId: string, messageId: string): MailMessage[] {
    const normalized = normalizeMessageId(messageId);
    if (!normalized) return [];
    const rows = this.options.db.prepare(`
      SELECT messages.public_id
      FROM mail_messages messages
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      WHERE accounts.public_id = ? AND messages.deleted_at_ms IS NULL
        AND LOWER(TRIM(messages.rfc_message_id)) IN (?, ?)
      ORDER BY messages.received_at_ms DESC, messages.id DESC
    `).all(accountId, normalized, normalized.slice(1, -1)) as Array<{ public_id: string }>;
    return this.snapshots(rows.map((row) => row.public_id));
  }

  private async mutate(
    id: string,
    mutation: { type: "move"; folder: string } | { type: "trash" },
  ): Promise<MailMessage | null> {
    const message = this.getMessageById(id);
    if (!message) return null;
    return (await this.options.mailDatabase.mutateMail(
      { accountId: message.accountId, emailId: id, mutation },
      `canonical-mutation:${id}:${randomUUID()}`,
    )).value.message;
  }

  private listCanonicalPage(input: {
    accountId: string;
    limit: number;
    cursor?: AccountMessagePageCursor;
  }): MailMessage[] {
    const limit = Math.min(5000, Math.max(1, input.limit));
    const cursorTime = input.cursor ? Date.parse(input.cursor.receivedAt) : null;
    const rows = this.options.db.prepare(`
      SELECT messages.public_id
      FROM mail_messages messages
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      WHERE accounts.public_id = ? AND messages.deleted_at_ms IS NULL
        AND (? IS NULL OR messages.received_at_ms < ?
          OR (messages.received_at_ms = ? AND messages.public_id < ?))
      ORDER BY messages.received_at_ms DESC, messages.public_id DESC
      LIMIT ?
    `).all(
      input.accountId,
      cursorTime,
      cursorTime,
      cursorTime,
      input.cursor?.id ?? null,
      limit,
    ) as Array<{ public_id: string }>;
    return this.snapshots(rows.map((row) => row.public_id));
  }

  private snapshots(ids: string[]): MailMessage[] {
    return ids
      .map((id) => this.queries.getSnapshot(id).message)
      .filter((message): message is MailMessage => !!message);
  }

  private hasAiTag(messageId: string, tag: string): boolean {
    const row = this.options.db.prepare(`
      SELECT 1
      FROM mail_messages messages
      JOIN mail_message_ai_current current
        ON current.message_id = messages.id AND current.artifact_kind = 'tags'
      JOIN mail_ai_artifacts artifact ON artifact.id = current.artifact_id
      JOIN json_each(artifact.json_value, '$.tags') item
      WHERE messages.public_id = ? AND artifact.state = 'ready'
        AND json_extract(item.value, '$.name') = ?
      LIMIT 1
    `).get(messageId, tag);
    return !!row;
  }
}

function normalizeMessageId(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed
    : `<${trimmed.replace(/^<|>$/g, "")}>`;
}
