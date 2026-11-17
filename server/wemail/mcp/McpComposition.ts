import type { AccountService } from "../account/AccountService.js";
import type { MailDatabase } from "../database/Database.js";
import type { MailFolder, MailProvider } from "../mail/MailProvider.js";
import type { SecretStore } from "../security/SecretStore.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type { TodoRecord, TodoRepository } from "../todos/TodoRepository.js";
import type { WemailMcpAccountCapabilities, WemailMcpFolderRole } from "../../../shared/wemail/mcp.js";
import { McpAccessTokenService } from "./McpAccessTokenService.js";
import type { McpDomainHandler } from "./McpDomainAdapters.js";
import { McpDomainError } from "./McpErrorMapper.js";
import { McpPublicRegistry } from "./McpPublicRegistry.js";
import { McpSessionManager } from "./McpSessionManager.js";
import { McpPreparedOperationRepository } from "./McpPreparedOperationRepository.js";
import { McpSettingsService } from "./McpSettingsService.js";
import { McpCursorCodec } from "./McpCursorCodec.js";
import type { AgentPendingActionRepository } from "../agent/AgentPendingActionRepository.js";
import type { AgentRunRepository } from "../agent/AgentRunRepository.js";
import { McpOperationService } from "./McpOperationService.js";
import type { MailAttachmentCache } from "../mail/MailAttachmentCache.js";
import { createHash } from "node:crypto";
import { McpAuditRepository } from "./McpAuditRepository.js";
import { McpIdempotencyRepository } from "./McpIdempotencyRepository.js";
import { randomUUID } from "node:crypto";
import type { MailAttachment, MailDraftRecord, MailMessage, WemailAddress } from "../../../shared/wemail/mail.js";
import type { MailCoreMessageSummary, MailRefreshResult } from "../../../shared/wemail/mailCoreProtocol.js";
import type { MailReceiptHealth } from "../../../shared/wemail/mailSync.js";
import {
  MCP_DEFAULT_MAX_ATTACHMENT_BYTES,
  MCP_DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
  validateMcpOutboundAttachments,
} from "./McpAttachmentInput.js";
import { McpAttachmentUploadStore } from "./McpAttachmentUploadStore.js";
import { resolveMcpAttachmentReferences } from "./McpAttachmentReferences.js";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import { resolveAiBodyText } from "../ai/context/ContextBuilder.js";
import type { IntelligenceService } from "../intelligence/IntelligenceService.js";
import type { SemanticSearchService } from "../search/SemanticSearchService.js";
import type { MailQaService } from "../search/MailQaService.js";
import type { DirectoryService } from "../directory/DirectoryService.js";
import type {
  EmailIntelligenceState,
  LinkExtractionResult,
  MailQaClaim,
  ReplyDraftResult,
  SemanticSearchChunk,
  SummaryResult,
  TagResult,
  TodoExtractionResult,
  TranslationResult,
} from "../../../shared/wemail/intelligence.js";
import type { DirectoryContactSummary } from "../../../shared/wemail/directory.js";
import type { ConversationState } from "../../../shared/wemail/conversationState.js";
import type { PersistedAgentRun } from "../../../shared/wemail/agentProtocol.js";

const MCP_THREAD_STRUCTURED_BUDGET_BYTES = 15 * 1024 * 1024;

export interface McpComposition {
  tokens: McpAccessTokenService;
  sessions: McpSessionManager;
  registry: McpPublicRegistry;
  operations: McpPreparedOperationRepository;
  settings: McpSettingsService;
  audit: McpAuditRepository;
  uploads: McpAttachmentUploadStore;
  close(): void;
}

export function deriveMcpAccountCapabilities(options: {
  imapHost: string;
  provider?: MailProvider;
}): WemailMcpAccountCapabilities {
  const gmail = options.imapHost.toLowerCase().includes("gmail");
  return {
    schemaVersion: 1,
    folderModel: gmail ? "labels" : "folders",
    threading: "synthesized",
    serverSearch: false,
    providerDrafts: false,
    sendAs: false,
    outboundAttachments: true,
    syncMode: options.provider?.syncAfterCursor ? "cursor" : "full",
    realtimeMode: options.provider?.supportsPushWatch?.() ? "idle" : "poll",
    maxAttachmentBytes: 25 * 1024 * 1024,
    maxRecipients: 200,
  };
}

function folderRole(folder: MailFolder): WemailMcpFolderRole {
  const value = `${folder.path} ${folder.name}`.toLowerCase();
  if (/\binbox\b/.test(value)) return "inbox";
  if (/\b(sent|sent items|已发送)\b/.test(value)) return "sent";
  if (/\b(draft|草稿)/.test(value)) return "drafts";
  if (/\b(archive|all mail|归档)\b/.test(value)) return "archive";
  if (/\b(trash|deleted|已删除|垃圾箱)\b/.test(value)) return "trash";
  if (/\b(spam|junk|垃圾邮件)\b/.test(value)) return "spam";
  return "custom";
}

function safeEnvelopeSnippet(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, "[link]").slice(0, 500);
}

function boundedUntrustedBody(value: string | undefined, maximum: number) {
  const source = value ?? "";
  return { value: source.slice(0, maximum), truncated: source.length > maximum };
}

function toMcpAddress(address: WemailAddress) {
  return {
    email: address.email,
    ...(address.name ? { name: address.name } : {}),
  };
}

/**
 * Project a stored message summary to the MCP envelope shape declared in
 * `mailEnvelopeOutput`. The DB summary carries fields (`messageId`, `to`,
 * `sentAt`, invoice flags) that the MCP output schema rejects
 * (`additionalProperties: false`); never spread the raw summary.
 */
export function toMcpEnvelope(message: MailCoreMessageSummary) {
  return {
    id: message.id,
    accountId: message.accountId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    folder: message.folder,
    from: toMcpAddress(message.from),
    subject: message.subject,
    snippet: safeEnvelopeSnippet(message.snippet),
    receivedAt: message.receivedAt,
    flags: message.flags,
    hasAttachments: message.hasAttachments,
  };
}

function toMcpAttachmentMetadata(attachment: MailAttachment | { id: string; filename: string; mimetype: string; size: number }) {
  const inbound = attachment as MailAttachment;
  return {
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimetype,
    size: attachment.size,
    ...(inbound.contentId ? { contentId: inbound.contentId } : {}),
    ...(inbound.disposition ? { disposition: inbound.disposition } : {}),
  };
}

function toMcpMessageDetail(message: MailMessage, maximum: number, includeHtml: boolean) {
  const text = boundedUntrustedBody(resolveAiBodyText(message).text, maximum);
  const html = boundedUntrustedBody(message.bodyHtml, maximum);
  return {
    id: message.id,
    accountId: message.accountId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    folder: message.folder,
    from: toMcpAddress(message.from),
    to: message.to.map(toMcpAddress),
    cc: message.cc.map(toMcpAddress),
    bcc: message.bcc.map(toMcpAddress),
    receivedAt: message.receivedAt,
    subject: message.subject,
    snippet: safeEnvelopeSnippet(message.snippet),
    attachments: message.attachments.map(toMcpAttachmentMetadata),
    bodyText: text.value,
    ...(includeHtml ? { bodyHtml: html.value } : {}),
    truncated: text.truncated || (includeHtml && html.truncated),
    contentTrust: "untrusted-provider-content" as const,
  };
}

function toMcpDraftDetail(draft: MailDraftRecord) {
  return {
    id: draft.id,
    accountId: draft.accountId,
    mode: draft.type,
    ...(draft.originalEmailId ? { sourceMessageId: draft.originalEmailId } : {}),
    to: draft.to.map(toMcpAddress),
    cc: draft.cc.map(toMcpAddress),
    bcc: draft.bcc.map(toMcpAddress),
    subject: draft.subject,
    bodyText: draft.bodyText,
    ...(draft.bodyHtml ? { bodyHtml: draft.bodyHtml } : {}),
    attachments: (draft.attachments ?? []).map(toMcpAttachmentMetadata),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

function toMcpTodo(todo: TodoRecord, mail?: CanonicalMailRepository) {
  const message = todo.emailId && mail ? mail.getMessageById(todo.emailId, todo.accountId) : null;
  return {
    id: todo.id, accountId: todo.accountId, title: todo.title,
    ...(todo.description ? { description: todo.description } : {}),
    priority: todo.priority ?? "medium",
    status: todo.done ? "completed" as const : todo.status,
    done: todo.done,
    ...(todo.startTime ? { startTime: todo.startTime } : {}),
    ...(todo.dueDate ? { dueTime: todo.dueDate } : {}),
    ...(todo.timezone ? { timezone: todo.timezone } : {}),
    source: todo.source,
    ...(todo.emailId ? { messageId: todo.emailId } : {}),
    ...(message ? { mail: { id: message.id, ...(message.threadId ? { threadId: message.threadId } : {}), subject: message.subject, from: toMcpAddress(message.from), receivedAt: message.receivedAt } } : {}),
    createdAt: todo.createdAt, updatedAt: todo.updatedAt,
  };
}

const MCP_INTELLIGENCE_MAX_TEXT = 8000;

function sliceText(value: string | undefined, maximum: number): { value: string; truncated: boolean } | null {
  if (value === undefined) return null;
  return { value: value.slice(0, maximum), truncated: value.length > maximum };
}

/**
 * Project the full per-capability intelligence state to the MCP
 * `get_mail_intelligence` output shape. Each capability reports `status`
 * plus a `ready` flag; result fields are projected only when present and
 * long text (draftMarkdown, translatedText) is bounded with a `truncated`
 * flag. Never spread the raw state — `additionalProperties: false` rejects
 * the nested `_metadata`, `job`, `system`, `signals` fields it carries.
 */
export function toMcpIntelligence(state: EmailIntelligenceState) {
  const summaryResult = state.summary.result as SummaryResult | undefined;
  const tagsResult = state.tags.result as TagResult | undefined;
  const replyDecisionResult = state.replyDecision.result;
  const replyDraftResult = state.replyDraft.result as ReplyDraftResult | undefined;
  const todoResult = state.todoExtraction?.result as TodoExtractionResult | undefined;
  const linkResult = state.linkExtraction?.result as LinkExtractionResult | undefined;
  const translationResult = state.translation?.result as TranslationResult | undefined;

  const summary = {
    status: state.summary.status,
    ready: state.summary.status === "succeeded" && !!summaryResult,
    ...(summaryResult ? {
      ...(summaryResult.urgency ? { urgency: summaryResult.urgency } : {}),
      ...(summaryResult.headline ? { headline: summaryResult.headline.slice(0, 500) } : {}),
      bullets: summaryResult.bullets.slice(0, 20).map((b) => b.slice(0, 500)),
      actionItems: summaryResult.actionItems.slice(0, 20).map((b) => b.slice(0, 500)),
    } : {}),
    ...(state.summary.error ? { error: state.summary.error.slice(0, 1000) } : {}),
    ...(state.summary.skipReason ? { skipReason: state.summary.skipReason.slice(0, 500) } : {}),
    ...(state.summary.canRetry !== undefined ? { canRetry: state.summary.canRetry } : {}),
  };

  const tags = {
    status: state.tags.status,
    ready: state.tags.status === "succeeded" && !!tagsResult,
    ...(tagsResult ? { tagNames: tagsResult.tags.map((t) => t.name).slice(0, 50) } : {}),
  };

  const replyDecision = {
    status: state.replyDecision.status,
    ready: state.replyDecision.status === "succeeded" && !!replyDecisionResult,
    ...(replyDecisionResult ? {
      shouldReply: replyDecisionResult.shouldReply,
      ...(replyDecisionResult.reason ? { reason: replyDecisionResult.reason.slice(0, 1000) } : {}),
    } : {}),
  };

  const replyDraft = {
    status: state.replyDraft.status,
    ready: state.replyDraft.status === "succeeded" && !!replyDraftResult,
    ...(replyDraftResult ? (() => {
      const draft = sliceText(replyDraftResult.draftMarkdown, MCP_INTELLIGENCE_MAX_TEXT)!;
      return {
        draftMarkdown: draft.value,
        truncated: draft.truncated,
        language: replyDraftResult.language.slice(0, 32),
      };
    })() : {}),
  };

  const intelligence: Record<string, unknown> = {
    emailId: state.emailId,
    summary,
    tags,
    replyDecision,
    replyDraft,
  };

  if (state.todoExtraction) {
    intelligence.todoExtraction = {
      status: state.todoExtraction.status,
      ready: state.todoExtraction.status === "succeeded" && !!todoResult,
      ...(todoResult ? { todoCount: Math.min(100, todoResult.todos.length) } : {}),
    };
  }
  if (state.linkExtraction) {
    intelligence.linkExtraction = {
      status: state.linkExtraction.status,
      ready: state.linkExtraction.status === "succeeded" && !!linkResult,
      ...(linkResult ? { linkCount: Math.min(100, linkResult.links.length) } : {}),
    };
  }
  if (state.translation) {
    intelligence.translation = {
      status: state.translation.status,
      ready: state.translation.status === "succeeded" && !!translationResult,
      ...(translationResult ? (() => {
        const translated = sliceText(translationResult.translatedText, MCP_INTELLIGENCE_MAX_TEXT)!;
        return {
          targetLanguage: translationResult.targetLanguage.slice(0, 32),
          translatedText: translated.value,
          truncated: translated.truncated,
        };
      })() : {}),
    };
  }
  return intelligence;
}

export function toMcpSearchChunk(chunk: SemanticSearchChunk) {
  return {
    emailId: chunk.emailId,
    chunkId: chunk.chunkId,
    score: chunk.score,
    snippet: chunk.snippet.slice(0, 1000),
    ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
    ...(chunk.subject ? { subject: chunk.subject } : {}),
    ...(chunk.sender ? { sender: chunk.sender } : {}),
    ...(chunk.recipient ? { recipient: chunk.recipient } : {}),
    ...(chunk.receivedAt ? { receivedAt: chunk.receivedAt } : {}),
    ...(chunk.folder ? { folder: chunk.folder } : {}),
    ...(chunk.read !== undefined ? { read: chunk.read } : {}),
    ...(chunk.starred !== undefined ? { starred: chunk.starred } : {}),
    ...(chunk.hasAttachments !== undefined ? { hasAttachments: chunk.hasAttachments } : {}),
  };
}

export function toMcpQaClaim(claim: MailQaClaim) {
  return {
    text: claim.text.slice(0, 2000),
    citations: claim.citations.slice(0, 10).map((c) => ({
      emailId: c.emailId,
      chunkId: c.chunkId,
      ...(c.quote ? { quote: c.quote.slice(0, 1000) } : {}),
    })),
  };
}

export function toMcpAgentRun(run: PersistedAgentRun) {
  return {
    id: run.id,
    conversationId: run.conversationId,
    state: run.state,
    lastSequence: run.lastSequence,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.settledAt ? { settledAt: run.settledAt } : {}),
    ...(run.interruptedAt ? { interruptedAt: run.interruptedAt } : {}),
    ...(run.errorCode ? { errorCode: run.errorCode } : {}),
  };
}

function textPreviewFromParts(parts: ConversationState["messages"][string]["parts"]): string {
  for (const part of parts) {
    if (part.type === "text" && typeof part.markdown === "string") {
      return part.markdown.slice(0, 500);
    }
  }
  return "";
}

/**
 * Project the full ConversationState to a bounded summary. The raw state
 * carries nested parts (markdown, tool input/output, citation maps) the
 * MCP output schema rejects; this projection keeps counts + the most
 * recent 20 messages/runs/confirmations with short previews only.
 */
export function toMcpConversationSummary(state: ConversationState) {
  const recentMessageIds = state.messageOrder.slice(-20);
  const recentMessages = recentMessageIds
    .map((id) => state.messages[id])
    .filter((m): m is ConversationState["messages"][string] => !!m)
    .map((m) => ({
      id: m.id,
      ...(m.runId ? { runId: m.runId } : {}),
      role: m.role,
      state: m.state,
      createdAt: m.createdAt,
      textPreview: textPreviewFromParts(m.parts),
    }));

  const runs = Object.values(state.runs).slice(0, 20).map((r) => ({
    id: r.id,
    state: r.state,
    lastSequence: r.lastSequence,
    ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    ...(r.settledAt ? { settledAt: r.settledAt } : {}),
    ...(r.error ? { errorCode: r.error.code } : {}),
  }));

  const pendingConfirmations = Object.values(state.confirmations).slice(0, 20).map((c) => ({
    id: c.id,
    actionType: c.actionType,
    description: c.description.slice(0, 500),
    riskLevel: c.riskLevel,
    status: c.status,
    expiresAt: c.expiresAt,
  }));

  return {
    conversationId: state.conversationId,
    messageCount: state.messageOrder.length,
    runCount: Object.keys(state.runs).length,
    toolCount: Object.keys(state.tools).length,
    pendingConfirmationCount: Object.keys(state.confirmations).length,
    followupCount: state.followupOrder.length,
    recentMessages,
    runs,
    pendingConfirmations,
  };
}

export function toMcpDirectoryContact(contact: DirectoryContactSummary) {
  return {
    id: contact.id,
    accountId: contact.accountId,
    name: contact.name,
    email: contact.email,
    aliases: contact.aliases.slice(0, 20),
    ...(contact.departmentId ? { departmentId: contact.departmentId } : {}),
    ...(contact.departmentPath ? { departmentPath: contact.departmentPath } : {}),
    ...(contact.title ? { title: contact.title.slice(0, 256) } : {}),
    // mobile / companyPhone intentionally stripped — PII.
  };
}

export function createMcpComposition(options: {
  db: MailDatabase;
  secrets: SecretStore;
  accounts: AccountService;
  mailDatabase: MailDatabaseClient;
  mail?: CanonicalMailRepository;
  todos?: TodoRepository;
  pendingActions?: AgentPendingActionRepository;
  attachmentCache?: MailAttachmentCache;
  intelligenceService?: IntelligenceService;
  semanticSearchService?: SemanticSearchService;
  mailQaService?: MailQaService;
  directoryService?: DirectoryService;
  agentRuns?: AgentRunRepository;
  limits?: {
    sessionConcurrentCalls?: number;
    defaultBodyCharacters?: number;
    maxBodyCharacters?: number;
    maxAttachmentBytes?: number;
    maxTotalAttachmentBytes?: number;
    maxPendingOperations?: number;
    maxUploadCountPerSession?: number;
    maxUploadBytesPerSession?: number;
    maxUploadBytesGlobal?: number;
    uploadTtlMs?: number;
  };
  getProvider(): MailProvider | undefined;
  /** Trigger an immediate mail metadata sync via the Mail Core worker. */
  refreshMail?: (accountId: string) => Promise<MailRefreshResult>;
  getMailReceipt?: (accountId: string) => MailReceiptHealth | null;
  /** Fetch an attachment's bytes through the Mail Core worker (MCP `get_mail_attachment`). */
  fetchAttachment?: (input: {
    accountId: string;
    remoteEmailId: string;
    partPath: string;
    source?: "inline" | "download";
    viewId?: string;
    signal?: AbortSignal;
  }) => Promise<{ bytes: Uint8Array; mediaType: string }>;
}): McpComposition {
  const settings = new McpSettingsService(options.db);
  const resolvePageSize = (input: Record<string, unknown>) => Math.min(
    settings.get().maxPageSize,
    typeof input.pageSize === "number" ? input.pageSize : settings.get().defaultPageSize,
  );
  const uploads = new McpAttachmentUploadStore({
    ttlMs: options.limits?.uploadTtlMs,
    maxUploadsPerSession: options.limits?.maxUploadCountPerSession,
    maxAttachmentBytes: options.limits?.maxAttachmentBytes,
    maxBytesPerSession: options.limits?.maxUploadBytesPerSession ?? options.limits?.maxTotalAttachmentBytes,
    maxBytesGlobal: options.limits?.maxUploadBytesGlobal,
  });
  const sessions = new McpSessionManager({
    maxConcurrentCalls: options.limits?.sessionConcurrentCalls,
    onTerminated: (session) => { uploads.purgeSession(session.sessionHash); },
  });
  const audit = new McpAuditRepository(options.db);
  const operations = new McpPreparedOperationRepository(options.db);
  if (typeof (options.db as { transaction?: unknown }).transaction === "function") {
    new McpIdempotencyRepository(options.db).reconcileStartup();
  }
  const cursors = new McpCursorCodec(options.secrets);
  // Bind each request to its receipt version: durable job IDs are reused between checks.
  const syncRecords = new Map<string, {
    id: string;
    accountId: string;
    folderId?: string;
    jobId?: number;
    receiptVersion?: number;
    runtimeId?: string;
    failure?: string;
    requestedAt: number;
  }>();
  type SyncRecord = NonNullable<ReturnType<typeof syncRecords.get>>;
  const rememberSync = (record: SyncRecord) => {
    syncRecords.set(record.id, record);
    const timer = setTimeout(() => syncRecords.delete(record.id), 5 * 60_000);
    timer.unref?.();
    return record;
  };
  const syncStateFromJob = (jobState: string): { state: string; phase: string; errorCode: string } => {
    if (jobState === "succeeded") return { state: "completed", phase: "done", errorCode: "" };
    if (jobState === "failed" || jobState === "terminal") return { state: "failed", phase: "done", errorCode: "sync_failed" };
    // `cancelled` is not a declared WemailMcpSyncState; map it onto `failed`
    // with a distinct errorCode so clients can tell cancellation from a real
    // failure while the projection stays within the shared contract.
    if (jobState === "cancelled") return { state: "failed", phase: "done", errorCode: "sync_cancelled" };
    return { state: "running", phase: "recent", errorCode: "" };
  };
  const renderSync = (record: SyncRecord) => {
    const now = new Date().toISOString();
    const base = { id: record.id, accountId: record.accountId, ...(record.folderId ? { folderId: record.folderId } : {}),
      processed: 0, total: 0, checkpoint: "", updatedAt: now };
    if (record.failure) return { ...base, state: "failed", phase: "done", errorCode: record.failure };
    if (record.runtimeId && record.receiptVersion !== undefined) {
      const receipt = options.getMailReceipt?.(record.accountId);
      if (!receipt || (receipt.observedAt !== undefined && receipt.observedAt <= record.requestedAt)) {
        return { ...base, state: "running", phase: "recent", errorCode: "" };
      }
      if (receipt.runtimeId !== record.runtimeId) return { ...base, state: "failed", phase: "done", errorCode: "sync_runtime_replaced" };
      if (receipt.completedVersion >= record.receiptVersion) return { ...base, state: "completed", phase: "done", errorCode: "" };
      if (receipt.failedVersion >= record.receiptVersion || receipt.stage === "credential-required") {
        return { ...base, state: "failed", phase: "done", errorCode: "sync_failed" };
      }
      return { ...base, state: "running", phase: "recent", errorCode: "" };
    }
    if (typeof record.jobId !== "number") {
      // No Mail Core job bound (e.g. refreshMail absent in tests) — report accepted.
      return { id: record.id, accountId: record.accountId, ...(record.folderId ? { folderId: record.folderId } : {}), state: "accepted", phase: "recent", processed: 0, total: 0, checkpoint: "", errorCode: "", updatedAt: now };
    }
    let jobState = "pending";
    let errorCode = "";
    try {
      const row = options.db.prepare("SELECT state, last_error_code AS error FROM mail_jobs WHERE id = ?").get(record.jobId) as { state?: string; error?: string | null } | undefined;
      jobState = row?.state ?? "pending";
      errorCode = row?.error ?? "";
    } catch {
      // DB read must never break the status response.
    }
    const mapped = syncStateFromJob(jobState);
    return { id: record.id, accountId: record.accountId, ...(record.folderId ? { folderId: record.folderId } : {}), state: mapped.state, phase: mapped.phase, processed: 0, total: 0, checkpoint: "", errorCode: errorCode || mapped.errorCode, updatedAt: now };
  };
  const tokens = new McpAccessTokenService({
    db: options.db,
    secrets: options.secrets,
    accountExists: (accountId) =>
      options.accounts.listAccounts().some((account) => account.id === accountId),
    onTokenRevoked: (tokenId) => sessions.terminateForToken(tokenId),
  });
  const operationService = options.mail && options.todos
    ? new McpOperationService({
        operations,
        db: options.db,
        mail: options.mail,
        mailDatabase: options.mailDatabase,
        todos: options.todos,
        getProvider: options.getProvider,
        uploads,
        maxAttachmentBytes: options.limits?.maxAttachmentBytes,
        maxTotalAttachmentBytes: options.limits?.maxTotalAttachmentBytes,
        maxPendingOperations: options.limits?.maxPendingOperations,
        getMaxRecipients: () => settings.get().maxRecipients,
        getMaxBatchMessages: () => settings.get().maxBatchMessages,
        getMaxPendingOperations: () => settings.get().maxPendingOperations,
      })
    : undefined;

  const requireAccount: McpDomainHandler = (_input, context) => {
    const account = options.accounts.getCurrentAccount();
    if (!account) throw new McpDomainError("account_not_found", "No active account.");
    if (account.id !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
    return account;
  };
  const registry = new McpPublicRegistry({
    list_mail_accounts: (_input, context) => {
      const account = options.accounts.getCurrentAccount();
      if (!account) return { accounts: [] };
      if (account.id !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
      return {
        accounts: [{
          id: account.id,
          provider: account.imap.host,
          email: account.emailAddress,
          ...(account.displayName ? { displayName: account.displayName } : {}),
            capabilities: {
              ...deriveMcpAccountCapabilities({ imapHost: account.imap.host, provider: options.getProvider() }),
              maxRecipients: settings.get().maxRecipients,
            },
        }],
      };
    },
    list_mail_folders: async (input, context) => {
      await requireAccount(input, context);
      if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
      const folders = await options.mailDatabase.listFolders(context.accountId);
      return {
        folders: folders.slice(0, 500).map((folder) => ({
          id: folder.id,
          name: folder.name,
          role: folderRole({ path: folder.id, name: folder.name }),
          selectable: true,
          model: "folder" as const,
        })),
      };
    },
    sync_mail_account: async (input, context) => {
      if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
      const folderId = typeof input.folderId === "string" ? input.folderId : undefined;
      const id = `sync-${randomUUID()}`;
      const requestedAt = Date.now();
      let jobId: number | undefined;
      let receiptVersion: number | undefined;
      let runtimeId: string | undefined;
      let failure: string | undefined;
      if (options.refreshMail) {
        try {
          const result = await options.refreshMail(context.accountId);
          if (result.status === "queued" && typeof result.jobId === "number") {
            jobId = result.jobId;
            receiptVersion = result.receiptVersion;
            runtimeId = result.runtimeId;
          } else failure = "sync_account_unavailable";
        } catch {
          // Surface as a failed sync job rather than a transport internal_error.
          failure = "sync_request_failed";
        }
      }
      // ponytail: when refreshMail is absent (tests / E2E), the Mail Core worker
      // still auto-syncs via IMAP IDLE; report "accepted" rather than failing.
      const record = rememberSync({ id, accountId: context.accountId, ...(folderId ? { folderId } : {}),
        ...(jobId !== undefined ? { jobId } : {}), receiptVersion, runtimeId, failure, requestedAt });
      const sync = renderSync(record);
      return { sync: { id: sync.id, state: sync.state, phase: sync.phase, processed: sync.processed, updatedAt: sync.updatedAt } };
    },
    get_mail_sync_status: (input, context) => {
      const record = syncRecords.get(String(input.syncId));
      if (!record || record.accountId !== context.accountId) throw new McpDomainError("operation_not_found", "Sync was not found.");
      return { sync: renderSync(record) };
    },
    list_mail_messages: async (input, context) => {
      if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
      const pageSize = resolvePageSize(input);
      const result = await options.mailDatabase.listMail({
        accountId: context.accountId,
        folder: String(input.folderId),
        unread: input.unreadOnly === true,
        limit: pageSize,
        cursor: typeof input.cursor === "string" ? input.cursor : undefined,
      });
      return {
        items: result.messages.map(toMcpEnvelope),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    },
    search_mail: async (input, context) => {
      if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
      const result = await options.mailDatabase.search({
        accountId: context.accountId,
        query: String(input.query).trim(),
        folder: input.folderId as string | undefined,
        limit: resolvePageSize(input),
        cursor: typeof input.cursor === "string" ? input.cursor : undefined,
      });
      return {
        mode: "local" as const,
        items: result.messages.map(toMcpEnvelope),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    },
    get_mail_message: async (input, context) => {
      if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
      const snapshot = await options.mailDatabase.getMailSnapshot(String(input.messageId));
      const message = snapshot.message;
      if (!message || message.accountId !== context.accountId) throw new McpDomainError("message_not_found", "Message not found.");
      const maximum = Math.min(
        options.limits?.maxBodyCharacters ?? settings.get().maxBodyCharacters,
        typeof input.maxBodyCharacters === "number"
          ? input.maxBodyCharacters
          : options.limits?.defaultBodyCharacters ?? settings.get().defaultBodyCharacters,
      );
      return { message: toMcpMessageDetail(message, maximum, input.includeHtml === true) };
    },
    set_mail_state: async (input, context) => {
      if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
      const action = String(input.action);
      const patch = action === "mark_read" ? { seen: true } : action === "mark_unread" ? { seen: false } : action === "star" ? { flagged: true } : { flagged: false };
      const result = await options.mailDatabase.mutateMail(
        {
          accountId: context.accountId,
          emailId: String(input.messageId),
          mutation: { type: "flags", patch },
        },
        `mcp:${context.sessionHash}:${String(input.messageId)}:${action}`,
      );
      if (!result.value.message) throw new McpDomainError("message_not_found", "Message not found.");
      return {
        messageId: result.value.message.id,
        action,
        flags: {
          seen: result.value.message.flags.seen,
          flagged: result.value.message.flags.flagged,
        },
      };
    },
    ...(options.mail ? {
      get_mail_thread: (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const pageSize = resolvePageSize(input);
        const maximum = Math.min(
          options.limits?.maxBodyCharacters ?? settings.get().maxBodyCharacters,
          typeof input.maxBodyCharacters === "number"
            ? input.maxBodyCharacters
            : options.limits?.defaultBodyCharacters ?? settings.get().defaultBodyCharacters,
        );
        const filters = { threadId: input.threadId, maxBodyCharacters: maximum, includeHtml: input.includeHtml === true };
        const offset = typeof input.cursor === "string"
          ? cursors.decode<{ offset: number }>(input.cursor, { accountId: context.accountId, tool: "get_mail_thread", filters, order: "received_asc" }).offset
          : 0;
        const rows = options.mail!.getMcpThreadPage({ accountId: context.accountId, threadId: String(input.threadId), offset, limit: pageSize + 1 });
        if (offset === 0 && rows.length === 0) throw new McpDomainError("thread_not_found", "Thread not found.");
        const threadId = String(input.threadId);
        const candidates = rows.slice(0, pageSize).map((message) => toMcpMessageDetail(message, maximum, input.includeHtml === true));
        const messages: ReturnType<typeof toMcpMessageDetail>[] = [];
        for (const candidate of candidates) {
          const next = [...messages, candidate];
          const bytes = Buffer.byteLength(JSON.stringify({ accountId: context.accountId, threadId, messages: next }), "utf8");
          if (messages.length > 0 && bytes > MCP_THREAD_STRUCTURED_BUDGET_BYTES) break;
          messages.push(candidate);
        }
        const returned = messages.length;
        return {
          accountId: context.accountId,
          threadId,
          messages,
          ...(rows.length > returned ? { nextCursor: cursors.encode({ accountId: context.accountId, tool: "get_mail_thread", filters, order: "received_asc", position: { offset: offset + returned } }) } : {}),
        };
      },
      ...(options.attachmentCache ? {
        get_mail_attachment: async (input, context) => {
          if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
          const message = options.mail!.getMessageById(String(input.messageId), context.accountId);
          if (!message) throw new McpDomainError("message_not_found", "Message not found.");
          const attachment = message.attachments.find((item) => item.id === input.attachmentId);
          if (!attachment) throw new McpDomainError("attachment_not_found", "Attachment not found.");
          const maximum = options.limits?.maxAttachmentBytes ?? 25 * 1024 * 1024;
          if (attachment.size > maximum) throw new McpDomainError("attachment_too_large", "Attachment is too large.");
          const provider = options.getProvider();
          const gateway = options.fetchAttachment;
          if (!provider?.fetchAttachment && !gateway) throw new McpDomainError("capability_not_supported", "Attachment fetch is unavailable.");
          const descriptor = gateway && options.mail
            ? options.mail.getAttachmentFetchDescriptor(message.id, String(input.attachmentId))
            : null;
          const cached = await options.attachmentCache!.getOrLoad(
            `${context.accountId}:${message.id}:${attachment.id}`,
            async (signal) => {
              if (provider?.fetchAttachment) {
                const fetched = await provider.fetchAttachment(message.id, attachment.id, signal);
                if (!fetched) throw new McpDomainError("attachment_not_found", "Attachment not found.");
                if (fetched.mimetype.toLowerCase() !== attachment.mimetype.toLowerCase()) {
                  throw new McpDomainError("invalid_request", "Attachment MIME metadata did not match fetched content.");
                }
                return Buffer.from(fetched.bytes);
              }
              if (!descriptor) throw new McpDomainError("attachment_not_found", "Attachment fetch descriptor was not found.");
              const fetched = await gateway!({
                accountId: context.accountId,
                remoteEmailId: descriptor.remoteEmailId,
                partPath: descriptor.partPath,
                source: descriptor.disposition === "inline" ? "inline" : "download",
                signal,
              });
              if (fetched.mediaType.toLowerCase() !== attachment.mimetype.toLowerCase()) {
                throw new McpDomainError("invalid_request", "Attachment MIME metadata did not match fetched content.");
              }
              return Buffer.from(fetched.bytes);
            },
            context.signal,
          );
          if (cached.bytes.byteLength > maximum) throw new McpDomainError("attachment_too_large", "Attachment is too large.");
          if (cached.bytes.byteLength !== attachment.size) throw new McpDomainError("invalid_request", "Attachment byte count was incomplete or mismatched.");
          const opaque = createHash("sha256").update(`${context.sessionHash}\0${context.accountId}\0${message.id}\0${attachment.id}`).digest("hex");
          const uri = `wemail-attachment://${context.sessionHash}/${opaque}`;
          return {
            structuredContent: { resource: { uri, filename: attachment.filename, mimeType: attachment.mimetype, size: cached.bytes.byteLength, sessionBound: true } },
            content: [{ type: "resource" as const, resource: { uri, mimeType: attachment.mimetype, blob: cached.bytes.toString("base64") } }],
          };
        },
      } : {}),
      upload_mail_attachment: (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        return uploads.upload({
          sessionHash: context.sessionHash,
          accountId: context.accountId,
          filename: input.filename,
          mimeType: input.mimeType,
          size: input.size,
          dataBase64: input.dataBase64,
        });
      },
      list_mail_drafts: (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const pageSize = resolvePageSize(input);
        const filters = {};
        const before = typeof input.cursor === "string"
          ? cursors.decode<{ updatedAt: string }>(input.cursor, { accountId: context.accountId, tool: "list_mail_drafts", filters, order: "updated_desc" }).updatedAt
          : undefined;
        const rows = options.mail!.listDrafts({ accountId: context.accountId, limit: pageSize + 1, before });
        const page = rows.slice(0, pageSize);
        const last = page.at(-1);
        return {
          drafts: page.map((draft) => ({
            id: draft.id,
            accountId: draft.accountId,
            mode: draft.type,
            subject: draft.subject,
            bodyExcerpt: draft.bodyText.slice(0, 240),
            updatedAt: draft.updatedAt,
          })),
          ...(rows.length > pageSize && last ? { nextCursor: cursors.encode({ accountId: context.accountId, tool: "list_mail_drafts", filters, order: "updated_desc", position: { updatedAt: last.updatedAt } }) } : {}),
        };
      },
      get_mail_draft: (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const draft = options.mail!.getDraftById(String(input.draftId));
        if (!draft || draft.accountId !== context.accountId) throw new McpDomainError("draft_not_found", "Draft not found.");
        return { draft: toMcpDraftDetail(draft) };
      },
      create_mail_draft: async (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const mode = String(input.mode);
        const recipients = [input.to, input.cc, input.bcc].flatMap((value) => Array.isArray(value) ? value : []);
        if (recipients.length > settings.get().maxRecipients) throw new McpDomainError("invalid_arguments", "Too many recipients.");
        const sourceMessageId = typeof input.sourceMessageId === "string" ? input.sourceMessageId : undefined;
        if (mode !== "new" && !sourceMessageId) throw new McpDomainError("invalid_arguments", "Source message is required.");
        if (sourceMessageId && !options.mail!.getMessageById(sourceMessageId, context.accountId)) throw new McpDomainError("message_not_found", "Message not found.");
        const attachments = Array.isArray(input.attachments)
          ? resolveMcpAttachmentReferences(input.attachments, {
              uploads,
              sessionHash: context.sessionHash,
              accountId: context.accountId,
              allowExistingAttachmentIds: false,
              maxAttachmentBytes: options.limits?.maxAttachmentBytes ?? MCP_DEFAULT_MAX_ATTACHMENT_BYTES,
              maxTotalAttachmentBytes: options.limits?.maxTotalAttachmentBytes ?? MCP_DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
            })
          : [];
        if (attachments.length > 0) {
          throw new McpDomainError("capability_not_supported", "Draft attachments cannot be persisted.");
        }
        const draft = await options.mail!.saveDraft({
          accountId: context.accountId,
          composeType: mode === "forward" ? "forward" : mode === "new" ? "new" : "reply",
          originalEmailId: sourceMessageId,
          to: Array.isArray(input.to) ? input.to as any : [],
          cc: Array.isArray(input.cc) ? input.cc as any : [],
          bcc: Array.isArray(input.bcc) ? input.bcc as any : [],
          subject: typeof input.subject === "string" ? input.subject : "",
          bodyText: typeof input.bodyText === "string" ? input.bodyText : "",
          bodyHtml: typeof input.bodyHtml === "string" ? input.bodyHtml : "",
          // Non-empty attachments are rejected above until blob staging exists.
          attachments: [],
        });
        return { draft: { id: draft.id, accountId: draft.accountId, subject: draft.subject, updatedAt: draft.updatedAt, sent: false } };
      },
      update_mail_draft: async (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const existing = options.mail!.getDraftById(String(input.draftId));
        if (!existing || existing.accountId !== context.accountId) throw new McpDomainError("draft_not_found", "Draft not found.");
        const to = Array.isArray(input.to) ? input.to as any : existing.to;
        const cc = Array.isArray(input.cc) ? input.cc as any : existing.cc;
        const bcc = Array.isArray(input.bcc) ? input.bcc as any : existing.bcc;
        if (to.length + cc.length + bcc.length > settings.get().maxRecipients) throw new McpDomainError("invalid_arguments", "Too many recipients.");
        const sourceMessageId = typeof input.sourceMessageId === "string" ? input.sourceMessageId : existing.originalEmailId;
        if (sourceMessageId && !options.mail!.getMessageById(sourceMessageId, context.accountId)) throw new McpDomainError("message_not_found", "Message not found.");
        const attachments = Array.isArray(input.attachments)
          ? resolveMcpAttachmentReferences(input.attachments, {
              uploads,
              sessionHash: context.sessionHash,
              accountId: context.accountId,
              existingAttachments: existing.attachments,
              allowExistingAttachmentIds: true,
              maxAttachmentBytes: options.limits?.maxAttachmentBytes ?? MCP_DEFAULT_MAX_ATTACHMENT_BYTES,
              maxTotalAttachmentBytes: options.limits?.maxTotalAttachmentBytes ?? MCP_DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
            })
          : validateMcpOutboundAttachments(existing.attachments ?? [], {
              maxAttachmentBytes: options.limits?.maxAttachmentBytes ?? MCP_DEFAULT_MAX_ATTACHMENT_BYTES,
              maxTotalAttachmentBytes: options.limits?.maxTotalAttachmentBytes ?? MCP_DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
            });
        if (attachments.length > 0) {
          throw new McpDomainError("capability_not_supported", "Draft attachments cannot be persisted.");
        }
        const draft = await options.mail!.updateDraft({
          id: existing.id,
          accountId: context.accountId,
          composeType: existing.type,
          originalEmailId: sourceMessageId,
          to,
          cc,
          bcc,
          subject: typeof input.subject === "string" ? input.subject : existing.subject,
          bodyText: typeof input.bodyText === "string" ? input.bodyText : existing.bodyText,
          bodyHtml: typeof input.bodyHtml === "string" ? input.bodyHtml : existing.bodyHtml,
          // Non-empty attachments are rejected above until blob staging exists.
          attachments: [],
        });
        if (!draft) throw new McpDomainError("draft_not_found", "Draft not found.");
        return { draft: { id: draft.id, accountId: draft.accountId, subject: draft.subject, updatedAt: draft.updatedAt, sent: false } };
      },
    } : {}),
    ...(options.todos ? {
      list_todos: (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const pageSize = resolvePageSize(input);
        const filters = { status: input.status, priority: input.priority, dueAfter: input.dueAfter, dueBefore: input.dueBefore, messageId: input.messageId };
        const offset = typeof input.cursor === "string"
          ? cursors.decode<{ offset: number }>(input.cursor, { accountId: context.accountId, tool: "list_todos", filters, order: "due_asc" }).offset
          : 0;
        const rows = options.todos!.listPage({
          accountId: context.accountId,
          status: input.status as any,
          priority: input.priority as any,
          dueAfter: input.dueAfter as string | undefined,
          dueBefore: input.dueBefore as string | undefined,
          emailId: input.messageId as string | undefined,
          limit: pageSize + 1,
          offset,
        });
        return {
          todos: rows.slice(0, pageSize).map((todo) => toMcpTodo(todo, options.mail)),
          ...(rows.length > pageSize ? { nextCursor: cursors.encode({ accountId: context.accountId, tool: "list_todos", filters, order: "due_asc", position: { offset: offset + pageSize } }) } : {}),
        };
      },
      get_todo: (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const todo = options.todos!.getById(String(input.todoId));
        if (!todo || todo.accountId !== context.accountId) throw new McpDomainError("todo_not_found", "Todo not found.");
        return { todo: toMcpTodo(todo, options.mail) };
      },
      create_todo: (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const messageId = typeof input.messageId === "string" ? input.messageId : undefined;
        if (messageId && (!options.mail || !options.mail.getMessageById(messageId, context.accountId))) throw new McpDomainError("message_not_found", "Message not found.");
        const todo = options.todos!.createManual({
          accountId: context.accountId, emailId: messageId, title: String(input.title),
          description: input.description as string | undefined, priority: input.priority as any,
          startTime: input.startTime as string | undefined, dueDate: input.dueTime as string | undefined,
          timezone: input.timezone as string | undefined, source: "mcp",
        });
        return { todo: toMcpTodo(todo, options.mail) };
      },
      update_todo: (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const todo = options.todos!.updateManual({
          id: String(input.todoId), accountId: context.accountId,
          title: input.title as string | undefined, description: input.description as string | undefined,
          priority: input.priority as any, startTime: input.startTime as string | undefined,
          dueDate: input.dueTime as string | undefined, timezone: input.timezone as string | undefined,
        });
        if (!todo) throw new McpDomainError("todo_not_found", "Todo not found.");
        return { todo: toMcpTodo(todo, options.mail) };
      },
      complete_todo: (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const existing = options.todos!.getById(String(input.todoId));
        if (!existing || existing.accountId !== context.accountId) throw new McpDomainError("todo_not_found", "Todo not found.");
        return { todo: toMcpTodo(options.todos!.complete(existing.id)!, options.mail) };
      },
      restore_todo: (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const existing = options.todos!.getById(String(input.todoId));
        if (!existing || existing.accountId !== context.accountId) throw new McpDomainError("todo_not_found", "Todo not found.");
        return { todo: toMcpTodo(options.todos!.restore(existing.id)!, options.mail) };
      },
    } : {}),
    ...(operationService ? {
      prepare_mail_actions: (input, context) => operationService.prepareMailActions(input, context),
      prepare_mail_send: (input, context) => operationService.prepareMailSend(input, context),
      prepare_delete_entity: (input, context) => operationService.prepareDeleteEntity(input, context),
      commit_mail_operation: (input, context) => operationService.commit(input.operationId, input.idempotencyKey, context.accountId),
      get_mail_operation_status: (input, context) => operationService.getStatus(input.operationId, context.accountId),
      cancel_mail_operation: (input, context) => operationService.cancel(input.operationId, context.accountId),
    } : {}),
    ...(options.intelligenceService && options.mailDatabase ? {
      get_mail_intelligence: async (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const snapshot = await options.mailDatabase!.getMailSnapshot(String(input.messageId));
        const message = snapshot.message;
        if (!message || message.accountId !== context.accountId) throw new McpDomainError("message_not_found", "Message not found.");
        const state = await options.intelligenceService!.getState(message.id);
        return { intelligence: toMcpIntelligence(state) };
      },
    } : {}),
    ...(options.semanticSearchService ? {
      search_mail_semantic: async (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const result = await options.semanticSearchService!.search({
          accountId: context.accountId,
          query: String(input.query).trim(),
          limit: Math.min(settings.get().maxPageSize, typeof input.limit === "number" ? input.limit : settings.get().defaultPageSize),
          offset: typeof input.offset === "number" ? input.offset : 0,
        });
        return {
          mode: result.mode,
          chunks: result.chunks.slice(0, settings.get().maxPageSize).map(toMcpSearchChunk),
          totalChunks: result.totalChunks,
        };
      },
    } : {}),
    ...(options.mailQaService ? {
      ask_mail_question: async (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const result = await options.mailQaService!.answer({
          accountId: context.accountId,
          question: String(input.question).trim(),
          maxChunks: Math.min(settings.get().maxPageSize, typeof input.maxChunks === "number" ? input.maxChunks : settings.get().defaultPageSize),
        });
        const answerText = result.answer ?? "";
        const bounded = sliceText(answerText, MCP_INTELLIGENCE_MAX_TEXT);
        return {
          hasEvidence: result.hasEvidence,
          ...(result.hasEvidence && bounded ? { answer: bounded.value, truncated: bounded.truncated } : {}),
          claims: result.claims.slice(0, settings.get().maxPageSize).map(toMcpQaClaim),
          mode: result.mode,
          retrievedChunkCount: result.retrievedChunkCount,
        };
      },
    } : {}),
    ...(options.intelligenceService && options.mailDatabase ? {
      record_tag_feedback: async (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const snapshot = await options.mailDatabase!.getMailSnapshot(String(input.messageId));
        const message = snapshot.message;
        if (!message || message.accountId !== context.accountId) throw new McpDomainError("message_not_found", "Message not found.");
        const caller = { source: "agent" as const, sessionId: context.sessionHash };
        const tag = String(input.tag);
        const action = String(input.action);
        if (action === "confirm") {
          await options.intelligenceService!.confirmTag(message.id, tag, caller);
        } else {
          await options.intelligenceService!.rejectTag(message.id, tag, caller);
        }
        return { messageId: message.id, tag, action, recorded: true };
      },
    } : {}),
    ...(options.agentRuns ? {
      list_agent_attention: (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const failureSince = new Date(Date.now() - 60 * 60_000).toISOString();
        const result = options.agentRuns!.listAttention(context.accountId, failureSince);
        return {
          active: result.active.slice(0, 50).map(toMcpAgentRun),
          failed: result.failed.slice(0, 50).map(toMcpAgentRun),
          pausedConversationIds: result.pausedConversationIds.slice(0, 100),
          failureSince,
        };
      },
    } : {}),
    ...(options.agentRuns && options.pendingActions ? {
      get_conversation_state: (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const conversationId = String(input.conversationId);
        const ownerAccountId = options.pendingActions!.getAccountIdForConversation(conversationId);
        if (ownerAccountId !== null && ownerAccountId !== context.accountId) {
          throw new McpDomainError("account_mismatch", "Account mismatch.");
        }
        const state = options.agentRuns!.loadConversationState(conversationId);
        return { conversation: toMcpConversationSummary(state) };
      },
    } : {}),
    ...(options.directoryService ? {
      search_directory_contacts: async (input, context) => {
        if (input.accountId !== context.accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
        const result = await options.directoryService!.searchContacts(
          context.accountId,
          String(input.query ?? "").trim(),
          {
            ...(typeof input.departmentId === "string" ? { departmentId: input.departmentId } : {}),
            limit: Math.min(settings.get().maxPageSize, typeof input.limit === "number" ? input.limit : settings.get().defaultPageSize),
            offset: typeof input.offset === "number" ? input.offset : 0,
          },
        );
        return {
          contacts: result.contacts.slice(0, settings.get().maxPageSize).map(toMcpDirectoryContact),
          total: result.total,
          remoteAvailable: result.remoteAvailable,
        };
      },
    } : {}),
  });
  const uploadMaintenance = setInterval(() => {
    uploads.cleanupExpired();
  }, 60_000);
  uploadMaintenance.unref?.();
  const maintenance = setInterval(() => {
    operations.expireDue();
    audit.deleteBefore(new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString());
    const terminalCutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
    operations.deleteTerminalBefore(terminalCutoff);
    tokens.deleteRevokedBefore(terminalCutoff);
  }, 60 * 60_000);
  maintenance.unref?.();
  return {
    tokens,
    sessions,
    registry,
    operations,
    settings,
    audit,
    uploads,
    close: () => {
      clearInterval(uploadMaintenance);
      clearInterval(maintenance);
      sessions.closeAll();
      uploads.clear();
    },
  };
}
