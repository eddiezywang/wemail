import { ChannelInboundRepository, ChannelDeliveryRepository } from "../channels/ChannelLedgerRepository.js";
import { MailDatabaseChannelLeaseParamsSchema, type MailDatabaseChannelLeaseParams } from "../../../shared/wemail/mailDatabaseProtocol.js";
import { runDatabaseRetentionBatch } from "../security/DatabaseRetention.js";
import { DirectoryRepository } from "../directory/DirectoryRepository.js";
import type { DirectoryWriteParams } from "../../../shared/wemail/directoryDatabase.js";
import type { DatabaseRetentionBatchParams, DatabaseRetentionBatchResult } from "../../../shared/wemail/retention.js";
import { BusinessPreferencesPatchSchema, type BusinessPreferences } from "../../../shared/wemail/businessPreferences.js";
import { BusinessPreferenceService } from "../settings/BusinessPreferenceService.js";
import { randomUUID } from "node:crypto";
import { deepStrictEqual } from "node:assert";
import { MailFolderSyncStateSchema, type MailFolderSyncState } from "../../../shared/wemail/mailSync.js";
import { materializeInvoiceSubjectCategory } from "./InvoiceSubjectCategory.js";
import type { MailCoreMutationResult } from "../../../shared/wemail/mailCoreProtocol.js";
import type {
  MailDatabaseChange,
  MailDatabaseConfigureAccountParams,
  MailDatabaseClaimedSend,
  MailDatabaseCompleteSendParams,
  MailDatabaseCompleteAiArtifactParams,
  MailDatabaseCompleteAiArtifactBatchParams,
  MailDatabaseCompleteRemoteMutationParams,
  MailDatabaseEnqueueSendParams,
  MailDatabaseEnqueueSendResult,
  MailDatabaseFailBodyParams,
  MailDatabaseClaimJobParams,
  MailDatabaseResetAiJobsResult,
  MailDatabaseEnqueueJobParams,
  MailDatabaseJob,
  MailDatabaseMutationParams,
  MailDatabaseMutationResult,
  MailDatabaseRequestIntelligenceParams,
  MailDatabasePersistBodyParams,
  MailDatabasePersistBodyResult,
  MailDatabasePersistMetadataParams,
  MailDatabaseSaveDraftParams,
  MailDatabaseSaveDraftResult,
  MailDatabaseSetSnoozeParams,
  MailDatabaseWriteResult,
} from "../../../shared/wemail/mailDatabaseProtocol.js";
import { MAIL_JOB_PRIORITY_MAX, MailDatabaseContentTopicTagsSchema, MailDatabasePersistTodoSuggestionsParamsSchema } from "../../../shared/wemail/mailDatabaseProtocol.js";
import type {
  MailDraftRecord,
  MailMessage,
  WemailAddress,
} from "../../../shared/wemail/mail.js";
import { isInlineImage, isMailBodyCached, normalizeContentId } from "../../../shared/wemail/mail.js";
import {
  SMART_CLASSIFICATION_IDS,
  smartClassificationSignal,
  type TagResult,
} from "../../../shared/wemail/intelligence.js";
import type { MailDatabase } from "./Database.js";
import { MailDatabaseQueryRepository } from "./MailDatabaseQueryRepository.js";
import {
  encodeFlagsBits,
  mapFolderRole,
  normalizeAddress,
  normalizeRfcMessageId,
  normalizeSubject,
  parseTimestampMs,
  sha256Text,
  stablePublicId,
} from "./CanonicalValues.js";
import { encodeTimeSortMessageId } from "./TimeSortMessageId.js";
import { CJK_SEARCH_INDEX_VERSION, cjkSearchTerms } from "./MailSearchCjk.js";
import { maxAttemptsForMailJob, shouldSkipPeriodicBodyRevive } from "../mail-core/MailJobRetryPolicy.js";
import { SmartTagBackfillRepository } from "../intelligence/SmartTagBackfillRepository.js";
import { TodoRepository } from "../todos/TodoRepository.js";
import { persistSuggestedTodos } from "../todos/persistSuggestedTodos.js";
import { ContentTopicService } from "../intelligence/ContentTopicService.js";
import { TopicCandidateRepository } from "../intelligence/TopicCandidateRepository.js";
import { evaluateSmartTagSuggestions } from "../intelligence/SmartTagSuggestionService.js";
import { UserTagRepository } from "../intelligence/UserTagRepository.js";
import { ApplicationMessageRepository } from "../applicationMessages/ApplicationMessageRepository.js";

/** Number of messages marked for the one-time initial AI coverage per account. */
const AI_INITIAL_COVERAGE_NEWEST = 2_000;

/**
 * Minimal HTML→text extraction for search indexing. Mail bodies that only
 * carry HTML land in html_sanitized with text_plain empty; without this the
 * FTS body_terms would never see their content.
 */
function stripHtmlText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
}

interface MessageRow {
  id: bigint;
  public_id: string;
  account_id: bigint;
  primary_folder_id: bigint | null;
  primary_instance_id: bigint | null;
  received_at_ms: bigint;
  has_attachments: bigint;
  is_seen: bigint;
  is_flagged: bigint;
  deleted_at_ms: bigint | null;
}

interface SearchIndexRow {
  subject: string;
  sender_preview: string;
  recipient_preview: string;
  content_version: bigint;
  text_plain: string | null;
  html_sanitized: string | null;
  attachment_names: string | null;
  summary_text: string | null;
  summary_version: bigint | null;
}

function smartTagBackfillRunIdFromPayload(json: string | undefined): string | undefined {
  if (!json) return undefined;
  try {
    const payload = JSON.parse(json) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const runId = (payload as Record<string, unknown>).smartTagBackfillRunId;
    return typeof runId === "string" && runId ? runId : undefined;
  } catch {
    return undefined;
  }
}

function aiPriorityFromBodyPayload(json: string | undefined): 0 | 1 | 2 | 4 | undefined {
  if (!json) return undefined;
  try {
    const payload = JSON.parse(json) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const priority = (payload as Record<string, unknown>).aiPriority;
    return priority === 0 || priority === 1 || priority === 2 || priority === 4
      ? priority
      : undefined;
  } catch {
    return undefined;
  }
}

function aiKindsFromBodyPayload(
  json: string | undefined,
): Array<"ai.summary" | "ai.tags" | "ai.reply-decision" | "ai.todo"> | undefined {
  if (!json) return undefined;
  try {
    const payload = JSON.parse(json) as { intelligenceKinds?: unknown };
    if (!Array.isArray(payload.intelligenceKinds)) return undefined;
    const jobKinds = {
      summary: "ai.summary",
      tags: "ai.tags",
      replyDecision: "ai.reply-decision",
      todo: "ai.todo",
    } as const;
    return payload.intelligenceKinds.flatMap((kind) =>
      typeof kind === "string" && kind in jobKinds
        ? [jobKinds[kind as keyof typeof jobKinds]]
        : [],
    );
  } catch {
    return undefined;
  }
}

function bodyReasonFromPayload(json: string | undefined): string | undefined {
  if (!json) return undefined;
  try {
    const payload = JSON.parse(json) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const reason = (payload as Record<string, unknown>).reason;
    return typeof reason === "string" ? reason : undefined;
  } catch {
    return undefined;
  }
}

interface FolderRow {
  id: bigint;
  public_id: string;
  remote_path: string;
}

interface CanonicalMessageRow extends MessageRow {
  thread_id: bigint | null;
  snippet: string | null;
  normalized_subject: string;
  sender_preview: string;
}

interface MetadataWriteResult {
  insertedCount: number;
  updatedCount: number;
  insertedIds: string[];
  updatedIds: string[];
}

interface InitialAiCoverageResult {
  markedCount: number;
  cancelledCount: number;
  enqueuedCount: number;
}

function sameJson(left: unknown, right: unknown): boolean {
  // Key-order-insensitive structural equality: a stringify comparison would
  // falsely report a checkpoint conflict whenever schema evolution or a
  // legacy row reorders keys.
  try {
    deepStrictEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

export class MailDatabaseWriter {
  private readonly queries: MailDatabaseQueryRepository;
  private readonly directory: DirectoryRepository;
  private readonly replyDecisionEnabled: boolean;
  private readonly contentTopics: ContentTopicService;

  constructor(
    private readonly db: MailDatabase,
    options: { replyDecisionEnabled?: boolean } = {},
  ) {
    // Same switch semantics as electron/main/app.ts: reply-decision is a
    // master flag (WEMAIL_REPLY_DECISION_ENABLED=1). The drain side
    // (CanonicalAiWorker) already skips ai.reply-decision claims when it is
    // off; keep the enqueue side consistent so a disabled capability produces
    // no new jobs (previously enqueued unconditionally, they piled up
    // pending forever because nothing claimed them).
    this.replyDecisionEnabled =
      options.replyDecisionEnabled ??
      process.env.WEMAIL_REPLY_DECISION_ENABLED === "1";
    this.queries = new MailDatabaseQueryRepository(db);
    this.directory = new DirectoryRepository(db);
    const topicCandidates = new TopicCandidateRepository(db);
    const suggestions = {
      topics: topicCandidates,
      userTags: new UserTagRepository(db),
      messages: new ApplicationMessageRepository(db),
    };
    this.contentTopics = new ContentTopicService(topicCandidates, (accountId, topicId) => {
      evaluateSmartTagSuggestions(suggestions, accountId, topicId);
    });
  }

  commitVersion(): number {
    return this.queries.commitVersion();
  }

  rebuildCjkSearchIndexBatch(limit = 50): { indexedCount: number; complete: boolean } {
    const version = this.db.prepare(
      "SELECT value FROM db_meta WHERE key = 'cjk_search_index_version'",
    ).get() as { value: string } | undefined;
    if (version?.value === String(CJK_SEARCH_INDEX_VERSION)) {
      return { indexedCount: 0, complete: true };
    }
    const batchSize = Math.min(500, Math.max(1, Math.floor(limit)));
    return this.db.transaction(() => {
      const cursorRow = this.db.prepare(
        "SELECT value FROM db_meta WHERE key = 'cjk_search_index_cursor'",
      ).get() as { value: string } | undefined;
      const cursor = BigInt(cursorRow?.value ?? "0");
      const rows = this.db.prepare(`
        SELECT messages.id, accounts.public_id AS account_public_id
        FROM mail_messages messages
        JOIN mail_accounts accounts ON accounts.id = messages.account_id
        WHERE messages.id > ?
        ORDER BY messages.id
        LIMIT ?
      `).all(cursor, batchSize) as Array<{
        id: bigint;
        account_public_id: string;
      }>;
      for (const row of rows) {
        this.updateCjkSearchIndex(row.id, row.account_public_id);
      }
      const last = rows.at(-1);
      if (last) {
        this.db.prepare(
          "INSERT INTO db_meta (key, value) VALUES ('cjk_search_index_cursor', ?) "
          + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(last.id.toString());
      }
      const complete = rows.length < batchSize;
      if (complete) {
        this.db.prepare(
          "INSERT INTO db_meta (key, value) VALUES ('cjk_search_index_version', ?) "
          + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(String(CJK_SEARCH_INDEX_VERSION));
        this.db.prepare(
          "DELETE FROM db_meta WHERE key = 'cjk_search_index_cursor'",
        ).run();
      }
      return { indexedCount: rows.length, complete };
    })();
  }

  enqueueJob(input: MailDatabaseEnqueueJobParams): MailDatabaseJob {
    const account = this.accountRow(input.accountId);
    const now = Date.now();
    const availableAt = input.availableAt ? Date.parse(input.availableAt) : now;
    const inputVersion = 1;
    const dedupeKey = input.idempotencyKey ?? randomUUID();
    const existing = this.db.prepare(`
      SELECT id, state, priority, max_attempts, available_at_ms
      FROM mail_jobs
      WHERE job_kind = ? AND dedupe_key = ? AND input_version = ?
    `).get(input.kind, dedupeKey, inputVersion) as {
      id: bigint;
      state: string;
      priority: bigint;
      max_attempts: bigint;
      available_at_ms: bigint;
    } | undefined;
    if (existing) {
      const terminal = existing.state === "succeeded" ||
        existing.state === "failed" ||
        existing.state === "terminal" ||
        existing.state === "cancelled";
      if (terminal && input.terminalPolicy === "revive") {
        this.db.prepare(`
          UPDATE mail_jobs
          SET account_id = ?, payload_json = ?, priority = ?, state = 'pending',
              attempt_count = 0, max_attempts = ?, available_at_ms = ?,
              lease_owner = NULL, lease_expires_at_ms = NULL,
              last_error_code = NULL, updated_at_ms = ?, row_version = row_version + 1
          WHERE id = ?
        `).run(
          account.id,
          JSON.stringify(input.payload ?? null),
          input.priority,
          input.maxAttempts ?? Number(existing.max_attempts),
          Number.isFinite(availableAt) ? availableAt : now,
          now,
          existing.id,
        );
      } else if (!terminal && existing.state !== "leased") {
        this.db.prepare(`
          UPDATE mail_jobs
          SET priority = MIN(priority, ?), max_attempts = MAX(max_attempts, ?),
              available_at_ms = MIN(available_at_ms, ?), updated_at_ms = ?,
              row_version = row_version + 1
          WHERE id = ?
        `).run(
          input.priority,
          input.maxAttempts ?? Number(existing.max_attempts),
          Number.isFinite(availableAt) ? availableAt : now,
          now,
          existing.id,
        );
      }
      return this.jobById(existing.id);
    }
    const subjectPublicId = typeof input.payload === "object" && input.payload &&
      "emailId" in input.payload && typeof input.payload.emailId === "string"
      ? input.payload.emailId
      : input.accountId;
    const result = this.db.prepare(`
      INSERT INTO mail_jobs (
        public_id, account_id, job_kind, subject_kind, subject_public_id,
        dedupe_key, payload_json, priority, state, attempt_count, max_attempts,
        available_at_ms, input_version, created_at_ms, updated_at_ms, row_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, 1)
    `).run(
      randomUUID(),
      account.id,
      input.kind,
      subjectPublicId === input.accountId ? "account" : "message",
      subjectPublicId,
      dedupeKey,
      JSON.stringify(input.payload ?? null),
      input.priority,
      input.maxAttempts ?? maxAttemptsForMailJob(input.kind),
      Number.isFinite(availableAt) ? availableAt : now,
      inputVersion,
      now,
      now,
    );
    return this.jobById(result.lastInsertRowid);
  }

  /**
   * Reconcile background body hydration for one account, in a single
   * transaction. Does three things, each bounded by `limit` so a tick is cheap
   * even with a large backlog:
   *
   *  1. Legacy reprioritize: pending `mail.body.ensure` jobs still at priority
   *     3/4 (the old fixed tiers) are rewritten to a time-weighted priority so
   *     the existing backlog hydrates newest-first too. (`enqueueJob` uses
   *     `MIN(priority)` on collision, so it cannot do this — needs a direct
   *     UPDATE.) Priority 0/1/2 and leased jobs are untouched.
   *  2. Enqueue missing bodies: messages whose content is missing/queued/failed
   *     with NO pending/leased body job, excluding permanent/credential
   *     failures, newest-first, get a fresh time-weighted body job.
   *  3. Revive non-permanent terminal: a terminal body job whose body is still
   *     missing and whose last error is not permanent/credential is revived to
   *     pending (attempts reset) at a time-weighted priority.
   *
   * Formula MUST match `bodyHydrationPriority` in MailCoreAccountRuntime:
   * `BASE + floor(max(0, now - received_at_ms) / MINUTE_MS)`, capped.
   */
  reconcileBodyHydration(
    accountId: string,
    options: {
      limit?: number;
      nowMs?: number;
      base?: number;
      minuteMs?: number;
      maxPriority?: number;
    } = {},
  ): {
    reprioritized: number;
    enqueued: number;
    revived: number;
    skippedPermanent: number;
  } {
    const limit = Math.min(500, Math.max(1, options.limit ?? 200));
    const base = options.base ?? 10;
    const minuteMs = options.minuteMs ?? 60_000;
    const maxPriority = options.maxPriority ?? MAIL_JOB_PRIORITY_MAX;
    const now = options.nowMs ?? Date.now();
    const priorityFor = (receivedAtMs: number): number => {
      const ageMs = receivedAtMs > 0 ? Math.max(0, now - receivedAtMs) : Number.MAX_SAFE_INTEGER;
      return Math.min(maxPriority, base + Math.floor(ageMs / minuteMs));
    };

    return this.db.transaction(() => {
      // Op 1: legacy reprioritize (newest `limit` pending priority-3/4 body jobs).
      const legacy = this.db.prepare(`
        SELECT jobs.id AS job_id, messages.received_at_ms
        FROM mail_jobs jobs
        JOIN mail_accounts accounts ON accounts.id = jobs.account_id
        JOIN mail_messages messages ON messages.public_id = jobs.subject_public_id
        WHERE accounts.public_id = ?
          AND jobs.job_kind = 'mail.body.ensure'
          AND jobs.state = 'pending'
          AND jobs.priority IN (3, 4)
        ORDER BY messages.received_at_ms DESC
        LIMIT ?
      `).all(accountId, limit) as Array<{ job_id: number; received_at_ms: number }>;
      const updateLegacy = this.db.prepare(`
        UPDATE mail_jobs SET priority = ?, updated_at_ms = ?, row_version = row_version + 1
        WHERE id = ?
      `);
      for (const row of legacy) {
        // The writer connection runs with safeIntegers: true, so integer columns
        // (jobs.id, messages.received_at_ms) come back as BigInt. Number() them
        // before use: priorityFor does `now - receivedAtMs`, and `Number - BigInt`
        // throws "Cannot mix BigInt and other types" (crashing the whole reconcile).
        updateLegacy.run(priorityFor(Number(row.received_at_ms)), now, Number(row.job_id));
      }

      // Op 2 + 3: candidates needing hydration with no pending/leased body job.
      const candidates = this.db.prepare(`
        SELECT messages.public_id,
               messages.received_at_ms,
               (SELECT j.last_error_code FROM mail_jobs j
                  WHERE j.subject_public_id = messages.public_id
                    AND j.job_kind = 'mail.body.ensure'
                  ORDER BY j.id DESC LIMIT 1) AS last_error_code,
               (SELECT j.id FROM mail_jobs j
                  WHERE j.subject_public_id = messages.public_id
                    AND j.job_kind = 'mail.body.ensure'
                    AND j.state = 'terminal'
                  ORDER BY j.id DESC LIMIT 1) AS terminal_job_id
        FROM mail_messages messages
        JOIN mail_accounts accounts ON accounts.id = messages.account_id
        JOIN mail_message_content content ON content.message_id = messages.id
        WHERE accounts.public_id = ?
          AND messages.deleted_at_ms IS NULL
          AND content.state IN ('missing', 'queued', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM mail_jobs j
            WHERE j.subject_public_id = messages.public_id
              AND j.job_kind = 'mail.body.ensure'
              AND j.state IN ('pending', 'leased')
          )
        ORDER BY messages.received_at_ms DESC
        LIMIT ?
      `).all(accountId, limit) as Array<{
        public_id: string;
        received_at_ms: number;
        last_error_code: string | null;
        terminal_job_id: number | null;
      }>;

      const reviveStmt = this.db.prepare(`
        UPDATE mail_jobs
        SET state = 'pending', attempt_count = 0, priority = ?,
            available_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
            last_error_code = NULL, updated_at_ms = ?, row_version = row_version + 1
        WHERE id = ?
      `);
      let enqueued = 0;
      let revived = 0;
      let skippedPermanent = 0;
      for (const candidate of candidates) {
        if (shouldSkipPeriodicBodyRevive(candidate.last_error_code)) {
          skippedPermanent += 1;
          continue;
        }
        const priority = priorityFor(Number(candidate.received_at_ms));
        if (candidate.terminal_job_id != null) {
          reviveStmt.run(priority, now, now, Number(candidate.terminal_job_id));
          revived += 1;
        } else {
          this.enqueueJob({
            kind: "mail.body.ensure",
            accountId,
            payload: { emailId: candidate.public_id, reason: "reconcile-body-hydration" },
            priority,
            maxAttempts: maxAttemptsForMailJob("mail.body.ensure"),
            idempotencyKey: `body.ensure:${accountId}:${candidate.public_id}`,
            terminalPolicy: "revive",
          });
          enqueued += 1;
        }
      }
      return {
        reprioritized: legacy.length,
        enqueued,
        revived,
        skippedPermanent,
      };
    }).immediate();
  }

  reconcileAiJobs(limit = 100): number {
    const boundedLimit = Math.min(500, Math.max(1, limit));
    const now = Date.now();
    this.db.prepare(`
      UPDATE mail_jobs
      SET priority = 0, updated_at_ms = ?, row_version = row_version + 1
      WHERE state = 'pending' AND priority = 2
        AND job_kind IN ('ai.summary','ai.tags','ai.reply-decision','ai.todo')
    `).run(now);
    const emptyBodies = this.db.prepare(`
      SELECT messages.id, messages.public_id,
             accounts.public_id AS account_public_id
      FROM mail_messages messages
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      JOIN mail_message_content content ON content.message_id = messages.id
      WHERE messages.deleted_at_ms IS NULL AND content.state = 'ready'
        AND COALESCE(content.byte_size, 0) = 0
        AND LENGTH(TRIM(messages.snippet)) > 0
      ORDER BY messages.received_at_ms DESC, messages.id DESC
      LIMIT ?
    `).all(boundedLimit) as Array<{
      id: bigint;
      public_id: string;
      account_public_id: string;
    }>;
    this.db.transaction(() => {
      for (const row of emptyBodies) {
        this.db.prepare(`
          UPDATE mail_message_content
          SET state = 'missing', retry_at_ms = NULL, retry_count = 0,
              retryable = 1, error_code = NULL, row_version = row_version + 1
          WHERE message_id = ? AND state = 'ready' AND COALESCE(byte_size, 0) = 0
        `).run(row.id);
        this.enqueueJob({
          kind: "mail.body.ensure",
          accountId: row.account_public_id,
          payload: { emailId: row.public_id, reason: "ready-empty-recovery" },
          priority: 2,
          maxAttempts: 5,
          idempotencyKey: `body.ensure:${row.account_public_id}:${row.public_id}`,
          terminalPolicy: "revive",
        });
      }
    }).immediate();
    // Reconcile only the messages marked during the one-time initial sync.
    // New/incremental and foreground demand are created by their normal body
    // or explicit-request paths; this maintenance pass must never rediscover a
    // moving Top-N window or walk older historical mail.
    const AI_INITIAL_BACKFILL_KINDS: ReadonlyArray<
      "ai.summary" | "ai.tags" | "ai.reply-decision" | "ai.todo"
    > = ["ai.tags", "ai.reply-decision", "ai.summary", "ai.todo"];
    let enqueued = 0;
    this.db.transaction(() => {
      for (const kind of AI_INITIAL_BACKFILL_KINDS) {
        const rows = this.db.prepare(`
          SELECT messages.id, messages.public_id,
                 accounts.id AS account_id, accounts.public_id AS account_public_id
          FROM mail_messages messages
          JOIN mail_accounts accounts ON accounts.id = messages.account_id
          JOIN mail_message_content content ON content.message_id = messages.id
          WHERE messages.deleted_at_ms IS NULL AND content.state = 'ready'
            AND content.content_sha256 IS NOT NULL
            AND messages.ai_initial_summary_scope = 1
            AND NOT EXISTS (
              SELECT 1 FROM mail_jobs jobs
              WHERE jobs.subject_kind = 'message'
                AND jobs.subject_public_id = messages.public_id
                AND jobs.job_kind = ?
                AND jobs.input_version = content.content_version
            )
          ORDER BY messages.received_at_ms DESC, messages.id DESC
          LIMIT ?
        `).all(kind, boundedLimit) as Array<{
          id: bigint;
          public_id: string;
          account_id: bigint;
          account_public_id: string;
        }>;
        for (const row of rows) {
          this.enqueueIntelligenceJobsForReadyContent({
            accountId: row.account_id,
            accountPublicId: row.account_public_id,
            messageId: row.id,
            messagePublicId: row.public_id,
            priority: 4,
            kinds: [kind],
          });
          enqueued += 1;
        }
      }
    }).immediate();
    return enqueued;
  }

  /**
   * Finalize the one-time initial AI window for an account. This is called by
   * the final historical metadata batch, inside that metadata transaction, so
   * the body pipeline can remain full-scope while only the marked messages
   * create automatic historical AI work. The insert guard makes repeated
   * historical sync completions a no-op.
   */
  private finalizeInitialAiCoverage(
    accountId: bigint,
    accountPublicId: string,
    changes: MailDatabaseChange[],
    now: number,
  ): InitialAiCoverageResult | null {
    const inserted = this.db.prepare(`
      INSERT INTO mail_ai_initial_coverage (account_id, finalized_at_ms, row_version)
      VALUES (?, ?, 1)
      ON CONFLICT(account_id) DO NOTHING
    `).run(accountId, now);
    if (inserted.changes !== 1) return null;

    // Mark the existing mailbox as historical-outside-scope first, then mark
    // exactly the newest 2000 by receive time (id is the deterministic
    // tie-breaker). Future messages keep the default 0 and use the incremental
    // priority path instead of changing this initial set.
    this.db.prepare(`
      UPDATE mail_messages
      SET ai_initial_summary_scope = 2, row_version = row_version + 1
      WHERE account_id = ? AND ai_initial_summary_scope IN (0, 1)
    `).run(accountId);
    const marked = this.db.prepare(`
      UPDATE mail_messages
      SET ai_initial_summary_scope = 1, row_version = row_version + 1
      WHERE id IN (
        SELECT id FROM mail_messages
        WHERE account_id = ? AND deleted_at_ms IS NULL
        ORDER BY received_at_ms DESC, id DESC
        LIMIT ?
      )
    `).run(accountId, AI_INITIAL_COVERAGE_NEWEST).changes;

    // Priority 1 is foreground/explicit demand and priority 2 is incremental
    // mail. Priority 3+ is reserved for historical/backfill work, so this
    // one-time cancellation cannot remove a new-mail summary.
    const cancelled = this.db.prepare(`
      UPDATE mail_jobs
      SET state = 'cancelled', lease_owner = NULL, lease_expires_at_ms = NULL,
          updated_at_ms = ?, row_version = row_version + 1
      WHERE state IN ('pending', 'leased', 'failed', 'terminal')
        AND account_id = ?
        AND job_kind IN ('ai.summary','ai.tags','ai.reply-decision','ai.todo')
        AND priority >= 3
        AND json_extract(payload_json, '$.smartTagBackfillRunId') IS NULL
        AND EXISTS (
          SELECT 1 FROM mail_messages messages
          WHERE messages.account_id = mail_jobs.account_id
            AND messages.public_id = mail_jobs.subject_public_id
            AND messages.ai_initial_summary_scope = 2
        )
    `).run(now, accountId).changes;

    const readyRows = this.db.prepare(`
      SELECT messages.id, messages.public_id,
             accounts.id AS account_id, accounts.public_id AS account_public_id
      FROM mail_messages messages
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      JOIN mail_message_content content ON content.message_id = messages.id
      WHERE messages.account_id = ?
        AND messages.deleted_at_ms IS NULL
        AND messages.ai_initial_summary_scope = 1
        AND content.state = 'ready'
        AND content.content_sha256 IS NOT NULL
      ORDER BY messages.received_at_ms DESC, messages.id DESC
    `).all(accountId) as Array<{
      id: bigint;
      public_id: string;
      account_id: bigint;
      account_public_id: string;
    }>;
    let enqueuedCount = 0;
    for (const row of readyRows) {
      enqueuedCount += this.enqueueIntelligenceJobsForReadyContent({
        accountId: row.account_id,
        accountPublicId: row.account_public_id,
        messageId: row.id,
        messagePublicId: row.public_id,
        priority: 4,
        reviveTerminal: true,
      });
    }

    changes.push({
      entityType: "account",
      entityPublicId: accountPublicId,
      operation: "update",
      scopeHint: `account:${accountPublicId}`,
    });
    if (cancelled > 0 || enqueuedCount > 0) {
      changes.push({
        entityType: "ai_job",
        entityPublicId: accountPublicId,
        operation: "update",
        scopeHint: `account:${accountPublicId}`,
      });
    }
    return { markedCount: marked, cancelledCount: cancelled, enqueuedCount };
  }

  /**
   * Cancel pending jobs of legacy Layer-A kinds (summary/tags/replyDecision/
   * replyDraft/…) that have no canonical consumer — CanonicalAiWorker claims
   * only ai.* and MailCore claims only mail.*. These rows otherwise sit
   * pending forever (the 13k `tags` backlog), inflating claim scans/counts.
   * Auditable: rows move to 'cancelled' (not deleted). Idempotent. Canonical
   * reconcile re-enqueues any still-wanted initially marked work as ai.*.
   */
  cancelOrphanedLegacyJobs(): number {
    return this.db
      .prepare(
        `UPDATE mail_jobs
         SET state = 'cancelled', lease_owner = NULL, lease_expires_at_ms = NULL,
             updated_at_ms = ?, row_version = row_version + 1
         WHERE state = 'pending'
           AND job_kind IN ('summary','tags','replyDecision','replyDraft',
                            'todoExtraction','linkExtraction','translation','composeMail')`,
      )
      .run(Date.now()).changes;
  }

  /**
   * Reset terminal `ai.*` jobs back to pending so they are reprocessed —
   * called after an LLM model/auth change, when earlier failures
   * (`auth_unavailable`, `request timed out`, malformed LLM output,
   * network/HTTP errors, `lease-expired`, …) are no longer assumed permanent.
   * Excludes only errors unrelated to the model: a genuinely empty body
   * (`mail-body-not-available`), a missing message (`mail-missing`), or a
   * structurally invalid payload (`invalid-ai-job-payload`). Idempotent and
   * safe to repeat: in-place UPDATE that does not touch the
   * `(job_kind, dedupe_key, input_version)` unique key, so revived rows are
   * claimed like any fresh pending job.
   */
  resetTerminalAiJobsForRetry(input: { afterId: number; throughId?: number } = { afterId: 0 }): MailDatabaseResetAiJobsResult {
    const now = Date.now();
    const throughId = input.throughId ?? Number(this.db.prepare("SELECT COALESCE(MAX(id), 0) FROM mail_jobs").pluck().get());
    const retryable = `state = 'terminal'
      AND job_kind IN ('ai.summary','ai.tags','ai.reply-decision','ai.todo')
      AND (last_error_code IS NULL OR last_error_code NOT IN (
        'mail-body-not-available', 'mail-missing', 'invalid-ai-job-payload'))`;
    // Page by primary key, including ineligible rows, so sparse terminal jobs cannot cause an unbounded scan.
    const rows = this.db.prepare(`SELECT id, (${retryable}) AS retryable FROM mail_jobs
      WHERE id > ? AND id <= ? ORDER BY id LIMIT 100`)
      .all(input.afterId, throughId) as Array<{ id: bigint; retryable: bigint }>;
    const afterId = rows.length === 100 ? Number(rows[rows.length - 1].id) : throughId;
    if (!rows.some((row) => Number(row.retryable) === 1)) return { count: 0, afterId, throughId };
    const result = this.db
      .prepare(
        `UPDATE mail_jobs
         SET state = 'pending', attempt_count = 0,
             available_at_ms = ?,
             lease_owner = NULL, lease_expires_at_ms = NULL,
             last_error_code = NULL, updated_at_ms = ?, row_version = row_version + 1
         WHERE id > ? AND id <= ? AND (${retryable})`,
      )
      .run(now, now, input.afterId, afterId);
    return { count: result.changes, afterId, throughId };
  }

  requestIntelligence(
    input: MailDatabaseRequestIntelligenceParams,
  ): MailDatabaseWriteResult<{ jobIds: number[] }> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT messages.id, messages.public_id,
               accounts.public_id AS account_public_id,
               content.state AS content_state,
               content.content_sha256, content.content_version
        FROM mail_messages messages
        JOIN mail_accounts accounts ON accounts.id = messages.account_id
        LEFT JOIN mail_message_content content ON content.message_id = messages.id
        WHERE messages.public_id = ? AND messages.deleted_at_ms IS NULL
      `).get(input.emailId) as {
        id: bigint;
        public_id: string;
        account_public_id: string;
        content_state: string | null;
        content_sha256: string | null;
        content_version: bigint | null;
      } | undefined;
      if (!row) throw new Error(`message-not-found:${input.emailId}`);
      const jobKinds = {
        summary: "ai.summary",
        tags: "ai.tags",
        replyDecision: "ai.reply-decision",
        todo: "ai.todo",
      } as const;
      const jobIds = row.content_state === "ready" && row.content_sha256 && row.content_version !== null
        ? input.kinds.map((kind) => {
        const jobKind = jobKinds[kind];
        return this.enqueueJob({
          kind: jobKind,
          accountId: row.account_public_id,
          payload: {
            accountId: row.account_public_id,
            emailId: row.public_id,
            contentSha256: row.content_sha256!,
            contentVersion: Number(row.content_version),
            ...(input.context?.smartTagBackfillRunId
              ? { smartTagBackfillRunId: input.context.smartTagBackfillRunId }
              : {}),
          },
          priority: 1,
          idempotencyKey: `${jobKind}:${row.public_id}:${row.content_sha256}`,
          terminalPolicy: input.revive ? "revive" : "reuse",
        }).id;
      })
        : [this.enqueueJob({
            kind: "mail.body.ensure",
            accountId: row.account_public_id,
            payload: {
              emailId: row.public_id,
              reason: "intelligence-request",
              aiPriority: 1,
              intelligenceKinds: input.kinds,
              ...(input.context?.smartTagBackfillRunId
                ? { smartTagBackfillRunId: input.context.smartTagBackfillRunId }
                : {}),
            },
            priority: 1,
            maxAttempts: 5,
            idempotencyKey: `body.ensure:${row.account_public_id}:${row.public_id}`,
            terminalPolicy: input.revive ? "revive" : "reuse",
          }).id];
      const changes: MailDatabaseChange[] = [{
        entityType: "ai_job",
        entityPublicId: row.public_id,
        operation: "update",
        scopeHint: `account:${row.account_public_id}`,
      }];
      const commitVersion = this.recordCommit("intelligence-request", changes, Date.now());
      return { jobIds, changes, commitVersion };
    });
    const result = transaction.immediate();
    return {
      value: { jobIds: result.jobIds },
      changes: result.changes,
      commitVersion: result.commitVersion,
    };
  }

  claimJob(input: MailDatabaseClaimJobParams): MailDatabaseJob | null {
    if (!input.owner) throw new Error("queue-owner-required");
    const now = Date.now();
    const clauses = ["jobs.state = 'pending'", "jobs.available_at_ms <= @now"];
    const params: Record<string, unknown> = { now };
    if (input.filter?.accountId) {
      clauses.push("jobs.account_id = (SELECT id FROM mail_accounts WHERE public_id = @accountId)");
      params.accountId = input.filter.accountId;
    }
    if (input.filter?.priorities?.length) {
      const names = input.filter.priorities.map((priority, index) => {
        params[`priority${index}`] = priority;
        return `@priority${index}`;
      });
      clauses.push(`jobs.priority IN (${names.join(", ")})`);
    }
    if (input.filter?.minPriority != null && Number.isFinite(input.filter.minPriority)) {
      params.minPriority = input.filter.minPriority;
      clauses.push("jobs.priority >= @minPriority");
    }
    if (input.filter?.subjectPublicId) {
      clauses.push("jobs.subject_public_id = @subjectPublicId");
      params.subjectPublicId = input.filter.subjectPublicId;
    }
    const order = input.filter?.order === "lifo"
      ? "priority ASC, sort_received_at_ms DESC, sort_message_id DESC, id DESC"
      : "priority ASC, available_at_ms ASC, id ASC";
    const columns = "id, priority, available_at_ms, sort_received_at_ms, sort_message_id";
    // Each kind contributes one ordered candidate; only those heads are merged.
    const kinds = [...new Set(input.filter?.kinds ?? [])];
    const indexHint = input.filter?.subjectPublicId ? ""
      : input.filter?.order === "lifo"
        ? " INDEXED BY idx_mail_jobs_dispatch_recency"
        : " INDEXED BY idx_mail_jobs_claim_kind";
    const candidates = kinds.length > 0
      ? kinds.map((kind, index) => {
        params[`dispatchKind${index}`] = kind;
        return `SELECT * FROM (SELECT ${columns} FROM mail_jobs jobs${indexHint}
          WHERE ${clauses.join(" AND ")} AND jobs.job_kind = @dispatchKind${index}
          ORDER BY ${order} LIMIT 1)`;
      }).join(" UNION ALL ")
      : `SELECT ${columns} FROM mail_jobs jobs WHERE ${clauses.join(" AND ")}`;
    const row = this.db.prepare(`
      SELECT id FROM (${candidates}) ORDER BY ${order} LIMIT 1
    `).get(params) as { id: bigint } | undefined;
    if (!row) return null;
    return this.db.transaction(() => {
      const updated = this.db.prepare(`
        UPDATE mail_jobs
        SET state = 'leased', attempt_count = attempt_count + 1,
            lease_owner = ?, lease_expires_at_ms = ?, updated_at_ms = ?,
            row_version = row_version + 1
        WHERE id = ? AND state = 'pending' AND available_at_ms <= ?
      `).run(input.owner, now + (input.leaseMs ?? 30_000), now, row.id, now);
      return updated.changes === 1 ? this.jobById(row.id) : null;
    }).immediate();
  }

  recoverExpiredJobLeases(now = Date.now()): number {
    const expired = this.db.prepare(`
      SELECT 1 FROM mail_jobs WHERE state = 'leased' AND lease_expires_at_ms <= ? LIMIT 1
    `).get(now);
    if (!expired) return 0;
    return this.db.transaction(() => {
      const recovered = this.db.prepare(`
      UPDATE mail_jobs
      SET state = CASE WHEN attempt_count >= max_attempts THEN 'terminal' ELSE 'pending' END,
          lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?,
          last_error_code = CASE WHEN attempt_count >= max_attempts
            THEN COALESCE(last_error_code, 'lease-expired') ELSE last_error_code END,
          row_version = row_version + 1
      WHERE id IN (
        SELECT id FROM mail_jobs
        WHERE state = 'leased' AND lease_expires_at_ms <= ?
        ORDER BY lease_expires_at_ms, id LIMIT 50
      )
      RETURNING id, state
    `).all(now, now) as Array<{ id: bigint; state: string }>;
      for (const job of recovered) {
        if (job.state === "terminal") this.recordBackfillTerminal(job.id);
      }
      return recovered.length;
    }).immediate();
  }

  completeJob(id: number, owner: string): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`
      UPDATE mail_jobs
      SET state = 'succeeded', lease_owner = NULL, lease_expires_at_ms = NULL,
          updated_at_ms = ?, row_version = row_version + 1
      WHERE id = ? AND state = 'leased' AND lease_owner = ?
      `).run(Date.now(), id, owner).changes === 1;
      if (changed) this.recordBackfillTerminal(id);
      return changed;
    }).immediate();
  }

  failJob(id: number, owner: string, error: string, retryDelayMs = 0): boolean {
    const now = Date.now();
    return this.db.transaction(() => {
      const changed = this.db.prepare(`
      UPDATE mail_jobs
      SET state = CASE WHEN attempt_count >= max_attempts THEN 'terminal' ELSE 'pending' END,
          available_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
          last_error_code = ?, updated_at_ms = ?, row_version = row_version + 1
      WHERE id = ? AND state = 'leased' AND lease_owner = ?
      `).run(now + Math.max(0, retryDelayMs), error, now, id, owner).changes === 1;
      if (changed) this.recordBackfillTerminal(id);
      return changed;
    }).immediate();
  }

  deferJob(id: number, owner: string, reason: string, delayMs: number): boolean {
    const now = Date.now();
    return this.db.prepare(`
      UPDATE mail_jobs
      SET state = 'pending',
          attempt_count = MAX(0, attempt_count - 1),
          available_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
          last_error_code = ?, updated_at_ms = ?, row_version = row_version + 1
      WHERE id = ? AND state = 'leased' AND lease_owner = ?
    `).run(now + Math.max(0, delayMs), reason, now, id, owner).changes === 1;
  }

  terminalJob(id: number, owner: string, error: string): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`
      UPDATE mail_jobs
      SET state = 'terminal', lease_owner = NULL, lease_expires_at_ms = NULL,
          last_error_code = ?, updated_at_ms = ?, row_version = row_version + 1
      WHERE id = ? AND state = 'leased' AND lease_owner = ?
      `).run(error, Date.now(), id, owner).changes === 1;
      if (changed) this.recordBackfillTerminal(id);
      return changed;
    }).immediate();
  }

  private recordBackfillTerminal(id: number | bigint): void {
    const job = this.db.prepare(`SELECT account_id, payload_json, state, last_error_code
      FROM mail_jobs WHERE id = ? AND job_kind = 'ai.tags'
        AND state IN ('succeeded', 'terminal')`).get(id) as {
      account_id: bigint; payload_json: string; state: string; last_error_code: string | null;
    } | undefined;
    if (!job) return;
    let payload: { smartTagBackfillRunId?: unknown } | null;
    try { payload = JSON.parse(job.payload_json); } catch { return; }
    const runId = payload?.smartTagBackfillRunId;
    if (typeof runId !== "string" || !runId) return;
    const run = this.db.prepare(`SELECT id FROM mail_smart_tag_backfill_runs
      WHERE public_id = ? AND account_id = ?`).get(runId, job.account_id) as { id: bigint } | undefined;
    if (!run) return;
    const recorded = this.db.prepare(`INSERT OR IGNORE INTO mail_smart_tag_backfill_job_results
      (job_id, run_id, outcome, recorded_at_ms) VALUES (?, ?, ?, ?)`)
      .run(id, run.id, job.state, Date.now());
    if (recorded.changes !== 1) return;
    new SmartTagBackfillRepository(this.db).recordJobTerminal({
      id: runId, failed: job.state === "terminal", error: job.last_error_code ?? undefined,
    });
  }

  completeAiArtifact(
    input: MailDatabaseCompleteAiArtifactParams,
  ): MailDatabaseWriteResult<{ artifactId: string; current: boolean }> {
    return this.db.transaction(() => {
      const now = parseTimestampMs(input.completedAt, Date.now());
      const outcome = this.applyAiArtifactCompletion(input, now);
      if (!outcome.applied) {
        throw new Error("ai-job-lease-not-owned");
      }
      const commitVersion = outcome.changes.length > 0
        ? this.recordCommit("ai-artifact", outcome.changes, now)
        : this.commitVersion();
      return {
        value: { artifactId: outcome.artifactId, current: outcome.current },
        commitVersion,
        changes: outcome.changes,
      };
    }).immediate();
  }

  /**
   * Phase B write-coalescing: apply N artifact completions in ONE transaction
   * with a single commit. Each item is lease-guarded individually via
   * {@link applyAiArtifactCompletion}; a stale-lease item (lease expired or
   * reclaimed before flush) is SKIPPED rather than aborting the batch — its job
   * stays leased and is reclaimed/reprocessed by lease expiry, and the
   * lease-guarded write makes any replay idempotent. Returns one commit version
   * for the whole batch (or the current version if nothing applied).
   */
  completeAiArtifactBatch(
    input: MailDatabaseCompleteAiArtifactBatchParams,
  ): MailDatabaseWriteResult<{
    results: Array<{
      jobId: number;
      artifactId?: string;
      current?: boolean;
      skipped?: boolean;
    }>;
  }> {
    return this.db.transaction(() => {
      const batchNow = Date.now();
      const changes: MailDatabaseChange[] = [];
      const results: Array<{
        jobId: number;
        artifactId?: string;
        current?: boolean;
        skipped?: boolean;
      }> = [];
      for (const item of input.items) {
        const now = parseTimestampMs(item.completedAt, batchNow);
        const outcome = this.applyAiArtifactCompletion(item, now);
        if (outcome.applied) {
          results.push({
            jobId: item.jobId,
            artifactId: outcome.artifactId,
            current: outcome.current,
          });
          changes.push(...outcome.changes);
        } else {
          results.push({ jobId: item.jobId, skipped: true });
        }
      }
      const commitVersion = changes.length > 0
        ? this.recordCommit("ai-artifact-batch", changes, batchNow)
        : this.commitVersion();
      return { value: { results }, changes, commitVersion };
    }).immediate();
  }

  /**
   * Apply ONE artifact completion INSIDE the caller's transaction. Guard-first:
   * the lease UPDATE runs before any artifact write, so a stale-lease item
   * leaves zero residue and the batch caller can skip it cleanly. Never throws
   * on a lost lease — returns `applied: false`. (A genuinely missing account is
   * still a thrown corruption error; a missing message mid-flight is treated as
   * a successful-but-empty completion since the job's lease is legitimately
   * ours and there is no artifact to persist.)
   */
  private applyAiArtifactCompletion(
    input: MailDatabaseCompleteAiArtifactParams,
    now: number,
  ):
    | { applied: true; artifactId: string; current: boolean; changes: MailDatabaseChange[] }
    | { applied: false; reason: "lease" } {
    const completed = this.db.prepare(`
      UPDATE mail_jobs SET state = 'succeeded', lease_owner = NULL,
        lease_expires_at_ms = NULL, updated_at_ms = ?, row_version = row_version + 1
      WHERE id = ? AND state = 'leased' AND lease_owner = ?
    `).run(now, input.jobId, input.owner);
    if (completed.changes !== 1) return { applied: false, reason: "lease" };
    this.recordBackfillTerminal(input.jobId);

    const account = this.accountRow(input.accountId);
    const message = this.db.prepare(`
      SELECT id FROM mail_messages
      WHERE public_id = ? AND account_id = ? AND deleted_at_ms IS NULL
    `).get(input.emailId, account.id) as { id: bigint } | undefined;
    if (!message) {
      // Job lease was ours and is now 'succeeded', but the message is gone
      // (deleted mid-flight): nothing to persist. Not an error — retrying would
      // not resurrect the message.
      return { applied: true, artifactId: "", current: false, changes: [] };
    }
    const content = this.db.prepare(`
      SELECT content_sha256, content_version
      FROM mail_message_content WHERE message_id = ? AND state = 'ready'
    `).get(message.id) as {
      content_sha256: string | null;
      content_version: bigint;
    } | undefined;
    const current = content?.content_sha256 === input.sourceContentSha256 &&
      Number(content.content_version) === input.sourceVersion;
    let artifactResult = input.result;
    if (current && input.artifactKind === "tags") {
      const tagsResult = input.result as Partial<TagResult> | null;
      const contentTags = MailDatabaseContentTopicTagsSchema.parse(tagsResult?.contentTags ?? []);
      if (contentTags.length > 0) {
        const metadata = this.db.prepare(`SELECT messages.sender_preview, threads.public_id AS thread_id
          FROM mail_messages messages LEFT JOIN mail_threads threads ON threads.id = messages.thread_id
          WHERE messages.id = ?`).get(message.id) as { sender_preview: string; thread_id: string | null };
        artifactResult = { ...tagsResult, contentTags: this.contentTopics.recordForMessage({
          id: input.emailId, accountId: input.accountId, threadId: metadata.thread_id ?? undefined,
          from: { email: metadata.sender_preview },
        }, contentTags) };
      }
    }
    if (current && input.artifactKind === "todoExtraction") {
      const inputResult = input.result as { todos?: unknown };
      const suggestions = MailDatabasePersistTodoSuggestionsParamsSchema.parse({
        accountId: input.accountId, emailId: input.emailId, todos: inputResult?.todos,
      });
      artifactResult = { ...inputResult, todos: persistSuggestedTodos(
        new TodoRepository(this.db), input.accountId, input.emailId, suggestions.todos,
      ) };
    }
    const publicId = randomUUID();
    const inserted = this.db.prepare(`
      INSERT INTO mail_ai_artifacts (
        public_id, account_id, scope_kind, message_id, artifact_kind,
        source_content_sha256, source_version, processor_version,
        prompt_version, model_id, state, text_value, json_value,
        created_at_ms, completed_at_ms, row_version
      ) VALUES (?, ?, 'message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      publicId,
      account.id,
      message.id,
      input.artifactKind,
      input.sourceContentSha256,
      input.sourceVersion,
      input.processorVersion,
      input.promptVersion ?? null,
      input.modelId ?? null,
      current ? "ready" : "stale",
      input.textValue ?? null,
      JSON.stringify(artifactResult),
      now,
      now,
    );
    if (current) {
      this.db.prepare(`
        INSERT INTO mail_message_ai_current (
          message_id, artifact_kind, artifact_id, row_version
        ) VALUES (?, ?, ?, 1)
        ON CONFLICT(message_id, artifact_kind) DO UPDATE SET
          artifact_id = excluded.artifact_id,
          row_version = mail_message_ai_current.row_version + 1
      `).run(message.id, input.artifactKind, inserted.lastInsertRowid);
      if (input.artifactKind === "tags") {
        this.materializeTagsArtifact({
          accountId: account.id,
          messageId: message.id,
          artifactId: inserted.lastInsertRowid,
          result: input.result,
        });
      }
      this.updateSearchIndex(message.id, input.accountId);
    }
    const changes: MailDatabaseChange[] = [{
      entityType: "ai_artifact",
      entityPublicId: input.emailId,
      operation: "update",
      scopeHint: `account:${input.accountId}`,
    }];
    return { applied: true, artifactId: publicId, current, changes };
  }

  nextMailDue(accountId: string): number | null {
    return this.nextQueueDue(["mail.body.ensure", "mail.metadata.sync"], accountId);
  }

  nextJobDue(kinds: readonly string[]): number | null {
    return this.nextQueueDue(kinds);
  }

  private nextQueueDue(kinds: readonly string[], accountId?: string): number | null {
    if (kinds.length === 0) return null;
    const params: Record<string, unknown> = {};
    const accountClause = accountId
      ? "AND account_id = (SELECT id FROM mail_accounts WHERE public_id = @accountId)"
      : "";
    if (accountId) params.accountId = accountId;
    const candidates = [...new Set(kinds)].flatMap((kind, index) => {
      params[`kind${index}`] = kind;
      return [
        `SELECT MIN(available_at_ms) AS due_at_ms FROM mail_jobs INDEXED BY ${accountId ? "idx_mail_jobs_account_pending_due" : "idx_mail_jobs_due"}
          WHERE state = 'pending' AND job_kind = @kind${index} ${accountClause}`,
        `SELECT MIN(lease_expires_at_ms) AS due_at_ms FROM mail_jobs INDEXED BY ${accountId ? "idx_mail_jobs_account_leased_due" : "idx_mail_jobs_leased_due"}
          WHERE state = 'leased' AND job_kind = @kind${index} ${accountClause}`,
      ];
    });
    const row = this.db.prepare(`
      SELECT MIN(due_at_ms) AS due_at_ms FROM (${candidates.join(" UNION ALL ")})
    `).get(params) as { due_at_ms: bigint | null };
    return row.due_at_ms === null ? null : Number(row.due_at_ms);
  }

  claimRemoteMutation(
    accountPublicId: string,
    owner: string,
    leaseMs = 30_000,
  ): MailDatabaseJob | null {
    if (!owner) throw new Error("queue-owner-required");
    return this.db.transaction(() => {
      const now = Date.now();
      this.db.prepare(`
        UPDATE mail_remote_mutations
        SET state = CASE WHEN attempt_count >= 8 THEN 'terminal' ELSE 'pending' END,
            lease_owner = NULL, lease_expires_at_ms = NULL,
            last_error_code = CASE WHEN attempt_count >= 8
              THEN COALESCE(last_error_code, 'lease-expired') ELSE last_error_code END,
            updated_at_ms = ?, row_version = row_version + 1
        WHERE state = 'leased' AND lease_expires_at_ms <= ?
      `).run(now, now);
      const row = this.db.prepare(`
        SELECT mutations.id, mutations.idempotency_key, mutations.payload_json,
               mutations.attempt_count, mutations.available_at_ms,
               messages.public_id AS message_public_id,
               messages.rfc_message_id,
               folders.remote_path,
               instances.remote_uid,
               instances.uid_validity,
               messages.internal_date_ms
        FROM mail_remote_mutations mutations
        JOIN mail_accounts accounts ON accounts.id = mutations.account_id
        JOIN mail_messages messages ON messages.id = mutations.message_id
        LEFT JOIN mail_message_instances instances ON instances.id = mutations.instance_id
        LEFT JOIN mail_folders folders ON folders.id = instances.folder_id
        WHERE accounts.public_id = ? AND mutations.state = 'pending'
          AND mutations.available_at_ms <= ?
        ORDER BY mutations.available_at_ms ASC, mutations.id ASC
        LIMIT 1
      `).get(accountPublicId, now) as {
        id: bigint;
        idempotency_key: string;
        payload_json: string;
        attempt_count: bigint;
        available_at_ms: bigint;
        message_public_id: string;
        rfc_message_id: string | null;
        remote_path: string | null;
        remote_uid: bigint | null;
        uid_validity: bigint | null;
        internal_date_ms: bigint | null;
      } | undefined;
      if (!row) return null;
      const updated = this.db.prepare(`
        UPDATE mail_remote_mutations
        SET state = 'leased', attempt_count = attempt_count + 1,
            lease_owner = ?, lease_expires_at_ms = ?, updated_at_ms = ?,
            row_version = row_version + 1
        WHERE id = ? AND state = 'pending'
      `).run(owner, now + leaseMs, now, row.id);
      if (updated.changes !== 1) return null;
      const folder = row.remote_path ?? "INBOX";
      const uid = Number(row.remote_uid ?? 0n);
      const uidValidity = Number(row.uid_validity ?? 0n);
      return {
        id: Number(row.id),
        kind: "mail.remote.mutation",
        accountId: accountPublicId,
        payload: {
          accountId: accountPublicId,
          emailId: row.message_public_id,
          mutation: JSON.parse(row.payload_json) as unknown,
          fallbackLocator: {
            folder,
            uid,
            uidValidity,
            internalDate: new Date(Number(row.internal_date_ms ?? BigInt(now))).toISOString(),
            state: uid > 0 && uidValidity > 0 ? "ready" : "unknown",
          },
          ...(row.rfc_message_id ? { fallbackMessageId: row.rfc_message_id } : {}),
        },
        priority: 0 as const,
        attempts: Number(row.attempt_count) + 1,
        maxAttempts: 8,
        availableAt: new Date(Number(row.available_at_ms)).toISOString(),
        leaseOwner: owner,
        leaseUntil: new Date(now + leaseMs).toISOString(),
        idempotencyKey: row.idempotency_key,
      };
    }).immediate();
  }

  completeRemoteMutation(
    input: MailDatabaseCompleteRemoteMutationParams,
  ): MailDatabaseWriteResult<boolean> {
    const transaction = this.db.transaction(() => {
      const mutation = this.db.prepare(`
        SELECT mutations.id, mutations.account_id, mutations.message_id,
               mutations.instance_id, messages.public_id AS message_public_id,
               accounts.public_id AS account_public_id,
               instances.folder_id AS from_folder_id,
               instances.uid_validity AS from_uid_validity,
               instances.remote_uid AS from_remote_uid
        FROM mail_remote_mutations mutations
        JOIN mail_accounts accounts ON accounts.id = mutations.account_id
        JOIN mail_messages messages ON messages.id = mutations.message_id
        LEFT JOIN mail_message_instances instances ON instances.id = mutations.instance_id
        WHERE mutations.id = ? AND mutations.state = 'leased'
          AND mutations.lease_owner = ? AND messages.public_id = ?
      `).get(input.id, input.owner, input.emailId) as {
        id: bigint;
        account_id: bigint;
        message_id: bigint;
        instance_id: bigint | null;
        message_public_id: string;
        account_public_id: string;
        from_folder_id: bigint | null;
        from_uid_validity: bigint | null;
        from_remote_uid: bigint | null;
      } | undefined;
      if (!mutation) return null;

      const now = Date.now();
      const changes: MailDatabaseChange[] = [];
      if (input.relocation) {
        const target = this.ensureFolder(
          mutation.account_id,
          mutation.account_public_id,
          input.relocation.folder,
        );
        const hasReadyLocator = input.relocation.state === "ready" &&
          input.relocation.uid !== undefined && input.relocation.uidValidity !== undefined;
        let representativeInstanceId = mutation.instance_id;
        if (hasReadyLocator) {
          const collision = this.db.prepare(`
            SELECT id, message_id FROM mail_message_instances
            WHERE folder_id = ? AND uid_validity = ? AND remote_uid = ?
          `).get(
            target.id,
            input.relocation.uidValidity,
            input.relocation.uid,
          ) as { id: bigint; message_id: bigint } | undefined;
          if (collision && collision.message_id !== mutation.message_id) {
            throw new Error(`remote-locator-collision:${input.emailId}`);
          }
          if (collision) {
            representativeInstanceId = collision.id;
            if (mutation.instance_id !== null && mutation.instance_id !== collision.id) {
              this.db.prepare(`
                UPDATE mail_message_instances
                SET is_active = 0, row_version = row_version + 1
                WHERE id = ?
              `).run(mutation.instance_id);
            }
          } else if (mutation.instance_id !== null) {
            this.db.prepare(`
              UPDATE mail_message_instances
              SET folder_id = ?, uid_validity = ?, remote_uid = ?, is_active = 1,
                  last_seen_at_ms = ?, row_version = row_version + 1
              WHERE id = ?
            `).run(
              target.id,
              input.relocation.uidValidity,
              input.relocation.uid,
              now,
              mutation.instance_id,
            );
          }
          if (representativeInstanceId !== null) {
            this.db.prepare(`
              UPDATE mail_folder_memberships
              SET representative_instance_id = ?, row_version = row_version + 1
              WHERE folder_id = ? AND message_id = ?
            `).run(representativeInstanceId, target.id, mutation.message_id);
            this.db.prepare(`
              UPDATE mail_messages
              SET primary_instance_id = ?, primary_folder_id = ?,
                  row_version = row_version + 1
              WHERE id = ?
            `).run(representativeInstanceId, target.id, mutation.message_id);
          }
        }
        this.db.prepare(`
          INSERT INTO mail_instance_relocations (
            mutation_id, instance_id, message_id, from_folder_id,
            from_uid_validity, from_remote_uid, to_folder_id,
            to_uid_validity, to_remote_uid, locator_state, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          mutation.id,
          mutation.instance_id,
          mutation.message_id,
          mutation.from_folder_id,
          mutation.from_uid_validity,
          mutation.from_remote_uid,
          target.id,
          input.relocation.uidValidity ?? null,
          input.relocation.uid ?? null,
          hasReadyLocator ? "ready" : "unknown",
          now,
        );
        changes.push(this.folderChange(target));
      }

      const applied = this.db.prepare(`
        UPDATE mail_remote_mutations
        SET state = 'applied', lease_owner = NULL, lease_expires_at_ms = NULL,
            updated_at_ms = ?, row_version = row_version + 1
        WHERE id = ? AND state = 'leased' AND lease_owner = ?
      `).run(now, input.id, input.owner).changes === 1;
      if (!applied) return null;
      changes.push(
        {
          entityType: "message",
          entityPublicId: mutation.message_public_id,
          operation: "update",
          scopeHint: `account:${mutation.account_public_id}`,
        },
        {
          entityType: "remote_mutation",
          entityPublicId: String(input.id),
          operation: "update",
          scopeHint: `account:${mutation.account_public_id}`,
        },
      );
      const bounded = this.dedupeChanges(changes);
      return {
        commitVersion: this.recordCommit("remote-mutation-complete", bounded, now),
        changes: bounded,
      };
    });
    const committed = transaction.immediate();
    if (!committed) {
      return { value: false, commitVersion: this.commitVersion(), changes: [] };
    }
    return { value: true, ...committed };
  }

  failRemoteMutation(
    id: number,
    owner: string,
    error: string,
    retryDelayMs = 0,
  ): boolean {
    const now = Date.now();
    return this.db.prepare(`
      UPDATE mail_remote_mutations
      SET state = CASE WHEN attempt_count >= 8 THEN 'terminal' ELSE 'pending' END,
          available_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
          last_error_code = ?, updated_at_ms = ?, row_version = row_version + 1
      WHERE id = ? AND state = 'leased' AND lease_owner = ?
    `).run(now + Math.max(0, retryDelayMs), error, now, id, owner).changes === 1;
  }

  configureAccount(
    input: MailDatabaseConfigureAccountParams,
  ): MailDatabaseWriteResult<{ accountId: string }> {
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT id, email_address, display_name,
          imap_host, imap_port, imap_secure, imap_username,
          smtp_host, smtp_port, smtp_secure, smtp_username,
          credential_ref, credential_generation, state
         FROM mail_accounts WHERE public_id = ?`,
      ).get(input.account.id) as {
        id: bigint;
        email_address: string;
        display_name: string | null;
        imap_host: string;
        imap_port: bigint;
        imap_secure: bigint;
        imap_username: string;
        smtp_host: string;
        smtp_port: bigint;
        smtp_secure: bigint;
        smtp_username: string;
        credential_ref: string;
        credential_generation: bigint;
        state: string;
      } | undefined;
      if (existing && input.credentialGeneration < Number(existing.credential_generation)) {
        throw new Error("stale-credential-generation");
      }
      const unchanged = existing &&
        existing.email_address === input.account.emailAddress &&
        existing.display_name === (input.account.displayName ?? null) &&
        existing.imap_host === input.account.imap.host &&
        Number(existing.imap_port) === input.account.imap.port &&
        Number(existing.imap_secure) === (input.account.imap.secure ? 1 : 0) &&
        existing.imap_username === input.account.imap.username &&
        existing.smtp_host === input.account.smtp.host &&
        Number(existing.smtp_port) === input.account.smtp.port &&
        Number(existing.smtp_secure) === (input.account.smtp.secure ? 1 : 0) &&
        existing.smtp_username === input.account.smtp.username &&
        existing.credential_ref === input.credentialRef &&
        Number(existing.credential_generation) === input.credentialGeneration &&
        existing.state === "active";
      if (unchanged) {
        return {
          value: { accountId: input.account.id },
          commitVersion: this.commitVersion(),
          changes: [],
        };
      }
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO mail_accounts (
          public_id, email_address, display_name, provider_kind,
          imap_host, imap_port, imap_secure, imap_username,
          smtp_host, smtp_port, smtp_secure, smtp_username,
          credential_ref, credential_generation, state,
          created_at_ms, updated_at_ms, row_version
        ) VALUES (
          @publicId, @emailAddress, @displayName, 'imap-smtp',
          @imapHost, @imapPort, @imapSecure, @imapUsername,
          @smtpHost, @smtpPort, @smtpSecure, @smtpUsername,
          @credentialRef, @credentialGeneration, 'active',
          @createdAtMs, @updatedAtMs, 1
        )
        ON CONFLICT(public_id) DO UPDATE SET
          email_address = excluded.email_address,
          display_name = excluded.display_name,
          imap_host = excluded.imap_host,
          imap_port = excluded.imap_port,
          imap_secure = excluded.imap_secure,
          imap_username = excluded.imap_username,
          smtp_host = excluded.smtp_host,
          smtp_port = excluded.smtp_port,
          smtp_secure = excluded.smtp_secure,
          smtp_username = excluded.smtp_username,
          credential_ref = excluded.credential_ref,
          credential_generation = excluded.credential_generation,
          state = 'active',
          updated_at_ms = excluded.updated_at_ms,
          row_version = mail_accounts.row_version + 1
      `).run({
        publicId: input.account.id,
        emailAddress: input.account.emailAddress,
        displayName: input.account.displayName ?? null,
        imapHost: input.account.imap.host,
        imapPort: input.account.imap.port,
        imapSecure: input.account.imap.secure ? 1 : 0,
        imapUsername: input.account.imap.username,
        smtpHost: input.account.smtp.host,
        smtpPort: input.account.smtp.port,
        smtpSecure: input.account.smtp.secure ? 1 : 0,
        smtpUsername: input.account.smtp.username,
        credentialRef: input.credentialRef,
        credentialGeneration: input.credentialGeneration,
        createdAtMs: parseTimestampMs(input.account.createdAt, now),
        updatedAtMs: parseTimestampMs(input.account.updatedAt, now),
      });
      const changes: MailDatabaseChange[] = [{
        entityType: "account",
        entityPublicId: input.account.id,
        operation: existing ? "update" : "insert",
      }];
      const commitVersion = this.recordCommit("account-credential", changes, now);
      return { value: { accountId: input.account.id }, commitVersion, changes };
    });
    const result = transaction.immediate();
    return result;
  }

  saveDraft(input: MailDatabaseSaveDraftParams): MailDatabaseSaveDraftResult {
    const transaction = this.db.transaction(() => {
      const account = this.accountRow(input.accountId);
      const publicId = input.id ?? `draft_${randomUUID()}`;
      const existing = this.db.prepare(`
        SELECT drafts.id, drafts.account_id, drafts.client_revision
        FROM mail_drafts drafts WHERE drafts.public_id = ?
      `).get(publicId) as {
        id: bigint;
        account_id: bigint;
        client_revision: bigint;
      } | undefined;
      if (existing && existing.account_id !== account.id) {
        throw new Error("draft-account-mismatch");
      }
      const replyTo = input.originalEmailId
        ? this.message(input.accountId, input.originalEmailId)
        : null;
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO mail_drafts (
          public_id, account_id, reply_to_message_id, subject, body_text,
          body_html, state, scheduled_at_ms, client_revision,
          created_at_ms, updated_at_ms, row_version
        ) VALUES (?, ?, ?, ?, ?, ?, 'editing', NULL, 1, ?, ?, 1)
        ON CONFLICT(public_id) DO UPDATE SET
          reply_to_message_id = excluded.reply_to_message_id,
          subject = excluded.subject,
          body_text = excluded.body_text,
          body_html = excluded.body_html,
          state = 'editing',
          scheduled_at_ms = NULL,
          client_revision = mail_drafts.client_revision + 1,
          updated_at_ms = excluded.updated_at_ms,
          row_version = mail_drafts.row_version + 1
      `).run(
        publicId,
        account.id,
        replyTo?.id ?? null,
        input.subject,
        input.bodyText,
        input.bodyHtml,
        now,
        now,
      );
      const draft = this.db.prepare(
        "SELECT id FROM mail_drafts WHERE public_id = ?",
      ).get(publicId) as { id: bigint };
      this.replaceRecipients("mail_draft_recipients", "draft_id", draft.id, input);
      const changes: MailDatabaseChange[] = [{
        entityType: "draft",
        entityPublicId: publicId,
        operation: existing ? "update" : "insert",
        scopeHint: `account:${input.accountId}`,
      }];
      const commitVersion = this.recordCommit("draft-save", changes, now);
      return { commitVersion, changes, value: this.draftRecord(publicId) };
    });
    return transaction.immediate();
  }

  deleteDraft(accountPublicId: string, draftPublicId: string): MailDatabaseWriteResult<boolean> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT drafts.id
        FROM mail_drafts drafts
        JOIN mail_accounts accounts ON accounts.id = drafts.account_id
        WHERE accounts.public_id = ? AND drafts.public_id = ?
      `).get(accountPublicId, draftPublicId) as { id: bigint } | undefined;
      if (!row) return null;
      const deleted = this.db.prepare(
        "DELETE FROM mail_drafts WHERE id = ?",
      ).run(row.id).changes === 1;
      if (!deleted) return null;
      const now = Date.now();
      const changes: MailDatabaseChange[] = [{
        entityType: "draft",
        entityPublicId: draftPublicId,
        operation: "delete",
        scopeHint: `account:${accountPublicId}`,
      }];
      return {
        commitVersion: this.recordCommit("draft-delete", changes, now),
        changes,
      };
    });
    const committed = transaction.immediate();
    return committed
      ? { value: true, ...committed }
      : { value: false, commitVersion: this.commitVersion(), changes: [] };
  }

  enqueueSend(
    input: MailDatabaseEnqueueSendParams,
  ): MailDatabaseWriteResult<MailDatabaseEnqueueSendResult> {
    if (input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0) === 0) {
      throw new Error("send-recipient-required");
    }
    const transaction = this.db.transaction(() => {
      const account = this.accountRow(input.accountId);
      const existing = this.db.prepare(`
        SELECT public_id, message_id_header FROM mail_outbox_items
        WHERE idempotency_key = ?
      `).get(input.idempotencyKey) as {
        public_id: string;
        message_id_header: string;
      } | undefined;
      if (existing) {
        return {
          commitVersion: this.commitVersion(),
          changes: [] as MailDatabaseChange[],
          value: {
            outboxId: existing.public_id,
            state: "pending" as const,
            messageIdHeader: existing.message_id_header,
          },
        };
      }
      const draft = input.draftId
        ? this.db.prepare(`
            SELECT id FROM mail_drafts WHERE public_id = ? AND account_id = ?
          `).get(input.draftId, account.id) as { id: bigint } | undefined
        : undefined;
      if (input.draftId && !draft) throw new Error("draft-not-found");
      const now = Date.now();
      const scheduledAt = input.scheduledAt
        ? parseTimestampMs(input.scheduledAt, now)
        : now;
      const publicId = `outbox_${randomUUID()}`;
      const messageIdHeader = `<${randomUUID()}@wemail.local>`;
      const inserted = this.db.prepare(`
        INSERT INTO mail_outbox_items (
          public_id, draft_id, account_id, idempotency_key,
          frozen_subject, frozen_body_text, frozen_body_html, state,
          scheduled_at_ms, attempt_count, max_attempts, available_at_ms,
          lease_owner, lease_expires_at_ms, smtp_recovery_id,
          message_id_header, last_error_code, created_at_ms, updated_at_ms,
          row_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, 3, ?, NULL, NULL,
          ?, ?, NULL, ?, ?, 1)
      `).run(
        publicId,
        draft?.id ?? null,
        account.id,
        input.idempotencyKey,
        input.subject,
        input.bodyText,
        input.bodyHtml,
        input.scheduledAt ? scheduledAt : null,
        scheduledAt,
        randomUUID(),
        messageIdHeader,
        now,
        now,
      );
      this.replaceRecipients(
        "mail_outbox_recipients",
        "outbox_id",
        inserted.lastInsertRowid,
        input,
      );
      if (draft) {
        this.db.prepare(`
          UPDATE mail_drafts SET state = 'queued', scheduled_at_ms = ?,
            updated_at_ms = ?, row_version = row_version + 1 WHERE id = ?
        `).run(input.scheduledAt ? scheduledAt : null, now, draft.id);
      }
      const changes: MailDatabaseChange[] = [{
        entityType: "outbox",
        entityPublicId: publicId,
        operation: "insert",
        scopeHint: `account:${input.accountId}`,
      }];
      if (input.draftId) changes.push({
        entityType: "draft",
        entityPublicId: input.draftId,
        operation: "update",
        scopeHint: `account:${input.accountId}`,
      });
      const commitVersion = this.recordCommit("outbox-enqueue", changes, now);
      return {
        commitVersion,
        changes,
        value: { outboxId: publicId, state: "pending" as const, messageIdHeader },
      };
    });
    return transaction.immediate();
  }

  cancelScheduled(
    accountPublicId: string,
    outboxPublicId: string,
  ): MailDatabaseWriteResult<boolean> {
    const transaction = this.db.transaction(() => {
      const now = Date.now();
      const row = this.db.prepare(`
        SELECT outbox.id, outbox.draft_id
        FROM mail_outbox_items outbox
        JOIN mail_accounts accounts ON accounts.id = outbox.account_id
        WHERE accounts.public_id = ? AND outbox.public_id = ?
          AND outbox.scheduled_at_ms IS NOT NULL
      `).get(accountPublicId, outboxPublicId) as {
        id: bigint;
        draft_id: bigint | null;
      } | undefined;
      if (!row) return null;
      const cancelled = this.db.prepare(`
        UPDATE mail_outbox_items
        SET state = 'cancelled', lease_owner = NULL, lease_expires_at_ms = NULL,
            updated_at_ms = ?, row_version = row_version + 1
        WHERE id = ? AND state = 'pending'
      `).run(now, row.id).changes === 1;
      if (!cancelled) return null;
      if (row.draft_id !== null) {
        this.db.prepare(`
          UPDATE mail_drafts SET state = 'editing', scheduled_at_ms = NULL,
            updated_at_ms = ?, row_version = row_version + 1 WHERE id = ?
        `).run(now, row.draft_id);
      }
      const changes: MailDatabaseChange[] = [{
        entityType: "outbox",
        entityPublicId: outboxPublicId,
        operation: "update",
        scopeHint: `account:${accountPublicId}`,
      }];
      return {
        commitVersion: this.recordCommit("scheduled-send-cancel", changes, now),
        changes,
      };
    });
    const committed = transaction.immediate();
    return committed
      ? { value: true, ...committed }
      : { value: false, commitVersion: this.commitVersion(), changes: [] };
  }

  deleteScheduled(
    accountPublicId: string,
    outboxPublicId: string,
  ): MailDatabaseWriteResult<boolean> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT outbox.id, outbox.draft_id
        FROM mail_outbox_items outbox
        JOIN mail_accounts accounts ON accounts.id = outbox.account_id
        WHERE accounts.public_id = ? AND outbox.public_id = ?
          AND outbox.scheduled_at_ms IS NOT NULL
          AND outbox.state IN ('pending','sent','failed','terminal','cancelled')
      `).get(accountPublicId, outboxPublicId) as {
        id: bigint;
        draft_id: bigint | null;
      } | undefined;
      if (!row) return null;
      const now = Date.now();
      if (row.draft_id !== null) {
        this.db.prepare(`
          UPDATE mail_drafts SET state = 'editing', scheduled_at_ms = NULL,
            updated_at_ms = ?, row_version = row_version + 1 WHERE id = ?
        `).run(now, row.draft_id);
      }
      const deleted = this.db.prepare(`
        DELETE FROM mail_outbox_items WHERE id = ?
      `).run(row.id).changes === 1;
      if (!deleted) return null;
      const changes: MailDatabaseChange[] = [{
        entityType: "outbox",
        entityPublicId: outboxPublicId,
        operation: "delete",
        scopeHint: `account:${accountPublicId}`,
      }];
      return {
        commitVersion: this.recordCommit("scheduled-send-delete", changes, now),
        changes,
      };
    });
    const committed = transaction.immediate();
    return committed
      ? { value: true, ...committed }
      : { value: false, commitVersion: this.commitVersion(), changes: [] };
  }

  claimSend(accountPublicId: string, owner: string, leaseMs = 60_000): MailDatabaseClaimedSend | null {
    if (!owner) throw new Error("queue-owner-required");
    return this.db.transaction(() => {
      const now = Date.now();
      this.db.prepare(`
        UPDATE mail_outbox_items
        SET state = CASE WHEN attempt_count >= max_attempts THEN 'terminal' ELSE 'pending' END,
          lease_owner = NULL, lease_expires_at_ms = NULL,
          last_error_code = COALESCE(last_error_code, 'lease-expired'),
          updated_at_ms = ?, row_version = row_version + 1
        WHERE state IN ('leased','sending') AND lease_expires_at_ms <= ?
      `).run(now, now);
      const row = this.db.prepare(`
        SELECT outbox.id, outbox.public_id, outbox.frozen_subject,
          outbox.frozen_body_text, outbox.frozen_body_html,
          outbox.message_id_header, outbox.attempt_count, outbox.max_attempts
        FROM mail_outbox_items outbox
        JOIN mail_accounts accounts ON accounts.id = outbox.account_id
        WHERE accounts.public_id = ? AND outbox.state = 'pending'
          AND outbox.available_at_ms <= ?
        ORDER BY outbox.available_at_ms, outbox.id LIMIT 1
      `).get(accountPublicId, now) as {
        id: bigint;
        public_id: string;
        frozen_subject: string;
        frozen_body_text: string | null;
        frozen_body_html: string | null;
        message_id_header: string;
        attempt_count: bigint;
        max_attempts: bigint;
      } | undefined;
      if (!row) return null;
      const claimed = this.db.prepare(`
        UPDATE mail_outbox_items SET state = 'leased',
          attempt_count = attempt_count + 1, lease_owner = ?,
          lease_expires_at_ms = ?, updated_at_ms = ?, row_version = row_version + 1
        WHERE id = ? AND state = 'pending'
      `).run(owner, now + leaseMs, now, row.id);
      if (claimed.changes !== 1) return null;
      const recipients = this.outboxRecipients(row.id);
      return {
        id: Number(row.id),
        publicId: row.public_id,
        accountId: accountPublicId,
        draft: {
          accountId: accountPublicId,
          to: recipients.to,
          cc: recipients.cc,
          bcc: recipients.bcc,
          subject: row.frozen_subject,
          bodyText: row.frozen_body_text ?? "",
          bodyHtml: row.frozen_body_html ?? "",
          attachments: [],
        },
        messageIdHeader: row.message_id_header,
        attempts: Number(row.attempt_count) + 1,
        maxAttempts: Number(row.max_attempts),
        leaseOwner: owner,
      };
    }).immediate();
  }

  failSend(id: number, owner: string, error: string, retryDelayMs = 0): boolean {
    const now = Date.now();
    return this.db.prepare(`
      UPDATE mail_outbox_items
      SET state = CASE WHEN attempt_count >= max_attempts THEN 'terminal' ELSE 'pending' END,
        available_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
        last_error_code = ?, updated_at_ms = ?, row_version = row_version + 1
      WHERE id = ? AND state IN ('leased','sending') AND lease_owner = ?
    `).run(now + Math.max(0, retryDelayMs), error, now, id, owner).changes === 1;
  }

  completeSend(
    input: MailDatabaseCompleteSendParams,
  ): MailDatabaseWriteResult<{ outboxId: string; messageId: string }> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT outbox.id, outbox.public_id, outbox.draft_id,
          accounts.id AS account_id, accounts.public_id AS account_public_id,
          accounts.email_address, outbox.frozen_subject, outbox.frozen_body_text,
          outbox.frozen_body_html, outbox.message_id_header
        FROM mail_outbox_items outbox
        JOIN mail_accounts accounts ON accounts.id = outbox.account_id
        WHERE outbox.id = ? AND outbox.state IN ('leased','sending')
          AND outbox.lease_owner = ?
      `).get(input.id, input.owner) as {
        id: bigint;
        public_id: string;
        draft_id: bigint | null;
        account_id: bigint;
        account_public_id: string;
        email_address: string;
        frozen_subject: string;
        frozen_body_text: string | null;
        frozen_body_html: string | null;
        message_id_header: string;
      } | undefined;
      if (!row) throw new Error("outbox-lease-not-owned");
      const recipients = this.outboxRecipients(row.id);
      const now = Date.now();
      const sentAt = new Date(now).toISOString();
      const message: MailMessage = {
        id: `sent:${row.public_id}`,
        source: "local",
        accountId: row.account_public_id,
        folder: "Sent",
        messageId: input.messageId || row.message_id_header,
        threadId: input.messageId || row.message_id_header,
        from: { email: row.email_address },
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        ...(input.delivery ? { delivery: input.delivery } : {}),
        subject: row.frozen_subject,
        snippet: (row.frozen_body_text ?? "").trim().slice(0, 240),
        bodyText: row.frozen_body_text ?? "",
        bodyHtml: row.frozen_body_html ?? "",
        bodyCachedUntil: sentAt,
        bodyVersion: 1,
        receivedAt: sentAt,
        sentAt,
        hasAttachments: false,
        attachments: [],
        flags: { seen: true, flagged: false, answered: false, draft: false },
        sync: {
          uid: -Math.max(1, now),
          uidValidity: 0,
          internalDate: sentAt,
          flagsAuthoritative: false,
        },
      };
      const persisted = this.upsertMessage(row.account_id, message, true);
      if (persisted.threadId !== null) this.rebuildThread(persisted.threadId);
      this.db.prepare(`
        UPDATE mail_outbox_items SET state = 'sent', lease_owner = NULL,
          lease_expires_at_ms = NULL, last_error_code = NULL,
          updated_at_ms = ?, row_version = row_version + 1 WHERE id = ?
      `).run(now, row.id);
      if (row.draft_id !== null) {
        this.db.prepare(`
          UPDATE mail_drafts SET state = 'sent', updated_at_ms = ?,
            row_version = row_version + 1 WHERE id = ?
        `).run(now, row.draft_id);
      }
      const changes: MailDatabaseChange[] = [
        {
          entityType: "outbox",
          entityPublicId: row.public_id,
          operation: "update",
          scopeHint: `account:${row.account_public_id}`,
        },
        {
          entityType: "message",
          entityPublicId: persisted.publicId,
          operation: persisted.inserted ? "insert" : "update",
          scopeHint: `account:${row.account_public_id}`,
        },
      ];
      const commitVersion = this.recordCommit("smtp-send-complete", changes, now);
      return {
        value: { outboxId: row.public_id, messageId: persisted.publicId },
        commitVersion,
        changes,
      };
    });
    return transaction.immediate();
  }

  persistMetadata(
    input: MailDatabasePersistMetadataParams,
  ): MailDatabaseWriteResult<MetadataWriteResult> {
    const transaction = this.db.transaction(() => {
      const accountId = this.requireAccount(input.accountId);
      if (input.checkpoint) {
        const owned = input.lease && this.db.prepare(`
          SELECT 1 FROM mail_jobs WHERE id = ? AND account_id = ?
            AND state = 'leased' AND lease_owner = ? AND job_kind = 'mail.metadata.sync'
        `).get(input.lease.id, accountId, input.lease.owner);
        if (!owned) throw new Error("metadata-lease-not-owned");
        const checkpoint = input.checkpoint;
        const folder = this.ensureFolder(accountId, input.accountId, checkpoint.folder);
        const row = this.db.prepare("SELECT cursor_json FROM mail_folder_sync_state WHERE folder_id = ?")
          .get(folder.id) as { cursor_json: string | null } | undefined;
        let current: MailFolderSyncState | null = null;
        try {
          const parsed = MailFolderSyncStateSchema.safeParse(JSON.parse(row?.cursor_json ?? "null"));
          if (parsed.success) current = parsed.data;
        } catch { /* Invalid legacy progress is equivalent to no checkpoint. */ }
        if (!sameJson(current, MailFolderSyncStateSchema.nullable().parse(checkpoint.previous))) {
          throw new Error("metadata-checkpoint-conflict");
        }
        const next = MailFolderSyncStateSchema.parse(checkpoint.next);
        if (current && current.uidValidity === next.uidValidity && next.uid < current.uid) {
          throw new Error("metadata-checkpoint-regressed");
        }
        if (current?.uidValidity === next.uidValidity && checkpoint.mode === "repair" && next.uid !== current.uid) {
          throw new Error("metadata-repair-changed-realtime-cursor");
        }
        this.db.prepare(`
          INSERT INTO mail_folder_sync_state (folder_id, phase, cursor_json, last_success_at_ms, row_version)
          VALUES (?, ?, ?, ?, 1)
          ON CONFLICT(folder_id) DO UPDATE SET phase = excluded.phase,
            cursor_json = excluded.cursor_json, last_success_at_ms = excluded.last_success_at_ms,
            last_error_code = NULL, retry_at_ms = NULL, row_version = mail_folder_sync_state.row_version + 1
        `).run(folder.id, input.origin, JSON.stringify(next), Date.now());
      }
      const changes: MailDatabaseChange[] = [];
      const threadIds = new Set<bigint>();
      let insertedCount = 0;
      let updatedCount = 0;
      const insertedIds: string[] = [];
      const updatedIds: string[] = [];
      for (const message of input.messages) {
        const result = this.upsertMessage(accountId, message, false);
        if (result.inserted) {
          insertedCount += 1;
          insertedIds.push(result.publicId);
          if (input.checkpoint && !isMailBodyCached(message)) {
            const historical = input.origin === "historical";
            const receivedAtMs = Date.parse(message.receivedAt);
            const ageMs = receivedAtMs > 0 ? Math.max(0, Date.now() - receivedAtMs) : Number.MAX_SAFE_INTEGER;
            this.enqueueJob({
              kind: "mail.body.ensure",
              accountId: input.accountId,
              payload: { emailId: result.publicId, aiPriority: historical ? 4 : 0 },
              priority: historical ? Math.min(MAIL_JOB_PRIORITY_MAX, 10 + Math.floor(ageMs / 60_000)) : 1,
              maxAttempts: maxAttemptsForMailJob("mail.body.ensure"),
              idempotencyKey: `body.ensure:${input.accountId}:${result.publicId}`,
              terminalPolicy: "revive",
            });
          }
        } else if (result.changed) {
          updatedCount += 1;
          updatedIds.push(result.publicId);
        }
        if (result.changed) {
          if (result.threadId !== null) threadIds.add(result.threadId);
          changes.push({
            entityType: "message",
            entityPublicId: result.publicId,
            operation: result.inserted ? "insert" : "update",
            scopeHint: `account:${input.accountId}`,
          });
        }
      }
      if (input.origin === "historical" && input.initialSyncCompleted === true) {
        this.finalizeInitialAiCoverage(accountId, input.accountId, changes, Date.now());
      }
      if (!input.checkpoint) this.persistSyncCursors(accountId, input.messages, input.origin);
      for (const threadId of threadIds) this.rebuildThread(threadId);
      const bounded = this.dedupeChanges(changes);
      const commitVersion = bounded.length > 0
        ? this.recordCommit(`imap-${input.origin}`, bounded, Date.now())
        : this.commitVersion();
      return {
        commitVersion,
        changes: bounded,
        insertedCount,
        updatedCount,
        insertedIds,
        updatedIds,
      };
    });
    const result = transaction.immediate();
    return {
      value: {
        insertedCount: result.insertedCount,
        updatedCount: result.updatedCount,
        insertedIds: result.insertedIds,
        updatedIds: result.updatedIds,
      },
      commitVersion: result.commitVersion,
      changes: result.changes,
    };
  }

  persistBody(
    input: MailDatabasePersistBodyParams,
  ): MailDatabaseWriteResult<MailDatabasePersistBodyResult> {
    const transaction = this.db.transaction(() => {
      const accountId = this.requireAccount(input.message.accountId);
      const result = this.upsertMessage(accountId, input.message, true);
      const sourceJob = this.db.prepare(`
        SELECT priority, payload_json FROM mail_jobs WHERE id = ?
      `).get(input.jobId) as { priority: bigint; payload_json: string } | undefined;
      const sourcePriority = Number(sourceJob?.priority ?? 3);
      const backfillRunId = smartTagBackfillRunIdFromPayload(sourceJob?.payload_json);
      const bodyAiPriority = aiPriorityFromBodyPayload(sourceJob?.payload_json);
      const bodyAiKinds = aiKindsFromBodyPayload(sourceJob?.payload_json);
      const bodyReason = bodyReasonFromPayload(sourceJob?.payload_json);
      const initialEligibility = this.db.prepare(`
        SELECT ai_initial_summary_scope,
               EXISTS (
                 SELECT 1 FROM mail_ai_initial_coverage coverage
                 WHERE coverage.account_id = mail_messages.account_id
               ) AS initial_ai_coverage_finalized
        FROM mail_messages
        WHERE id = ? AND account_id = ?
      `).get(result.id, accountId) as {
        ai_initial_summary_scope: bigint;
        initial_ai_coverage_finalized: bigint;
      } | undefined;
      const initialScope = Number(initialEligibility?.ai_initial_summary_scope ?? 0);
      const isInitialSummaryEligible = initialScope === 1;
      const initialCoverageFinalized = Number(
        initialEligibility?.initial_ai_coverage_finalized ?? 0,
      ) === 1;
      // Body hydration remains full-scope. Only the AI fan-out is gated: the
      // one-time initial mark admits historical body jobs, while explicit and
      // incremental body jobs carry their normal AI priority (0 or 1).
      const aiPriority: 0 | 1 | 2 | 4 | null = backfillRunId !== undefined
        ? 4
        : bodyReason === "intelligence-request"
          ? 1
          : bodyAiPriority
            ?? (sourcePriority === 0
              ? 1
              : sourcePriority === 1
                ? 0
                : isInitialSummaryEligible
                ? 4
                : initialCoverageFinalized && initialScope === 0
                  ? 0
                  : null);
      const canEnqueueAi = aiPriority === 0 ||
        aiPriority === 1 ||
        backfillRunId !== undefined ||
        aiPriority === 2 ||
        (aiPriority === 4 && isInitialSummaryEligible);
      if (aiPriority !== null && canEnqueueAi) {
        this.enqueueIntelligenceJobsForReadyContent({
          accountId,
          accountPublicId: input.message.accountId,
          messageId: result.id,
          messagePublicId: result.publicId,
          priority: aiPriority,
          smartTagBackfillRunId: backfillRunId,
          kinds: bodyAiKinds,
        });
      }
      if (result.threadId !== null) this.rebuildThread(result.threadId);
      const completed = this.db.prepare(`
        UPDATE mail_jobs SET state = 'succeeded', lease_owner = NULL,
          lease_expires_at_ms = NULL, updated_at_ms = ?,
          row_version = row_version + 1
        WHERE id = ? AND state = 'leased' AND lease_owner = ?
      `).run(Date.now(), input.jobId, input.jobOwner);
      if (completed.changes !== 1) throw new Error("body-job-lease-not-owned");
      const changes = this.dedupeChanges([
        {
          entityType: "message",
          entityPublicId: result.publicId,
          operation: result.inserted ? "insert" : "update",
          scopeHint: `account:${input.message.accountId}`,
        },
        {
          entityType: "content",
          entityPublicId: result.publicId,
          operation: "update",
          scopeHint: `account:${input.message.accountId}`,
        },
        {
          entityType: "search",
          entityPublicId: result.publicId,
          operation: "update",
          scopeHint: `account:${input.message.accountId}`,
        },
      ] satisfies MailDatabaseChange[]);
      const commitVersion = this.recordCommit("imap-body", changes, parseTimestampMs(input.completedAt, Date.now()));
      return {
        commitVersion,
        changes,
        messagePublicId: result.publicId,
        inlineImagePublicIds: result.inlineImagePublicIds,
      };
    });
    const result = transaction.immediate();
    return {
      value: {
        emailId: input.message.id,
        bodyCached: true,
        jobCompleted: true,
        messagePublicId: result.messagePublicId,
        inlineImagePublicIds: result.inlineImagePublicIds,
      },
      commitVersion: result.commitVersion,
      changes: result.changes,
    };
  }

  failBody(
    input: MailDatabaseFailBodyParams,
  ): MailDatabaseWriteResult<{
    attempts: number;
    nextRetryAt?: string;
    jobCompleted: boolean;
  }> {
    const transaction = this.db.transaction(() => {
      const message = this.message(input.accountId, input.emailId);
      if (!message) throw new Error(`message-not-found:${input.emailId}`);
      const sourceJob = this.db.prepare(`
        SELECT payload_json FROM mail_jobs WHERE id = ?
      `).get(input.jobId) as { payload_json: string } | undefined;
      this.db.prepare(`
        INSERT INTO mail_message_content (
          message_id, state, content_version, retry_at_ms, retry_count,
          retryable, error_code, row_version
        ) VALUES (?, 'failed', 0, ?, 1, ?, ?, 1)
        ON CONFLICT(message_id) DO UPDATE SET
          state = CASE
            WHEN mail_message_content.state = 'ready' THEN 'ready'
            ELSE 'failed'
          END,
          retry_at_ms = CASE
            WHEN mail_message_content.state = 'ready' THEN mail_message_content.retry_at_ms
            ELSE excluded.retry_at_ms
          END,
          retry_count = CASE
            WHEN mail_message_content.state = 'ready' THEN mail_message_content.retry_count
            ELSE mail_message_content.retry_count + 1
          END,
          retryable = CASE
            WHEN mail_message_content.state = 'ready' THEN mail_message_content.retryable
            ELSE excluded.retryable
          END,
          error_code = CASE
            WHEN mail_message_content.state = 'ready' THEN mail_message_content.error_code
            ELSE excluded.error_code
          END,
          row_version = mail_message_content.row_version + 1
      `).run(
        message.id,
        input.retryAt ? parseTimestampMs(input.retryAt) : null,
        input.retryable ? 1 : 0,
        input.errorCode,
      );
      const state = this.db.prepare(`
        SELECT retry_count, retry_at_ms FROM mail_message_content WHERE message_id = ?
      `).get(message.id) as { retry_count: bigint; retry_at_ms: bigint | null };
      const availableAt = input.retryAt ? parseTimestampMs(input.retryAt, Date.now()) : Date.now();
      const completed = this.db.prepare(`
        UPDATE mail_jobs SET
          state = CASE
            WHEN ? = 0 OR attempt_count >= max_attempts THEN 'terminal'
            ELSE 'pending'
          END,
          available_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
          last_error_code = ?, updated_at_ms = ?, row_version = row_version + 1
        WHERE id = ? AND state = 'leased' AND lease_owner = ?
      `).run(
        input.retryable ? 1 : 0,
        availableAt,
        input.errorCode,
        Date.now(),
        input.jobId,
        input.jobOwner,
      );
      if (completed.changes !== 1) throw new Error("body-job-lease-not-owned");
      const terminalState = this.db.prepare(
        "SELECT state FROM mail_jobs WHERE id = ?",
      ).get(input.jobId) as { state: string } | undefined;
      const backfillRunId = smartTagBackfillRunIdFromPayload(sourceJob?.payload_json);
      if (terminalState?.state === "terminal" && backfillRunId) {
        this.recordSmartTagBackfillTerminal(backfillRunId, true, input.errorCode);
      }
      const changes: MailDatabaseChange[] = [{
        entityType: "content",
        entityPublicId: message.public_id,
        operation: "update",
        scopeHint: `account:${input.accountId}`,
      }];
      const commitVersion = this.recordCommit(
        "imap-body-failure",
        changes,
        parseTimestampMs(input.failedAt, Date.now()),
      );
      return { commitVersion, changes, state };
    });
    const result = transaction.immediate();
    return {
      value: {
        attempts: Number(result.state.retry_count),
        jobCompleted: true,
        ...(result.state.retry_at_ms !== null
          ? { nextRetryAt: new Date(Number(result.state.retry_at_ms)).toISOString() }
          : {}),
      },
      commitVersion: result.commitVersion,
      changes: result.changes,
    };
  }

  mutate(input: MailDatabaseMutationParams): MailDatabaseMutationResult {
    const existing = this.db.prepare(`
      SELECT id FROM mail_remote_mutations WHERE idempotency_key = ?
    `).get(input.idempotencyKey) as { id: bigint } | undefined;
    if (existing) {
      return {
        value: this.mutationResult(input.emailId, Number(existing.id)),
        commitVersion: this.commitVersion(),
        changes: [],
      };
    }

    const transaction = this.db.transaction(() => {
      const message = this.message(input.accountId, input.emailId);
      if (!message) throw new Error(`message-not-found:${input.emailId}`);
      if (message.deleted_at_ms !== null && input.mutation.type !== "delete") {
        throw new Error(`message-deleted:${input.emailId}`);
      }

      const now = Date.now();
      const changes: MailDatabaseChange[] = [];
      let deleted = false;
      let targetFolder: FolderRow | null = null;
      // May be rewritten to the physical folder path when the requested
      // identity only resolved via role (e.g. "archive" -> "[Gmail]/All Mail").
      let mutation = input.mutation;

      if (input.mutation.type === "flags") {
        const seen = input.mutation.patch.seen ?? (message.is_seen === 1n);
        const flagged = input.mutation.patch.flagged ?? (message.is_flagged === 1n);
        this.updateFlags(message, seen, flagged);
      } else if (input.mutation.type === "delete") {
        deleted = true;
        this.deleteProjection(message, now);
      } else {
        targetFolder = input.mutation.type === "move"
          ? this.resolveMoveTarget(input.accountId, input.mutation.folder)
          : this.specialFolder(input.accountId, "trash");
        if (!targetFolder) {
          throw new Error(`target-folder-not-found:${input.mutation.type === "move" ? input.mutation.folder : "trash"}`);
        }
        if (input.mutation.type === "move" && input.mutation.folder !== targetFolder.remote_path) {
          // The queued remote mutation must move to the physical folder
          // path, not the canonical/aliased identity that resolved it.
          mutation = { type: "move", folder: targetFolder.remote_path };
        }
        this.moveProjection(message, targetFolder);
      }


      const mutationRun = this.db.prepare(`
        INSERT INTO mail_remote_mutations (
          public_id, account_id, message_id, instance_id, mutation_kind,
          idempotency_key, payload_json, state, attempt_count, available_at_ms,
          lease_expires_at_ms, last_error_code, created_at_ms, updated_at_ms,
          row_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?, 1)
      `).run(
        `mutation_${randomUUID()}`,
        message.account_id,
        message.id,
        message.primary_instance_id,
        mutation.type,
        input.idempotencyKey,
        JSON.stringify(mutation),
        now,
        now,
        now,
      );
      const mutationId = Number(mutationRun.lastInsertRowid);
      changes.push({
        entityType: "message",
        entityPublicId: message.public_id,
        operation: deleted ? "delete" : "update",
        scopeHint: `account:${input.accountId}`,
      });
      if (message.primary_folder_id !== null) {
        const previousFolder = this.folderById(message.primary_folder_id);
        if (previousFolder) changes.push(this.folderChange(previousFolder));
      }
      if (targetFolder) changes.push(this.folderChange(targetFolder));
      changes.push({
        entityType: "remote_mutation",
        entityPublicId: String(mutationId),
        operation: "insert",
        scopeHint: `account:${input.accountId}`,
      });
      const commitVersion = this.recordCommit("renderer-mutation", changes, now);
      return { commitVersion, changes, mutationId, deleted };
    });

    const committed = transaction.immediate();
    return {
      value: this.mutationResult(input.emailId, committed.mutationId, committed.deleted),
      commitVersion: committed.commitVersion,
      changes: committed.changes,
    };
  }

  private upsertMessage(
    accountId: bigint,
    message: MailMessage,
    includeBody: boolean,
  ): {
    id: bigint;
    publicId: string;
    threadId: bigint | null;
    inserted: boolean;
    changed: boolean;
    inlineImagePublicIds: Array<{ contentId: string; publicId: string }>;
  } {
    const receivedAtMs = parseTimestampMs(message.receivedAt, Date.now());
    const internalDateMs = parseTimestampMs(message.sync.internalDate, receivedAtMs);
    const sentAtMs = message.sentAt ? parseTimestampMs(message.sentAt) : null;
    const normalizedSubject = normalizeSubject(message.subject);
    const sender = normalizeAddress(message.from.email);
    const rfcMessageId = normalizeRfcMessageId(message.messageId);
    const structuralFingerprint = sha256Text([
      normalizedSubject,
      sender,
      message.sentAt ?? "",
      message.snippet,
    ].join("\0"));
    const folder = this.ensureFolder(accountId, message.accountId, message.folder);
    let canonical = this.findMessageForUpsert(
      accountId,
      message,
      folder.id,
      normalizedSubject,
      sender,
      rfcMessageId,
      structuralFingerprint,
    );
    const inserted = canonical === null;
    const threadId = this.ensureThread(
      accountId,
      message.accountId,
      message.threadId ?? normalizedSubject,
      normalizedSubject,
      receivedAtMs,
    );
    const effectiveSeen = !inserted && message.sync.flagsAuthoritative !== true
      ? canonical!.is_seen === 1n
      : message.flags.seen;
    const effectiveFlagged = !inserted && message.sync.flagsAuthoritative !== true
      ? canonical!.is_flagged === 1n
      : message.flags.flagged;
    const changed = inserted || canonical === null ||
      canonical.thread_id !== threadId ||
      canonical.primary_folder_id !== folder.id ||
      canonical.received_at_ms !== BigInt(receivedAtMs) ||
      canonical.has_attachments !== BigInt(message.hasAttachments ? 1 : 0) ||
      (message.sync.flagsAuthoritative === true && (
        canonical.is_seen !== BigInt(message.flags.seen ? 1 : 0) ||
        canonical.is_flagged !== BigInt(message.flags.flagged ? 1 : 0)
      )) ||
      canonical.deleted_at_ms !== null ||
      canonical.normalized_subject !== normalizedSubject ||
      canonical.sender_preview !== sender;
    if (!canonical) {
      const id = encodeTimeSortMessageId({
        receivedAtMs,
        sequence: this.allocateMessageSequence(receivedAtMs),
      });
      const publicId = this.availableMessagePublicId(accountId, message.id);
      this.db.prepare(`
        INSERT INTO mail_messages (
          id, public_id, account_id, thread_id, rfc_message_id,
          normalized_subject, subject, snippet, sender_preview, recipient_preview,
          sent_at_ms, received_at_ms, internal_date_ms, size_bytes,
          has_attachments, is_seen, is_flagged, importance,
          primary_folder_id, content_version, row_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, 1)
      `).run(
        id,
        publicId,
        accountId,
        threadId,
        rfcMessageId,
        normalizedSubject,
        message.subject,
        message.snippet,
        sender,
        this.recipientPreview(message),
        sentAtMs,
        receivedAtMs,
        internalDateMs,
        message.hasAttachments ? 1 : 0,
        effectiveSeen ? 1 : 0,
        effectiveFlagged ? 1 : 0,
        folder.id,
        Math.max(0, message.bodyVersion ?? 0),
      );
      canonical = {
        id,
        public_id: publicId,
        account_id: accountId,
        thread_id: threadId,
        primary_folder_id: folder.id,
        primary_instance_id: null,
        received_at_ms: BigInt(receivedAtMs),
        has_attachments: message.hasAttachments ? 1n : 0n,
        is_seen: effectiveSeen ? 1n : 0n,
        is_flagged: effectiveFlagged ? 1n : 0n,
        deleted_at_ms: null,
        snippet: message.snippet,
        normalized_subject: normalizedSubject,
        sender_preview: sender,
      };
      this.db.prepare(`
        INSERT INTO mail_message_identity_keys (
          message_id, key_kind, key_value, confidence
        ) VALUES (?, ?, ?, ?)
      `).run(
        id,
        rfcMessageId ? "rfc_message_id" : "strong_fingerprint",
        rfcMessageId ?? structuralFingerprint,
        rfcMessageId ? 90 : 80,
      );
      this.db.prepare(`
        INSERT OR IGNORE INTO mail_message_identity_keys (
          message_id, key_kind, key_value, confidence
        ) VALUES (?, 'structural_fingerprint', ?, 70)
      `).run(id, structuralFingerprint);
      this.db.prepare(`
        INSERT INTO mail_message_content (
          message_id, state, content_version, retry_count, retryable, row_version
        ) VALUES (?, 'missing', ?, 0, 1, 1)
      `).run(id, Math.max(0, message.bodyVersion ?? 0));
    } else {
      // A metadata (no source) fetch parses an empty snippet. Never let it
      // blank the snippet a body hydration already stored on the row.
      const storedSnippet = message.snippet.trim().length > 0 || !canonical.snippet
        ? message.snippet
        : canonical.snippet;
      this.db.prepare(`
        UPDATE mail_messages SET
          thread_id = ?, rfc_message_id = COALESCE(?, rfc_message_id),
          normalized_subject = ?, subject = ?, snippet = ?, sender_preview = ?,
          recipient_preview = ?, sent_at_ms = COALESCE(?, sent_at_ms),
          received_at_ms = ?, internal_date_ms = ?,
          has_attachments = ?, primary_folder_id = ?, deleted_at_ms = NULL,
          row_version = row_version + 1
        WHERE id = ?
      `).run(
        threadId,
        rfcMessageId,
        normalizedSubject,
        message.subject,
        storedSnippet,
        sender,
        this.recipientPreview(message),
        sentAtMs,
        receivedAtMs,
        internalDateMs,
        message.hasAttachments ? 1 : 0,
        folder.id,
        canonical.id,
      );
    }

    const instancePublicId = stablePublicId(
      "instance",
      `${message.accountId}\0${message.folder}\0${message.sync.uidValidity}\0${message.sync.uid}`,
    );
    this.db.prepare(`
      INSERT INTO mail_message_instances (
        public_id, account_id, message_id, folder_id, uid_validity,
        remote_uid, flags_bits, keywords_norm, is_active,
        last_seen_at_ms, row_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 1, ?, 1)
      ON CONFLICT(folder_id, uid_validity, remote_uid) DO UPDATE SET
        message_id = excluded.message_id,
        flags_bits = excluded.flags_bits,
        is_active = 1,
        last_seen_at_ms = excluded.last_seen_at_ms,
        row_version = mail_message_instances.row_version + 1
    `).run(
      instancePublicId,
      accountId,
      canonical.id,
      folder.id,
      message.sync.uidValidity,
      message.sync.uid,
      encodeFlagsBits({
        isSeen: effectiveSeen,
        isFlagged: effectiveFlagged,
        isAnswered: message.flags.answered,
        isDraft: message.flags.draft,
      }),
      Date.now(),
    );
    const instance = this.db.prepare(`
      SELECT id FROM mail_message_instances
      WHERE folder_id = ? AND uid_validity = ? AND remote_uid = ?
    `).get(folder.id, message.sync.uidValidity, message.sync.uid) as { id: bigint };
    this.db.prepare(`
      INSERT INTO mail_folder_memberships (
        folder_id, message_id, representative_instance_id, received_at_ms,
        is_seen, is_flagged, has_attachments, row_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(folder_id, message_id) DO UPDATE SET
        representative_instance_id = excluded.representative_instance_id,
        received_at_ms = excluded.received_at_ms,
        is_seen = excluded.is_seen,
        is_flagged = excluded.is_flagged,
        has_attachments = excluded.has_attachments,
        row_version = mail_folder_memberships.row_version + 1
    `).run(
      folder.id,
      canonical.id,
      instance.id,
      receivedAtMs,
      effectiveSeen ? 1 : 0,
      effectiveFlagged ? 1 : 0,
      message.hasAttachments ? 1 : 0,
    );
    this.db.prepare(`
      UPDATE mail_messages SET
        primary_instance_id = ?, primary_folder_id = ?,
        is_seen = (SELECT MIN(is_seen) FROM mail_folder_memberships WHERE message_id = ?),
        is_flagged = (SELECT MAX(is_flagged) FROM mail_folder_memberships WHERE message_id = ?),
        row_version = row_version + 1
      WHERE id = ?
    `).run(instance.id, folder.id, canonical.id, canonical.id, canonical.id);

    this.replaceAddresses(canonical.id, message);
    this.replaceHeaders(canonical.id, message);
    const inlineImagePublicIds = this.upsertAttachments(
      canonical.id,
      canonical.public_id,
      message,
    );
    // Metadata and body are separate authorities. Provider list/metadata
    // payloads frequently contain empty body fields; treating those fields as
    // authoritative can overwrite a previously committed non-empty body with
    // `ready + empty`. Only the explicit persistBody command may write content.
    if (includeBody) this.upsertBody(canonical.id, message);
    this.updateSearchIndex(canonical.id, message.accountId);
    materializeInvoiceSubjectCategory(this.db, canonical.id);
    return {
      id: canonical.id,
      publicId: canonical.public_id,
      threadId,
      inserted,
      changed,
      inlineImagePublicIds,
    };
  }

  private requireAccount(publicId: string): bigint {
    const row = this.db.prepare(`
      SELECT id FROM mail_accounts WHERE public_id = ? AND state <> 'disabled'
    `).get(publicId) as { id: bigint } | undefined;
    if (!row) throw new Error(`account-not-found:${publicId}`);
    return row.id;
  }

  private ensureFolder(
    accountId: bigint,
    accountPublicId: string,
    remotePath: string,
  ): FolderRow {
    const existing = this.db.prepare(`
      SELECT id, public_id, remote_path FROM mail_folders
      WHERE account_id = ? AND remote_path = ? AND deleted_at_ms IS NULL
    `).get(accountId, remotePath) as FolderRow | undefined;
    if (existing) return existing;
    const publicId = stablePublicId("folder", `${accountPublicId}\0${remotePath}`);
    const result = this.db.prepare(`
      INSERT INTO mail_folders (
        public_id, account_id, remote_path, display_name, role,
        is_selectable, is_subscribed, row_version
      ) VALUES (?, ?, ?, ?, ?, 1, 1, 1)
    `).run(publicId, accountId, remotePath, remotePath, mapFolderRole(remotePath));
    return { id: BigInt(result.lastInsertRowid), public_id: publicId, remote_path: remotePath };
  }

  private findMessageForUpsert(
    accountId: bigint,
    message: MailMessage,
    folderId: bigint,
    normalizedSubject: string,
    sender: string,
    rfcMessageId: string | null,
    structuralFingerprint: string,
  ): CanonicalMessageRow | null {
    const exact = this.db.prepare(`
      SELECT messages.id, messages.public_id, messages.account_id,
             messages.thread_id, messages.primary_folder_id,
             messages.primary_instance_id, messages.received_at_ms,
             messages.has_attachments, messages.is_seen, messages.is_flagged,
             messages.deleted_at_ms, messages.normalized_subject,
             messages.sender_preview, messages.snippet
      FROM mail_messages messages
      WHERE messages.account_id = ? AND messages.public_id = ?
      LIMIT 1
    `).get(accountId, message.id) as CanonicalMessageRow | undefined;
    if (exact) return exact;
    const locator = this.db.prepare(`
      SELECT messages.id, messages.public_id, messages.account_id,
             messages.thread_id, messages.primary_folder_id,
             messages.primary_instance_id, messages.received_at_ms,
             messages.has_attachments, messages.is_seen, messages.is_flagged,
             messages.deleted_at_ms, messages.normalized_subject,
             messages.sender_preview, messages.snippet
      FROM mail_message_instances instances
      JOIN mail_messages messages ON messages.id = instances.message_id
      WHERE instances.folder_id = ? AND instances.uid_validity = ?
        AND instances.remote_uid = ?
      LIMIT 1
    `).get(folderId, message.sync.uidValidity, message.sync.uid) as CanonicalMessageRow | undefined;
    if (locator) return locator;
    const keyKind = rfcMessageId ? "rfc_message_id" : "strong_fingerprint";
    const keyValue = rfcMessageId ?? structuralFingerprint;
    const candidates = this.db.prepare(`
      SELECT messages.id, messages.public_id, messages.account_id,
             messages.thread_id, messages.primary_folder_id,
             messages.primary_instance_id, messages.received_at_ms,
             messages.has_attachments, messages.is_seen, messages.is_flagged,
             messages.deleted_at_ms, messages.normalized_subject,
             messages.sender_preview, messages.snippet
      FROM mail_message_identity_keys keys
      JOIN mail_messages messages ON messages.id = keys.message_id
      WHERE messages.account_id = ? AND keys.key_kind = ? AND keys.key_value = ?
        AND messages.normalized_subject = ? AND messages.sender_preview = ?
      ORDER BY messages.id
      LIMIT 2
    `).all(
      accountId,
      keyKind,
      keyValue,
      normalizedSubject,
      sender,
    ) as CanonicalMessageRow[];
    return candidates.length === 1 ? candidates[0] : null;
  }

  private availableMessagePublicId(accountId: bigint, preferred: string): string {
    const existing = this.db.prepare(`
      SELECT account_id FROM mail_messages WHERE public_id = ?
    `).get(preferred) as { account_id: bigint } | undefined;
    if (!existing || existing.account_id === accountId) return preferred;
    return stablePublicId("message", `${accountId.toString()}\0${preferred}`);
  }

  private allocateMessageSequence(receivedAtMs: number): number {
    this.db.prepare(`
      INSERT INTO mail_message_id_sequences (received_at_ms, next_sequence)
      VALUES (?, 1)
      ON CONFLICT(received_at_ms) DO UPDATE
      SET next_sequence = next_sequence + 1
    `).run(receivedAtMs);
    const row = this.db.prepare(`
      SELECT next_sequence - 1 AS sequence
      FROM mail_message_id_sequences WHERE received_at_ms = ?
    `).get(receivedAtMs) as { sequence: bigint };
    const sequence = Number(row.sequence);
    if (sequence >= 1_048_576) throw new Error(`message-sequence-exhausted:${receivedAtMs}`);
    return sequence;
  }

  private ensureThread(
    accountId: bigint,
    accountPublicId: string,
    sourceThreadId: string,
    normalizedSubject: string,
    receivedAtMs: number,
  ): bigint {
    const publicId = stablePublicId(
      "thread",
      `${accountPublicId}\0${sourceThreadId || normalizedSubject}`,
    );
    const current = this.db.prepare(`
      SELECT id FROM mail_threads WHERE public_id = ?
    `).get(publicId) as { id: bigint } | undefined;
    if (current) return current.id;
    const result = this.db.prepare(`
      INSERT INTO mail_threads (
        public_id, account_id, normalized_subject, latest_received_at_ms,
        message_count, unread_count, row_version
      ) VALUES (?, ?, ?, ?, 0, 0, 1)
    `).run(publicId, accountId, normalizedSubject, receivedAtMs);
    return BigInt(result.lastInsertRowid);
  }

  private replaceAddresses(messageId: bigint, message: MailMessage): void {
    this.db.prepare("DELETE FROM mail_message_addresses WHERE message_id = ?").run(messageId);
    const insert = this.db.prepare(`
      INSERT INTO mail_message_addresses (
        message_id, kind, ordinal, address_norm, address_display, name_display
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const groups: Array<["from" | "to" | "cc" | "bcc", WemailAddress[]]> = [
      ["from", [message.from]],
      ["to", message.to],
      ["cc", message.cc],
      ["bcc", message.bcc],
    ];
    for (const [kind, values] of groups) {
      values.forEach((address, ordinal) => {
        const normalized = normalizeAddress(address.email);
        if (!normalized) return;
        insert.run(
          messageId,
          kind,
          ordinal,
          normalized,
          address.email.trim(),
          address.name?.trim() || null,
        );
      });
    }
  }

  private replaceHeaders(messageId: bigint, message: MailMessage): void {
    this.db.prepare("DELETE FROM mail_message_headers WHERE message_id = ?").run(messageId);
    this.db.prepare("DELETE FROM mail_message_references WHERE message_id = ?").run(messageId);
    const insertHeader = this.db.prepare(`
      INSERT INTO mail_message_headers (
        message_id, name_norm, ordinal, value_text
      ) VALUES (?, ?, 0, ?)
    `);
    const insertReference = this.db.prepare(`
      INSERT INTO mail_message_references (
        message_id, ordinal, reference_value
      ) VALUES (?, ?, ?)
    `);
    let referenceOrdinal = 0;
    for (const [name, value] of Object.entries(message.headers ?? {})) {
      const normalizedName = name.trim().toLowerCase();
      if (!normalizedName) continue;
      insertHeader.run(messageId, normalizedName, value);
      if (normalizedName === "references" || normalizedName === "in-reply-to") {
        for (const reference of value.match(/<[^>]+>/g) ?? []) {
          insertReference.run(messageId, referenceOrdinal++, reference.toLowerCase());
        }
      }
    }
    if (message.parentMessageId && referenceOrdinal === 0) {
      insertReference.run(messageId, 0, message.parentMessageId.trim().toLowerCase());
    }
  }

  private upsertAttachments(
    messageId: bigint,
    messagePublicId: string,
    message: MailMessage,
  ): Array<{ contentId: string; publicId: string }> {
    const keep = new Set<string>();
    const inlineImagePublicIds: Array<{ contentId: string; publicId: string }> = [];
    const upsert = this.db.prepare(`
      INSERT INTO mail_attachments (
        public_id, message_id, part_path, filename, filename_norm, media_type,
        content_id, disposition, byte_size, is_inline, state, row_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'metadata', 1)
      ON CONFLICT(message_id, part_path) DO UPDATE SET
        filename = excluded.filename,
        filename_norm = excluded.filename_norm,
        media_type = excluded.media_type,
        content_id = excluded.content_id,
        disposition = excluded.disposition,
        byte_size = excluded.byte_size,
        is_inline = excluded.is_inline,
        row_version = mail_attachments.row_version + 1
    `);
    message.attachments.forEach((attachment, ordinal) => {
      const partPath = attachment.id || String(ordinal + 1);
      keep.add(partPath);
      const publicId = stablePublicId(
        "attachment",
        `${messagePublicId}\0${partPath}`,
      );
      upsert.run(
        publicId,
        messageId,
        partPath,
        attachment.filename || null,
        attachment.filename ? attachment.filename.normalize("NFKC").trim().toLowerCase() : null,
        attachment.mimetype,
        attachment.contentId ?? null,
        attachment.disposition ?? null,
        attachment.size,
        attachment.disposition === "inline" ? 1 : 0,
      );
      // Surface inline-image public ids (matched by normalized contentId) so
      // the mail-core process can seed the attachment disk cache for bytes it
      // captured at parse — same key the HTTP route reads with.
      if (isInlineImage(attachment)) {
        const cid = normalizeContentId(attachment.contentId);
        if (cid) inlineImagePublicIds.push({ contentId: cid, publicId });
      }
    });
    const existing = this.db.prepare(`
      SELECT part_path FROM mail_attachments WHERE message_id = ?
    `).all(messageId) as Array<{ part_path: string }>;
    const remove = this.db.prepare(`
      DELETE FROM mail_attachments WHERE message_id = ? AND part_path = ?
    `);
    for (const row of existing) {
      if (!keep.has(row.part_path)) remove.run(messageId, row.part_path);
    }
    return inlineImagePublicIds;
  }

  private upsertBody(messageId: bigint, message: MailMessage): void {
    const text = message.bodyText ?? "";
    const html = message.bodyHtml ?? null;
    const contentSha256 = sha256Text(`${text}\0${html ?? ""}`);
    const byteSize = Buffer.byteLength(text, "utf8") + Buffer.byteLength(html ?? "", "utf8");
    const requestedVersion = Math.max(1, message.bodyVersion ?? 1);
    this.db.prepare(`
      INSERT INTO mail_message_content (
        message_id, state, text_plain, html_sanitized, content_sha256,
        content_version, byte_size, fetched_at_ms, retry_at_ms, retry_count,
        retryable, error_code, row_version
      ) VALUES (?, 'ready', ?, ?, ?, ?, ?, ?, NULL, 0, 1, NULL, 1)
      ON CONFLICT(message_id) DO UPDATE SET
        state = 'ready',
        text_plain = excluded.text_plain,
        html_sanitized = excluded.html_sanitized,
        content_sha256 = excluded.content_sha256,
        content_version = MAX(mail_message_content.content_version, excluded.content_version),
        byte_size = excluded.byte_size,
        fetched_at_ms = excluded.fetched_at_ms,
        retry_at_ms = NULL,
        retry_count = 0,
        retryable = 1,
        error_code = NULL,
        row_version = mail_message_content.row_version + 1
    `).run(
      messageId,
      text,
      html,
      contentSha256,
      requestedVersion,
      byteSize,
      message.bodyCachedUntil ? parseTimestampMs(message.bodyCachedUntil, Date.now()) : Date.now(),
    );
    this.db.prepare(`
      UPDATE mail_messages
      SET content_version = MAX(content_version, ?), row_version = row_version + 1
      WHERE id = ?
    `).run(requestedVersion, messageId);
  }

  private updateSearchIndex(messageId: bigint, accountPublicId: string): void {
    const row = this.searchIndexRow(messageId);
    this.db.prepare("DELETE FROM mail_search_fts WHERE rowid = ?").run(messageId);
    this.db.prepare(`
      INSERT INTO mail_search_fts (
        rowid, account_terms, subject_terms, sender_terms,
        recipient_terms, body_terms, attachment_terms, summary_terms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      `acct${sha256Text(accountPublicId).slice(0, 16)}`,
      this.searchTerms(row.subject),
      this.searchTerms(row.sender_preview),
      this.searchTerms(row.recipient_preview),
      this.searchTerms(
        `${row.text_plain ?? ""} ${stripHtmlText(row.html_sanitized ?? "")}`.trim(),
      ),
      this.searchTerms(row.attachment_names ?? ""),
      this.searchTerms(row.summary_text ?? ""),
    );
    this.updateCjkSearchIndex(messageId, accountPublicId, row);
    this.db.prepare(`
      INSERT INTO mail_search_index_state (
        message_id, indexed_content_version, indexed_summary_version,
        indexed_at_ms, row_version
      ) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(message_id) DO UPDATE SET
        indexed_content_version = excluded.indexed_content_version,
        indexed_summary_version = excluded.indexed_summary_version,
        indexed_at_ms = excluded.indexed_at_ms,
        row_version = mail_search_index_state.row_version + 1
    `).run(
      messageId,
      row.content_version,
      row.summary_version ?? 0,
      Date.now(),
    );
  }

  private searchIndexRow(messageId: bigint): SearchIndexRow {
    return this.db.prepare(`
      SELECT messages.subject, messages.sender_preview, messages.recipient_preview,
             messages.content_version, content.text_plain, content.html_sanitized,
             GROUP_CONCAT(attachments.filename, ' ') AS attachment_names,
             current_artifact.text_value AS summary_text,
             current_artifact.source_version AS summary_version
      FROM mail_messages messages
      LEFT JOIN mail_message_content content ON content.message_id = messages.id
      LEFT JOIN mail_attachments attachments ON attachments.message_id = messages.id
      LEFT JOIN mail_message_ai_current current
        ON current.message_id = messages.id AND current.artifact_kind = 'summary'
      LEFT JOIN mail_ai_artifacts current_artifact ON current_artifact.id = current.artifact_id
      WHERE messages.id = ?
      GROUP BY messages.id
    `).get(messageId) as SearchIndexRow;
  }

  private updateCjkSearchIndex(
    messageId: bigint,
    accountPublicId: string,
    row = this.searchIndexRow(messageId),
  ): void {
    this.db.prepare("DELETE FROM mail_search_cjk_fts WHERE rowid = ?").run(messageId);
    this.db.prepare(`
      INSERT INTO mail_search_cjk_fts (
        rowid, account_terms, subject_terms, sender_terms,
        recipient_terms, body_terms, attachment_terms, summary_terms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      `acct${sha256Text(accountPublicId).slice(0, 16)}`,
      cjkSearchTerms(row.subject),
      cjkSearchTerms(row.sender_preview),
      cjkSearchTerms(row.recipient_preview),
      cjkSearchTerms(
        `${row.text_plain ?? ""} ${stripHtmlText(row.html_sanitized ?? "")}`.trim(),
      ),
      cjkSearchTerms(row.attachment_names ?? ""),
      cjkSearchTerms(row.summary_text ?? ""),
    );
  }

  private rebuildThread(threadId: bigint): void {
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS message_count,
             COALESCE(SUM(is_seen = 0), 0) AS unread_count,
             COALESCE(MAX(received_at_ms), 0) AS latest_received_at_ms
      FROM mail_messages WHERE thread_id = ? AND deleted_at_ms IS NULL
    `).get(threadId) as {
      message_count: bigint;
      unread_count: bigint;
      latest_received_at_ms: bigint;
    };
    this.db.prepare(`
      UPDATE mail_threads SET
        message_count = ?, unread_count = ?, latest_received_at_ms = ?,
        row_version = row_version + 1
      WHERE id = ?
    `).run(
      counts.message_count,
      counts.unread_count,
      counts.latest_received_at_ms,
      threadId,
    );
  }

  private recipientPreview(message: MailMessage): string {
    return [...message.to, ...message.cc]
      .map((address) => normalizeAddress(address.email))
      .filter(Boolean)
      .join(",");
  }

  private searchTerms(value: string): string {
    return value.normalize("NFKC").trim().toLowerCase();
  }

  private dedupeChanges(changes: MailDatabaseChange[]): MailDatabaseChange[] {
    const unique = new Map<string, MailDatabaseChange>();
    for (const change of changes) {
      unique.set(`${change.entityType}\0${change.entityPublicId}\0${change.operation}`, change);
    }
    return [...unique.values()].slice(0, 1_000);
  }

  private message(accountPublicId: string, messagePublicId: string): MessageRow | null {
    return (this.db.prepare(`
      SELECT messages.id, messages.public_id, messages.account_id,
             messages.primary_folder_id, messages.primary_instance_id,
             messages.received_at_ms, messages.has_attachments,
             messages.is_seen, messages.is_flagged, messages.deleted_at_ms
      FROM mail_messages messages
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      WHERE accounts.public_id = ? AND messages.public_id = ?
      LIMIT 1
    `).get(accountPublicId, messagePublicId) as MessageRow | undefined) ?? null;
  }

  /**
   * Resolve a move target by exact identity first, then by folder role.
   * Providers name special folders differently (Gmail's All Mail is the
   * archive, 已发送 is sent, …), so canonical ids like "archive" must fall
   * back to a role/name match to find the physical folder row — including
   * rows that predate role mapping ("[Gmail]/All Mail" stored as custom).
   */
  private resolveMoveTarget(accountPublicId: string, identity: string): FolderRow | null {
    const exact = this.folder(accountPublicId, identity);
    if (exact) return exact;
    const want = mapFolderRole(identity);
    const rows = this.db.prepare(`
      SELECT folders.id, folders.public_id, folders.remote_path
      FROM mail_folders folders
      JOIN mail_accounts accounts ON accounts.id = folders.account_id
      WHERE accounts.public_id = ? AND folders.deleted_at_ms IS NULL
    `).all(accountPublicId) as FolderRow[];
    for (const row of rows) {
      const role = mapFolderRole(row.remote_path);
      // Gmail archives into All Mail, which maps to role "all" not "archive".
      if (role === want || (want === "archive" && role === "all")) return row;
    }
    return null;
  }

  private folder(accountPublicId: string, identity: string): FolderRow | null {
    return (this.db.prepare(`
      SELECT folders.id, folders.public_id, folders.remote_path
      FROM mail_folders folders
      JOIN mail_accounts accounts ON accounts.id = folders.account_id
      WHERE accounts.public_id = ?
        AND (folders.public_id = ? OR folders.remote_path = ?)
        AND folders.deleted_at_ms IS NULL
      LIMIT 1
    `).get(accountPublicId, identity, identity) as FolderRow | undefined) ?? null;
  }

  private specialFolder(accountPublicId: string, role: string): FolderRow | null {
    return (this.db.prepare(`
      SELECT folders.id, folders.public_id, folders.remote_path
      FROM mail_folders folders
      JOIN mail_accounts accounts ON accounts.id = folders.account_id
      WHERE accounts.public_id = ? AND folders.role = ?
        AND folders.deleted_at_ms IS NULL
      ORDER BY folders.id
      LIMIT 1
    `).get(accountPublicId, role) as FolderRow | undefined) ?? null;
  }

  private folderById(id: bigint): FolderRow | null {
    return (this.db.prepare(`
      SELECT id, public_id, remote_path FROM mail_folders WHERE id = ?
    `).get(id) as FolderRow | undefined) ?? null;
  }

  private updateFlags(message: MessageRow, seen: boolean, flagged: boolean): void {
    const values = { seen: seen ? 1 : 0, flagged: flagged ? 1 : 0, messageId: message.id };
    this.db.prepare(`
      UPDATE mail_messages
      SET is_seen = @seen, is_flagged = @flagged, row_version = row_version + 1
      WHERE id = @messageId
    `).run(values);
    for (const table of [
      "mail_folder_memberships",
      "mail_message_system_categories",
      "mail_message_user_tags",
    ]) {
      this.db.prepare(`
        UPDATE ${table}
        SET is_seen = @seen, is_flagged = @flagged, row_version = row_version + 1
        WHERE message_id = @messageId
      `).run(values);
    }
  }

  private moveProjection(message: MessageRow, folder: FolderRow): void {
    if (message.primary_folder_id !== null) {
      this.db.prepare(`
        DELETE FROM mail_folder_memberships
        WHERE folder_id = ? AND message_id = ?
      `).run(message.primary_folder_id, message.id);
    }
    if (message.primary_instance_id === null) {
      throw new Error(`message-has-no-instance:${message.public_id}`);
    }
    this.db.prepare(`
      INSERT INTO mail_folder_memberships (
        folder_id, message_id, representative_instance_id, received_at_ms,
        is_seen, is_flagged, has_attachments, row_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(folder_id, message_id) DO UPDATE SET
        representative_instance_id = excluded.representative_instance_id,
        received_at_ms = excluded.received_at_ms,
        is_seen = excluded.is_seen,
        is_flagged = excluded.is_flagged,
        has_attachments = excluded.has_attachments,
        row_version = mail_folder_memberships.row_version + 1
    `).run(
      folder.id,
      message.id,
      message.primary_instance_id,
      message.received_at_ms,
      message.is_seen,
      message.is_flagged,
      message.has_attachments,
    );
    this.db.prepare(`
      UPDATE mail_messages
      SET primary_folder_id = ?, row_version = row_version + 1
      WHERE id = ?
    `).run(folder.id, message.id);
  }

  private deleteProjection(message: MessageRow, deletedAt: number): void {
    this.db.prepare(`
      UPDATE mail_messages
      SET deleted_at_ms = ?, row_version = row_version + 1 WHERE id = ?
    `).run(deletedAt, message.id);
    this.db.prepare("DELETE FROM mail_folder_memberships WHERE message_id = ?").run(message.id);
    this.db.prepare("DELETE FROM mail_message_system_categories WHERE message_id = ?").run(message.id);
    this.db.prepare("DELETE FROM mail_message_user_tags WHERE message_id = ?").run(message.id);
  }

  writeDirectory(input: DirectoryWriteParams): number {
    if (input.operation === "replaceSnapshot") throw new Error("directory-snapshot-requires-chunks");
    return this.directory.write(input);
  }

  leaseChannelWork(input: MailDatabaseChannelLeaseParams) {
    const params = MailDatabaseChannelLeaseParamsSchema.parse(input);
    return params.queue === "inbound"
      ? new ChannelInboundRepository(this.db).leaseNext(params.workerId, params.leaseMs)
      : new ChannelDeliveryRepository(this.db).leaseNext(params.workerId, params.leaseMs);
  }

  runRetentionBatch(params: DatabaseRetentionBatchParams): DatabaseRetentionBatchResult {
    return this.db.transaction(() => runDatabaseRetentionBatch(this.db, params)).immediate();
  }

  saveBusinessPreferences(patch: Partial<BusinessPreferences>): MailDatabaseWriteResult<BusinessPreferences> {
    const validated = BusinessPreferencesPatchSchema.parse(patch);
    return this.db.transaction(() => {
      const value = new BusinessPreferenceService(this.db).save(validated);
      const changes: MailDatabaseChange[] = [{ entityType: "setting", entityPublicId: "business-preferences", operation: "update" }];
      const commitVersion = this.recordCommit("business-preferences", changes, Date.now());
      return { value, changes, commitVersion };
    }).immediate();
  }

  private recordCommit(
    source: string,
    changes: MailDatabaseChange[],
    committedAt: number,
  ): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(version), 0) + 1 AS version FROM db_commits
    `).get() as { version: bigint };
    const version = Number(row.version);
    this.db.prepare(`
      INSERT INTO db_commits (version, committed_at_ms, source, change_count)
      VALUES (?, ?, ?, ?)
    `).run(version, committedAt, source, changes.length);
    const insertChange = this.db.prepare(`
      INSERT INTO db_changes (
        commit_version, ordinal, entity_type, entity_public_id, operation, scope_hint
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    changes.forEach((change, ordinal) => insertChange.run(
      version,
      ordinal,
      change.entityType,
      change.entityPublicId,
      change.operation,
      change.scopeHint ?? null,
    ));
    return version;
  }

  private materializeTagsArtifact(input: {
    accountId: bigint;
    messageId: bigint;
    artifactId: number | bigint;
    result: unknown;
  }): void {
    if (!input.result || typeof input.result !== "object") return;
    const result = input.result as Partial<TagResult>;
    if (result.type !== "tags" || !Array.isArray(result.tags)) return;
    const message = this.db.prepare(`
      SELECT received_at_ms, is_seen, is_flagged, has_attachments
      FROM mail_messages WHERE id = ? AND account_id = ?
    `).get(input.messageId, input.accountId) as {
      received_at_ms: bigint;
      is_seen: bigint;
      is_flagged: bigint;
      has_attachments: bigint;
    } | undefined;
    if (!message) return;

    this.db.prepare(`
      DELETE FROM mail_message_system_categories
      WHERE account_id = ? AND message_id = ?
    `).run(input.accountId, input.messageId);
    const insertCategory = this.db.prepare(`
      INSERT INTO mail_message_system_categories (
        account_id, category_id, message_id, received_at_ms, source, score,
        classifier_version, is_seen, is_flagged, has_attachments, row_version
      )
      SELECT ?, categories.id, ?, ?, 'ai', ?, ?, ?, ?, ?, 1
      FROM mail_system_categories categories WHERE categories.key = ?
    `);
    for (const key of SMART_CLASSIFICATION_IDS) {
      const signal = smartClassificationSignal(result as TagResult, key);
      if (!signal?.matched) continue;
      insertCategory.run(
        input.accountId,
        input.messageId,
        message.received_at_ms,
        signal.confidence,
        String((result as TagResult)._metadata?.version ?? "tags"),
        message.is_seen,
        message.is_flagged,
        message.has_attachments,
        key,
      );
    }

    // AI refresh must not remove the deterministic invoice subject membership.
    materializeInvoiceSubjectCategory(this.db, input.messageId);

    this.db.prepare(`
      DELETE FROM mail_message_user_tags
      WHERE account_id = ? AND message_id = ? AND source = 'ai'
    `).run(input.accountId, input.messageId);
    const now = Date.now();
    const upsertTag = this.db.prepare(`
      INSERT INTO mail_user_tags (
        public_id, account_id, name, name_norm, creation_source,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 'system', ?, ?)
      ON CONFLICT(account_id, name_norm) DO NOTHING
    `);
    const selectTag = this.db.prepare(`
      SELECT id FROM mail_user_tags
      WHERE account_id = ? AND name_norm = ? AND deleted_at_ms IS NULL
    `);
    const insertMembership = this.db.prepare(`
      INSERT INTO mail_message_user_tags (
        account_id, tag_id, message_id, received_at_ms, is_seen, is_flagged,
        has_attachments, source, confidence, source_artifact_id, row_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, 1)
      ON CONFLICT(account_id, tag_id, message_id) DO UPDATE SET
        received_at_ms = excluded.received_at_ms,
        is_seen = excluded.is_seen,
        is_flagged = excluded.is_flagged,
        has_attachments = excluded.has_attachments,
        source = CASE WHEN mail_message_user_tags.source = 'user' THEN 'user' ELSE 'ai' END,
        confidence = CASE WHEN mail_message_user_tags.source = 'user'
          THEN mail_message_user_tags.confidence ELSE excluded.confidence END,
        source_artifact_id = CASE WHEN mail_message_user_tags.source = 'user'
          THEN mail_message_user_tags.source_artifact_id ELSE excluded.source_artifact_id END,
        row_version = mail_message_user_tags.row_version + 1
    `);
    for (const tag of result.tags) {
      const name = typeof tag?.name === "string" ? tag.name.trim() : "";
      if (!name) continue;
      const normalized = name.normalize("NFKC").toLocaleLowerCase();
      upsertTag.run(randomUUID(), input.accountId, name, normalized, now, now);
      const row = selectTag.get(input.accountId, normalized) as { id: bigint } | undefined;
      if (!row) continue;
      insertMembership.run(
        input.accountId,
        row.id,
        input.messageId,
        message.received_at_ms,
        message.is_seen,
        message.is_flagged,
        message.has_attachments,
        Math.max(0, Math.min(1, Number(tag.confidence) || 0)),
        input.artifactId,
      );
    }
  }

  private enqueueIntelligenceJobsForReadyContent(input: {
    accountId: bigint;
    accountPublicId: string;
    messageId: bigint;
    messagePublicId: string;
    priority: 0 | 1 | 2 | 4;
    smartTagBackfillRunId?: string;
    reviveTerminal?: boolean;
    /**
     * Optional subset of the four AI kinds to enqueue. Default: all four.
     * Used by reconcile backfill to apply per-kind recovery.
     */
    kinds?: readonly ("ai.summary" | "ai.tags" | "ai.reply-decision" | "ai.todo")[];
  }): number {
    const content = this.db.prepare(`
      SELECT content_sha256, content_version
      FROM mail_message_content
      WHERE message_id = ? AND state = 'ready' AND content_sha256 IS NOT NULL
    `).get(input.messageId) as {
      content_sha256: string;
      content_version: bigint;
    } | undefined;
    if (!content) return 0;

    const now = Date.now();
    const allJobs = [
      { kind: "ai.summary", maxAttempts: maxAttemptsForMailJob("ai.summary") },
      { kind: "ai.tags", maxAttempts: maxAttemptsForMailJob("ai.tags") },
      {
        kind: "ai.reply-decision",
        maxAttempts: maxAttemptsForMailJob("ai.reply-decision"),
      },
      { kind: "ai.todo", maxAttempts: maxAttemptsForMailJob("ai.todo") },
    ] as const;
    const jobs = (input.kinds?.length
      ? allJobs.filter((job) => input.kinds!.includes(job.kind))
      : allJobs)
      .filter((job) => job.kind !== "ai.reply-decision" || this.replyDecisionEnabled);
    const makePayload = (job: (typeof allJobs)[number]) => ({
      accountId: input.accountPublicId,
      emailId: input.messagePublicId,
      contentSha256: content.content_sha256,
      contentVersion: Number(content.content_version),
      ...(job.kind === "ai.tags" && input.smartTagBackfillRunId
        ? { smartTagBackfillRunId: input.smartTagBackfillRunId }
        : {}),
    });
    const insert = this.db.prepare(`
      INSERT INTO mail_jobs (
        public_id, account_id, job_kind, subject_kind, subject_public_id,
        dedupe_key, payload_json, priority, state, attempt_count, max_attempts,
        available_at_ms, input_version, created_at_ms, updated_at_ms, row_version
      ) VALUES (?, ?, ?, 'message', ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(job_kind, dedupe_key, input_version) DO NOTHING
    `);
    if (input.reviveTerminal) {
      for (const job of jobs) {
        const dedupeKey = `${job.kind}:${input.messagePublicId}:${content.content_sha256}`;
        const existing = this.db.prepare(`
          SELECT state FROM mail_jobs
          WHERE job_kind = ? AND dedupe_key = ? AND input_version = ?
        `).get(job.kind, dedupeKey, Number(content.content_version)) as {
          state: string;
        } | undefined;
        const payload = JSON.stringify(makePayload(job));
        if (existing && ["cancelled", "failed", "terminal"].includes(existing.state)) {
          this.db.prepare(`
            UPDATE mail_jobs
            SET account_id = ?, payload_json = ?, priority = ?, state = 'pending',
                attempt_count = 0, max_attempts = ?, available_at_ms = ?,
                lease_owner = NULL, lease_expires_at_ms = NULL,
                last_error_code = NULL, updated_at_ms = ?, row_version = row_version + 1
            WHERE job_kind = ? AND dedupe_key = ? AND input_version = ?
          `).run(
            input.accountId,
            payload,
            input.priority,
            job.maxAttempts,
            now,
            now,
            job.kind,
            dedupeKey,
            Number(content.content_version),
          );
        } else if (!existing) {
          insert.run(
            randomUUID(),
            input.accountId,
            job.kind,
            input.messagePublicId,
            dedupeKey,
            payload,
            input.priority,
            job.maxAttempts,
            now,
            Number(content.content_version),
            now,
            now,
          );
        }
      }
      return jobs.length;
    }
    for (const job of jobs) {
      const dedupeKey = `${job.kind}:${input.messagePublicId}:${content.content_sha256}`;
      insert.run(
        randomUUID(),
        input.accountId,
        job.kind,
        input.messagePublicId,
        dedupeKey,
        JSON.stringify(makePayload(job)),
        input.priority,
        job.maxAttempts,
        now,
        Number(content.content_version),
        now,
        now,
      );
    }
    return jobs.length;
  }

  private recordSmartTagBackfillTerminal(
    runId: string,
    failed: boolean,
    error?: string,
  ): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE mail_smart_tag_backfill_runs
      SET processed_count = processed_count + ?,
          failed_count = failed_count + ?,
          error_code = COALESCE(error_code, ?),
          updated_at_ms = ?
      WHERE public_id = ? AND state = 'running'
    `).run(failed ? 0 : 1, failed ? 1 : 0, error ?? null, now, runId);
    this.db.prepare(`
      UPDATE mail_smart_tag_backfill_runs
      SET state = 'completed', completed_at_ms = ?, updated_at_ms = ?
      WHERE public_id = ? AND state = 'running'
        AND processed_count + failed_count >= queued_count
    `).run(now, now, runId);
  }

  private persistSyncCursors(
    accountId: bigint,
    messages: readonly MailMessage[],
    origin: MailDatabasePersistMetadataParams["origin"],
  ): void {
    const cursors = new Map<string, MailMessage>();
    for (const message of messages) {
      const current = cursors.get(message.folder);
      if (!current || message.sync.uid > current.sync.uid) cursors.set(message.folder, message);
    }
    const now = Date.now();
    for (const [folderPath, message] of cursors) {
      const folder = this.db.prepare(`
        SELECT id FROM mail_folders WHERE account_id = ? AND remote_path = ?
      `).get(accountId, folderPath) as { id: bigint } | undefined;
      if (!folder) continue;
      const previous = this.db.prepare(`
        SELECT cursor_json FROM mail_folder_sync_state WHERE folder_id = ?
      `).get(folder.id) as { cursor_json: string | null } | undefined;
      let previousUid = -1;
      let previousUidValidity = message.sync.uidValidity;
      if (previous?.cursor_json) {
        try {
          const parsed = JSON.parse(previous.cursor_json) as {
            uid?: unknown;
            uidValidity?: unknown;
          };
          if (typeof parsed.uid === "number") previousUid = parsed.uid;
          if (typeof parsed.uidValidity === "number") previousUidValidity = parsed.uidValidity;
        } catch {
          previousUid = -1;
        }
      }
      const cursor = previousUidValidity === message.sync.uidValidity && previousUid > message.sync.uid
        ? previous!.cursor_json
        : JSON.stringify({
            uid: message.sync.uid,
            uidValidity: message.sync.uidValidity,
            internalDate: message.sync.internalDate,
          });
      this.db.prepare(`
        INSERT INTO mail_folder_sync_state (
          folder_id, phase, cursor_json, last_success_at_ms,
          last_error_code, retry_at_ms, row_version
        ) VALUES (?, ?, ?, ?, NULL, NULL, 1)
        ON CONFLICT(folder_id) DO UPDATE SET
          phase = excluded.phase,
          cursor_json = excluded.cursor_json,
          last_success_at_ms = excluded.last_success_at_ms,
          last_error_code = NULL,
          retry_at_ms = NULL,
          row_version = mail_folder_sync_state.row_version + 1
      `).run(folder.id, origin, cursor, now);
    }
  }

  private replaceRecipients(
    table: "mail_draft_recipients" | "mail_outbox_recipients",
    ownerColumn: "draft_id" | "outbox_id",
    ownerId: number | bigint,
    input: { to?: WemailAddress[]; cc?: WemailAddress[]; bcc?: WemailAddress[] },
  ): void {
    this.db.prepare(`DELETE FROM ${table} WHERE ${ownerColumn} = ?`).run(ownerId);
    const insert = this.db.prepare(`
      INSERT INTO ${table} (
        ${ownerColumn}, kind, ordinal, address_norm, address_display, name_display
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const kind of ["to", "cc", "bcc"] as const) {
      const recipients = input[kind] ?? [];
      recipients.forEach((address, ordinal) => insert.run(
        ownerId,
        kind,
        ordinal,
        normalizeAddress(address.email),
        address.email.trim(),
        address.name?.trim() || null,
      ));
    }
  }

  private draftRecord(publicId: string): MailDraftRecord {
    const row = this.db.prepare(`
      SELECT drafts.id, drafts.public_id, accounts.public_id AS account_public_id,
        original.public_id AS original_public_id, drafts.subject,
        drafts.body_text, drafts.body_html, drafts.created_at_ms, drafts.updated_at_ms
      FROM mail_drafts drafts
      JOIN mail_accounts accounts ON accounts.id = drafts.account_id
      LEFT JOIN mail_messages original ON original.id = drafts.reply_to_message_id
      WHERE drafts.public_id = ?
    `).get(publicId) as {
      id: bigint;
      public_id: string;
      account_public_id: string;
      original_public_id: string | null;
      subject: string;
      body_text: string | null;
      body_html: string | null;
      created_at_ms: bigint;
      updated_at_ms: bigint;
    } | undefined;
    if (!row) throw new Error(`draft-not-found:${publicId}`);
    const recipients = this.recipients("mail_draft_recipients", "draft_id", row.id);
    return {
      id: row.public_id,
      accountId: row.account_public_id,
      ...(row.original_public_id ? { originalEmailId: row.original_public_id } : {}),
      type: row.original_public_id ? "reply" : "new",
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject: row.subject,
      bodyText: row.body_text ?? "",
      bodyHtml: row.body_html ?? "",
      attachments: [],
      status: "draft",
      createdAt: new Date(Number(row.created_at_ms)).toISOString(),
      updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    };
  }

  resetBodyFailure(
    accountId: string,
    emailId: string,
  ): MailDatabaseWriteResult<boolean> {
    const transaction = this.db.transaction(() => {
      const message = this.message(accountId, emailId);
      if (!message) throw new Error(`message-not-found:${emailId}`);
      const updated = this.db.prepare(`
        UPDATE mail_message_content SET state = 'queued', retry_at_ms = NULL,
          retry_count = 0, retryable = 1, error_code = NULL,
          row_version = row_version + 1
        WHERE message_id = ? AND state <> 'ready'
      `).run(message.id);
      if (updated.changes === 0) {
        return { value: false, commitVersion: this.commitVersion(), changes: [] };
      }
      const changes: MailDatabaseChange[] = [{
        entityType: "content",
        entityPublicId: message.public_id,
        operation: "update",
        scopeHint: `account:${accountId}`,
      }];
      const commitVersion = this.recordCommit("body-explicit-retry", changes, Date.now());
      return { value: true, commitVersion, changes };
    });
    return transaction.immediate();
  }

  setSnooze(input: MailDatabaseSetSnoozeParams): MailDatabaseWriteResult<MailMessage | null> {
    const transaction = this.db.transaction(() => {
      const message = this.message(input.accountId, input.emailId);
      if (!message || message.deleted_at_ms !== null) {
        return { value: null, commitVersion: this.commitVersion(), changes: [] };
      }
      const untilMs = input.until ? parseTimestampMs(input.until, Number.NaN) : null;
      if (untilMs !== null && (!Number.isFinite(untilMs) || untilMs <= Date.now())) {
        throw new Error("invalid-snooze-until");
      }
      this.db.prepare(`
        UPDATE mail_messages
        SET snoozed_until_ms = ?, row_version = row_version + 1
        WHERE id = ?
      `).run(untilMs, message.id);
      const changes: MailDatabaseChange[] = [{
        entityType: "message",
        entityPublicId: message.public_id,
        operation: "update",
        scopeHint: `account:${input.accountId}`,
      }];
      return {
        value: this.queries.getSnapshot(input.emailId).message,
        commitVersion: this.recordCommit("mail-snooze", changes, Date.now()),
        changes,
      };
    });
    return transaction.immediate();
  }

  private outboxRecipients(ownerId: bigint): Record<"to" | "cc" | "bcc", WemailAddress[]> {
    return this.recipients("mail_outbox_recipients", "outbox_id", ownerId);
  }

  private recipients(
    table: "mail_draft_recipients" | "mail_outbox_recipients",
    ownerColumn: "draft_id" | "outbox_id",
    ownerId: bigint,
  ): Record<"to" | "cc" | "bcc", WemailAddress[]> {
    const result: Record<"to" | "cc" | "bcc", WemailAddress[]> = {
      to: [],
      cc: [],
      bcc: [],
    };
    const rows = this.db.prepare(`
      SELECT kind, address_display, name_display FROM ${table}
      WHERE ${ownerColumn} = ? ORDER BY kind, ordinal
    `).all(ownerId) as Array<{
      kind: "to" | "cc" | "bcc";
      address_display: string;
      name_display: string | null;
    }>;
    for (const row of rows) {
      result[row.kind].push({
        email: row.address_display,
        ...(row.name_display ? { name: row.name_display } : {}),
      });
    }
    return result;
  }

  private accountRow(publicId: string): { id: bigint } {
    const account = this.db.prepare(
      "SELECT id FROM mail_accounts WHERE public_id = ? AND state = 'active'",
    ).get(publicId) as { id: bigint } | undefined;
    if (!account) throw new Error(`mail-account-not-found:${publicId}`);
    return account;
  }

  private jobById(id: number | bigint): MailDatabaseJob {
    const row = this.db.prepare(`
      SELECT jobs.id, jobs.job_kind, accounts.public_id AS account_public_id,
             jobs.payload_json, jobs.priority, jobs.attempt_count,
             jobs.max_attempts, jobs.available_at_ms, jobs.lease_owner,
             jobs.lease_expires_at_ms, jobs.dedupe_key
      FROM mail_jobs jobs
      JOIN mail_accounts accounts ON accounts.id = jobs.account_id
      WHERE jobs.id = ?
    `).get(id) as {
      id: bigint;
      job_kind: string;
      account_public_id: string;
      payload_json: string;
      priority: bigint;
      attempt_count: bigint;
      max_attempts: bigint;
      available_at_ms: bigint;
      lease_owner: string | null;
      lease_expires_at_ms: bigint | null;
      dedupe_key: string;
    } | undefined;
    if (!row) throw new Error(`mail-job-not-found:${String(id)}`);
    return {
      id: Number(row.id),
      kind: row.job_kind,
      accountId: row.account_public_id,
      payload: JSON.parse(row.payload_json) as unknown,
      priority: Number(row.priority) as MailDatabaseJob["priority"],
      attempts: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      availableAt: new Date(Number(row.available_at_ms)).toISOString(),
      leaseOwner: row.lease_owner,
      leaseUntil: row.lease_expires_at_ms === null
        ? null
        : new Date(Number(row.lease_expires_at_ms)).toISOString(),
      idempotencyKey: row.dedupe_key,
    };
  }

  private folderChange(folder: FolderRow): MailDatabaseChange {
    return {
      entityType: "folder",
      entityPublicId: folder.public_id,
      operation: "update",
      scopeHint: `folder:${folder.remote_path}`,
    };
  }

  private mutationResult(
    messagePublicId: string,
    mutationId: number,
    deleted = false,
  ): MailCoreMutationResult {
    return {
      status: "applied",
      message: deleted ? null : this.queries.getSnapshot(messagePublicId).message,
      deleted,
      outboxId: mutationId,
    };
  }
}
