export interface WemailAddress {
  name?: string;
  email: string;
  /** Locally persisted enterprise-directory display name. Never sent over SMTP. */
  directoryName?: string;
}

export interface WemailAttachmentMeta {
  id: string;
  filename: string;
  mimetype: string;
  size: number;
  contentId?: string | null;
  disposition?: string | null;
  cachedUntil?: string | null;
}

export interface WemailOutboundAttachment {
  id: string;
  filename: string;
  mimetype: string;
  size: number;
  dataBase64: string;
}

export interface WemailDeliveryRejection {
  recipient: string;
  response?: string;
  responseCode?: number;
}

/** SMTP envelope acceptance recorded for a locally sent message. */
export interface WemailDeliveryResult {
  status: "sent" | "partial";
  accepted: string[];
  rejected: string[];
  rejectedDetails?: WemailDeliveryRejection[];
}

export interface WemailMessage {
  id: string;
  accountId: string;
  mailboxId: string;
  folderId: string;
  threadId: string;
  subject: string;
  from: WemailAddress;
  to: WemailAddress[];
  cc: WemailAddress[];
  bcc: WemailAddress[];
  /** Present only when WeMail observed the SMTP envelope result while sending. */
  delivery?: WemailDeliveryResult;
  receivedAt: string;
  bodyHtml?: string;
  bodyText: string;
  bodyCachedUntil?: string | null;
  attachments: WemailAttachmentMeta[];
}

export interface WemailDraftInput {
  accountId: string;
  composeType?: MailDraftType;
  originalEmailId?: string;
  threadId?: string;
  to: WemailAddress[];
  cc?: WemailAddress[];
  bcc?: WemailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  attachments?: WemailOutboundAttachment[];
  /** Internal durable SMTP recovery identity. UI callers should omit it. */
  smtpMessageId?: string;
  /** Internal frozen reply headers from the durable outbox. */
  smtpInReplyTo?: string;
  smtpReferences?: string[];
}

export interface WemailDraftSaveInput {
  id?: string;
  accountId: string;
  composeType?: MailDraftType;
  originalEmailId?: string;
  threadId?: string;
  to?: WemailAddress[];
  cc?: WemailAddress[];
  bcc?: WemailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  attachments?: WemailOutboundAttachment[];
}

/**
 * Attachment metadata stub used by the normalized {@link MailMessage}.
 * Body bytes are NOT included — fetchers resolve them on demand.
 */
export interface MailAttachment {
  id: string;
  filename: string;
  mimetype: string;
  size: number;
  contentId?: string | null;
  disposition?: "inline" | "attachment" | null;
}

export function hasDownloadableAttachments(
  attachments: Array<{ disposition?: string | null }> | null | undefined,
): boolean {
  return attachments?.some((attachment) => attachment.disposition !== "inline") ?? false;
}

/**
 * Inline image bytes captured at body-parse time, used to pre-seed the disk
 * attachment cache so opening a detail view never re-fetches them from IMAP.
 * NOT persisted — stripped before any DB write. `bytes` is a `Uint8Array`
 * because `Buffer` does not survive structured-clone across worker boundaries.
 */
export interface InlineImageCapture {
  contentId: string;
  mimetype: string;
  bytes: Uint8Array;
}

/**
 * Unified "is this an inline image we should render + pre-cache" predicate.
 * Image-only, and matches both `Content-Disposition: inline` parts and
 * `multipart/related` CID images that carry no disposition (common for
 * marketing/branded mail). Used by the normalizer (capture), the DB writer
 * (which attachment public-ids to return), and the renderer (which `cid:`
 * refs to rewrite) so the cached set equals the rendered set.
 */
export function isInlineImage(att: {
  mimetype?: string | null;
  disposition?: string | null;
  contentId?: string | null;
}): boolean {
  const mime = (att.mimetype ?? "").toLowerCase();
  if (!mime.startsWith("image/")) return false;
  return att.disposition === "inline" || Boolean(att.contentId);
}

/**
 * Normalize a Content-ID for matching: trim, strip surrounding `<>`, lowercase.
 * Applied at capture, at DB upsert (returned public-id mapping), and at cache
 * seed matching so all three agree regardless of how the sender formatted CID.
 */
export function normalizeContentId(contentId: string | null | undefined): string {
  if (!contentId) return "";
  const trimmed = contentId.trim();
  const stripped =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1)
      : trimmed;
  return stripped.toLowerCase();
}

/**
 * Canonical attachment-cache key (NUL-joined public ids). Shared by the HTTP
 * attachment route (read) and the mail-core pre-seed (write) so a seeded entry
 * is found by the route's disk fast-path. MCP uses a different (colon) key and
 * does not share entries — intentionally out of scope here.
 */
export function mailAttachmentCacheKey(
  accountId: string,
  messageId: string,
  attachmentId: string,
): string {
  return [accountId, messageId, attachmentId].join(String.fromCharCode(0));
}

/**
 * Normalized per-message flag set. Mirrors IMAP system flags we care about
 * for phase one; additional labels/keywords are out of scope.
 */
export interface MailFlags {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
}

export type MailFlagsPatch = Partial<MailFlags>;

export interface MailSearchQuery {
  q?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  folder?: string;
  read?: boolean;
  unread?: boolean;
  starred?: boolean;
  hasAttachment?: boolean;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export type MailDraftType = "new" | "reply" | "forward";

export interface MailDraftRecord {
  id: string;
  accountId: string;
  originalEmailId?: string;
  type: MailDraftType;
  to: WemailAddress[];
  cc: WemailAddress[];
  bcc: WemailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  attachments?: WemailOutboundAttachment[];
  status: "draft";
  createdAt: string;
  updatedAt: string;
}

/**
 * Sync cursor info carried alongside each normalized message so
 * the canonical Writer can persist provider-side state transactionally.
 * `uid` is the IMAP UID; `uidValidity` detects folder reset; `internalDate`
 * is the provider's internal timestamp used for ordering.
 */
export interface MailSyncCursor {
  uid: number;
  uidValidity: number;
  internalDate: string;
  /** True when this sync payload included provider message flags. */
  flagsAuthoritative?: boolean;
}

/** Exact metadata for a filtered mail view, calculated before pagination. */
export interface MailListCounts {
  totalCount: number;
  unreadCount: number;
}

/**
 * Cross-package canonical normalized mail message (Wave 0).
 *
 * Locked shape consumed across Mail Core, DB Service, and trusted clients.
 */
export interface MailMessage {
  id: string;
  /**
   * Provider messages mirror a remote mailbox and may write flags back to it.
   * Local messages (fixtures/imports) persist interaction state only in WeMail.
   * Omitted values are treated as provider-backed.
   */
  source?: "provider" | "local";
  accountId: string;
  folder: string;
  messageId: string;
  threadId?: string;
  /**
   * Parent message id derived from the `In-Reply-To` envelope header, if any.
   * This is NOT a thread identifier — threading is not implemented in phase one.
   */
  parentMessageId?: string;
  from: WemailAddress;
  to: WemailAddress[];
  cc: WemailAddress[];
  bcc: WemailAddress[];
  /** Present only when WeMail observed the SMTP envelope result while sending. */
  delivery?: WemailDeliveryResult;
  subject: string;
  snippet: string;
  bodyText?: string;
  bodyHtml?: string;
  /** Non-null when the full RFC822 body has been downloaded locally. */
  bodyCachedUntil?: string | null;
  /** Monotonic local body revision used to invalidate derived intelligence. */
  bodyVersion?: number;
  receivedAt: string;
  sentAt?: string;
  hasAttachments: boolean;
  attachments: MailAttachment[];
  /**
   * Inline image bytes captured at parse time for cache pre-seeding. Transient
   * — never persisted; stripped before any DB write. Undefined when the source
   * was not parsed by PostalMime (e.g. >2MB lightweight fallback) or when the
   * message had no qualifying inline images.
   */
  inlineImages?: InlineImageCapture[];
  flags: MailFlags;
  sync: MailSyncCursor;
  /** Selected mail headers used by intelligence (e.g. precedence, list-id). Not all headers are stored. */
  headers?: Record<string, string>;
  /**
   * ISO timestamp until which the message is snoozed. When present and in
   * the future, the message is hidden from the standard inbox view and
   * surfaces in the "Snoozed" virtual folder.
   */
  snoozedUntil?: string;
}

/**
 * Minimal raw IMAP payload fed into {@link normalizeMail}. Package B
 * supplies the full imapflow-shaped input; this interface keeps the
 * normalizer's public seam narrow so the implementation detail stays
 * inside Package B.
 */
export interface RawImapMessage {
  uid: number;
  /** IMAP system flags returned with message metadata. */
  flags?: Iterable<string> | null;
  /**
   * IMAP server-assigned timestamp for when the message was delivered to the
   * mailbox. Distinct from `envelope.date`, which is the sender-declared
   * Date header. Used as the canonical `receivedAt` when present.
   */
  internalDate?: string | Date | null;
  envelope: {
    date?: string | Date | null;
    subject?: string | null;
    messageId?: string | null;
    inReplyTo?: string | null;
    from?: Array<{ name?: string | null; address?: string | null }> | null;
    to?: Array<{ name?: string | null; address?: string | null }> | null;
    cc?: Array<{ name?: string | null; address?: string | null }> | null;
    bcc?: Array<{ name?: string | null; address?: string | null }> | null;
  };
  bodyStructure: unknown;
  /** Omitted for metadata-only sync; present when the full body was fetched. */
  source?: Buffer | Uint8Array | string;
}

export function isMailBodyCached(message: Pick<MailMessage, "bodyCachedUntil" | "bodyText" | "bodyHtml">): boolean {
  return message.bodyCachedUntil != null || Boolean(message.bodyText || message.bodyHtml);
}

/**
 * Async normalizer signature. Implementation lives in
 * `server/wemail/mail/normalizeMail.ts` (Package B). Declared here so
 * downstream consumers can import the type without pulling in Package B.
 */
export type NormalizeMailFn = (
  input: RawImapMessage,
  context: { accountId: string; folder: string; uidValidity: number },
) => Promise<MailMessage>;
