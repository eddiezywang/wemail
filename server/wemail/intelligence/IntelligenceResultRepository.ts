import {
  INTELLIGENCE_ATTRIBUTE_KINDS,
  SMART_CLASSIFICATION_IDS,
  SMART_CLASSIFICATION_LABELS,
  SMART_CLASSIFICATION_SET,
  type InboxCategory,
  type IntelligenceAttributeKind,
  type IntelligenceAttributeStatus,
  type IntelligenceJobType,
  type IntelligenceResult,
  type SummaryHealthItem,
  type SummaryHealthStatus,
  type SummaryRetryMode,
  type SummaryWorkState,
  type TagResult,
} from "../../../shared/wemail/intelligence.js";
import type { ListCategory } from "../../../shared/wemail/usage.js";
import type { MailDatabase } from "../database/Database.js";

export interface EmailIntelligenceResults {
  summary?: IntelligenceResult;
  tags?: IntelligenceResult;
  replyDecision?: IntelligenceResult;
  replyDraft?: IntelligenceResult;
  todoExtraction?: IntelligenceResult;
  linkExtraction?: IntelligenceResult;
  translation?: IntelligenceResult;
  composeMail?: IntelligenceResult;
}

export interface SummaryHealthScope {
  accountId: string;
  folder?: string;
  query?: string;
  states?: SummaryWorkState[];
  emailIds?: string[];
  limit?: number;
  offset?: number;
  pageOnly?: boolean;
}

export interface SummaryRetryCandidate {
  emailId: string;
  accountId: string;
  state: SummaryWorkState;
}

interface ArtifactRow {
  email_id: string;
  artifact_kind: string;
  json_value: string | null;
}

interface AttributeArtifactRow {
  email_id: string;
  artifact_kind: string;
  json_value: string | null;
}

interface AttributeJobRow {
  email_id: string;
  job_kind: string;
  job_id: string;
  job_state: string | null;
  job_attempt_count: number | null;
  job_max_attempts: number | null;
  job_created_at_ms: bigint | null;
  job_updated_at_ms: bigint | null;
  last_error_code: string | null;
}

/**
 * SQL state predicates for retry candidate selection, mirroring summaryItem's
 * state derivation but pushed into the query so the DB filters instead of the
 * application scanning the whole table. `invalid` is best-effort (json shape).
 */
const RETRY_STATE_FILTERS: Record<"missing" | "failed" | "invalid" | "succeeded", string> = {
  // missing: never touched — no summary artifact, no summary job.
  missing: "artifact.id IS NULL AND jobs.id IS NULL",
  // failed: no artifact, job exhausted (terminal/failed, or pending at max attempts).
  failed:
    "artifact.id IS NULL AND jobs.id IS NOT NULL AND (" +
    "jobs.state IN ('failed','terminal') OR " +
    "(jobs.state = 'pending' AND jobs.attempt_count >= jobs.max_attempts))",
  // invalid: artifact present but not a completed summary with content.
  invalid:
    "artifact.id IS NOT NULL AND (" +
    "NOT json_valid(artifact.json_value) OR (" +
    "json_extract(artifact.json_value, '$._status') IS NOT 'completed' AND " +
    "COALESCE(json_array_length(json_extract(artifact.json_value, '$.bullets')), 0) = 0 AND " +
    "COALESCE(json_array_length(json_extract(artifact.json_value, '$.actionItems')), 0) = 0 AND " +
    "(json_extract(artifact.json_value, '$.headline') IS NULL OR trim(json_extract(artifact.json_value, '$.headline')) = '')" +
    "))",
  succeeded:
    "artifact.id IS NOT NULL AND json_valid(artifact.json_value) AND (" +
    "json_extract(artifact.json_value, '$._status') = 'completed' OR " +
    "COALESCE(json_array_length(json_extract(artifact.json_value, '$.bullets')), 0) > 0 OR " +
    "COALESCE(json_array_length(json_extract(artifact.json_value, '$.actionItems')), 0) > 0 OR " +
    "(json_extract(artifact.json_value, '$.headline') IS NOT NULL AND trim(json_extract(artifact.json_value, '$.headline')) <> '')" +
    ")",
};

/** Shared FROM/JOIN for summary-health queries. */
const SUMMARY_FROM_JOIN = `
  FROM mail_messages messages
  JOIN mail_accounts accounts ON accounts.id = messages.account_id
  LEFT JOIN mail_folders folders ON folders.id = messages.primary_folder_id
  LEFT JOIN mail_message_ai_current current_artifact
    ON current_artifact.message_id = messages.id
   AND current_artifact.artifact_kind = 'summary'
  LEFT JOIN mail_ai_artifacts artifact ON artifact.id = current_artifact.artifact_id
  LEFT JOIN mail_jobs jobs ON jobs.id = (
    SELECT candidate.id FROM mail_jobs candidate
    WHERE candidate.subject_kind = 'message'
      AND candidate.subject_public_id = messages.public_id
      AND candidate.job_kind = 'ai.summary'
    ORDER BY candidate.input_version DESC, candidate.id DESC LIMIT 1
  )`;

/**
 * SQL state expression mirroring summaryItem's derivation, so state counts can
 * be aggregated in the DB (GROUP BY state) instead of loading every row.
 */
const SUMMARY_STATE_EXPRESSION = `CASE
  WHEN artifact.id IS NOT NULL AND json_valid(artifact.json_value) AND (
    json_extract(artifact.json_value, '$._status') = 'completed'
    OR COALESCE(json_array_length(json_extract(artifact.json_value, '$.bullets')), 0) > 0
    OR COALESCE(json_array_length(json_extract(artifact.json_value, '$.actionItems')), 0) > 0
    OR (json_extract(artifact.json_value, '$.headline') IS NOT NULL AND trim(json_extract(artifact.json_value, '$.headline')) <> '')
  ) THEN 'succeeded'
  WHEN artifact.id IS NOT NULL THEN 'invalid'
  WHEN jobs.state = 'leased' THEN 'running'
  WHEN jobs.state = 'pending' AND jobs.attempt_count >= jobs.max_attempts THEN 'failed'
  WHEN jobs.state = 'pending' THEN 'pending'
  WHEN jobs.state IN ('failed', 'terminal') THEN 'failed'
  WHEN jobs.state = 'cancelled' THEN 'skipped'
  ELSE 'missing'
END`;

interface SummaryRow {
  email_id: string;
  account_id: string;
  subject: string;
  sender: string;
  received_at_ms: bigint;
  artifact_json: string | null;
  job_id: string | null;
  job_state: string | null;
  job_attempt_count: number | null;
  job_max_attempts: number | null;
  job_available_at_ms: bigint | null;
  job_created_at_ms: bigint | null;
  job_updated_at_ms: bigint | null;
  last_error_code: string | null;
}

/**
 * Read-only adapter over canonical, content-bound AI artifacts.
 *
 * All production writes are owned by MailDatabaseWriter through DB Service.
 * The former direct intelligence writer was deliberately removed; callers
 * that still attempt it fail loudly so a second authority cannot reappear.
 */
export class IntelligenceResultRepository {
  constructor(
    private readonly db: MailDatabase,
    _now?: () => string,
  ) {}

  saveResult(_emailId: string, _result: IntelligenceResult, _model?: string): void {
    throw new Error("canonical-intelligence-writes-require-db-service");
  }

  saveSkipped(
    _emailId: string,
    _processor: IntelligenceJobType,
    _reason: string,
    _matchedRule?: string,
  ): void {
    throw new Error("canonical-intelligence-writes-require-db-service");
  }

  findByEmailId(emailId: string): EmailIntelligenceResults {
    return this.rowsForEmailIds([emailId]).get(emailId) ?? {};
  }

  findByEmailIds(emailIds: string[]): Map<string, EmailIntelligenceResults> {
    if (emailIds.length === 0) return new Map();
    return this.rowsForEmailIds(emailIds);
  }

  getTagDefinitionFingerprint(emailId: string): string | null {
    const tags = this.findByEmailId(emailId).tags as (TagResult & {
      _metadata?: { tagDefinitionFingerprint?: unknown };
    }) | undefined;
    const value = tags?._metadata?.tagDefinitionFingerprint;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  hasFreshTagResult(emailId: string, tagDefinitionFingerprint: string): boolean {
    return this.getTagDefinitionFingerprint(emailId) === tagDefinitionFingerprint;
  }

  getSummaryHealth(input: SummaryHealthScope): SummaryHealthStatus {
    if (input.pageOnly) return this.getSummaryHealthPage(input);

    // Common path (no state filter): counts via SQL GROUP BY + a small page
    // query, so the 15s poll doesn't load the whole account into JS.
    if (!input.states?.length) {
      const counts = this.countSummaryStatesSafe(input);
      const count = (s: SummaryWorkState) => counts.get(s) ?? 0;
      const total = [...counts.values()].reduce((n, c) => n + c, 0);
      const offset = Math.max(0, input.offset ?? 0);
      const limit = Math.max(1, input.limit ?? 1);
      const pageRows = this.summaryRows(input, { limit: limit + 1, offset });
      const pageItems = pageRows.slice(0, limit).map((row) => this.summaryItem(row));
      const attributesByEmail = this.attributeRows(pageItems.map((item) => item.emailId));
      const page = pageItems.map((item) => ({
        ...item,
        ...(attributesByEmail.size > 0 ? { attributes: attributesByEmail.get(item.emailId) } : {}),
      }));
      const hasMore = pageRows.length > limit;
      return {
        total,
        succeeded: count("succeeded"),
        failed: count("failed"),
        missing: count("missing"),
        invalid: count("invalid"),
        pending: count("pending"),
        running: count("running"),
        skipped: count("skipped"),
        retryable: count("failed") + count("missing") + count("invalid"),
        items: page,
        hasMore,
        ...(hasMore ? { nextOffset: offset + page.length } : {}),
      };
    }

    // State-filtered aggregate (not used by the panel): preserve prior semantics.
    const rows = this.summaryRows(input);
    let items = rows.map((row) => this.summaryItem(row));
    const allowed = new Set<SummaryWorkState>(input.states);
    items = items.filter((item) => allowed.has(item.state));
    const count = (state: SummaryWorkState) => items.filter((item) => item.state === state).length;
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.max(1, input.limit ?? items.length);
    const pageItems = items.slice(offset, offset + limit);
    const attributesByEmail = this.attributeRows(pageItems.map((item) => item.emailId));
    const page = pageItems.map((item) => ({
      ...item,
      ...(attributesByEmail.size > 0 ? { attributes: attributesByEmail.get(item.emailId) } : {}),
    }));
    const nextOffset = offset + page.length;
    return {
      total: items.length,
      succeeded: count("succeeded"),
      failed: count("failed"),
      missing: count("missing"),
      invalid: count("invalid"),
      pending: count("pending"),
      running: count("running"),
      skipped: count("skipped"),
      retryable: items.filter((item) => ["failed", "missing", "invalid"].includes(item.state)).length,
      items: page,
      hasMore: nextOffset < items.length,
      ...(nextOffset < items.length ? { nextOffset } : {}),
    };
  }

  private getSummaryHealthPage(input: SummaryHealthScope): SummaryHealthStatus {
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.max(1, input.limit ?? 20);
    const allowed = input.states?.length
      ? new Set<SummaryWorkState>(input.states)
      : null;
    const matches: SummaryHealthItem[] = [];
    let matched = 0;
    let scanOffset = 0;

    // ponytail: filtered offsets scan in 500-row chunks; replace with a SQL
    // state expression only if deep-page latency becomes measurable.
    while (matches.length <= limit) {
      const rows = this.summaryRows(input, { limit: 500, offset: scanOffset });
      if (rows.length === 0) break;
      scanOffset += rows.length;
      for (const row of rows) {
        const item = this.summaryItem(row);
        if (allowed && !allowed.has(item.state)) continue;
        if (matched++ < offset) continue;
        matches.push(item);
        if (matches.length > limit) break;
      }
      if (matches.length > limit || rows.length < 500) break;
    }

    const hasMore = matches.length > limit;
    const pageItems = matches.slice(0, limit);
    const attributesByEmail = this.attributeRows(pageItems.map((item) => item.emailId));
    const items = pageItems.map((item) => ({
      ...item,
      ...(attributesByEmail.size > 0
        ? { attributes: attributesByEmail.get(item.emailId) }
        : {}),
    }));
    const count = (state: SummaryWorkState) =>
      pageItems.filter((item) => item.state === state).length;
    const nextOffset = offset + items.length;
    return {
      total: nextOffset + (hasMore ? 1 : 0),
      succeeded: count("succeeded"),
      failed: count("failed"),
      missing: count("missing"),
      invalid: count("invalid"),
      pending: count("pending"),
      running: count("running"),
      skipped: count("skipped"),
      retryable: pageItems.filter((item) =>
        ["failed", "missing", "invalid"].includes(item.state)
      ).length,
      items,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
    };
  }

  listSummaryRetryCandidates(
    input: SummaryHealthScope & {
      mode?: SummaryRetryMode;
      /**
       * Attributes to retry. Defaults to summary-only; when a non-summary
       * attribute is requested the candidate filter follows THAT attribute's
       * state, not the summary's (a succeeded summary must not block
       * retrying a failed tags/replyDecision/todo task).
       */
      kinds?: IntelligenceAttributeKind[];
      /** Explicit maintenance refresh; successful summaries are excluded by default. */
      includeSucceeded?: boolean;
      /** Max candidates to return. Defaults to 500, clamped to [1, 2000]. */
      limit?: number;
    },
  ): SummaryRetryCandidate[] {
    const mode = input.mode ?? "all";
    const kinds = input.kinds?.length ? input.kinds : ["summary"];
    const cap = Math.min(Math.max(1, input.limit ?? 500), 2000);
    const summaryOnly = kinds.length === 1 && kinds[0] === "summary";

    // SQL filters by state — no full-table scan. For "all" we query missing
    // first (never-tried always wins a slot), then failed, then invalid, so
    // repeatedly-failed items never crowd out new mail. Each query is LIMIT +
    // newest-first; the candidate's state is known from which query produced it.
    if (summaryOnly) {
      const scopes: Array<"missing" | "failed" | "invalid" | "succeeded"> =
        mode === "missing" ? ["missing"]
        : mode === "failed" ? ["failed"]
        : input.includeSucceeded
          ? ["missing", "failed", "invalid", "succeeded"]
          : ["missing", "failed", "invalid"];
      const out: SummaryRetryCandidate[] = [];
      for (const state of scopes) {
        if (out.length >= cap) break;
        const rows = this.summaryRows(input, {
          limit: cap - out.length,
          retryStateFilter: state,
        });
        for (const row of rows) {
          out.push({ emailId: row.email_id, accountId: row.account_id, state });
        }
      }
      return out;
    }

    // Attribute-scoped path (tags/replyDecision/todo): always per-email —
    // retryAttribute passes emailIds — so query those emails directly. No
    // pagination loop: the input set is already the answer set. State lives on
    // the attribute, classified in JS.
    const want = new Set(kinds);
    const allowed = new Set<SummaryWorkState>(
      mode === "failed" ? ["failed"]
      : mode === "missing" ? ["missing"]
      : ["failed", "missing", "invalid"],
    );
    const rows = this.summaryRows(input);
    const attributesByEmail = this.attributeRows(rows.map((row) => row.email_id));
    const out: SummaryRetryCandidate[] = [];
    for (const row of rows) {
      const retryable = (attributesByEmail.get(row.email_id) ?? []).find(
        (attribute) => want.has(attribute.kind) && allowed.has(attribute.state),
      );
      if (!retryable) continue;
      out.push({ emailId: row.email_id, accountId: row.account_id, state: retryable.state });
    }
    return out;
  }

  listDynamicTagCategories(input: {
    accountId: string;
    limit?: number;
    recentLimit?: number;
  }): ListCategory[] {
    const limit = Math.min(200, Math.max(1, input.limit ?? 5));
    return (this.db.prepare(`
      SELECT tags.name, counts.total_count
      FROM mail_user_tags tags
      JOIN mail_accounts accounts ON accounts.id = tags.account_id
      LEFT JOIN mail_tag_counts counts
        ON counts.account_id = tags.account_id AND counts.tag_id = tags.id
      WHERE accounts.public_id = ? AND tags.deleted_at_ms IS NULL
        AND COALESCE(counts.total_count, 0) > 0
      ORDER BY counts.total_count DESC, tags.name_norm ASC
      LIMIT ?
    `).all(input.accountId, limit) as Array<{ name: string; total_count: bigint }>).map((row) => ({
      id: row.name,
      label: row.name,
      count: Number(row.total_count),
    }));
  }

  messageHasTag(emailId: string, tagName: string): boolean {
    return this.db.prepare(`
      SELECT 1
      FROM mail_messages messages
      JOIN mail_message_user_tags memberships ON memberships.message_id = messages.id
      JOIN mail_user_tags tags ON tags.id = memberships.tag_id
      WHERE messages.public_id = ? AND tags.name_norm = ? AND tags.deleted_at_ms IS NULL
      LIMIT 1
    `).get(emailId, this.normalizeTag(tagName)) !== undefined;
  }

  addUserTagToMessage(_emailId: string, _tagName: string): boolean {
    throw new Error("canonical-tag-writes-require-db-service");
  }

  upsertAiTagToMessage(_emailId: string, _tagName: string, _confidence: number): boolean {
    throw new Error("canonical-tag-writes-require-db-service");
  }

  removeTagFromMessage(_emailId: string, _tagName: string): boolean {
    throw new Error("canonical-tag-writes-require-db-service");
  }

  removeTagFromAccount(_accountId: string, _tagName: string): number {
    throw new Error("canonical-tag-writes-require-db-service");
  }

  listAllTagNamesByAccount(accountId: string, limit = 200): string[] {
    return (this.db.prepare(`
      SELECT tags.name
      FROM mail_user_tags tags
      JOIN mail_accounts accounts ON accounts.id = tags.account_id
      WHERE accounts.public_id = ? AND tags.deleted_at_ms IS NULL
      ORDER BY tags.updated_at_ms DESC, tags.id DESC
      LIMIT ?
    `).all(accountId, Math.min(500, Math.max(1, limit))) as Array<{ name: string }>).map(
      (row) => row.name,
    );
  }

  listCategories(input: { accountId: string; dynamicLimit?: number }): InboxCategory[] {
    return (this.db.prepare(`
      SELECT categories.key, categories.display_name,
             COALESCE(counts.total_count, 0) AS total_count,
             COALESCE(counts.unread_count, 0) AS unread_count
      FROM mail_system_categories categories
      JOIN mail_accounts accounts ON accounts.public_id = ?
      LEFT JOIN mail_category_counts counts
        ON counts.account_id = accounts.id AND counts.category_id = categories.id
      WHERE categories.is_enabled = 1
      ORDER BY categories.sort_order, categories.id
    `).all(input.accountId) as Array<{
      key: string;
      display_name: string;
      total_count: bigint;
      unread_count: bigint;
    }>).map((row) => ({
      id: row.key,
      label: SMART_CLASSIFICATION_SET.has(row.key)
        ? SMART_CLASSIFICATION_LABELS[row.key as (typeof SMART_CLASSIFICATION_IDS)[number]]
        : row.display_name,
      count: Number(row.total_count),
      unreadCount: Number(row.unread_count),
      system: true,
    }));
  }

  messageHasCategory(emailId: string, categoryId: string): boolean {
    if (!SMART_CLASSIFICATION_SET.has(categoryId)) return false;
    return this.db.prepare(`
      SELECT 1
      FROM mail_messages messages
      JOIN mail_message_system_categories memberships ON memberships.message_id = messages.id
      JOIN mail_system_categories categories ON categories.id = memberships.category_id
      WHERE messages.public_id = ? AND categories.key = ?
      LIMIT 1
    `).get(emailId, categoryId) !== undefined;
  }

  listReplyRequired(
    accountId: string,
    options?: { level?: "low" | "normal" | "high"; limit?: number },
  ): Array<{
    emailId: string;
    priorityScore: number;
    level: "low" | "normal" | "high";
    deadline?: string;
  }> {
    const limit = Math.min(100, Math.max(1, options?.limit ?? 50));
    const rows = this.db.prepare(`
      SELECT messages.public_id, artifact.json_value
      FROM mail_messages messages
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      JOIN mail_message_ai_current current_artifact
        ON current_artifact.message_id = messages.id
       AND current_artifact.artifact_kind = 'replyDecision'
      JOIN mail_ai_artifacts artifact ON artifact.id = current_artifact.artifact_id
      WHERE accounts.public_id = ? AND messages.deleted_at_ms IS NULL
        AND artifact.state = 'ready'
      ORDER BY messages.received_at_ms DESC, messages.id DESC
      LIMIT 500
    `).all(accountId) as Array<{ public_id: string; json_value: string | null }>;
    return rows.flatMap((row) => {
      const result = this.parseResult(row.json_value);
      if (!result || result.type !== "replyDecision" || !result.replyRequired) return [];
      if (options?.level && result.level !== options.level) return [];
      return [{
        emailId: row.public_id,
        priorityScore: result.priorityScore,
        level: result.level,
        ...(result.deadline ? { deadline: result.deadline } : {}),
      }];
    }).sort((left, right) => right.priorityScore - left.priorityScore).slice(0, limit);
  }

  private rowsForEmailIds(
    emailIds: string[],
  ): Map<string, EmailIntelligenceResults> {
    const placeholders = emailIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT messages.public_id AS email_id, current_artifact.artifact_kind,
             artifact.json_value
      FROM mail_messages messages
      JOIN mail_message_ai_current current_artifact ON current_artifact.message_id = messages.id
      JOIN mail_ai_artifacts artifact ON artifact.id = current_artifact.artifact_id
      WHERE messages.public_id IN (${placeholders}) AND artifact.state = 'ready'
    `).all(...emailIds) as ArtifactRow[];
    const output = new Map<string, EmailIntelligenceResults>();
    for (const row of rows) {
      const result = this.parseResult(row.json_value);
      if (!result) continue;
      const current = output.get(row.email_id) ?? {};
      if (row.artifact_kind === "summary") current.summary = result;
      else if (row.artifact_kind === "tags") current.tags = result;
      else if (row.artifact_kind === "replyDecision") current.replyDecision = result;
      else if (row.artifact_kind === "replyDraft") current.replyDraft = result;
      else if (row.artifact_kind === "todoExtraction") current.todoExtraction = result;
      else if (row.artifact_kind === "linkExtraction") current.linkExtraction = result;
      else if (row.artifact_kind === "translation") current.translation = result;
      else if (row.artifact_kind === "composeMail") current.composeMail = result;
      output.set(row.email_id, current);
    }
    return output;
  }

  private summaryRows(
    input: SummaryHealthScope,
    opts?: { limit?: number; offset?: number; retryStateFilter?: "missing" | "failed" | "invalid" | "succeeded" },
  ): SummaryRow[] {
    const { clauses, params } = this.buildSummaryClauses(input);
    if (opts?.retryStateFilter) {
      clauses.push(RETRY_STATE_FILTERS[opts.retryStateFilter]);
    }
    const pagination =
      opts?.limit != null
        ? ` LIMIT ${Math.max(1, Math.min(500, opts.limit))} OFFSET ${Math.max(0, opts.offset ?? 0)}`
        : '';
    return this.db.prepare(`
      SELECT messages.public_id AS email_id, accounts.public_id AS account_id,
             messages.subject, messages.sender_preview AS sender,
             messages.received_at_ms, artifact.json_value AS artifact_json,
             jobs.public_id AS job_id, jobs.state AS job_state,
             jobs.attempt_count AS job_attempt_count,
             jobs.max_attempts AS job_max_attempts,
             jobs.available_at_ms AS job_available_at_ms,
             jobs.created_at_ms AS job_created_at_ms,
             jobs.updated_at_ms AS job_updated_at_ms,
             jobs.last_error_code
      ${SUMMARY_FROM_JOIN}
      WHERE ${clauses.join(" AND ")}
      ORDER BY messages.received_at_ms DESC, messages.id DESC${pagination}
    `).all(params) as SummaryRow[];
  }

  /** Shared WHERE-clause builder for summary-health queries. */
  private buildSummaryClauses(input: SummaryHealthScope): {
    clauses: string[];
    params: Record<string, unknown>;
  } {
    const clauses = ["accounts.public_id = @accountId", "messages.deleted_at_ms IS NULL"];
    const params: Record<string, unknown> = { accountId: input.accountId };
    if (input.folder) {
      clauses.push("folders.remote_path = @folder");
      params.folder = input.folder;
    }
    if (input.emailIds?.length) {
      input.emailIds.forEach((id, index) => {
        params[`email${index}`] = id;
      });
      clauses.push(`messages.public_id IN (${input.emailIds.map((_, index) => `@email${index}`).join(", ")})`);
    }
    const query = input.query?.trim();
    if (query) {
      params.q = `%${query}%`;
      clauses.push(
        "(messages.subject LIKE @q OR messages.sender_preview LIKE @q OR COALESCE(jobs.last_error_code, '') LIKE @q)",
      );
    }
    return { clauses, params };
  }

  /** Counts per summary state via SQL aggregation — no full-row JS materialization. */
  private countSummaryStates(input: SummaryHealthScope): Map<SummaryWorkState, number> {
    const { clauses, params } = this.buildSummaryClauses(input);
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_STATE_EXPRESSION} AS state, COUNT(*) AS n
         ${SUMMARY_FROM_JOIN}
         WHERE ${clauses.join(" AND ")}
         GROUP BY state`,
      )
      .all(params) as Array<{ state: SummaryWorkState; n: number }>;
    return new Map(rows.map((row) => [row.state, row.n]));
  }

  /**
   * Counts per summary state, falling back to a row-load + JS classification if
   * the SQL aggregation fails (e.g. malformed artifact JSON). The fast path runs
   * in the DB; the fallback keeps counts correct without breaking the page.
   */
  private countSummaryStatesSafe(input: SummaryHealthScope): Map<SummaryWorkState, number> {
    try {
      return this.countSummaryStates(input);
    } catch {
      const rows = this.summaryRows(input);
      const counts = new Map<SummaryWorkState, number>();
      for (const row of rows) {
        const state = this.summaryItem(row).state;
        counts.set(state, (counts.get(state) ?? 0) + 1);
      }
      return counts;
    }
  }

  private summaryItem(row: SummaryRow): SummaryHealthItem {
    const result = this.parseResult(row.artifact_json);
    const summary = result?.type === "summary"
      ? result as unknown as Record<string, unknown>
      : null;
    const hasText = (items: unknown) => Array.isArray(items) && items.some(
      (item) => typeof item === "string" && item.trim().length > 0,
    );
    const hasSummary = !!summary && (
      summary._status === "completed" ||
      hasText(summary.bullets) ||
      hasText(summary.actionItems) ||
      (typeof summary.headline === "string" && summary.headline.trim().length > 0)
    );
    const attemptsExhausted =
      row.job_attempt_count !== null &&
      row.job_max_attempts !== null &&
      row.job_attempt_count >= row.job_max_attempts;
    const state: SummaryWorkState = hasSummary ? "succeeded"
      : row.artifact_json ? "invalid"
      : row.job_state === "leased" ? "running"
      : row.job_state === "pending"
        ? (attemptsExhausted ? "failed" : "pending")
      : row.job_state === "failed" || row.job_state === "terminal" ? "failed"
      : row.job_state === "cancelled" ? "skipped"
      : "missing";
    const job = row.job_id
      ? {
          id: row.job_id,
          status: statusFromJobState(row.job_state),
          attempts: Number(row.job_attempt_count ?? 0),
          maxAttempts: Number(row.job_max_attempts ?? 0),
          createdAt: new Date(Number(row.job_created_at_ms)).toISOString(),
          updatedAt: new Date(Number(row.job_updated_at_ms)).toISOString(),
          ...(row.job_state === "leased"
            ? { startedAt: new Date(Number(row.job_updated_at_ms)).toISOString() }
            : {}),
          ...(row.job_state && row.job_state !== "pending" && row.job_state !== "leased"
            ? { finishedAt: new Date(Number(row.job_updated_at_ms)).toISOString() }
            : {}),
          ...(row.last_error_code ? { error: row.last_error_code } : {}),
        }
      : undefined;
    return {
      emailId: row.email_id,
      subject: row.subject,
      sender: row.sender,
      receivedAt: new Date(Number(row.received_at_ms)).toISOString(),
      state,
      ...(row.last_error_code ? { error: row.last_error_code } : {}),
      ...(row.last_error_code
        ? {
            diagnostic: {
              source: "job" as const,
              errorCode: row.last_error_code,
              ...(row.job_updated_at_ms !== null
                ? { updatedAt: new Date(Number(row.job_updated_at_ms)).toISOString() }
                : {}),
            },
          }
        : {}),
      ...(job ? { job } : {}),
    };
  }

  /**
   * Per-email attribute states (summary/tags/replyDecision/todoExtraction)
   * derived from current artifacts + ai.* jobs in two bulk queries.
   */
  private attributeRows(
    emailIds: string[],
  ): Map<string, IntelligenceAttributeStatus[]> {
    const output = new Map<string, IntelligenceAttributeStatus[]>();
    if (emailIds.length === 0) return output;
    const placeholders = emailIds.map(() => "?").join(", ");

    const artifacts = this.db.prepare(`
      SELECT messages.public_id AS email_id, current_artifact.artifact_kind,
             artifact.json_value
      FROM mail_messages messages
      JOIN mail_message_ai_current current_artifact ON current_artifact.message_id = messages.id
      JOIN mail_ai_artifacts artifact ON artifact.id = current_artifact.artifact_id
      WHERE messages.public_id IN (${placeholders}) AND artifact.state = 'ready'
    `).all(...emailIds) as AttributeArtifactRow[];

    const jobs = this.db.prepare(`
      SELECT jobs.subject_public_id AS email_id, jobs.job_kind,
             jobs.public_id AS job_id, jobs.state AS job_state,
             jobs.attempt_count AS job_attempt_count,
             jobs.max_attempts AS job_max_attempts,
             jobs.created_at_ms AS job_created_at_ms,
             jobs.updated_at_ms AS job_updated_at_ms,
             jobs.last_error_code
      FROM mail_jobs jobs
      WHERE jobs.subject_kind = 'message'
        AND jobs.job_kind IN ('ai.summary', 'ai.tags', 'ai.reply-decision', 'ai.todo')
        AND jobs.subject_public_id IN (${placeholders})
    `).all(...emailIds) as AttributeJobRow[];

    const artifactsByEmail = new Map<string, Map<string, IntelligenceResult | null>>();
    for (const row of artifacts) {
      const kind = ARTIFACT_KIND_TO_ATTRIBUTE[row.artifact_kind];
      if (!kind) continue;
      const byKind = artifactsByEmail.get(row.email_id) ?? new Map();
      byKind.set(kind, this.parseResult(row.json_value));
      artifactsByEmail.set(row.email_id, byKind);
    }
    const jobsByEmail = new Map<string, AttributeJobRow[]>();
    for (const row of jobs) {
      const list = jobsByEmail.get(row.email_id) ?? [];
      list.push(row);
      jobsByEmail.set(row.email_id, list);
    }

    for (const emailId of emailIds) {
      const resultByKind = artifactsByEmail.get(emailId) ?? new Map();
      const jobRows = jobsByEmail.get(emailId) ?? [];
      const attributes: IntelligenceAttributeStatus[] = [];
      for (const kind of INTELLIGENCE_ATTRIBUTE_KINDS) {
        const result = resultByKind.get(kind);
        const job = jobRows.find(
          (row) => JOB_KIND_TO_ATTRIBUTE[row.job_kind] === kind,
        );
        const state = this.deriveAttributeState(kind, result, job);
        const attribute: IntelligenceAttributeStatus = {
          kind,
          state,
          ...(job?.last_error_code ? { error: job.last_error_code } : {}),
          ...(job ? { job: this.attributeJob(job) } : {}),
        };
        attributes.push(attribute);
      }
      output.set(emailId, attributes);
    }
    return output;
  }

  private deriveAttributeState(
    kind: IntelligenceAttributeKind,
    result: IntelligenceResult | null,
    job: AttributeJobRow | undefined,
  ): SummaryWorkState {
    const hasResult = !!result && result.type === kind;
    if (hasResult) {
      return "succeeded";
    }
    const attemptsExhausted =
      job?.job_attempt_count !== null &&
      job?.job_max_attempts !== null &&
      Number(job?.job_attempt_count ?? 0) >= Number(job?.job_max_attempts ?? 0);
    if (job?.job_state === "leased") return "running";
    if (job?.job_state === "pending") {
      return attemptsExhausted ? "failed" : "pending";
    }
    if (job?.job_state === "failed" || job?.job_state === "terminal") {
      return "failed";
    }
    if (job?.job_state === "cancelled") return "skipped";
    return "missing";
  }

  private attributeJob(row: AttributeJobRow): IntelligenceAttributeStatus["job"] {
    return {
      id: row.job_id,
      status: statusFromJobState(row.job_state),
      attempts: Number(row.job_attempt_count ?? 0),
      maxAttempts: Number(row.job_max_attempts ?? 0),
      createdAt: new Date(Number(row.job_created_at_ms)).toISOString(),
      updatedAt: new Date(Number(row.job_updated_at_ms)).toISOString(),
      ...(row.job_state === "leased"
        ? { startedAt: new Date(Number(row.job_updated_at_ms)).toISOString() }
        : {}),
      ...(row.job_state && row.job_state !== "pending" && row.job_state !== "leased"
        ? { finishedAt: new Date(Number(row.job_updated_at_ms)).toISOString() }
        : {}),
      ...(row.last_error_code ? { error: row.last_error_code } : {}),
    };
  }

  private parseResult(value: string | null): IntelligenceResult | null {
    if (!value) return null;
    try {
      return JSON.parse(value) as IntelligenceResult;
    } catch {
      return null;
    }
  }

  private normalizeTag(value: string): string {
    return value.trim().normalize("NFKC").toLocaleLowerCase();
  }
}

function statusFromJobState(
  state: string | null,
): "pending" | "running" | "succeeded" | "failed" | "skipped" {
  switch (state) {
    case "leased":
      return "running";
    case "succeeded":
      return "succeeded";
    case "terminal":
    case "cancelled":
      return "skipped";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

/** artifact_kind (DB) → attribute kind. */
const ARTIFACT_KIND_TO_ATTRIBUTE: Record<string, IntelligenceAttributeKind> = {
  summary: "summary",
  tags: "tags",
  replyDecision: "replyDecision",
  todoExtraction: "todoExtraction",
};

/** job_kind (DB) → attribute kind. */
const JOB_KIND_TO_ATTRIBUTE: Record<string, IntelligenceAttributeKind> = {
  "ai.summary": "summary",
  "ai.tags": "tags",
  "ai.reply-decision": "replyDecision",
  "ai.todo": "todoExtraction",
};
