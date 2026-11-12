import type { WemailOutboundAttachment } from "../../../shared/wemail/mail.js";
import { McpDomainError } from "./McpErrorMapper.js";
import {
  MCP_DEFAULT_MAX_ATTACHMENT_BYTES,
  MCP_DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
  MCP_MAX_ATTACHMENT_COUNT,
  validateMcpOutboundAttachments,
} from "./McpAttachmentInput.js";
import type { McpAttachmentUploadStore } from "./McpAttachmentUploadStore.js";

export function resolveMcpAttachmentReferences(
  value: unknown,
  options: {
    uploads: McpAttachmentUploadStore;
    sessionHash: string;
    accountId: string;
    existingAttachments?: WemailOutboundAttachment[];
    allowExistingAttachmentIds: boolean;
    maxAttachmentBytes?: number;
    maxTotalAttachmentBytes?: number;
  },
): WemailOutboundAttachment[] {
  if (!Array.isArray(value)) {
    throw new McpDomainError("invalid_arguments", "Attachments must be an array.");
  }
  if (value.length > MCP_MAX_ATTACHMENT_COUNT) {
    throw new McpDomainError("invalid_arguments", "Too many attachments.");
  }

  const seenReferences = new Set<string>();
  const seenAttachmentIds = new Set<string>();
  const existing = new Map((options.existingAttachments ?? []).map((attachment) => [attachment.id, attachment]));
  const resolved = value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new McpDomainError("invalid_arguments", "Attachment reference is invalid.");
    }
    const item = raw as Record<string, unknown>;
    const keys = Object.keys(item);
    const hasUploadRef = typeof item.uploadRef === "string";
    const hasAttachmentId = typeof item.attachmentId === "string";
    if (keys.length !== 1 || hasUploadRef === hasAttachmentId) {
      throw new McpDomainError("invalid_arguments", "Attachment reference is invalid.");
    }

    let attachment: WemailOutboundAttachment;
    if (hasUploadRef) {
      const uploadRef = String(item.uploadRef);
      const referenceKey = `upload:${uploadRef}`;
      if (seenReferences.has(referenceKey)) {
        throw new McpDomainError("invalid_arguments", "Duplicate attachment reference.");
      }
      seenReferences.add(referenceKey);
      attachment = options.uploads.resolve(uploadRef, {
        sessionHash: options.sessionHash,
        accountId: options.accountId,
      });
    } else {
      if (!options.allowExistingAttachmentIds) {
        throw new McpDomainError("invalid_arguments", "Existing attachment ids require a draft.");
      }
      const attachmentId = String(item.attachmentId);
      const referenceKey = `existing:${attachmentId}`;
      if (seenReferences.has(referenceKey)) {
        throw new McpDomainError("invalid_arguments", "Duplicate attachment reference.");
      }
      seenReferences.add(referenceKey);
      const found = existing.get(attachmentId);
      if (!found) throw new McpDomainError("attachment_not_found", "Draft attachment was not found.");
      attachment = { ...found };
    }

    if (seenAttachmentIds.has(attachment.id)) {
      throw new McpDomainError("invalid_arguments", "Duplicate final attachment.");
    }
    seenAttachmentIds.add(attachment.id);
    return attachment;
  });

  return validateMcpOutboundAttachments(resolved, {
    maxAttachmentBytes: options.maxAttachmentBytes ?? MCP_DEFAULT_MAX_ATTACHMENT_BYTES,
    maxTotalAttachmentBytes: options.maxTotalAttachmentBytes ?? MCP_DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
  });
}
