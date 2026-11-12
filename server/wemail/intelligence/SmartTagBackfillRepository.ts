import { randomUUID } from "node:crypto";
import type { MailDatabase } from "../database/Database.js";

export type SmartTagBackfillStatus = "running" | "completed" | "failed";

export interface SmartTagBackfillRun {
  id: string;
  accountId: string;
  reason: string;
  status: SmartTagBackfillStatus;
  scope: "account-scan" | "tagged-relations-only";
  targetTagId?: string;
  promptVersion?: string;
  targetFingerprint?: string;
  scannedCount: number;
  queuedCount: number;
  recentCount: number;
  historicalCount: number;
  processedCount: number;
  failedCount: number;
  retainedCount: number;
  removedCount: number;
  cursorReceivedAt?: string;
  cursorEmailId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface Row {
  id: string;
  account_id: string;
  reason: string;
  status: string;
  scope: string;
  target_tag_id: string | null;
  prompt_version: string | null;
  target_fingerprint: string | null;
  scanned_count: number;
  queued_count: number;
  recent_count: number;
  historical_count: number;
  processed_count: number;
  failed_count: number;
  retained_count: number;
  removed_count: number;
  cursor_received_at: string | null;
  cursor_email_id: string | null;
  error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
}

const RUN_SELECT = `SELECT runs.public_id AS id,
  accounts.public_id AS account_id, runs.reason, runs.state AS status,
  runs.scope, tags.public_id AS target_tag_id, runs.prompt_version,
  runs.target_fingerprint, runs.scanned_count, runs.queued_count,
  runs.recent_count, runs.historical_count, runs.processed_count,
  runs.failed_count, runs.retained_count, runs.removed_count,
  CASE WHEN runs.cursor_received_at_ms IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', runs.cursor_received_at_ms / 1000.0, 'unixepoch') END AS cursor_received_at,
  cursor_messages.public_id AS cursor_email_id, runs.error_code AS error,
  runs.created_at_ms, runs.updated_at_ms, runs.completed_at_ms
  FROM mail_smart_tag_backfill_runs runs
  JOIN mail_accounts accounts ON accounts.id = runs.account_id
  LEFT JOIN mail_user_tags tags ON tags.id = runs.target_tag_id
  LEFT JOIN mail_messages cursor_messages ON cursor_messages.id = runs.cursor_message_id`;

function rowToRun(row: Row): SmartTagBackfillRun {
  return {
    id: row.id,
    accountId: row.account_id,
    reason: row.reason,
    status: row.status === "failed" ? "failed" : row.status === "completed" ? "completed" : "running",
    scope: row.scope === "tagged-relations-only"
      ? "tagged-relations-only"
      : "account-scan",
    targetTagId: row.target_tag_id ?? undefined,
    promptVersion: row.prompt_version ?? undefined,
    targetFingerprint: row.target_fingerprint ?? undefined,
    scannedCount: Number(row.scanned_count),
    queuedCount: Number(row.queued_count),
    recentCount: Number(row.recent_count),
    historicalCount: Number(row.historical_count),
    processedCount: Number(row.processed_count),
    failedCount: Number(row.failed_count),
    retainedCount: Number(row.retained_count),
    removedCount: Number(row.removed_count),
    cursorReceivedAt: row.cursor_received_at ?? undefined,
    cursorEmailId: row.cursor_email_id ?? undefined,
    error: row.error ?? undefined,
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    completedAt: row.completed_at_ms == null ? undefined : new Date(Number(row.completed_at_ms)).toISOString(),
  };
}

export class SmartTagBackfillRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  create(input: {
    accountId: string;
    reason: string;
    targetFingerprint?: string;
  }): SmartTagBackfillRun {
    const id = `stbr-${randomUUID()}`;
    const nowMs = parseTime(this.now());
    this.db
      .prepare(
        `INSERT INTO mail_smart_tag_backfill_runs (
           public_id, account_id, reason, scope, state, target_fingerprint,
           scanned_count, queued_count, recent_count, historical_count, failed_count,
           created_at_ms, updated_at_ms
         ) SELECT @id, accounts.id, @reason, 'account-scan', 'running', @targetFingerprint,
           0, 0, 0, 0, 0,
           @nowMs, @nowMs
         FROM mail_accounts accounts WHERE accounts.public_id = @accountId`,
      )
      .run({
        id,
        accountId: input.accountId,
        reason: input.reason,
        targetFingerprint: input.targetFingerprint ?? null,
        nowMs,
      });
    return this.getById(id)!;
  }

  addProgress(input: {
    id: string;
    scannedDelta?: number;
    queuedDelta?: number;
    recentDelta?: number;
    historicalDelta?: number;
    failedDelta?: number;
    cursorReceivedAt?: string;
    cursorEmailId?: string;
  }): SmartTagBackfillRun | null {
    const nowMs = parseTime(this.now());
    this.db
      .prepare(
        `UPDATE mail_smart_tag_backfill_runs
            SET scanned_count = scanned_count + @scannedDelta,
                queued_count = queued_count + @queuedDelta,
                recent_count = recent_count + @recentDelta,
                historical_count = historical_count + @historicalDelta,
                failed_count = failed_count + @failedDelta,
                cursor_received_at_ms = COALESCE(@cursorReceivedAtMs, cursor_received_at_ms),
                cursor_message_id = COALESCE((SELECT id FROM mail_messages WHERE public_id = @cursorEmailId), cursor_message_id),
                updated_at_ms = @nowMs
          WHERE public_id = @id`,
      )
      .run({
        id: input.id,
        scannedDelta: input.scannedDelta ?? 0,
        queuedDelta: input.queuedDelta ?? 0,
        recentDelta: input.recentDelta ?? 0,
        historicalDelta: input.historicalDelta ?? 0,
        failedDelta: input.failedDelta ?? 0,
        cursorReceivedAtMs: input.cursorReceivedAt ? parseTime(input.cursorReceivedAt) : null,
        cursorEmailId: input.cursorEmailId ?? null,
        nowMs,
      });
    return this.getById(input.id);
  }

  complete(id: string): SmartTagBackfillRun | null {
    const nowMs = parseTime(this.now());
    this.db
      .prepare(
        `UPDATE mail_smart_tag_backfill_runs
            SET state = 'completed', updated_at_ms = @nowMs, completed_at_ms = @nowMs
          WHERE public_id = @id`,
      )
      .run({ id, nowMs });
    return this.getById(id);
  }

  createTargeted(input: {
    accountId: string;
    tagId: string;
    promptVersion: string;
    emailRelations: ReadonlyArray<{ emailId: string; source: "ai" | "user" }>;
  }): SmartTagBackfillRun {
    const id = `stbr-${randomUUID()}`;
    const nowMs = parseTime(this.now());
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO mail_smart_tag_backfill_runs (
           public_id, account_id, reason, state, scope, target_tag_id, prompt_version,
           target_fingerprint, scanned_count, queued_count, recent_count,
           historical_count, processed_count, failed_count, retained_count,
           removed_count, error_code, created_at_ms, updated_at_ms, completed_at_ms
         ) SELECT @id, accounts.id, 'smart-tag-targeted-retag', @status,
           'tagged-relations-only', tags.id, @promptVersion, @promptVersion,
           @count, @count, 0, @count, 0, 0, 0, 0,
           NULL, @nowMs, @nowMs, @completedAtMs
         FROM mail_accounts accounts JOIN mail_user_tags tags ON tags.account_id = accounts.id
         WHERE accounts.public_id = @accountId AND tags.public_id = @tagId`,
      ).run({
        id,
        accountId: input.accountId,
        tagId: input.tagId,
        promptVersion: input.promptVersion,
        count: input.emailRelations.length,
        status: input.emailRelations.length === 0 ? "completed" : "running",
        completedAtMs: input.emailRelations.length === 0 ? nowMs : null,
        nowMs,
      });
      const insert = this.db.prepare(
        `INSERT INTO mail_smart_tag_retag_items (
           run_id, message_id, original_source, state, created_at_ms, updated_at_ms
         ) SELECT runs.id, messages.id, @source, 'pending', @nowMs, @nowMs
         FROM mail_smart_tag_backfill_runs runs
         JOIN mail_messages messages ON messages.public_id = @emailId
         WHERE runs.public_id = @runId`,
      );
      for (const relation of input.emailRelations) {
        insert.run({ runId: id, ...relation, nowMs });
      }
    });
    tx();
    return this.getById(id)!;
  }

  listRunningTargeted(accountId: string, limit = 5): SmartTagBackfillRun[] {
    const rows = this.db.prepare(
      `${RUN_SELECT}
        WHERE accounts.public_id = @accountId
          AND runs.state = 'running'
          AND runs.scope = 'tagged-relations-only'
        ORDER BY runs.created_at_ms ASC, runs.id ASC
        LIMIT @limit`,
    ).all({ accountId, limit: Math.max(1, Math.min(20, limit)) }) as Row[];
    return rows.map(rowToRun);
  }

  cancelTargetedForTag(accountId: string, tagId: string): number {
    const nowMs = parseTime(this.now());
    return this.db.prepare(
      `UPDATE mail_smart_tag_backfill_runs
          SET state = 'failed',
              error_code = 'tag-deleted',
              updated_at_ms = @nowMs,
              completed_at_ms = @nowMs
        WHERE account_id = (SELECT id FROM mail_accounts WHERE public_id = @accountId)
          AND target_tag_id = (SELECT id FROM mail_user_tags WHERE public_id = @tagId)
          AND scope = 'tagged-relations-only'
          AND state = 'running'`,
    ).run({ accountId, tagId, nowMs }).changes;
  }

  listPendingTargetedItems(runId: string, limit = 20): Array<{
    emailId: string;
    originalSource: "ai" | "user";
  }> {
    const rows = this.db.prepare(
      `SELECT messages.public_id AS email_id, items.original_source
        FROM mail_smart_tag_retag_items items
        JOIN mail_smart_tag_backfill_runs runs ON runs.id = items.run_id
        JOIN mail_messages messages ON messages.id = items.message_id
        WHERE runs.public_id = @runId AND items.state = 'pending'
        ORDER BY items.created_at_ms ASC, messages.public_id ASC
        LIMIT @limit`,
    ).all({ runId, limit: Math.max(1, Math.min(200, limit)) }) as Array<{
      email_id: string;
      original_source: string;
    }>;
    return rows.map((row) => ({
      emailId: row.email_id,
      originalSource: row.original_source === "user" ? "user" : "ai",
    }));
  }

  recordTargetedItem(input: {
    runId: string;
    emailId: string;
    matched?: boolean;
    confidence?: number;
    outcome: "retained" | "removed" | "failed";
    errorCode?: string;
  }): SmartTagBackfillRun | null {
    const nowMs = parseTime(this.now());
    const tx = this.db.transaction(() => {
      const changed = this.db.prepare(
        `UPDATE mail_smart_tag_retag_items
            SET state = @status,
                matched = @matched,
                confidence = @confidence,
                error_code = @errorCode,
                updated_at_ms = @nowMs
          WHERE run_id = (SELECT id FROM mail_smart_tag_backfill_runs WHERE public_id = @runId)
            AND message_id = (SELECT id FROM mail_messages WHERE public_id = @emailId)
            AND state = 'pending'`,
      ).run({
        ...input,
        status: input.outcome === "failed" ? "failed" : "completed",
        matched: input.matched === undefined ? null : input.matched ? 1 : 0,
        confidence: input.confidence ?? null,
        errorCode: input.errorCode ?? null,
        nowMs,
      }).changes;
      if (changed === 0) return;
      this.db.prepare(
        `UPDATE mail_smart_tag_backfill_runs
            SET processed_count = processed_count + @processedDelta,
                failed_count = failed_count + @failedDelta,
                retained_count = retained_count + @retainedDelta,
                removed_count = removed_count + @removedDelta,
                error_code = COALESCE(error_code, @errorCode),
                updated_at_ms = @nowMs
          WHERE public_id = @runId AND state = 'running'`,
      ).run({
        runId: input.runId,
        processedDelta: input.outcome === "failed" ? 0 : 1,
        failedDelta: input.outcome === "failed" ? 1 : 0,
        retainedDelta: input.outcome === "retained" ? 1 : 0,
        removedDelta: input.outcome === "removed" ? 1 : 0,
        errorCode: input.errorCode ?? null,
        nowMs,
      });
      const remaining = this.db.prepare(
        `SELECT COUNT(*) AS count FROM mail_smart_tag_retag_items
          WHERE run_id = (SELECT id FROM mail_smart_tag_backfill_runs WHERE public_id = ?)
            AND state = 'pending'`,
      ).get(input.runId) as { count: number };
      if (remaining.count === 0) {
        this.db.prepare(
          `UPDATE mail_smart_tag_backfill_runs
              SET state = 'completed', completed_at_ms = @nowMs, updated_at_ms = @nowMs
            WHERE public_id = @runId AND state = 'running'`,
        ).run({ runId: input.runId, nowMs });
      }
    });
    tx();
    return this.getById(input.runId);
  }

  finishEnqueue(id: string): SmartTagBackfillRun | null {
    const run = this.getById(id);
    if (!run) return null;
    if (run.queuedCount === 0) return this.complete(id);
    return run;
  }

  resumeInterrupted(id: string, accountId: string): SmartTagBackfillRun | null {
    const nowMs = parseTime(this.now());
    const changed = this.db.prepare(
      `UPDATE mail_smart_tag_backfill_runs
          SET state = 'running', error_code = NULL,
              completed_at_ms = NULL, updated_at_ms = @nowMs
        WHERE public_id = @id
          AND account_id = (SELECT id FROM mail_accounts WHERE public_id = @accountId)
          AND state = 'failed' AND error_code = 'backfill-interrupted'`,
    ).run({ id, accountId, nowMs }).changes;
    return changed > 0 ? this.getById(id) : null;
  }

  recordJobTerminal(input: {
    id: string;
    failed?: boolean;
    error?: string;
  }): SmartTagBackfillRun | null {
    const nowMs = parseTime(this.now());
    this.db
      .prepare(
        `UPDATE mail_smart_tag_backfill_runs
            SET processed_count = processed_count + @processedDelta,
                failed_count = failed_count + @failedDelta,
                error_code = CASE
                  WHEN @error IS NULL THEN error_code
                  WHEN error_code IS NULL OR error_code = '' THEN @error
                  ELSE error_code
                END,
                updated_at_ms = @nowMs
          WHERE public_id = @id AND state = 'running'`,
      )
      .run({
        id: input.id,
        processedDelta: input.failed ? 0 : 1,
        failedDelta: input.failed ? 1 : 0,
        error: input.error ?? null,
        nowMs,
      });
    const run = this.getById(input.id);
    if (!run || run.status !== "running") return run;
    if (run.processedCount + run.failedCount < run.queuedCount) return run;
    return this.complete(input.id);
  }

  fail(id: string, error: string): SmartTagBackfillRun | null {
    const nowMs = parseTime(this.now());
    this.db
      .prepare(
        `UPDATE mail_smart_tag_backfill_runs
            SET state = 'failed', error_code = @error,
                updated_at_ms = @nowMs, completed_at_ms = @nowMs
          WHERE public_id = @id`,
      )
      .run({ id, error, nowMs });
    return this.getById(id);
  }

  getById(id: string): SmartTagBackfillRun | null {
    const row = this.db
      .prepare(`${RUN_SELECT} WHERE runs.public_id = ?`)
      .get(id) as Row | undefined;
    return row ? rowToRun(row) : null;
  }

  listByAccount(accountId: string, limit = 20): SmartTagBackfillRun[] {
    const rows = this.db
      .prepare(
        `${RUN_SELECT}
          WHERE accounts.public_id = @accountId
          ORDER BY runs.created_at_ms DESC, runs.id DESC
          LIMIT @limit`,
      )
      .all({ accountId, limit: Math.max(1, Math.min(100, limit)) }) as Row[];
    return rows.map(rowToRun);
  }
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid-smart-tag-backfill-time");
  return parsed;
}
