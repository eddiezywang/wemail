import type {
  MailFlagsPatch,
  MailSyncCursor,
  MailMessage,
  WemailDeliveryResult,
  WemailDraftInput,
} from "../../../shared/wemail/mail.js";
import type { MailProviderRole } from "../../../shared/wemail/startup.js";
import type { MailFolderSyncStates, MailSyncCheckpoint } from "../../../shared/wemail/mailSync.js";

export interface MailboxStatus {
  path: string;
  uidValidity: number;
  uidNext: number | null;
  highestModseq: string | null;
  supportsIdle: boolean;
  supportsCondstore: boolean;
  supportsQresync: boolean;
}

export interface MailFolder {
  path: string;
  name: string;
  delimiter?: string;
}

export interface MailMetadataContinuation extends MailSyncCursor {
  completed: boolean;
}

export interface MailMetadataPage {
  folder: string;
  messages: MailMessage[];
  continuation: MailMetadataContinuation;
  checkpoint?: MailSyncCheckpoint;
}

export interface MailIncrementalPageOptions {
  states: Readonly<MailFolderSyncStates>;
  since: Date;
  repair?: boolean;
}

export interface MailMetadataPageResume {
  states: Readonly<MailFolderSyncStates>;
  recheckInbox: boolean;
}

export type MailIncrementalPageStream = AsyncGenerator<MailMetadataPage, void, MailMetadataPageResume | undefined>;

export interface MailMetadataPageOptions {
  since: Date;
  pageSize: number;
  continuations?: Readonly<Record<string, MailMetadataContinuation>>;
}

/**
 * Protocol-agnostic mail provider seam. Consumers (Mail Core sync worker, the
 * send-draft flow, and later the agent tools) depend on THIS interface;
 * they MUST NOT import `ImapSmtpMailProvider` directly, so alternate
 * transports (e.g. JMAP, a stub in tests) can be swapped without rewriting
 * the consumer.
 */
export interface MailProvider {
  /** Account-scoped connection role. Used for diagnostics, never routing secrets. */
  readonly role?: MailProviderRole;
  /** Establish an authenticated session. Idempotent. */
  connect(): Promise<void>;
  /** Tear down the session. Idempotent; safe to call after a failed connect. */
  disconnect(): Promise<void>;
  /**
   * Mark a broken session unusable so its connection owner can recycle it.
   * Business workers should prefer this over disconnecting shared providers.
   */
  invalidateConnection?(cause?: unknown): Promise<void>;
  /**
   * Fetch up to `limit` most-recent messages from the account's primary
   * inbox. Normalised to the shared {@link MailMessage} shape so callers
   * do not touch protocol-specific payloads.
   */
  syncRecent(limit: number): Promise<MailMessage[]>;
  /**
   * Fetch messages received on or after `since` from the provider's primary
   * inbox. Used for bounded historical backfill after account connection.
   */
  syncSince(since: Date): Promise<MailMessage[]>;
  /** Stream bounded envelope pages so large backfills never retain a full window. */
  syncMetadataPages?(
    options: MailMetadataPageOptions,
  ): AsyncIterable<MailMetadataPage>;
  syncIncrementalPages?(options: MailIncrementalPageOptions): MailIncrementalPageStream;
  /**
   * Fetch messages whose IMAP UID is greater than the stored cursor. Return
   * `null` when the cursor can no longer be trusted, for example after an
   * IMAP UIDVALIDITY change; callers should then fall back to a bounded
   * window sync.
   */
  syncAfterCursor?(cursor: MailSyncCursor): Promise<MailMessage[] | null>;
  /** Refresh metadata and provider flags for already-synchronized messages. */
  refreshFlags?(emailIds: string[]): Promise<MailMessage[]>;
  /** Persist read/starred and related message flags to the remote mailbox. */
  updateFlags?(emailId: string, patch: MailFlagsPatch): Promise<void>;
  /** Move a message to another remote mailbox. */
  moveMessage?(emailId: string, folder: string): Promise<MailMoveResult | void>;
  /** Permanently delete a message from the remote mailbox. */
  deleteMessage?(emailId: string): Promise<void>;
  /** Resolve a moved message in a destination mailbox when UIDPLUS mapping is unavailable. */
  resolveMessageLocator?(
    folder: string,
    messageId: string,
  ): Promise<{ uid: number; uidValidity: number } | null>;
  /** Enumerate provider folders visible to the active account. */
  listFolders?(): Promise<MailFolder[]>;
  /** Fetch a single message by its normalized id. Returns null if missing. */
  getMessage(
    emailId: string,
    options?: { onDemand?: boolean },
  ): Promise<MailMessage | null>;
  /**
   * Fetch raw bytes for a single MIME part of a message. The `partId` is
   * the same identifier surfaced by {@link MailAttachment}.id. Optional —
   * providers without an attachment fetch path (e.g. the test injectors)
   * may omit this; the route returns 404 in that case.
   */
  fetchAttachment?(
    emailId: string,
    partId: string,
    signal?: AbortSignal,
  ): Promise<FetchAttachmentResult | null>;
  /** Whether this provider can wait on server-push mailbox change signals. */
  supportsPushWatch?(): boolean;
  /**
   * Wait until the selected mailbox changes or `signal` aborts. Providers
   * should reject promptly on abort even if the underlying protocol wait
   * primitive itself is not directly cancellable.
   */
  waitForMailboxChange?(signal?: AbortSignal): Promise<void>;
  /** Read safe mailbox/capability health through the protocol engine. */
  getMailboxStatus?(): Promise<MailboxStatus>;
  /** Send a user-reviewed draft. Returns the provider-assigned message id. */
  sendDraft(input: WemailDraftInput): Promise<SendDraftResult>;
}

export interface MailMoveResult {
  folder: string;
  uid?: number;
  uidValidity?: number;
}

export interface FetchAttachmentResult {
  bytes: Buffer;
  mimetype: string;
}

export interface SendDraftResult {
  messageId: string;
  delivery?: WemailDeliveryResult;
}
