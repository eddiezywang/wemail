import type { WemailOutboundAttachment } from "../../../shared/wemail/mail.js";
import { McpDomainError } from "./McpErrorMapper.js";

export const MCP_MAX_ATTACHMENT_COUNT = 20;
export const MCP_DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MCP_DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function hasCanonicalPaddingBits(value: string): boolean {
  if (value.endsWith("==")) return (BASE64_ALPHABET.indexOf(value[value.length - 3]) & 0b1111) === 0;
  if (value.endsWith("=")) return (BASE64_ALPHABET.indexOf(value[value.length - 2]) & 0b11) === 0;
  return true;
}

function decodedBase64Length(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function validateMcpOutboundAttachments(
  value: unknown,
  options: {
    maxAttachmentBytes?: number;
    maxTotalAttachmentBytes?: number;
  } = {},
): WemailOutboundAttachment[] {
  if (!Array.isArray(value)) {
    throw new McpDomainError("invalid_arguments", "Attachments must be an array.");
  }
  if (value.length > MCP_MAX_ATTACHMENT_COUNT) {
    throw new McpDomainError("invalid_arguments", "Too many attachments.");
  }

  const maxAttachmentBytes = options.maxAttachmentBytes ?? MCP_DEFAULT_MAX_ATTACHMENT_BYTES;
  const maxTotalAttachmentBytes = options.maxTotalAttachmentBytes ?? MCP_DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES;
  let totalBytes = 0;

  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new McpDomainError("invalid_arguments", "Attachment metadata is invalid.");
    }
    const item = raw as Record<string, unknown>;
    const id = item.id;
    const filename = item.filename;
    const mimetype = item.mimetype ?? item.mimeType;
    const size = item.size;
    const dataBase64 = item.dataBase64;
    if (
      typeof id !== "string" || id.length === 0 ||
      typeof filename !== "string" || filename.length === 0 ||
      typeof mimetype !== "string" || mimetype.length === 0 ||
      typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 ||
      typeof dataBase64 !== "string" || dataBase64.length === 0 ||
      !CANONICAL_BASE64.test(dataBase64) || !hasCanonicalPaddingBits(dataBase64)
    ) {
      throw new McpDomainError("invalid_arguments", "Attachment metadata or Base64 content is invalid.");
    }

    const decodedBytes = decodedBase64Length(dataBase64);
    if (decodedBytes !== size) {
      throw new McpDomainError("invalid_arguments", "Attachment size does not match its Base64 content.");
    }
    if (decodedBytes > maxAttachmentBytes) {
      throw new McpDomainError("attachment_too_large", "Attachment is too large.");
    }
    totalBytes += decodedBytes;
    if (totalBytes > maxTotalAttachmentBytes) {
      throw new McpDomainError("attachment_too_large", "Attachments exceed the total allowed size.");
    }

    return { id, filename, mimetype, size, dataBase64 };
  });
}
