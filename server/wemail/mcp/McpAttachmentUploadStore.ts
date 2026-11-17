import { randomBytes, randomUUID } from "node:crypto";
import type { WemailOutboundAttachment } from "../../../shared/wemail/mail.js";
import { McpDomainError } from "./McpErrorMapper.js";
import {
  MCP_DEFAULT_MAX_ATTACHMENT_BYTES,
  validateMcpOutboundAttachments,
} from "./McpAttachmentInput.js";

export const MCP_ATTACHMENT_UPLOAD_TTL_MS = 15 * 60 * 1000;
export const MCP_MAX_UPLOADS_PER_SESSION = 20;
export const MCP_DEFAULT_MAX_UPLOAD_BYTES_PER_SESSION = 25 * 1024 * 1024;
export const MCP_DEFAULT_MAX_UPLOAD_BYTES_GLOBAL = 64 * 1024 * 1024;

interface McpAttachmentUploadRecord {
  uploadRef: string;
  sessionHash: string;
  accountId: string;
  attachment: WemailOutboundAttachment;
  createdAt: string;
  expiresAt: string;
}

export interface McpAttachmentUploadView {
  uploadRef: string;
  attachment: {
    filename: string;
    mimeType: string;
    size: number;
  };
  expiresAt: string;
}

export class McpAttachmentUploadStore {
  private readonly uploads = new Map<string, McpAttachmentUploadRecord>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxUploadsPerSession: number;
  private readonly maxAttachmentBytes: number;
  private readonly maxBytesPerSession: number;
  private readonly maxBytesGlobal: number;

  constructor(options: {
    now?: () => Date;
    ttlMs?: number;
    maxUploadsPerSession?: number;
    maxAttachmentBytes?: number;
    maxBytesPerSession?: number;
    maxBytesGlobal?: number;
  } = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? MCP_ATTACHMENT_UPLOAD_TTL_MS;
    this.maxUploadsPerSession = options.maxUploadsPerSession ?? MCP_MAX_UPLOADS_PER_SESSION;
    this.maxAttachmentBytes = options.maxAttachmentBytes ?? MCP_DEFAULT_MAX_ATTACHMENT_BYTES;
    this.maxBytesPerSession = options.maxBytesPerSession ?? MCP_DEFAULT_MAX_UPLOAD_BYTES_PER_SESSION;
    this.maxBytesGlobal = options.maxBytesGlobal ?? MCP_DEFAULT_MAX_UPLOAD_BYTES_GLOBAL;
  }

  upload(input: {
    sessionHash: string;
    accountId: string;
    filename: unknown;
    mimeType: unknown;
    size: unknown;
    dataBase64: unknown;
  }): McpAttachmentUploadView {
    this.cleanupExpired();
    const [attachment] = validateMcpOutboundAttachments([{
      id: randomUUID(),
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.size,
      dataBase64: input.dataBase64,
    }], {
      maxAttachmentBytes: this.maxAttachmentBytes,
      maxTotalAttachmentBytes: this.maxAttachmentBytes,
    });
    const sessionRecords = [...this.uploads.values()].filter((record) => record.sessionHash === input.sessionHash);
    if (sessionRecords.length >= this.maxUploadsPerSession) {
      throw new McpDomainError("rate_limited", "Too many staged attachments for this session.", true);
    }
    const sessionBytes = sessionRecords.reduce((sum, record) => sum + record.attachment.size, 0);
    const globalBytes = [...this.uploads.values()].reduce((sum, record) => sum + record.attachment.size, 0);
    if (sessionBytes + attachment.size > this.maxBytesPerSession || globalBytes + attachment.size > this.maxBytesGlobal) {
      throw new McpDomainError("rate_limited", "Temporary attachment capacity is exhausted.", true);
    }
    const createdAt = this.now();
    const record: McpAttachmentUploadRecord = {
      uploadRef: randomBytes(24).toString("base64url"),
      sessionHash: input.sessionHash,
      accountId: input.accountId,
      attachment,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.ttlMs).toISOString(),
    };
    this.uploads.set(record.uploadRef, record);
    return this.view(record);
  }

  resolve(uploadRef: string, context: { sessionHash: string; accountId: string }): WemailOutboundAttachment {
    this.cleanupExpired();
    const record = this.uploads.get(uploadRef);
    if (!record || record.sessionHash !== context.sessionHash || record.accountId !== context.accountId) {
      throw new McpDomainError("attachment_not_found", "Attachment upload was not found.");
    }
    return { ...record.attachment };
  }

  purgeSession(sessionHash: string): number {
    let removed = 0;
    for (const [uploadRef, record] of this.uploads) {
      if (record.sessionHash !== sessionHash) continue;
      this.uploads.delete(uploadRef);
      removed += 1;
    }
    return removed;
  }

  cleanupExpired(): number {
    const now = this.now().getTime();
    let removed = 0;
    for (const [uploadRef, record] of this.uploads) {
      if (Date.parse(record.expiresAt) > now) continue;
      this.uploads.delete(uploadRef);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.uploads.clear();
  }

  get size(): number {
    this.cleanupExpired();
    return this.uploads.size;
  }

  private view(record: McpAttachmentUploadRecord): McpAttachmentUploadView {
    return {
      uploadRef: record.uploadRef,
      attachment: {
        filename: record.attachment.filename,
        mimeType: record.attachment.mimetype,
        size: record.attachment.size,
      },
      expiresAt: record.expiresAt,
    };
  }
}
