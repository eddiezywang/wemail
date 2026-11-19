import { createHash } from "node:crypto";
import { MailFolderSyncStateSchema, type MailFolderSyncStates } from "../../../shared/wemail/mailSync.js";
import type {
  MailCoreCategoryResult,
  MailCoreFolderResult,
  MailCoreListParams,
  MailCoreListResult,
  MailCoreMessageSummary,
  MailSnapshotResult,
} from "../../../shared/wemail/mailCoreProtocol.js";
import type {
  MailDatabaseChange,
  MailDatabaseAccountRecord,
  MailDatabaseChangesSinceResult,
  MailDatabaseScheduledSendRecord,
  MailDatabaseScheduledSendPage,
  MailDatabaseSearchParams,
} from "../../../shared/wemail/mailDatabaseProtocol.js";
import { MailDatabaseDeliveryResultSchema } from "../../../shared/wemail/mailDatabaseProtocol.js";
import type { MailAttachment, MailDraftRecord, MailMessage, WemailAddress, WemailDeliveryResult } from "../../../shared/wemail/mail.js";
import type {
  EmailIntelligenceState,
  IntelligenceStatus,
  MailSceneAction,
  SummaryResult,
} from "../../../shared/wemail/intelligence.js";
import type { InvoiceMailStatusSummary } from "../../../shared/wemail/invoice.js";
import {
  resolveInvoiceStatusStore,
  type IsInvoiceAttachmentCandidate,
  type InvoiceStatusPort,
} from "../agent/allowancePort.js";
import {
  defaultSceneActionContributors,
  resolveMailSceneActions,
  type SceneActionContributor,
} from "../intelligence/MailSceneActionResolver.js";
import type { MailDatabase } from "./Database.js";
import { CJK_SEARCH_INDEX_VERSION, cjkSearchTerms, containsHan } from "./MailSearchCjk.js";
import { resolveEditionModules, type EditionModules } from "../bootstrap/editionModules.js";

function parseDeliveryResult(raw: string | null): WemailDeliveryResult | undefined {
  if (!raw) return undefined;
  try {
    const parsed = MailDatabaseDeliveryResultSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

interface ListCursor {
  v: 2;
  accountId: string;
  scope: string;
  filterHash: string;
  anchor: { time: number; id: string };
  after: { time: number; id: string };
  viewVersion: number;
}

interface SummaryRow {
  id: bigint;
  public_id: string;
  account_public_id: string;
  thread_public_id: string | null;
  rfc_message_id: string | null;
  subject: string;
  snippet: string;
  sender_preview: string;
  recipient_preview: string;
  received_at_ms: bigint;
  sent_at_ms: bigint | null;
  has_attachments: bigint;
  is_seen: bigint;
  is_flagged: bigint;
  flags_bits: bigint;
  folder_path: string | null;
}

interface DraftRow {
  id: bigint;
  public_id: string;
  account_public_id: string;
  original_public_id: string | null;
  compose_type: "new" | "reply" | "forward" | null;
  subject: string;
  body_text: string | null;
  body_html: string | null;
  created_at_ms: bigint;
  updated_at_ms: bigint;
}

export interface MailDatabaseQueryRepositoryOptions {
  /**
   * Scene-action contributors captured at construction. Omitting it uses the
   * build-time edition registration (the independent DB reader lane needs no
   * extra wiring). An explicit empty array disables contributed actions for
   * this instance only — it never falls back to the registration.
   */
  sceneActionContributors?: readonly SceneActionContributor[];
  /** Edition invoice store; omitted uses the build-time registration. */
  invoiceStatuses?: InvoiceStatusPort | null;
  invoiceCandidateCheck?: IsInvoiceAttachmentCandidate;
}

export function queryOptionsForEdition(db: MailDatabase, features?: import("../../../shared/wemail/edition.js").EditionFeatures, modules: EditionModules = resolveEditionModules()): MailDatabaseQueryRepositoryOptions {
  return {
    sceneActionContributors: [
      ...(features?.officeSceneDetection ? modules.sceneActionContributors ?? [] : []),
      ...(modules.featureSceneActionContributors ?? [])
        .filter((item) => item.requires.every((feature) => features?.[feature] === true))
        .flatMap((item) => item.contributors),
    ],
    invoiceStatuses: features?.allowanceInvoice ? modules.allowance?.createInvoiceStatusStore(db) ?? null : null,
    invoiceCandidateCheck: features?.allowanceInvoice && features?.wecli ? modules.allowance?.isInvoiceAttachmentCandidate ?? (() => false) : () => false,
  };
}

export class MailDatabaseQueryRepository {
  private readonly sceneActionContributors: readonly SceneActionContributor[];
  /**
   * P2.6: the invoice_attachment_statuses store is an edition module. The
   * open edition has none, so both invoice read sites below collapse to the
   * empty shape (omitted field / null) while the DTO contract and the
   * underlying table stay for DB compatibility.
   */
  private readonly invoiceStatuses: InvoiceStatusPort | undefined;
  private readonly invoiceCandidateCheck?: IsInvoiceAttachmentCandidate;

  constructor(
    private readonly db: MailDatabase,
    options: MailDatabaseQueryRepositoryOptions = {},
  ) {
    this.sceneActionContributors =
      options.sceneActionContributors ?? defaultSceneActionContributors();
    this.invoiceStatuses = options.invoiceStatuses === null
      ? undefined : options.invoiceStatuses ?? resolveInvoiceStatusStore(db);
    this.invoiceCandidateCheck = options.invoiceCandidateCheck;
  }

  listAccounts(): MailDatabaseAccountRecord[] {
    const rows = this.db.prepare(`
      SELECT public_id, email_address, display_name,
        imap_host, imap_port, imap_secure, imap_username,
        smtp_host, smtp_port, smtp_secure, smtp_username,
        credential_ref, credential_generation, state,
        created_at_ms, updated_at_ms
      FROM mail_accounts
      ORDER BY updated_at_ms DESC, created_at_ms DESC, public_id
      LIMIT 100
    `).all() as Array<{
      public_id: string;
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
      state: "active" | "auth_required" | "disabled";
      created_at_ms: bigint;
      updated_at_ms: bigint;
    }>;
    return rows.map((row) => ({
      account: {
        id: row.public_id,
        emailAddress: row.email_address,
        ...(row.display_name ? { displayName: row.display_name } : {}),
        imap: {
          host: row.imap_host,
          port: Number(row.imap_port),
          secure: Number(row.imap_secure) === 1,
          username: row.imap_username,
        },
        smtp: {
          host: row.smtp_host,
          port: Number(row.smtp_port),
          secure: Number(row.smtp_secure) === 1,
          username: row.smtp_username,
        },
        createdAt: new Date(Number(row.created_at_ms)).toISOString(),
        updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
      },
      credentialRef: row.credential_ref,
      credentialGeneration: Number(row.credential_generation),
      state: row.state,
    }));
  }

  getDraft(accountId: string, id: string): MailDraftRecord | null {
    const row = this.draftRows(accountId, id, 1)[0];
    return row ? this.mapDraft(row) : null;
  }

  listDrafts(accountId: string, limit = 100): MailDraftRecord[] {
    return this.draftRows(accountId, undefined, Math.max(1, Math.floor(limit)))
      .map((row) => this.mapDraft(row));
  }

  listSnoozed(accountId: string): MailMessage[] {
    const rows = this.db.prepare(`
      SELECT messages.public_id
      FROM mail_messages messages
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      WHERE accounts.public_id = ?
        AND messages.deleted_at_ms IS NULL
        AND messages.snoozed_until_ms > ?
      ORDER BY messages.snoozed_until_ms ASC, messages.id ASC
    `).all(accountId, Date.now()) as Array<{ public_id: string }>;
    return rows
      .map((row) => this.getSnapshot(row.public_id).message)
      .filter((message): message is MailMessage => message !== null);
  }

  /**
   * Envelope-only message for scene-action contributors (office-scene
   * detection reads subject + sender). Deliberately carries no body,
   * attachments, recipients or headers; use {@link getSnapshot} when those
   * are needed. Reads one indexed row instead of the full snapshot join
   * chain, so every non-invoice office mail can reach contributors without
   * an extra full-message read on detail-panel load.
   */
  private sceneEnvelope(emailId: string): MailMessage | undefined {
    const row = this.db.prepare(`
      SELECT
        messages.public_id,
        messages.subject,
        messages.snippet,
        messages.sender_preview,
        messages.received_at_ms,
        messages.sent_at_ms,
        messages.has_attachments,
        messages.is_seen,
        messages.is_flagged,
        COALESCE((SELECT flags_bits FROM mail_message_instances WHERE id = messages.primary_instance_id), 0) AS flags_bits,
        accounts.public_id AS account_public_id
      FROM mail_messages messages
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      WHERE messages.public_id = ? AND messages.deleted_at_ms IS NULL
      LIMIT 1
    `).get(emailId) as {
      public_id: string;
      subject: string;
      snippet: string;
      sender_preview: string;
      received_at_ms: bigint;
      sent_at_ms: bigint | null;
      has_attachments: bigint;
      is_seen: bigint;
      is_flagged: bigint;
      flags_bits: bigint;
      account_public_id: string;
    } | undefined;
    if (!row) return undefined;
    const receivedAt = new Date(Number(row.received_at_ms)).toISOString();
    return {
      id: row.public_id,
      accountId: row.account_public_id,
      folder: "",
      messageId: row.public_id,
      from: { email: row.sender_preview },
      to: [],
      cc: [],
      bcc: [],
      subject: row.subject,
      snippet: row.snippet,
      receivedAt,
      ...(row.sent_at_ms !== null
        ? { sentAt: new Date(Number(row.sent_at_ms)).toISOString() }
        : {}),
      hasAttachments: Number(row.has_attachments) === 1,
      attachments: [],
      flags: {
        seen: Number(row.is_seen) === 1,
        flagged: Number(row.is_flagged) === 1,
        answered: (Number(row.flags_bits) & 4) !== 0,
        draft: (Number(row.flags_bits) & 8) !== 0,
      },
      sync: { uid: 0, uidValidity: 0, internalDate: receivedAt },
    };
  }

  getIntelligenceState(emailId: string): EmailIntelligenceState {
    const message = this.db.prepare(`
      SELECT id FROM mail_messages WHERE public_id = ? AND deleted_at_ms IS NULL
    `).get(emailId) as { id: bigint } | undefined;
    if (!message) throw new Error(`message-not-found:${emailId}`);

    const capability = (artifactKind: string, jobKind: string) => {
      const artifact = this.db.prepare(`
        SELECT artifact.state, artifact.json_value, artifact.error_code
        FROM mail_message_ai_current current
        JOIN mail_ai_artifacts artifact ON artifact.id = current.artifact_id
        WHERE current.message_id = ? AND current.artifact_kind = ?
      `).get(message.id, artifactKind) as {
        state: string;
        json_value: string | null;
        error_code: string | null;
      } | undefined;
      if (artifact?.state === "ready") {
        return {
          status: "succeeded" as const,
          ...(artifact.json_value ? { result: JSON.parse(artifact.json_value) as unknown } : {}),
        };
      }
      const job = this.db.prepare(`
        SELECT state, last_error_code
        FROM mail_jobs
        WHERE subject_kind = 'message' AND subject_public_id = ? AND job_kind = ?
        ORDER BY input_version DESC, id DESC LIMIT 1
      `).get(emailId, jobKind) as {
        state: string;
        last_error_code: string | null;
      } | undefined;
      const status: IntelligenceStatus =
        job?.state === "leased" ? "running" :
        job?.state === "failed" || job?.state === "terminal" ? "failed" :
        artifact?.state === "failed" ? "failed" : "pending";
      return {
        status,
        ...(status === "failed" && (job?.last_error_code ?? artifact?.error_code)
          ? { error: job?.last_error_code ?? artifact?.error_code ?? undefined }
          : {}),
      };
    };

    const summaryState = capability("summary", "ai.summary");
    const summaryResult = (summaryState as { result?: SummaryResult }).result;
    const invoiceIntent =
      summaryResult?.intent === "invoice" || summaryResult?.intent === "receipt";

    // Project canonical summary actions into the same scene-action catalog as
    // built-in report and invoice workflows. Invoice attachment checks need
    // the full snapshot (body + attachments). Edition scene contributors only
    // need the envelope (subject + sender), so non-invoice office mail gets a
    // single lightweight row read instead of hydrating the whole message.
    let sceneActions: MailSceneAction[] | undefined;
    let invoiceStatus: InvoiceMailStatusSummary | undefined;
    if (summaryResult) {
      const snapshotMessage = invoiceIntent ? this.getSnapshot(emailId).message : undefined;
      if (invoiceIntent) {
        invoiceStatus = this.invoiceStatuses?.getMailStatus(emailId);
      }
      const envelopeMessage = !invoiceIntent && this.sceneActionContributors.length > 0
        ? this.sceneEnvelope(emailId)
        : undefined;
      const resolved = resolveMailSceneActions({
        message: snapshotMessage ?? envelopeMessage,
        summary: summaryResult,
        invoiceIntent,
        ...(invoiceStatus ? { invoiceStatus } : {}),
        ...(this.invoiceCandidateCheck ? { invoiceCandidateCheck: this.invoiceCandidateCheck } : {}),
        contributors: this.sceneActionContributors,
      });
      if (resolved.length > 0) sceneActions = resolved;
    }

    return {
      emailId,
      summary: summaryState,
      tags: capability("tags", "ai.tags"),
      replyDecision: capability("replyDecision", "ai.reply-decision"),
      replyDraft: capability("replyDraft", "ai.replyDraft"),
      todoExtraction: capability("todoExtraction", "ai.todo"),
      linkExtraction: { status: "skipped" },
      ...(invoiceStatus ? { invoiceStatus } : {}),
      ...(sceneActions ? { sceneActions } : {}),
    } as EmailIntelligenceState;
  }

  list(params: MailCoreListParams): MailCoreListResult {
    const limit = Math.max(1, Math.floor(params.limit ?? 50));
    const account = this.account(params.accountId);
    if (!account) return { messages: [], totalCount: 0, unreadCount: 0, hasMore: false };
    const scope = this.scopeKey(params);
    const filterHash = this.filterHash(params);
    const cursor = this.decodeCursor(params.cursor);
    if (
      cursor &&
      (
        cursor.accountId !== params.accountId ||
        cursor.scope !== scope ||
        cursor.filterHash !== filterHash
      )
    ) {
      throw new Error("invalid-cursor");
    }
    const { fromSql, whereSql, bindings } = this.listSource(params, account.id);
    const clauses = [
      `messages.deleted_at_ms IS NULL`,
    ];
    bindings.nowMs = Date.now();
    if (params.scope === "snoozed") {
      clauses.push("messages.snoozed_until_ms > @nowMs");
    } else if (params.scope !== "all" && !params.allMail) {
      clauses.push("(messages.snoozed_until_ms IS NULL OR messages.snoozed_until_ms <= @nowMs)");
    }
    if (params.scope === "starred") clauses.push("messages.is_flagged = 1");
    if (params.scope === "newsletter") {
      clauses.push(`EXISTS (
        SELECT 1 FROM mail_message_headers newsletter_header
        WHERE newsletter_header.message_id = messages.id
          AND newsletter_header.name_norm IN ('list-unsubscribe', 'list-id')
      )`);
    }
    if (params.scope === "todos") {
      clauses.push(`EXISTS (
        SELECT 1 FROM mail_todos open_todo
        WHERE open_todo.message_id = messages.id
          AND open_todo.deleted_at_ms IS NULL
          AND open_todo.completed_at_ms IS NULL
          AND open_todo.source = 'ai'
      )`);
    }
    if (params.unread) clauses.push("source.is_seen = 0");
    if (params.hasAttachment) clauses.push("source.has_attachments = 1");
    if (params.toMe) {
      clauses.push(`EXISTS (
        SELECT 1 FROM mail_message_addresses recipients
        WHERE recipients.message_id = messages.id
          AND recipients.kind = 'to' AND recipients.address_norm = @accountEmail
      )`);
      bindings.accountEmail = account.email_address.trim().toLowerCase();
    }
    if (params.ccMe) {
      clauses.push(`EXISTS (
        SELECT 1 FROM mail_message_addresses recipients
        WHERE recipients.message_id = messages.id
          AND recipients.kind = 'cc' AND recipients.address_norm = @accountEmail
      )`);
      bindings.accountEmail = account.email_address.trim().toLowerCase();
    }
    if (params.olderThan) {
      const days = Number.parseInt(params.olderThan, 10);
      clauses.push("source.received_at_ms < @receivedBefore");
      bindings.receivedBefore = Date.now() - days * 86_400_000;
    }
    if (params.before) {
      clauses.push("source.received_at_ms < @before");
      bindings.before = Date.parse(params.before);
    }
    if (cursor) {
      clauses.push(`(
        source.received_at_ms < @afterTime OR
        (source.received_at_ms = @afterTime AND source.message_id < @afterId)
      )`);
      clauses.push(`(
        source.received_at_ms < @anchorTime OR
        (source.received_at_ms = @anchorTime AND source.message_id <= @anchorId)
      )`);
      bindings.afterTime = cursor.after.time;
      bindings.afterId = BigInt(cursor.after.id);
      bindings.anchorTime = cursor.anchor.time;
      bindings.anchorId = BigInt(cursor.anchor.id);
    }
    const rows = this.db.prepare(`
      SELECT
        messages.id,
        messages.public_id,
        accounts.public_id AS account_public_id,
        threads.public_id AS thread_public_id,
        messages.rfc_message_id,
        messages.subject,
        messages.snippet,
        messages.sender_preview,
        messages.recipient_preview,
        messages.received_at_ms,
        messages.sent_at_ms,
        messages.has_attachments,
        messages.is_seen,
        messages.is_flagged,
        COALESCE((SELECT flags_bits FROM mail_message_instances WHERE id = messages.primary_instance_id), 0) AS flags_bits,
        messages.snoozed_until_ms,
        folders.remote_path AS folder_path
      ${fromSql}
      JOIN mail_messages messages ON messages.id = source.message_id
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      LEFT JOIN mail_threads threads ON threads.id = messages.thread_id
      LEFT JOIN mail_folders folders ON folders.id = messages.primary_folder_id
      WHERE ${whereSql}
        AND ${clauses.join("\n        AND ")}
      ORDER BY source.received_at_ms DESC, source.message_id DESC
      LIMIT @limit
    `).all({ ...bindings, limit: limit + 1 }) as SummaryRow[];
    const hasNext = rows.length > limit;
    const page = rows.slice(0, limit);
    const messages = page.map((row) => this.toSummary(row));
    const counts = this.counts(params, account.id);
    const first = page[0];
    const last = page.at(-1);
    const viewVersion = this.commitVersion();
    const anchor = cursor?.anchor ?? (
      first
        ? { time: Number(first.received_at_ms), id: first.id.toString() }
        : { time: Date.now(), id: "0" }
    );
    return {
      messages,
      totalCount: counts.total,
      unreadCount: counts.unread,
      hasMore: hasNext,
      ...(hasNext && last
        ? {
            nextCursor: this.encodeCursor({
              v: 2,
              accountId: params.accountId,
              scope,
              filterHash,
              anchor,
              after: {
                time: Number(last.received_at_ms),
                id: last.id.toString(),
              },
              viewVersion,
            }),
          }
        : {}),
    };
  }

  search(params: MailDatabaseSearchParams): MailCoreListResult {
    const account = this.account(params.accountId);
    if (!account) return { messages: [], totalCount: 0, unreadCount: 0, hasMore: false };
    const normalized = (params.query ?? "").normalize("NFKC").trim().toLowerCase();
    const scope = params.scope ?? "default";
    const characterCount = [...normalized].length;
    if (scope === "body" && characterCount < 2) throw new Error("body-query-too-short");
    const limit = Math.min(100, Math.max(1, params.limit ?? 50));
    const searchPage = Math.max(1, Math.floor(params.page ?? 1));
    const accountTerm = `acct${createHash("sha256").update(params.accountId).digest("hex").slice(0, 16)}`;
    const ftsParts: string[] = [];
    const cjkFilters: Array<{
      value: string;
      scope: NonNullable<MailDatabaseSearchParams["scope"]> | "sender" | "recipient";
    }> = [];
    const substringFilters: Array<{
      value: string;
      scope: NonNullable<MailDatabaseSearchParams["scope"]> | "sender" | "recipient";
    }> = [];
    const cjkIndexReady = this.cjkSearchIndexReady();
    // Free-text words, kept alongside their FTS form so the default scope can
    // OR each word against a smart-tag name match (tag names live in plain
    // tables, not the FTS index).
    const freeTextWords: Array<{ raw: string; fts: string | null }> = [];
    for (const term of normalized.split(/\s+/).filter(Boolean)) {
      if (this.requiresCjkSearch(term)) {
        (cjkIndexReady ? cjkFilters : substringFilters).push({ value: term, scope });
        freeTextWords.push({ raw: term, fts: null });
      } else {
        const fts = this.ftsQuery(term, scope);
        ftsParts.push(fts);
        freeTextWords.push({ raw: term, fts });
      }
    }
    if (params.from?.trim()) {
      const value = params.from.normalize("NFKC").trim().toLowerCase();
      if (this.requiresCjkSearch(value)) {
        (cjkIndexReady ? cjkFilters : substringFilters).push({ value, scope: "sender" });
      } else {
        ftsParts.push(`sender_terms:${this.ftsPhrase(value)}`);
      }
    }
    if (params.to?.trim()) {
      const value = params.to.normalize("NFKC").trim().toLowerCase();
      if (this.requiresCjkSearch(value)) {
        (cjkIndexReady ? cjkFilters : substringFilters).push({ value, scope: "recipient" });
      } else {
        ftsParts.push(`recipient_terms:${this.ftsPhrase(value)}`);
      }
    }
    if (params.subject?.trim()) {
      const value = params.subject.normalize("NFKC").trim().toLowerCase();
      if (this.requiresCjkSearch(value)) {
        (cjkIndexReady ? cjkFilters : substringFilters).push({ value, scope: "subject" });
      } else {
        ftsParts.push(`subject_terms:${this.ftsPhrase(value)}`);
      }
    }
    const bindings: Record<string, string | number | bigint> = {
      accountId: account.id,
      accountEmail: account.email_address.trim().toLowerCase(),
      limit: limit + 1,
      offset: (searchPage - 1) * limit,
    };
    const clauses = [
      "messages.account_id = @accountId",
      "messages.deleted_at_ms IS NULL",
    ];
    if (params.mailScope === "snoozed") {
      clauses.push("messages.snoozed_until_ms > @nowMs");
      bindings.nowMs = Date.now();
    } else if (params.mailScope !== "all") {
      clauses.push("(messages.snoozed_until_ms IS NULL OR messages.snoozed_until_ms <= @nowMs)");
      bindings.nowMs = Date.now();
    }
    if (params.mailScope === "starred") clauses.push("messages.is_flagged = 1");
    if (params.mailScope === "newsletter") clauses.push(`EXISTS (
      SELECT 1 FROM mail_message_headers search_newsletter_header
      WHERE search_newsletter_header.message_id = messages.id
        AND search_newsletter_header.name_norm IN ('list-unsubscribe', 'list-id')
    )`);
    if (params.mailScope === "todos") clauses.push(`EXISTS (
      SELECT 1 FROM mail_todos search_open_todo
      WHERE search_open_todo.message_id = messages.id
        AND search_open_todo.deleted_at_ms IS NULL
        AND search_open_todo.completed_at_ms IS NULL
        AND search_open_todo.source = 'ai'
    )`);
    if (params.category) {
      clauses.push(`EXISTS (
        SELECT 1 FROM mail_message_system_categories search_category_membership
        JOIN mail_system_categories search_category
          ON search_category.id = search_category_membership.category_id
        WHERE search_category_membership.message_id = messages.id
          AND search_category_membership.account_id = @accountId
          AND search_category.key = @category
      )`);
      bindings.category = params.category;
    }
    if (params.smartTagId) {
      clauses.push(`EXISTS (
        SELECT 1 FROM mail_message_user_tags search_tag_membership
        JOIN mail_user_tags search_tag ON search_tag.id = search_tag_membership.tag_id
        WHERE search_tag_membership.message_id = messages.id
          AND search_tag_membership.account_id = @accountId
          AND search_tag.public_id = @smartTagId
      )`);
      bindings.smartTagId = params.smartTagId;
    }
    if (params.folder) {
      clauses.push("folders.remote_path = @folder");
      bindings.folder = params.folder;
    } else if (params.mailScope !== "all") {
      // Global search (no folder scope): exclude default-hidden folders so a
      // mail moved to Trash (e.g. via a bot "delete" → move-to-Trash) stops
      // appearing in results. Mirrors shared/folders.ts
      // isDefaultSearchExcludedFolder for the common server folder paths;
      // applied here (before LIMIT) so the page fills with visible matches.
      clauses.push(`(folders.remote_path IS NULL OR (
        LOWER(folders.remote_path) NOT LIKE '%trash%' AND
        LOWER(folders.remote_path) NOT LIKE '%spam%' AND
        LOWER(folders.remote_path) NOT LIKE '%junk%' AND
        LOWER(folders.remote_path) NOT LIKE '%draft%'))`);
    }
    if (params.dateFrom) {
      clauses.push("messages.received_at_ms >= @dateFrom");
      bindings.dateFrom = Date.parse(params.dateFrom);
    }
    if (params.dateTo) {
      clauses.push("messages.received_at_ms <= @dateTo");
      bindings.dateTo = Date.parse(params.dateTo) + 86_399_999;
    }
    if (Number.isFinite(params.receivedFromMs)) {
      clauses.push("messages.received_at_ms >= @receivedFromMs");
      bindings.receivedFromMs = params.receivedFromMs!;
    }
    if (Number.isFinite(params.receivedToMs)) {
      clauses.push("messages.received_at_ms <= @receivedToMs");
      bindings.receivedToMs = params.receivedToMs!;
    }
    if (params.read !== undefined) {
      clauses.push("messages.is_seen = @isSeen");
      bindings.isSeen = params.read ? 1 : 0;
    }
    if (params.unread) clauses.push("messages.is_seen = 0");
    if (params.starred !== undefined) {
      clauses.push("messages.is_flagged = @isFlagged");
      bindings.isFlagged = params.starred ? 1 : 0;
    }
    if (params.hasAttachment !== undefined) {
      clauses.push("messages.has_attachments = @hasAttachments");
      bindings.hasAttachments = params.hasAttachment ? 1 : 0;
    }
    if (params.toMe) {
      clauses.push(`EXISTS (
        SELECT 1 FROM mail_message_addresses own_to
        WHERE own_to.message_id = messages.id
          AND own_to.kind = 'to' AND own_to.address_norm = @accountEmail
      )`);
    }
    if (params.ccMe) {
      clauses.push(`EXISTS (
        SELECT 1 FROM mail_message_addresses own_cc
        WHERE own_cc.message_id = messages.id
          AND own_cc.kind = 'cc' AND own_cc.address_norm = @accountEmail
      )`);
    }
    if (params.olderThan) {
      bindings.olderThan = Date.now() - Number.parseInt(params.olderThan, 10) * 86_400_000;
      clauses.push("messages.received_at_ms < @olderThan");
    }
    for (const [index, filter] of cjkFilters.entries()) {
      const matchBinding = `cjkMatch${index}`;
      const tagBinding = `cjkTag${index}`;
      bindings[matchBinding] = `account_terms:${accountTerm} AND ${this.cjkFtsQuery(filter.value, filter.scope)}`;
      bindings[tagBinding] = filter.value;
      const indexedMatch = `messages.id IN (
        SELECT rowid FROM mail_search_cjk_fts
        WHERE mail_search_cjk_fts MATCH @${matchBinding}
      )`;
      clauses.push(filter.scope === "default"
        ? `(${indexedMatch} OR ${this.smartTagSearchClause(tagBinding)})`
        : indexedMatch);
    }
    for (const [index, filter] of substringFilters.entries()) {
      const binding = `substring${index}`;
      bindings[binding] = filter.value;
      clauses.push(this.substringSearchClause(filter.scope, binding));
    }
    if (ftsParts.length > 0) {
      if (scope === "default") {
        // Default scope: each free-text FTS word may also hit a smart-tag
        // name, so it becomes `(FTS match OR tag-name substring)`. Substring
        // words already cover tags via substringSearchClause's default branch.
        // Exact from:/to:/subject: filters keep a single merged MATCH.
        const freeTextFts = new Set(
          freeTextWords.flatMap((word) => (word.fts ? [word.fts] : [])),
        );
        const exactFts = ftsParts.filter((part) => !freeTextFts.has(part));
        let wordIndex = 0;
        for (const word of freeTextWords) {
          if (!word.fts) continue;
          const matchBinding = `wordMatch${wordIndex}`;
          const tagBinding = `wordTag${wordIndex}`;
          bindings[matchBinding] = `account_terms:${accountTerm} AND ${word.fts}`;
          bindings[tagBinding] = word.raw;
          // FTS5 MATCH cannot reliably sit beside a non-FTS branch in this OR.
          clauses.push(`(
            messages.id IN (
              SELECT rowid FROM mail_search_fts
              WHERE mail_search_fts MATCH @${matchBinding}
            )
            OR ${this.smartTagSearchClause(tagBinding)}
          )`);
          wordIndex++;
        }
        if (exactFts.length > 0) {
          clauses.push("mail_search_fts MATCH @exactMatch");
          bindings.exactMatch = `account_terms:${accountTerm} AND (${exactFts.join(" AND ")})`;
        }
      } else {
        clauses.push("mail_search_fts MATCH @match");
        bindings.match = `account_terms:${accountTerm} AND (${ftsParts.join(" AND ")})`;
      }
    }
    const rows = this.db.prepare(`
      SELECT
        messages.id,
        messages.public_id,
        accounts.public_id AS account_public_id,
        threads.public_id AS thread_public_id,
        messages.rfc_message_id,
        messages.subject,
        messages.snippet,
        messages.sender_preview,
        messages.recipient_preview,
        messages.received_at_ms,
        messages.sent_at_ms,
        messages.has_attachments,
        messages.is_seen,
        messages.is_flagged,
        COALESCE((SELECT flags_bits FROM mail_message_instances WHERE id = messages.primary_instance_id), 0) AS flags_bits,
        folders.remote_path AS folder_path
      FROM mail_messages messages
      ${ftsParts.length > 0
        ? "JOIN mail_search_fts ON mail_search_fts.rowid = messages.id"
        : ""}
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      LEFT JOIN mail_threads threads ON threads.id = messages.thread_id
      LEFT JOIN mail_folders folders ON folders.id = messages.primary_folder_id
      WHERE ${clauses.join("\n        AND ")}
      ORDER BY messages.received_at_ms DESC, messages.id DESC
      LIMIT @limit
      OFFSET @offset
    `).all(bindings) as SummaryRow[];
    const page = rows.slice(0, limit);
    return {
      messages: page.map((row) => this.toSummary(row)),
      totalCount: page.length,
      unreadCount: page.filter((row) => Number(row.is_seen) === 0).length,
      hasMore: rows.length > limit,
      ...(rows.length > limit ? { nextCursor: String(searchPage + 1) } : {}),
    };
  }

  getSnapshot(publicId: string): MailSnapshotResult {
    const row = this.db.prepare(`
      SELECT
        messages.*,
        (SELECT result_json FROM mail_message_delivery WHERE message_id = messages.id) AS delivery_json,
        accounts.public_id AS account_public_id,
        threads.public_id AS thread_public_id,
        folders.remote_path AS folder_path,
        instances.remote_uid,
        instances.uid_validity,
        COALESCE(instances.flags_bits, 0) AS flags_bits,
        content.state AS body_state,
        content.text_plain,
        content.html_sanitized,
        content.byte_size AS body_byte_size,
        content.content_version AS stored_content_version,
        content.fetched_at_ms,
        content.retry_at_ms,
        content.retry_count,
        content.retryable,
        content.error_code
      FROM mail_messages messages
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      LEFT JOIN mail_threads threads ON threads.id = messages.thread_id
      LEFT JOIN mail_folders folders ON folders.id = messages.primary_folder_id
      LEFT JOIN mail_message_instances instances
        ON instances.id = messages.primary_instance_id
      LEFT JOIN mail_message_content content ON content.message_id = messages.id
      WHERE messages.public_id = ?
      LIMIT 1
    `).get(publicId) as (Record<string, unknown> & {
      id: bigint;
      public_id: string;
      account_public_id: string;
      thread_public_id: string | null;
      folder_path: string | null;
      rfc_message_id: string | null;
      delivery_json: string | null;
      subject: string;
      snippet: string;
      received_at_ms: bigint;
      sent_at_ms: bigint | null;
      internal_date_ms: bigint;
      has_attachments: bigint;
      is_seen: bigint;
      is_flagged: bigint;
      snoozed_until_ms: bigint | null;
      body_state: "missing" | "queued" | "fetching" | "ready" | "failed" | null;
      text_plain: string | null;
      html_sanitized: string | null;
      body_byte_size: bigint | null;
      stored_content_version: bigint | null;
      fetched_at_ms: bigint | null;
      retry_at_ms: bigint | null;
      retry_count: bigint | null;
      retryable: bigint | null;
      error_code: string | null;
      remote_uid: bigint | null;
      uid_validity: bigint | null;
      flags_bits: bigint;
    }) | undefined;
    if (!row) {
      return {
        message: null,
        bodyState: "missing",
        bodyAttempts: 0,
        bodyRetryable: false,
        invoiceDetected: false,
        invoiceStatus: null,
      };
    }
    const addresses = this.addresses(row.id);
    const attachments = this.attachments(row.id);
    const headers = this.headers(row.id);
    const delivery = parseDeliveryResult(row.delivery_json);
    const archive = this.db.prepare(`SELECT state FROM mail_jobs WHERE job_kind = 'mail.sent.archive' AND subject_public_id = ? ORDER BY id DESC LIMIT 1`).get(publicId) as { state: string } | undefined;
    // A provider metadata upsert may leave a non-empty snippet while the
    // content row is still an empty `ready` placeholder. Do not expose that
    // impossible-to-render combination to the UI: it is a body hydration
    // miss and must re-enter the foreground fetch path. A genuinely empty
    // message remains ready and is not retried forever.
    const hasMeaningfulBody =
      (row.text_plain?.trim().length ?? 0) > 0 ||
      (row.html_sanitized?.trim().length ?? 0) > 0;
    const readyBodyMissing = row.body_state === "ready" &&
      !hasMeaningfulBody &&
      (row.snippet?.trim().length ?? 0) > 0 &&
      Number(row.body_byte_size ?? 0n) === 0;
    const bodyState = readyBodyMissing
      ? "missing"
      : row.body_state === "ready"
      ? "ready"
      : row.body_state === "failed"
        ? "failed"
        : row.body_state === "fetching" || row.body_state === "queued"
          ? "fetching"
          : "missing";
    const message: MailMessage = {
      id: row.public_id,
      source: "provider",
      accountId: row.account_public_id,
      folder: row.folder_path ?? "",
      messageId: row.rfc_message_id ?? row.public_id,
      ...(row.thread_public_id ? { threadId: row.thread_public_id } : {}),
      ...(headers["in-reply-to"] ? { parentMessageId: headers["in-reply-to"] } : {}),
      from: addresses.from[0] ?? { email: "" },
      to: addresses.to,
      cc: addresses.cc,
      bcc: addresses.bcc,
      ...(delivery ? { delivery } : {}),
      subject: row.subject,
      snippet: row.snippet,
      ...(row.text_plain !== null ? { bodyText: row.text_plain } : {}),
      ...(row.html_sanitized !== null ? { bodyHtml: row.html_sanitized } : {}),
      ...(row.fetched_at_ms !== null
        ? { bodyCachedUntil: new Date(Number(row.fetched_at_ms)).toISOString() }
        : {}),
      bodyVersion: Number(row.stored_content_version ?? 0n),
      receivedAt: new Date(Number(row.received_at_ms)).toISOString(),
      ...(row.sent_at_ms !== null
        ? { sentAt: new Date(Number(row.sent_at_ms)).toISOString() }
        : {}),
      hasAttachments: Number(row.has_attachments) === 1,
      attachments,
      flags: {
        seen: Number(row.is_seen) === 1,
        flagged: Number(row.is_flagged) === 1,
        answered: (Number(row.flags_bits) & 4) !== 0,
        draft: (Number(row.flags_bits) & 8) !== 0,
      },
      ...(row.snoozed_until_ms !== null
        ? { snoozedUntil: new Date(Number(row.snoozed_until_ms)).toISOString() }
        : {}),
      sync: {
        uid: Number(row.remote_uid ?? 0n),
        uidValidity: Number(row.uid_validity ?? 0n),
        internalDate: new Date(Number(row.internal_date_ms)).toISOString(),
      },
      headers,
    };
    const invoiceDetected = /invoice|发票/i.test(message.subject) ||
      attachments.some((attachment) => /invoice|发票/i.test(attachment.filename));
    return {
      message,
      bodyState,
      ...(archive ? { sentArchiveState: archive.state === "succeeded" ? "succeeded" as const : ["pending", "leased"].includes(archive.state) ? "pending" as const : "failed" as const } : {}),
      ...(row.error_code ? { bodyErrorCode: row.error_code } : {}),
      bodyAttempts: Number(row.retry_count ?? 0n),
      ...(row.retry_at_ms !== null
        ? { bodyNextRetryAt: new Date(Number(row.retry_at_ms)).toISOString() }
        : {}),
      // Missing/fetching content without a materialized content row is still
      // retryable. Only an explicit retryable=0 (typically a permanent
      // provider failure) should disable the foreground retry action.
      bodyRetryable: readyBodyMissing
        ? true
        : row.retryable === null
          ? row.body_state !== "ready"
          : Number(row.retryable) !== 0,
      invoiceDetected,
      invoiceStatus: this.invoiceStatuses?.getMailStatus(message.id, message.accountId) ?? null,
    };
  }

  getSyncCursor(
    accountPublicId: string,
    folderPath = "INBOX",
  ): import("../../../shared/wemail/mailDatabaseProtocol.js").MailDatabaseSyncCursorResult | null {
    const row = this.db.prepare(`
      SELECT state.cursor_json
      FROM mail_folder_sync_state state
      JOIN mail_folders folders ON folders.id = state.folder_id
      JOIN mail_accounts accounts ON accounts.id = folders.account_id
      WHERE accounts.public_id = ? AND folders.remote_path = ?
    `).get(accountPublicId, folderPath) as { cursor_json: string | null } | undefined;
    if (!row?.cursor_json) return null;
    try {
      const value = JSON.parse(row.cursor_json) as Record<string, unknown>;
      if (
        typeof value.uid !== "number" ||
        typeof value.uidValidity !== "number" ||
        typeof value.internalDate !== "string"
      ) return null;
      return {
        uid: value.uid,
        uidValidity: value.uidValidity,
        internalDate: value.internalDate,
      };
    } catch {
      return null;
    }
  }

  getSyncStates(accountPublicId: string): MailFolderSyncStates {
    const rows = this.db.prepare(`
      SELECT folders.remote_path, state.cursor_json
      FROM mail_folder_sync_state state
      JOIN mail_folders folders ON folders.id = state.folder_id
      JOIN mail_accounts accounts ON accounts.id = folders.account_id
      WHERE accounts.public_id = ? AND folders.deleted_at_ms IS NULL
    `).all(accountPublicId) as Array<{ remote_path: string; cursor_json: string | null }>;
    const states: MailFolderSyncStates = Object.create(null);
    for (const row of rows) {
      if (!row.cursor_json) continue;
      try {
        const parsed = MailFolderSyncStateSchema.safeParse(JSON.parse(row.cursor_json));
        if (parsed.success) states[row.remote_path] = parsed.data;
      } catch { /* Legacy invalid checkpoints are rebuilt from the remote window. */ }
    }
    return states;
  }

  listFolders(accountPublicId: string): MailCoreFolderResult[] {
    return (this.db.prepare(`
      SELECT folders.remote_path, folders.display_name,
             counts.total_count, counts.unread_count
      FROM mail_folders folders
      JOIN mail_accounts accounts ON accounts.id = folders.account_id
      LEFT JOIN mail_folder_counts counts ON counts.folder_id = folders.id
      WHERE accounts.public_id = ? AND folders.deleted_at_ms IS NULL
      ORDER BY folders.id
    `).all(accountPublicId) as Array<{
      remote_path: string;
      display_name: string;
      total_count: bigint | null;
      unread_count: bigint | null;
    }>).map((row) => ({
      id: row.remote_path,
      name: row.display_name,
      totalCount: Number(row.total_count ?? 0n),
      unreadCount: Number(row.unread_count ?? 0n),
    }));
  }

  listCategories(accountPublicId: string): MailCoreCategoryResult {
    return (this.db.prepare(`
      SELECT categories.key, categories.display_name,
             counts.total_count, counts.unread_count
      FROM mail_system_categories categories
      JOIN mail_accounts accounts ON accounts.public_id = ?
      LEFT JOIN mail_category_counts counts
        ON counts.account_id = accounts.id AND counts.category_id = categories.id
      WHERE categories.is_enabled = 1
      ORDER BY categories.sort_order, categories.id
    `).all(accountPublicId) as Array<{
      key: string;
      display_name: string;
      total_count: bigint | null;
      unread_count: bigint | null;
    }>).map((row) => ({
      id: row.key,
      label: row.display_name,
      count: Number(row.total_count ?? 0n),
      unreadCount: Number(row.unread_count ?? 0n),
      system: true,
    }));
  }

  listScheduled(accountPublicId: string, options?: { limit?: number; offset?: number }): MailDatabaseScheduledSendRecord[] {
    const limit = Math.min(200, Math.max(1, Math.floor(options?.limit ?? 200)));
    const offset = Math.max(0, Math.floor(options?.offset ?? 0));
    const rows = this.db.prepare(`
      SELECT outbox.id, outbox.public_id, accounts.public_id AS account_public_id,
             outbox.frozen_subject, outbox.frozen_body_text, outbox.frozen_body_html,
             outbox.state, outbox.scheduled_at_ms, outbox.last_error_code, outbox.delivery_json,
             outbox.created_at_ms, outbox.updated_at_ms
      FROM mail_outbox_items outbox
      JOIN mail_accounts accounts ON accounts.id = outbox.account_id
      WHERE accounts.public_id = ? AND (outbox.scheduled_at_ms IS NOT NULL OR outbox.state IN ('pending','leased','sending','failed','terminal','cancelled')
        OR (outbox.state = 'sent' AND CASE WHEN json_valid(outbox.delivery_json) THEN json_extract(outbox.delivery_json, '$.status') END = 'partial'))
      ORDER BY CASE WHEN outbox.state IN ('failed','terminal') OR (CASE WHEN json_valid(outbox.delivery_json) THEN json_extract(outbox.delivery_json, '$.status') END) = 'partial' THEN 0 ELSE 1 END,
        COALESCE(outbox.scheduled_at_ms, outbox.created_at_ms) DESC, outbox.id DESC
      LIMIT ? OFFSET ?
    `).all(accountPublicId, limit, offset) as Array<{
      id: bigint;
      public_id: string;
      account_public_id: string;
      frozen_subject: string;
      frozen_body_text: string | null;
      frozen_body_html: string | null;
      state: string;
      scheduled_at_ms: bigint | null;
      last_error_code: string | null;
      delivery_json: string | null;
      created_at_ms: bigint;
      updated_at_ms: bigint;
    }>;
    const recipientQuery = this.db.prepare(`
      SELECT kind, address_display, name_display
      FROM mail_outbox_recipients WHERE outbox_id = ?
      ORDER BY kind, ordinal
    `);
    return rows.map((row) => {
      const recipients: Record<"to" | "cc" | "bcc", WemailAddress[]> = {
        to: [],
        cc: [],
        bcc: [],
      };
      for (const recipient of recipientQuery.all(row.id) as Array<{
        kind: "to" | "cc" | "bcc";
        address_display: string;
        name_display: string | null;
      }>) {
        recipients[recipient.kind].push({
          email: recipient.address_display,
          ...(recipient.name_display ? { name: recipient.name_display } : {}),
        });
      }
      const delivery = parseDeliveryResult(row.delivery_json);
      const status: MailDatabaseScheduledSendRecord["status"] =
        row.state === "sent" ? (delivery?.status === "partial" ? "partial" : "sent")
          : row.state === "cancelled" ? "cancelled"
            : row.state === "leased" || row.state === "sending" ? "sending"
            : row.state === "failed" || row.state === "terminal" ? "failed"
              : "pending";
      return {
        id: row.public_id,
        accountId: row.account_public_id,
        payload: {
          accountId: row.account_public_id,
          to: recipients.to,
          cc: recipients.cc,
          bcc: recipients.bcc,
          subject: row.frozen_subject,
          bodyText: row.frozen_body_text ?? "",
          bodyHtml: row.frozen_body_html ?? "",
          attachments: [],
        },
        sendAt: new Date(Number(row.scheduled_at_ms ?? row.created_at_ms)).toISOString(),
        status,
        isScheduled: row.scheduled_at_ms !== null,
        ...(delivery ? { delivery } : {}),
        lastError: row.last_error_code,
        createdAt: new Date(Number(row.created_at_ms)).toISOString(),
        updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
      };
    });
  }

  listScheduledPage(accountPublicId: string, page = 1, limit = 50): MailDatabaseScheduledSendPage {
    const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
    const safePage = Math.max(1, Math.floor(page));
    const total = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM mail_outbox_items outbox
      JOIN mail_accounts accounts ON accounts.id = outbox.account_id
      WHERE accounts.public_id = ? AND (outbox.scheduled_at_ms IS NOT NULL OR outbox.state IN ('pending','leased','sending','failed','terminal','cancelled')
        OR (outbox.state = 'sent' AND CASE WHEN json_valid(outbox.delivery_json) THEN json_extract(outbox.delivery_json, '$.status') END = 'partial'))
    `).get(accountPublicId) as { total: bigint };
    const rows = this.listScheduled(accountPublicId, {
      limit: safeLimit + 1,
      offset: (safePage - 1) * safeLimit,
    });
    return {
      scheduled: rows.slice(0, safeLimit),
      totalCount: Number(total.total),
      hasMore: rows.length > safeLimit,
    };
  }

  schemaVersion(): number {
    const row = this.db.prepare(
      "SELECT value FROM db_meta WHERE key = 'schema_version'",
    ).get() as { value: string } | undefined;
    return row ? Number.parseInt(row.value, 10) : 0;
  }

  commitVersion(): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM db_commits",
    ).get() as { version: bigint };
    return Number(row.version);
  }

  changesSince(afterVersion: number, limit = 500): MailDatabaseChangesSinceResult {
    const current = this.commitVersion();
    if (afterVersion >= current) {
      return { commitVersion: current, changes: [], resetRequired: false };
    }
    const bounds = this.db.prepare(`
      SELECT MIN(commit_version) AS oldest FROM db_changes
    `).get() as { oldest: bigint | null };
    const oldest = bounds.oldest === null ? current : Number(bounds.oldest);
    if (afterVersion > 0 && afterVersion < oldest - 1) {
      return { commitVersion: current, changes: [], resetRequired: true };
    }
    const rows = this.db.prepare(`
      SELECT commit_version, entity_type, entity_public_id, operation, scope_hint
      FROM db_changes
      WHERE commit_version > ?
      ORDER BY commit_version, ordinal
      LIMIT ?
    `).all(afterVersion, Math.min(2_000, Math.max(1, limit))) as Array<{
      commit_version: bigint;
      entity_type: MailDatabaseChange["entityType"];
      entity_public_id: string;
      operation: MailDatabaseChange["operation"];
      scope_hint: string | null;
    }>;
    const lastVersion = rows.length > 0
      ? Number(rows.at(-1)!.commit_version)
      : current;
    return {
      commitVersion: lastVersion,
      changes: rows.map((row) => ({
        entityType: row.entity_type,
        entityPublicId: row.entity_public_id,
        operation: row.operation,
        ...(row.scope_hint ? { scopeHint: row.scope_hint } : {}),
      })),
      resetRequired: rows.length >= limit && lastVersion < current,
    };
  }

  private account(publicId: string): { id: bigint; email_address: string } | null {
    return (this.db.prepare(
      "SELECT id, email_address FROM mail_accounts WHERE public_id = ? AND state <> 'disabled'",
    ).get(publicId) as { id: bigint; email_address: string } | undefined) ?? null;
  }

  private listSource(
    params: MailCoreListParams,
    accountId: bigint,
  ): { fromSql: string; whereSql: string; bindings: Record<string, unknown> } {
    const whereClauses = ["source.account_id = @accountId"];
    const bindings: Record<string, unknown> = { accountId };

    // Keep the message list as the stable source row and apply folder,
    // category, and smart-tag scopes as independent EXISTS predicates. The
    // previous mutually-exclusive source selection meant `folder + category`
    // silently ignored the category and returned the whole inbox.
    if (params.folder) {
      whereClauses.push(`EXISTS (
        SELECT 1
        FROM mail_folder_memberships folder_membership
        JOIN mail_folders scoped_folder ON scoped_folder.id = folder_membership.folder_id
        WHERE folder_membership.message_id = source.message_id
          AND scoped_folder.account_id = @accountId
          AND scoped_folder.remote_path = @folder
      )`);
      bindings.folder = params.folder;
    }
    if (params.category) {
      whereClauses.push(`EXISTS (
        SELECT 1
        FROM mail_message_system_categories category_membership
        JOIN mail_system_categories scoped_category
          ON scoped_category.id = category_membership.category_id
        WHERE category_membership.message_id = source.message_id
          AND category_membership.account_id = @accountId
          AND scoped_category.key = @category
      )`);
      bindings.category = params.category;
    }
    if (params.smartTagId) {
      whereClauses.push(`EXISTS (
        SELECT 1
        FROM mail_message_user_tags tag_membership
        JOIN mail_user_tags scoped_tag ON scoped_tag.id = tag_membership.tag_id
        WHERE tag_membership.message_id = source.message_id
          AND tag_membership.account_id = @accountId
          AND scoped_tag.public_id = @smartTagId
      )`);
      bindings.smartTagId = params.smartTagId;
    }
    return {
      fromSql: `
        FROM (
          SELECT id AS message_id, account_id, received_at_ms,
                 is_seen, is_flagged, has_attachments
          FROM mail_messages
          WHERE account_id = @accountId AND deleted_at_ms IS NULL
        ) source
      `,
      whereSql: whereClauses.join(" AND "),
      bindings,
    };
  }

  private counts(params: MailCoreListParams, accountId: bigint): { total: number; unread: number } {
    const { fromSql, whereSql, bindings } = this.listSource(params, accountId);
    const clauses = ["count_messages.deleted_at_ms IS NULL"];
    bindings.nowMs = Date.now();
    if (params.scope === "snoozed") {
      clauses.push("count_messages.snoozed_until_ms > @nowMs");
    } else if (params.scope !== "all" && !params.allMail) {
      clauses.push("(count_messages.snoozed_until_ms IS NULL OR count_messages.snoozed_until_ms <= @nowMs)");
    }
    if (params.scope === "starred") clauses.push("source.is_flagged = 1");
    if (params.scope === "newsletter") clauses.push(`EXISTS (
      SELECT 1 FROM mail_message_headers count_newsletter_header
      WHERE count_newsletter_header.message_id = source.message_id
        AND count_newsletter_header.name_norm IN ('list-unsubscribe', 'list-id')
    )`);
    if (params.scope === "todos") clauses.push(`EXISTS (
      SELECT 1 FROM mail_todos count_open_todo
      WHERE count_open_todo.message_id = source.message_id
        AND count_open_todo.deleted_at_ms IS NULL
        AND count_open_todo.completed_at_ms IS NULL
        AND count_open_todo.source = 'ai'
    )`);
    if (params.unread) clauses.push("source.is_seen = 0");
    if (params.hasAttachment) clauses.push("source.has_attachments = 1");
    if (params.before) {
      clauses.push("source.received_at_ms < @before");
      bindings.before = Date.parse(params.before);
    }
    if (params.olderThan) {
      clauses.push("source.received_at_ms < @receivedBefore");
      bindings.receivedBefore = Date.now() - Number.parseInt(params.olderThan, 10) * 86_400_000;
    }
    if (params.toMe || params.ccMe) {
      const account = this.db.prepare(
        "SELECT email_address FROM mail_accounts WHERE id = ?",
      ).get(accountId) as { email_address: string };
      bindings.accountEmail = account.email_address.trim().toLowerCase();
      if (params.toMe) clauses.push(`EXISTS (
        SELECT 1 FROM mail_message_addresses recipients
        WHERE recipients.message_id = source.message_id
          AND recipients.kind = 'to' AND recipients.address_norm = @accountEmail
      )`);
      if (params.ccMe) clauses.push(`EXISTS (
        SELECT 1 FROM mail_message_addresses recipients
        WHERE recipients.message_id = source.message_id
          AND recipients.kind = 'cc' AND recipients.address_norm = @accountEmail
      )`);
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(source.is_seen = 0), 0) AS unread
      ${fromSql}
      JOIN mail_messages count_messages ON count_messages.id = source.message_id
      WHERE ${whereSql} AND ${clauses.join(" AND ")}
    `).get(bindings) as { total: bigint; unread: bigint };
    return { total: Number(row.total), unread: Number(row.unread) };
  }

  private toSummary(row: SummaryRow): MailCoreMessageSummary {
    return {
      id: row.public_id,
      accountId: row.account_public_id,
      folder: row.folder_path ?? "",
      messageId: row.rfc_message_id ?? row.public_id,
      ...(row.thread_public_id ? { threadId: row.thread_public_id } : {}),
      from: { email: row.sender_preview },
      to: row.recipient_preview
        ? row.recipient_preview.split(",").map((email) => ({ email: email.trim() })).filter((value) => value.email)
        : [],
      subject: row.subject,
      snippet: row.snippet,
      receivedAt: new Date(Number(row.received_at_ms)).toISOString(),
      ...(row.sent_at_ms !== null
        ? { sentAt: new Date(Number(row.sent_at_ms)).toISOString() }
        : {}),
      hasAttachments: Number(row.has_attachments) === 1,
      flags: {
        seen: Number(row.is_seen) === 1,
        flagged: Number(row.is_flagged) === 1,
        answered: (Number(row.flags_bits) & 4) !== 0,
        draft: (Number(row.flags_bits) & 8) !== 0,
      },
    };
  }

  private addresses(messageId: bigint): Record<"from" | "to" | "cc" | "bcc", WemailAddress[]> {
    const result: Record<"from" | "to" | "cc" | "bcc", WemailAddress[]> = {
      from: [],
      to: [],
      cc: [],
      bcc: [],
    };
    const rows = this.db.prepare(`
      SELECT addresses.kind, addresses.address_display, addresses.name_display,
        directory.name AS directory_name
      FROM mail_message_addresses addresses
      JOIN mail_messages messages ON messages.id = addresses.message_id
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      LEFT JOIN directory_active_contacts directory
        ON directory.account_id = accounts.public_id
        AND directory.email = addresses.address_norm COLLATE NOCASE
      WHERE addresses.message_id = ?
      ORDER BY addresses.kind, addresses.ordinal
    `).all(messageId) as Array<{
      kind: string;
      address_display: string;
      name_display: string | null;
      directory_name: string | null;
    }>;
    for (const row of rows) {
      const kind = row.kind === "from" || row.kind === "to" || row.kind === "cc" || row.kind === "bcc"
        ? row.kind
        : null;
      if (!kind) continue;
      result[kind].push({
        email: row.address_display,
        ...(row.name_display ? { name: row.name_display } : {}),
        ...(row.directory_name ? { directoryName: row.directory_name } : {}),
      });
    }
    return result;
  }

  private attachments(messageId: bigint): MailAttachment[] {
    return (this.db.prepare(`
      SELECT public_id, filename, media_type, byte_size, content_id, disposition
      FROM mail_attachments WHERE message_id = ? ORDER BY id
    `).all(messageId) as Array<{
      public_id: string;
      filename: string | null;
      media_type: string;
      byte_size: bigint;
      content_id: string | null;
      disposition: string | null;
    }>).map((row) => ({
      id: row.public_id,
      filename: row.filename ?? "",
      mimetype: row.media_type,
      size: Number(row.byte_size),
      contentId: row.content_id,
      disposition: row.disposition === "inline" || row.disposition === "attachment"
        ? row.disposition
        : null,
    }));
  }

  private headers(messageId: bigint): Record<string, string> {
    const rows = this.db.prepare(`
      SELECT name_norm, value_text
      FROM mail_message_headers
      WHERE message_id = ?
      ORDER BY name_norm, ordinal
    `).all(messageId) as Array<{ name_norm: string; value_text: string }>;
    return Object.fromEntries(rows.map((row) => [row.name_norm, row.value_text]));
  }

  private ftsQuery(query: string, scope: NonNullable<MailDatabaseSearchParams["scope"]>): string {
    const escaped = query.replaceAll('"', '""');
    const term = `"${escaped}"*`;
    switch (scope) {
      case "subject":
        return `subject_terms:${term}`;
      case "address":
        return `(sender_terms:${term} OR recipient_terms:${term})`;
      case "body":
        return `body_terms:${term}`;
      case "summary":
        return `summary_terms:${term}`;
      default:
        return `(
          subject_terms:${term} OR sender_terms:${term} OR recipient_terms:${term}
          OR body_terms:${term} OR attachment_terms:${term} OR summary_terms:${term}
        )`;
    }
  }

  private cjkFtsQuery(
    query: string,
    scope: NonNullable<MailDatabaseSearchParams["scope"]> | "sender" | "recipient",
  ): string {
    const phrase = `"${cjkSearchTerms(query)}"`;
    switch (scope) {
      case "subject":
        return `subject_terms:${phrase}`;
      case "address":
        return `(sender_terms:${phrase} OR recipient_terms:${phrase})`;
      case "sender":
        return `sender_terms:${phrase}`;
      case "recipient":
        return `recipient_terms:${phrase}`;
      case "body":
        return `body_terms:${phrase}`;
      case "summary":
        return `summary_terms:${phrase}`;
      default:
        return `(
          subject_terms:${phrase} OR sender_terms:${phrase} OR recipient_terms:${phrase}
          OR body_terms:${phrase} OR attachment_terms:${phrase} OR summary_terms:${phrase}
        )`;
    }
  }

  private cjkSearchIndexReady(): boolean {
    const row = this.db.prepare(
      "SELECT value FROM db_meta WHERE key = 'cjk_search_index_version'",
    ).get() as { value: string } | undefined;
    return row?.value === String(CJK_SEARCH_INDEX_VERSION);
  }

  private requiresCjkSearch(value: string): boolean {
    // unicode61 keeps contiguous Han text in coarse tokens. A user searching
    // for a meaningful fragment in the middle of such a token otherwise gets
    // no result even when the visible subject/body contains that text.
    return containsHan(value);
  }

  private substringSearchClause(
    scope: NonNullable<MailDatabaseSearchParams["scope"]> | "sender" | "recipient",
    binding: string,
  ): string {
    const contains = (column: string) =>
      `instr(lower(COALESCE(${column}, '')), @${binding}) > 0`;
    const body = `EXISTS (
      SELECT 1 FROM mail_message_content search_content
      WHERE search_content.message_id = messages.id
        AND (${contains("search_content.text_plain")} OR ${contains("search_content.html_sanitized")})
    )`;
    const summary = `EXISTS (
      SELECT 1
      FROM mail_message_ai_current search_current
      JOIN mail_ai_artifacts search_artifact ON search_artifact.id = search_current.artifact_id
      WHERE search_current.message_id = messages.id
        AND search_current.artifact_kind = 'summary'
        AND ${contains("search_artifact.text_value")}
    )`;
    const smartTag = this.smartTagSearchClause(binding);
    switch (scope) {
      case "subject":
        return contains("messages.subject");
      case "address":
        return `(${contains("messages.sender_preview")} OR ${contains("messages.recipient_preview")})`;
      case "sender":
        return contains("messages.sender_preview");
      case "recipient":
        return contains("messages.recipient_preview");
      case "body":
        return body;
      case "summary":
        return summary;
      default:
        return `(
          ${contains("messages.subject")}
          OR ${contains("messages.sender_preview")}
          OR ${contains("messages.recipient_preview")}
          OR ${body}
          OR ${summary}
          OR ${smartTag}
          OR EXISTS (
            SELECT 1 FROM mail_attachments search_attachment
            WHERE search_attachment.message_id = messages.id
              AND ${contains("search_attachment.filename")}
          )
        )`;
    }
  }

  /**
   * Smart-tag name substring match: a message hits when a live tag whose
   * normalized name contains the search word is attached to it.
   */
  private smartTagSearchClause(binding: string): string {
    return `EXISTS (
      SELECT 1 FROM mail_message_user_tags tag_links
      JOIN mail_user_tags tag_def ON tag_def.id = tag_links.tag_id
      WHERE tag_links.message_id = messages.id
        AND tag_links.account_id = messages.account_id
        AND tag_def.deleted_at_ms IS NULL
        AND instr(lower(tag_def.name_norm), @${binding}) > 0
    )`;
  }

  private draftRows(accountId: string, id: string | undefined, limit: number): DraftRow[] {
    return this.db.prepare(`
      SELECT drafts.id, drafts.public_id, accounts.public_id AS account_public_id,
        original.public_id AS original_public_id, drafts.subject, drafts.compose_type,
        drafts.body_text, drafts.body_html, drafts.created_at_ms, drafts.updated_at_ms
      FROM mail_drafts drafts
      JOIN mail_accounts accounts ON accounts.id = drafts.account_id
      LEFT JOIN mail_messages original ON original.id = drafts.reply_to_message_id
      WHERE accounts.public_id = ? AND (? IS NULL OR drafts.public_id = ?)
        AND drafts.state = 'editing'
      ORDER BY drafts.updated_at_ms DESC, drafts.public_id
      LIMIT ?
    `).all(accountId, id ?? null, id ?? null, limit) as DraftRow[];
  }

  private mapDraft(row: DraftRow): MailDraftRecord {
    const recipients: Record<"to" | "cc" | "bcc", WemailAddress[]> = {
      to: [],
      cc: [],
      bcc: [],
    };
    const rows = this.db.prepare(`
      SELECT kind, address_display, name_display
      FROM mail_draft_recipients
      WHERE draft_id = ?
      ORDER BY kind, ordinal
    `).all(row.id) as Array<{
      kind: string;
      address_display: string;
      name_display: string | null;
    }>;
    for (const recipient of rows) {
      if (recipient.kind !== "to" && recipient.kind !== "cc" && recipient.kind !== "bcc") continue;
      recipients[recipient.kind].push({
        email: recipient.address_display,
        ...(recipient.name_display ? { name: recipient.name_display } : {}),
      });
    }
    return {
      id: row.public_id,
      accountId: row.account_public_id,
      ...(row.original_public_id ? { originalEmailId: row.original_public_id } : {}),
      type: row.compose_type ?? (row.original_public_id ? "reply" : "new"),
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

  private ftsPhrase(value: string): string {
    return `"${value.normalize("NFKC").trim().toLowerCase().replaceAll('"', '""')}"`;
  }

  private scopeKey(params: MailCoreListParams): string {
    const scopes = [
      params.scope ? `scope:${params.scope}` : null,
      params.folder ? `folder:${params.folder}` : null,
      params.category ? `category:${params.category}` : null,
      params.smartTagId ? `tag:${params.smartTagId}` : null,
    ].filter((scope): scope is string => Boolean(scope));
    return scopes.join("|") || "all";
  }

  private filterHash(params: MailCoreListParams): string {
    return createHash("sha256").update(JSON.stringify({
      scope: params.scope ?? null,
      folder: params.folder ?? null,
      category: params.category ?? null,
      smartTagId: params.smartTagId ?? null,
      allMail: Boolean(params.allMail),
      unread: Boolean(params.unread),
      toMe: Boolean(params.toMe),
      ccMe: Boolean(params.ccMe),
      hasAttachment: Boolean(params.hasAttachment),
      olderThan: params.olderThan ?? null,
      before: params.before ?? null,
    })).digest("hex").slice(0, 16);
  }

  private encodeCursor(cursor: ListCursor): string {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  }

  private decodeCursor(value: string | undefined): ListCursor | null {
    if (!value) return null;
    try {
      const parsed = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8"),
      ) as Partial<ListCursor>;
      if (
        parsed.v !== 2 ||
        typeof parsed.accountId !== "string" ||
        typeof parsed.scope !== "string" ||
        typeof parsed.filterHash !== "string" ||
        typeof parsed.anchor?.time !== "number" ||
        typeof parsed.anchor?.id !== "string" ||
        typeof parsed.after?.time !== "number" ||
        typeof parsed.after?.id !== "string" ||
        typeof parsed.viewVersion !== "number"
      ) {
        throw new Error("invalid-cursor");
      }
      return parsed as ListCursor;
    } catch {
      throw new Error("invalid-cursor");
    }
  }
}
