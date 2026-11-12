import { createHash, randomUUID } from "node:crypto";
import type { WemailDraftInput } from "../../../shared/wemail/mail.js";
import type { MailProvider } from "../mail/MailProvider.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import type { TodoRepository } from "../todos/TodoRepository.js";
import { McpDomainError } from "./McpErrorMapper.js";
import { McpIdempotencyRepository } from "./McpIdempotencyRepository.js";
import {
  McpPreparedOperationRepository,
  type McpPreparedOperationRecord,
} from "./McpPreparedOperationRepository.js";
import {
  MCP_DEFAULT_MAX_ATTACHMENT_BYTES,
  MCP_DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
  validateMcpOutboundAttachments,
} from "./McpAttachmentInput.js";
import { resolveMcpAttachmentReferences } from "./McpAttachmentReferences.js";
import type { McpAttachmentUploadStore } from "./McpAttachmentUploadStore.js";

type MailAction = "archive" | "move" | "trash" | "restore" | "spam" | "unspam" | "delete_forever";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalMcpPayload(value: Record<string, unknown>): Record<string, unknown> {
  return canonicalize(value) as Record<string, unknown>;
}

export function hashMcpValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function operationView(operation: McpPreparedOperationRecord) {
  return {
    id: operation.id,
    accountId: operation.accountId,
    type: operation.operationType,
    state: operation.state,
    preview: operation.preview,
    payloadHash: operation.payloadHash,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    expiresAt: operation.expiresAt,
    executed: operation.state === "succeeded",
    retryable: operation.state === "failed_retryable",
    ...(operation.resultCode ? { resultCode: operation.resultCode } : {}),
  };
}

export class McpOperationService {
  readonly idempotency: McpIdempotencyRepository;

  constructor(private readonly options: {
    operations: McpPreparedOperationRepository;
    db: ConstructorParameters<typeof McpIdempotencyRepository>[0];
    mail: CanonicalMailRepository;
    mailDatabase: MailDatabaseClient;
    todos: TodoRepository;
    getProvider(): MailProvider | undefined;
    uploads: McpAttachmentUploadStore;
    now?: () => Date;
    maxAttachmentBytes?: number;
    maxTotalAttachmentBytes?: number;
    maxPendingOperations?: number;
    getMaxRecipients?: () => number;
    getMaxBatchMessages?: () => number;
    getMaxPendingOperations?: () => number;
  }) {
    this.idempotency = new McpIdempotencyRepository(options.db, options.now);
  }

  prepareMailActions(input: Record<string, unknown>, context: { accountId: string; tokenId: string; sessionHash: string }) {
    this.assertAccount(input.accountId, context.accountId);
    const action = String(input.action) as MailAction;
    const messageIds = [...new Set((input.messageIds as string[]).map((id) => id.trim()))].sort();
    if (messageIds.length > (this.options.getMaxBatchMessages?.() ?? 100)) throw new McpDomainError("invalid_arguments", "Too many messages.");
    for (const messageId of messageIds) {
      if (!this.options.mail.getMessageById(messageId, context.accountId)) {
        throw new McpDomainError("message_not_found", "One or more messages were not found.");
      }
    }
    const destinationFolderId = typeof input.destinationFolderId === "string" ? input.destinationFolderId.trim() : undefined;
    if (action === "move" && !destinationFolderId) {
      throw new McpDomainError("invalid_arguments", "Move requires a destination folder.");
    }
    if (action !== "move" && destinationFolderId) {
      throw new McpDomainError("invalid_arguments", "A destination folder is valid only for move.");
    }
    const warning = action === "delete_forever" ? " This permanently deletes mail and cannot be undone." : "";
    return this.prepare({
      accountId: context.accountId,
      tokenId: context.tokenId,
      sessionHash: context.sessionHash,
      operationType: "mail_action",
      payload: { accountId: context.accountId, action, messageIds, ...(destinationFolderId ? { destinationFolderId } : {}) },
      preview: `${action} ${messageIds.length} message(s).${warning}`,
    });
  }

  prepareMailSend(input: Record<string, unknown>, context: { accountId: string; tokenId: string; sessionHash: string }) {
    this.assertAccount(input.accountId, context.accountId);
    // ponytail: MCP is open-permission by policy (no high-risk confirmation gate).
    // Sending is routed through the durable outbox (mailDatabase.enqueueSend),
    // which the Mail Core SMTP worker drains — the same path the renderer uses.
    const stored = typeof input.draftId === "string" ? this.options.mail.getDraftById(input.draftId) : undefined;
    if (input.draftId && (!stored || stored.accountId !== context.accountId)) {
      throw new McpDomainError("draft_not_found", "Draft not found.");
    }
    const mode = String(input.mode);
    const sourceMessageId = typeof input.sourceMessageId === "string" ? input.sourceMessageId : stored?.originalEmailId;
    if (mode !== "new" && (!sourceMessageId || !this.options.mail.getMessageById(sourceMessageId, context.accountId))) {
      throw new McpDomainError("message_not_found", "A valid source message is required.");
    }
    const to = Array.isArray(input.to) ? input.to : stored?.to ?? [];
    const cc = Array.isArray(input.cc) ? input.cc : stored?.cc ?? [];
    const bcc = Array.isArray(input.bcc) ? input.bcc : stored?.bcc ?? [];
    if (to.length === 0) throw new McpDomainError("invalid_arguments", "At least one recipient is required.");
    if (to.length + cc.length + bcc.length > (this.options.getMaxRecipients?.() ?? 200)) throw new McpDomainError("invalid_arguments", "Too many recipients.");
    const attachments = Array.isArray(input.attachments)
      ? resolveMcpAttachmentReferences(input.attachments, {
          uploads: this.options.uploads,
          sessionHash: context.sessionHash,
          accountId: context.accountId,
          existingAttachments: stored?.attachments,
          allowExistingAttachmentIds: Boolean(stored),
          maxAttachmentBytes: this.options.maxAttachmentBytes ?? MCP_DEFAULT_MAX_ATTACHMENT_BYTES,
          maxTotalAttachmentBytes: this.options.maxTotalAttachmentBytes ?? MCP_DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
        })
      : validateMcpOutboundAttachments(stored?.attachments ?? [], {
          maxAttachmentBytes: this.options.maxAttachmentBytes ?? MCP_DEFAULT_MAX_ATTACHMENT_BYTES,
          maxTotalAttachmentBytes: this.options.maxTotalAttachmentBytes ?? MCP_DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
        });
    const draft: WemailDraftInput & { draftId?: string; mode: string } = {
      accountId: context.accountId,
      mode,
      ...(stored ? { draftId: stored.id } : {}),
      ...(sourceMessageId ? { originalEmailId: sourceMessageId } : {}),
      ...(typeof input.threadId === "string" ? { threadId: input.threadId } : {}),
      to: to as WemailDraftInput["to"],
      cc: cc as WemailDraftInput["cc"],
      bcc: bcc as WemailDraftInput["bcc"],
      subject: typeof input.subject === "string" ? input.subject : stored?.subject ?? "",
      bodyText: typeof input.bodyText === "string" ? input.bodyText : stored?.bodyText ?? "",
      bodyHtml: typeof input.bodyHtml === "string" ? input.bodyHtml : stored?.bodyHtml ?? "",
      attachments,
    };
    return this.prepare({
      accountId: context.accountId,
      tokenId: context.tokenId,
      sessionHash: context.sessionHash,
      operationType: "send",
      payload: draft as unknown as Record<string, unknown>,
      preview: `Send “${draft.subject.slice(0, 200)}” to ${to.length + cc.length + bcc.length} recipient(s).`,
    });
  }

  prepareDeleteEntity(input: Record<string, unknown>, context: { accountId: string; tokenId: string; sessionHash: string }) {
    this.assertAccount(input.accountId, context.accountId);
    const entityType = String(input.entityType);
    const entityId = String(input.entityId);
    if (entityType === "draft") {
      const draft = this.options.mail.getDraftById(entityId);
      if (!draft || draft.accountId !== context.accountId) throw new McpDomainError("draft_not_found", "Draft not found.");
      return this.prepare({ accountId: context.accountId, tokenId: context.tokenId, sessionHash: context.sessionHash, operationType: "delete_draft", payload: { accountId: context.accountId, entityId }, preview: `Delete saved draft “${draft.subject.slice(0, 200)}”.` });
    }
    const todo = this.options.todos.getById(entityId);
    if (!todo || todo.accountId !== context.accountId) throw new McpDomainError("todo_not_found", "Todo not found.");
    const suppression = todo.source === "ai" && Boolean(todo.emailId);
    return this.prepare({ accountId: context.accountId, tokenId: context.tokenId, sessionHash: context.sessionHash, operationType: "delete_todo", payload: { accountId: context.accountId, entityId, suppression }, preview: `Delete todo “${todo.title.slice(0, 200)}”.${suppression ? " The same AI suggestion will be suppressed for this message." : ""}` });
  }

  getStatus(operationId: unknown, accountId: string) {
    const operation = this.getOwned(String(operationId), accountId);
    return { operation: operationView(operation) };
  }

  cancel(operationId: unknown, accountId: string) {
    try {
      return { operation: operationView(this.options.operations.cancel(String(operationId), accountId)) };
    } catch (error) {
      throw new McpDomainError("operation_not_cancellable", error instanceof Error ? error.message : "Operation cannot be cancelled.");
    }
  }

  async commit(operationId: unknown, idempotencyKey: unknown, accountId: string) {
    const operation = this.getOwned(String(operationId), accountId);
    if (operation.state === "expired" || Date.parse(operation.expiresAt) <= Date.now()) {
      if (operation.state !== "expired") this.options.operations.transition(operation.id, "expired");
      throw new McpDomainError("operation_expired", "Operation expired.");
    }
    if (operation.state === "prepared" || operation.state === "awaiting_confirmation" || operation.state === "cancelled") {
      throw new McpDomainError("operation_not_approved", "Operation requires exact approval in WeMail.");
    }
    const keyHash = hashMcpValue({ accountId, key: String(idempotencyKey) });
    const reservation = this.idempotency.reserve({ accountId, operationId: operation.id, keyHash, payloadHash: operation.payloadHash });
    if (reservation.status === "conflict") throw new McpDomainError("idempotency_conflict", "Idempotency key was used for another operation.");
    if (reservation.status === "existing") {
      if (reservation.reservation.dispatchState === "succeeded") return { operation: operationView(this.options.operations.get(operation.id)!) };
      if (reservation.reservation.dispatchState === "dispatching" || reservation.reservation.dispatchState === "outcome_unknown") {
        this.idempotency.setState(reservation.reservation.id, "outcome_unknown", { code: "outcome_unknown" });
        return { operation: operationView(this.options.operations.transition(operation.id, "outcome_unknown", { code: "outcome_unknown" })) };
      }
    }
    if (operation.state !== "approved" && operation.state !== "failed_retryable") {
      throw new McpDomainError("operation_not_approved", "Operation requires exact approval in WeMail.");
    }
    this.options.operations.transition(operation.id, "committing");
    this.idempotency.setState(reservation.reservation.id, "dispatching");
    try {
      const summary = await this.execute(operation);
      this.idempotency.setState(reservation.reservation.id, "succeeded", { code: "ok", summary });
      return { operation: operationView(this.options.operations.transition(operation.id, "succeeded", { code: "ok", summary })) };
    } catch (error) {
      const code = error instanceof Error ? error.message : "provider_error";
      const state = operation.operationType === "send" ? "outcome_unknown" : "failed_retryable";
      this.idempotency.setState(reservation.reservation.id, state, { code });
      const failed = this.options.operations.transition(operation.id, state, { code });
      if (state === "outcome_unknown") return { operation: operationView(failed) };
      throw new McpDomainError("provider_error", "Operation failed before a confirmed outcome.", true);
    }
  }

  private prepare(input: { accountId: string; tokenId: string; sessionHash: string; operationType: "send" | "mail_action" | "delete_draft" | "delete_todo"; payload: Record<string, unknown>; preview: string }) {
    const maximum = this.options.getMaxPendingOperations?.() ?? this.options.maxPendingOperations ?? 100;
    if (this.options.operations.listPending(input.accountId, maximum).length >= maximum) {
      throw new McpDomainError("rate_limited", "Too many pending operations.", true);
    }
    const payload = canonicalMcpPayload(input.payload);
    const operation = this.options.operations.create({ id: `mcp-op-${randomUUID()}`, accountId: input.accountId, tokenId: input.tokenId, sessionHash: input.sessionHash, operationType: input.operationType, payload, payloadHash: hashMcpValue(payload), preview: input.preview, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), state: "approved" });
    return { operation: operationView(operation) };
  }

  private getOwned(id: string, accountId: string) {
    const operation = this.options.operations.getOwned(id, accountId);
    if (!operation) throw new McpDomainError("operation_not_found", "Operation not found.");
    return operation;
  }

  private assertAccount(inputAccountId: unknown, accountId: string) {
    if (inputAccountId !== accountId) throw new McpDomainError("account_mismatch", "Account mismatch.");
  }

  private async execute(operation: McpPreparedOperationRecord): Promise<Record<string, unknown>> {
    const payload = operation.payload;
    if (operation.operationType === "send") {
      const draft = payload as unknown as (WemailDraftInput & { draftId?: string });
      // ponytail: outbound attachment blob staging is unimplemented app-wide
      // (see app/services/api.ts sendWemailDraft); enqueueSend rejects non-empty
      // attachments, so they are stripped here exactly like the renderer.
      const committed = await this.options.mailDatabase.enqueueSend({
        accountId: draft.accountId,
        ...(draft.originalEmailId ? { originalEmailId: draft.originalEmailId } : {}),
        ...(draft.threadId ? { threadId: draft.threadId } : {}),
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        bodyText: draft.bodyText,
        bodyHtml: draft.bodyHtml,
        attachments: [],
        idempotencyKey: `mcp-send:${operation.id}`,
        ...(typeof draft.draftId === "string" ? { draftId: draft.draftId } : {}),
      });
      return { successCount: 1, outboxId: committed.value.outboxId, messageIdHeader: committed.value.messageIdHeader };
    }
    if (operation.operationType === "delete_draft") {
      if (!(await this.options.mail.deleteDraft(String(payload.entityId)))) throw new Error("draft_not_found");
      return { successCount: 1 };
    }
    if (operation.operationType === "delete_todo") {
      if (!this.options.todos.deleteAndSuppress(String(payload.entityId))) throw new Error("todo_not_found");
      return { successCount: 1, suppressionRecorded: payload.suppression === true };
    }
    const messageIds = payload.messageIds as string[];
    const action = String(payload.action) as MailAction;
    let successCount = 0;
    for (const messageId of messageIds) {
      const destination = action === "archive" ? "Archive" : action === "trash" ? "Trash" : action === "restore" ? "Inbox" : action === "spam" ? "Spam" : action === "unspam" ? "Inbox" : action === "move" ? String(payload.destinationFolderId) : undefined;
      const ok = action === "delete_forever"
        ? await this.options.mail.deleteMessage(messageId)
        : Boolean(destination && await this.options.mail.moveMessage(messageId, destination));
      if (!ok) throw new Error("message_not_found");
      successCount += 1;
    }
    return { successCount, action };
  }
}
