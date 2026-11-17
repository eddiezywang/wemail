import { createHash, randomUUID } from "node:crypto";
import type { MailDatabase } from "../database/Database.js";

export interface SmartTagPromptRevisionRecord {
  id: string;
  accountId: string;
  tagId: string;
  tagName: string;
  oldPrompt: string;
  newPrompt: string;
  summary: string;
  actionCount: number;
  createdAt: string;
}

interface Row {
  id: string;
  account_id: string;
  tag_id: string;
  tag_name: string;
  old_prompt: string;
  new_prompt: string;
  summary: string;
  action_count: number;
  created_at_ms: number;
}

const REVISION_SELECT = `SELECT revisions.public_id AS id,
  accounts.public_id AS account_id, tags.public_id AS tag_id,
  tags.name AS tag_name, revisions.old_prompt, revisions.new_prompt,
  revisions.summary, revisions.action_count, revisions.created_at_ms
  FROM mail_smart_tag_prompt_revisions revisions
  JOIN mail_accounts accounts ON accounts.id = revisions.account_id
  JOIN mail_user_tags tags ON tags.id = revisions.tag_id`;

export class SmartTagPromptRevisionRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  create(input: {
    accountId: string;
    tagId: string;
    tagName: string;
    oldPrompt: string;
    newPrompt: string;
    summary: string;
    actionCount: number;
  }): SmartTagPromptRevisionRecord {
    const id = `stpr-${randomUUID()}`;
    const nowMs = parseTime(this.now());
    this.db.prepare(`INSERT INTO mail_smart_tag_prompt_revisions (
      public_id, account_id, tag_id, revision, old_prompt, new_prompt,
      old_prompt_hash, new_prompt_hash, summary, action_count, created_at_ms
    ) SELECT @id, accounts.id, tags.id,
      COALESCE((SELECT MAX(existing.revision) + 1
        FROM mail_smart_tag_prompt_revisions existing WHERE existing.tag_id = tags.id), 1),
      @oldPrompt, @newPrompt, @oldPromptHash, @newPromptHash,
      @summary, @actionCount, @nowMs
      FROM mail_accounts accounts
      JOIN mail_user_tags tags ON tags.account_id = accounts.id
      WHERE accounts.public_id = @accountId AND tags.public_id = @tagId`).run({
      id,
      ...input,
      oldPromptHash: hashPrompt(input.oldPrompt),
      newPromptHash: hashPrompt(input.newPrompt),
      nowMs,
    });
    const revision = this.getById(id);
    if (!revision) throw new Error("smart-tag-revision-target-missing");
    return revision;
  }

  getById(id: string): SmartTagPromptRevisionRecord | null {
    const row = this.db.prepare(`${REVISION_SELECT} WHERE revisions.public_id = ?`).get(id) as Row | undefined;
    return row ? rowToRevision(row) : null;
  }

  listRecent(accountId: string, limit = 10): SmartTagPromptRevisionRecord[] {
    const rows = this.db.prepare(`${REVISION_SELECT}
      WHERE accounts.public_id = @accountId
      ORDER BY revisions.created_at_ms DESC, revisions.id DESC LIMIT @limit`).all({
      accountId,
      limit: Math.max(1, Math.min(100, limit)),
    }) as Row[];
    return rows.map(rowToRevision);
  }
}

function rowToRevision(row: Row): SmartTagPromptRevisionRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    tagId: row.tag_id,
    tagName: row.tag_name,
    oldPrompt: row.old_prompt,
    newPrompt: row.new_prompt,
    summary: row.summary,
    actionCount: row.action_count,
    createdAt: new Date(row.created_at_ms).toISOString(),
  };
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid-smart-tag-revision-time");
  return parsed;
}
