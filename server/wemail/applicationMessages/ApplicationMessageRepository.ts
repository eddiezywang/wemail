import { randomUUID } from "node:crypto";
import type {
  ApplicationMessage, ApplicationMessageContentBlock, ApplicationMessageFilters,
  ApplicationMessageInteraction, ApplicationMessageListResult, ApplicationMessageReference,
  ApplicationMessageSeverity, ApplicationMessageType,
} from "../../../shared/wemail/applicationMessages.js";
import type { MailDatabase } from "../database/Database.js";
import { normalizeApplicationMessageContent } from "./ApplicationMessageContent.js";

interface Row {
  id: string; account_id: string; source_type: ApplicationMessage["sourceType"];
  owner_type: "account" | "local_profile"; owner_profile_id: string | null;
  source_rule_id: string | null; source_run_id: string | null; message_type: ApplicationMessageType;
  severity: ApplicationMessageSeverity; title: string; preview: string; content_json: string;
  references_json: string; interactions_json: string; read_at: string | null; archived_at: string | null;
  artifact_id: string | null; artifact_version: number | null; artifact_kind: "brief" | "report" | "dashboard" | "deck" | null;
  artifact_content_hash: string | null; key_metrics_json: string | null; delayed: number;
  created_at: string; expires_at: string | null;
}

export class ApplicationMessageRepository {
  constructor(private readonly db: MailDatabase, private readonly now = () => new Date().toISOString()) {}

  create(input: Omit<ApplicationMessage, "id" | "readAt" | "archivedAt" | "createdAt"> & { id?: string }): ApplicationMessage {
    const id = input.id ?? `message-${randomUUID()}`;
    const content = normalizeApplicationMessageContent(input.content);
    this.db.prepare(`INSERT INTO application_messages (
      id, account_id, source_type, source_rule_id, source_run_id, message_type, severity,
      title, preview, content_json, references_json, interactions_json,
      artifact_id, artifact_version, artifact_kind, artifact_content_hash, key_metrics_json, delayed,
      owner_type, owner_profile_id, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`.replace("INSERT INTO", "INSERT OR IGNORE INTO")).run(
      id, input.accountId, input.sourceType, input.sourceRuleId ?? null, input.sourceRunId ?? null,
      input.type, input.severity, input.title.trim(), input.preview.trim().slice(0, 500),
      JSON.stringify(content), JSON.stringify(input.references ?? []), JSON.stringify(input.interactions ?? []),
      input.artifact?.id ?? null, input.artifact?.version ?? null, input.artifact?.kind ?? null,
      input.artifact?.contentHash ?? null, input.keyMetrics ? JSON.stringify(input.keyMetrics.slice(0, 6)) : null,
      input.delayed ? 1 : 0,
      input.owner?.type === "localProfile" ? "local_profile" : "account",
      input.owner?.type === "localProfile" ? input.owner.profileId : null,
      this.now(), input.expiresAt ?? null,
    );
    const result = input.sourceRuleId && input.sourceRunId
      ? this.db.prepare("SELECT * FROM application_messages WHERE source_rule_id = ? AND source_run_id = ?").get(input.sourceRuleId, input.sourceRunId) as Row
      : this.db.prepare("SELECT * FROM application_messages WHERE id = ?").get(id) as Row;
    return rowToMessage(result);
  }

  get(id: string, accountId: string): ApplicationMessage | null {
    const row = this.db.prepare(`
      SELECT * FROM application_messages
       WHERE id = ?
         AND (
           (owner_type = 'account' AND account_id = ?)
           OR (owner_type = 'local_profile' AND owner_profile_id = 'default')
         )
    `).get(id, accountId) as Row | undefined;
    return row ? rowToMessage(row) : null;
  }

  findByArtifact(
    artifactId: string,
    artifactVersion: number,
    accountId: string,
  ): ApplicationMessage | null {
    const row = this.db.prepare(`
      SELECT * FROM application_messages
       WHERE artifact_id = ? AND artifact_version = ?
         AND (
           (owner_type = 'account' AND account_id = ?)
           OR (owner_type = 'local_profile' AND owner_profile_id = 'default')
         )
       ORDER BY created_at DESC
       LIMIT 1
    `).get(artifactId, artifactVersion, accountId) as Row | undefined;
    return row ? rowToMessage(row) : null;
  }

  list(accountId: string, filters: ApplicationMessageFilters = {}): ApplicationMessageListResult {
    const where = [
      "((owner_type = 'account' AND account_id = ?) OR (owner_type = 'local_profile' AND owner_profile_id = 'default'))",
      "(expires_at IS NULL OR expires_at > ?)",
    ];
    const params: unknown[] = [accountId, this.now()];
    if (filters.archived !== undefined) where.push(filters.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL");
    else where.push("archived_at IS NULL");
    if (filters.unread !== undefined) where.push(filters.unread ? "read_at IS NULL" : "read_at IS NOT NULL");
    if (filters.type) { where.push("message_type = ?"); params.push(filters.type); }
    if (filters.sourceType) { where.push("source_type = ?"); params.push(filters.sourceType); }
    const clause = where.join(" AND ");
    const total = (this.db.prepare(`SELECT COUNT(*) count FROM application_messages WHERE ${clause}`).get(...params) as { count: number }).count;
    const unread = (this.db.prepare(`
      SELECT COUNT(*) count FROM application_messages
       WHERE ((owner_type = 'account' AND account_id = ?)
          OR (owner_type = 'local_profile' AND owner_profile_id = 'default'))
         AND read_at IS NULL AND archived_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
    `).get(accountId, this.now()) as { count: number }).count;
    const limit = Math.min(100, Math.max(1, filters.limit ?? 30));
    const offset = Math.max(0, filters.offset ?? 0);
    const rows = this.db.prepare(`SELECT * FROM application_messages WHERE ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[];
    return { messages: rows.map(rowToMessage), total, unread, nextOffset: offset + rows.length < total ? offset + rows.length : undefined };
  }

  markRead(id: string, accountId: string, read: boolean): ApplicationMessage | null {
    this.db.prepare(`
      UPDATE application_messages SET read_at = ?
       WHERE id = ? AND (
         (owner_type = 'account' AND account_id = ?)
         OR (owner_type = 'local_profile' AND owner_profile_id = 'default')
       )
    `).run(read ? this.now() : null, id, accountId);
    return this.get(id, accountId);
  }

  archive(id: string, accountId: string, archived: boolean): ApplicationMessage | null {
    this.db.prepare(`
      UPDATE application_messages SET archived_at = ?
       WHERE id = ? AND (
         (owner_type = 'account' AND account_id = ?)
         OR (owner_type = 'local_profile' AND owner_profile_id = 'default')
       )
    `).run(archived ? this.now() : null, id, accountId);
    return this.get(id, accountId);
  }

  replaceContentAndInteractions(input: {
    id: string;
    accountId: string;
    preview: string;
    content: ApplicationMessageContentBlock[];
    interactions?: ApplicationMessageInteraction[];
    severity?: ApplicationMessageSeverity;
  }): ApplicationMessage | null {
    this.db.prepare(`UPDATE application_messages
      SET preview = ?, content_json = ?, interactions_json = ?, severity = ?
      WHERE id = ? AND (
        (owner_type = 'account' AND account_id = ?)
        OR (owner_type = 'local_profile' AND owner_profile_id = 'default')
      )`).run(
      input.preview.trim().slice(0, 500),
      JSON.stringify(normalizeApplicationMessageContent(input.content)),
      JSON.stringify(input.interactions ?? []),
      input.severity ?? "info",
      input.id,
      input.accountId,
    );
    return this.get(input.id, input.accountId);
  }

  cleanupExpired(): number {
    return this.db.prepare("DELETE FROM application_messages WHERE expires_at IS NOT NULL AND expires_at <= ?").run(this.now()).changes;
  }
}

function rowToMessage(row: Row): ApplicationMessage {
  return {
    id: row.id, accountId: row.account_id, sourceType: row.source_type,
    owner:
      row.owner_type === "local_profile"
        ? { type: "localProfile", profileId: "default" }
        : { type: "account", accountId: row.account_id },
    sourceRuleId: row.source_rule_id ?? undefined, sourceRunId: row.source_run_id ?? undefined,
    type: row.message_type, severity: row.severity, title: row.title, preview: row.preview,
    content: JSON.parse(row.content_json) as ApplicationMessageContentBlock[],
    references: JSON.parse(row.references_json) as ApplicationMessageReference[],
    interactions: JSON.parse(row.interactions_json) as ApplicationMessageInteraction[],
    artifact: row.artifact_id && row.artifact_version && row.artifact_kind && row.artifact_content_hash ? {
      id: row.artifact_id, version: row.artifact_version, kind: row.artifact_kind, contentHash: row.artifact_content_hash,
    } : undefined,
    keyMetrics: row.key_metrics_json ? JSON.parse(row.key_metrics_json) as ApplicationMessage["keyMetrics"] : undefined,
    delayed: !!row.delayed,
    readAt: row.read_at ?? undefined, archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at, expiresAt: row.expires_at ?? undefined,
  };
}
