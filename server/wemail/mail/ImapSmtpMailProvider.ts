import { ImapFlow } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import type {
  MailFlagsPatch,
  MailMessage,
  MailSyncCursor,
  RawImapMessage,
  WemailDeliveryRejection,
  WemailDeliveryResult,
  WemailDraftInput,
} from "../../../shared/wemail/mail.js";
import type { AccountService } from "../account/AccountService.js";
import {
  imapPasswordKey,
  smtpPasswordKey,
} from "../account/AccountTypes.js";
import type { SecretStore } from "../security/SecretStore.js";
import { enableSystemCertificateAuthorities } from "../security/SystemCa.js";
import type {
  MailboxStatus,
  MailFolder,
  MailMetadataPage,
  MailMetadataPageOptions,
  MailIncrementalPageOptions,
  MailIncrementalPageStream,
  MailProvider,
} from "./MailProvider.js";
import type { MailProviderRole } from "../../../shared/wemail/startup.js";
import { normalizeMail } from "./normalizeMail.js";
import type { MailFolderSyncState } from "../../../shared/wemail/mailSync.js";

export interface ImapSmtpMailProviderOptions {
  accountService: AccountService;
  secrets: SecretStore;
  folder?: string;
  imapClientInfo?: ImapClientInfo;
  /** Override factory for tests — defaults to constructing a real ImapFlow. */
  imapFactory?: (config: ImapClientConfig) => ImapLikeClient;
  /** Override factory for tests — defaults to nodemailer's transport. */
  smtpFactory?: (config: SmtpClientConfig) => MailTransport;
  logger?: (message: string) => void;
  onOperationTiming?: (timing: ImapMessageOperationTiming) => void;
  onSyncProgress?: () => void;
  /**
   * Maximum TOTAL connect attempts (phase-one default is 3 — one initial
   * attempt plus two retries on transient failures). Set to 1 to disable
   * retries entirely.
   */
  maxConnectAttempts?: number;
  role?: MailProviderRole;
}

export interface ImapMessageOperationTiming {
  operation: "getMessage";
  emailId: string;
  folder: string;
  role: MailProviderRole;
  outcome: "success" | "missing" | "failure";
  coldConnection: boolean;
  sourceBytes: number;
  connectMs: number;
  selectMs: number;
  fetchMs: number;
  parseMs: number;
  restoreMs: number;
  totalMs: number;
}

export interface ImapClientConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  clientInfo: ImapClientInfo;
  maxIdleTime: number;
  missingIdleCommand: "STATUS";
}

export interface SmtpClientConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}

export interface ImapClientInfo {
  name: string;
  version: string;
  vendor: string;
}

/**
 * Minimal imapflow surface the provider actually uses. Typed as its own
 * interface so tests can swap in a pure JS fake without inheriting all of
 * imapflow's network concerns.
 */
export interface ImapLikeClient {
  capabilities?: Map<string, boolean | number>;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close?(): void;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  mailboxOpen(path: string): Promise<{
    uidValidity: bigint | number;
    uidNext?: number;
    highestModseq?: bigint | number;
  }>;
  status?(
    path: string,
    query: {
      uidNext?: boolean;
      uidValidity?: boolean;
      highestModseq?: boolean;
    },
  ): Promise<{
    path?: string;
    uidNext?: number;
    uidValidity?: bigint | number;
    highestModseq?: bigint | number;
  }>;
  getMailboxLock?(path: string): Promise<{ release(): void }>;
  list?(): Promise<ImapMailboxLike[]>;
  mailboxClose?: () => Promise<void>;
  search(
    query: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<number[] | false>;
  fetch(
    range: string | number[],
    query: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): AsyncIterable<RawFetchLike>;
  /**
   * Optional — present on real imapflow clients but not required by tests.
   * Used to stream raw bytes of a single MIME part (e.g. an inline image).
   */
  download?(
    range: string | number,
    part: string,
    options?: Record<string, unknown>,
  ): Promise<{
    meta?: { contentType?: string };
    content?: NodeJS.ReadableStream;
  }>;
  messageFlagsAdd?(
    range: string | number[],
    flags: string[],
    options?: Record<string, unknown>,
  ): Promise<boolean>;
  messageFlagsRemove?(
    range: string | number[],
    flags: string[],
    options?: Record<string, unknown>,
  ): Promise<boolean>;
  messageMove?(
    range: string | number[],
    destination: string,
    options?: Record<string, unknown>,
  ): Promise<{
    uidValidity?: bigint;
    uidMap?: Map<number, number>;
  } | false>;
  messageDelete?(
    range: string | number[],
    options?: Record<string, unknown>,
  ): Promise<boolean>;
}

export interface RawFetchLike {
  uid: number;
  flags?: Iterable<string> | null;
  envelope?: unknown;
  bodyStructure?: unknown;
  source?: Buffer | Uint8Array | string;
  bodyParts?: Map<string, Buffer>;
  /** RFC822.SIZE — server-reported message size, populated when requested. */
  size?: number;
  /** IMAP INTERNALDATE — server-assigned arrival timestamp. */
  internalDate?: string | Date | null;
}

export interface MailTransport {
  sendMail(options: {
    from: string;
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageId?: string;
    text: string;
    html?: string;
    attachments?: Array<{
      filename: string;
      content: Buffer | string;
      contentType?: string;
      contentDisposition?: "attachment" | "inline";
      encoding?: "base64";
    }>;
  }): Promise<{
    messageId: string;
    accepted?: unknown[];
    rejected?: unknown[];
    rejectedErrors?: unknown[];
  }>;
}

export interface ImapMailboxLike {
  path?: string;
  name?: string;
  delimiter?: string;
  specialUse?: string;
  flags?: Iterable<string>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_SYNC_WINDOW_FETCH_UIDS = 5000;
const METADATA_FETCH_BATCH_SIZE = 500;
const ATTACHMENT_DOWNLOAD_CHUNK_SIZES = [64 * 1024, 8 * 1024, 4 * 1024, 1024] as const;
// Cap attachment downloads: the worker_thread buffers the whole attachment via
// Buffer.concat, so a single huge attachment (>~100MB) OOM'd the 128MB worker.
// Abort once the streamed size exceeds this; the caller gets a clear error
// instead of a crash. WEMAIL_MAX_ATTACHMENT_DOWNLOAD_MB may lower the cap,
// but cannot raise it past the worker-safe ceiling. Truly streaming large
// attachments to disk (no in-memory buffer) is a follow-up.
const MAX_ATTACHMENT_DOWNLOAD_BYTES = boundedMegabytes(
  process.env.WEMAIL_MAX_ATTACHMENT_DOWNLOAD_MB,
  64,
  64,
);
// Cap a single message's RFC822 source: getMessage() fetches `source: true`
// (full raw MIME) into the worker_thread heap and parses it synchronously, so
// one ~90MB+ email OOM'd the 128MB worker and blocked the event loop ~40s
// during intelligence hydration. Probe RFC822.SIZE first and refuse to load the
// body beyond this. WEMAIL_MAX_BODY_SOURCE_MB may lower the cap, but cannot
// raise it past the worker-safe ceiling.
const MAX_BODY_SOURCE_BYTES = boundedMegabytes(
  process.env.WEMAIL_MAX_BODY_SOURCE_MB,
  5,
  32,
);
// Oversized messages are hydrated by fetching only their renderable MIME body
// parts. Keep a hard ceiling here as malformed BODYSTRUCTURE metadata can label
// an attachment as text and would otherwise recreate the full-source problem.
const MAX_RENDERABLE_BODY_PART_BYTES = 2 * 1024 * 1024;
const MAX_RENDERABLE_BODY_PARTS = 4;
const DEFAULT_IMAP_CLIENT_INFO: ImapClientInfo = {
  name: "WeMail",
  version: "1.0.0",
  vendor: "WeMail",
};

function boundedMegabytes(raw: string | undefined, fallback: number, ceiling: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback * 1024 * 1024;
  return Math.min(ceiling, Math.max(1, parsed)) * 1024 * 1024;
}

/**
 * Structured error surfaced when the provider cannot establish a session
 * or resolve the credentials needed for a phase (imap connect / smtp send).
 * Lets callers distinguish auth/configuration problems from transient
 * network errors without parsing free-form message strings.
 */
export class MailProviderConnectError extends Error {
  readonly phase: "imap" | "smtp";
  override readonly cause?: unknown;

  constructor(options: { phase: "imap" | "smtp"; cause?: unknown; message?: string }) {
    const base =
      options.message ??
      (options.cause instanceof Error
        ? options.cause.message
        : String(options.cause ?? `${options.phase} connect failed`));
    super(`${options.phase}: ${base}`);
    this.name = "MailProviderConnectError";
    this.phase = options.phase;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export class MailProviderCommandError extends Error {
  readonly phase:
    | "imap.login"
    | "imap.select"
    | "imap.search"
    | "imap.fetch"
    | "imap.store"
    | "imap.move"
    | "imap.delete";
  readonly responseStatus?: string;
  readonly responseText?: string;
  readonly code?: string;
  readonly serverResponseCode?: string;
  readonly executedCommand?: string;
  override readonly cause?: unknown;

  constructor(options: {
    phase:
      | "imap.login"
      | "imap.select"
      | "imap.search"
      | "imap.fetch"
      | "imap.store"
      | "imap.move"
      | "imap.delete";
    cause: unknown;
  }) {
    const details = getImapCommandErrorDetails(options.cause);
    super(`${options.phase}: ${details.rendered}`);
    this.name = "MailProviderCommandError";
    this.phase = options.phase;
    if (details.responseStatus) this.responseStatus = details.responseStatus;
    if (details.responseText) this.responseText = details.responseText;
    if (details.code) this.code = details.code;
    if (details.serverResponseCode) this.serverResponseCode = details.serverResponseCode;
    if (details.executedCommand) this.executedCommand = details.executedCommand;
    this.cause = options.cause;
  }
}

/**
 * Concrete IMAP + SMTP implementation of {@link MailProvider}. Wraps
 * `imapflow` for the receive path and `nodemailer` for the send path.
 *
 * Credentials never leave this module — they are resolved through
 * {@link SecretStore} keyed by the current account id (`imapPasswordKey`,
 * `smtpPasswordKey`). Tests should inject `imapFactory` / `smtpFactory`
 * rather than standing up real network clients.
 */
export class ImapSmtpMailProvider implements MailProvider {
  readonly role: MailProviderRole;
  private readonly accountService: AccountService;
  private readonly secrets: SecretStore;
  private readonly folder: string;
  private readonly imapFactory: (c: ImapClientConfig) => ImapLikeClient;
  private readonly smtpFactory: (c: SmtpClientConfig) => MailTransport;
  private readonly log: (message: string) => void;
  private readonly onOperationTiming?: (timing: ImapMessageOperationTiming) => void;
  private readonly onSyncProgress?: () => void;
  private readonly maxAttempts: number;
  private readonly imapClientInfo: ImapClientInfo;
  private imap: ImapLikeClient | null = null;
  private metadataAbort = new AbortController();
  private uidValidity: number | null = null;
  private selectedFolder: string | null = null;
  private selectedUidValidity: number | null = null;
  private readonly clientErrorListeners = new WeakMap<
    ImapLikeClient,
    {
      error: (...args: unknown[]) => void;
      close: (...args: unknown[]) => void;
    }
  >();

  constructor(options: ImapSmtpMailProviderOptions) {
    this.accountService = options.accountService;
    this.secrets = options.secrets;
    this.folder = options.folder ?? "INBOX";
    this.imapFactory =
      options.imapFactory ??
      ((c) =>
        new ImapFlow({
          host: c.host,
          port: c.port,
          secure: c.secure,
          auth: c.auth,
          clientInfo: c.clientInfo,
          maxIdleTime: c.maxIdleTime,
          missingIdleCommand: c.missingIdleCommand,
          logger: false,
          connectionTimeout: 30_000,
          greetingTimeout: 30_000,
          socketTimeout: 30_000,
        }) as unknown as ImapLikeClient);
    this.smtpFactory =
      options.smtpFactory ??
      ((c) => nodemailer.createTransport(c) as unknown as MailTransport);
    this.log = options.logger ?? (() => {});
    this.onOperationTiming = options.onOperationTiming;
    this.onSyncProgress = options.onSyncProgress;
    this.maxAttempts = options.maxConnectAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.imapClientInfo = options.imapClientInfo ?? DEFAULT_IMAP_CLIENT_INFO;
    this.role = options.role ?? "foreground-realtime";
  }

  async connect(): Promise<void> {
    if (this.imap) return;
    enableSystemCertificateAuthorities();
    const { config, imapPassword } = this.resolveImapCredentials();

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const client = this.imapFactory({
        host: config.imap.host,
        port: config.imap.port,
        secure: config.imap.secure,
        auth: { user: config.imap.username, pass: imapPassword },
        clientInfo: this.imapClientInfo,
        maxIdleTime: 240_000,
        missingIdleCommand: "STATUS",
      });
      try {
        await this.withMetadataDeadline(client, () => client.connect());
      } catch (error) {
        const commandError = new MailProviderCommandError({
          phase: "imap.login",
          cause: error,
        });
        lastError = commandError;
        this.log(
          `imap connect attempt ${attempt}/${this.maxAttempts} failed host=${config.imap.host} error=${String((lastError as Error).message ?? lastError)}`,
        );
        try {
          await client.logout();
        } catch {
          // best-effort cleanup after a failed connect
        }
        if (
          commandError.responseStatus?.toUpperCase() === "NO" &&
          /login error or password error/i.test(
            commandError.responseText ?? commandError.message,
          )
        ) {
          throw commandError;
        }
        if (attempt < this.maxAttempts) {
          const jitter = 0.75 + Math.random() * 0.5;
          await sleep(Math.round(200 * 2 ** (attempt - 1) * jitter));
        }
        continue;
      }
      try {
        const box = await this.withMetadataDeadline(client, () => client.mailboxOpen(this.folder));
        this.uidValidity = Number(box.uidValidity);
        this.selectedFolder = this.folder;
        this.selectedUidValidity = this.uidValidity;
        this.imap = client;
        this.attachClientLifecycleListeners(client);
        return;
      } catch (error) {
        lastError = new MailProviderCommandError({
          phase: "imap.select",
          cause: error,
        });
        this.log(
          `imap connect attempt ${attempt}/${this.maxAttempts} failed host=${config.imap.host} error=${String((lastError as Error).message ?? lastError)}`,
        );
        try {
          await client.logout();
        } catch {
          // best-effort cleanup after a failed connect
        }
        if (attempt < this.maxAttempts) {
          const jitter = 0.75 + Math.random() * 0.5;
          await sleep(Math.round(200 * 2 ** (attempt - 1) * jitter));
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("imap connect failed");
  }

  async invalidateConnection(cause: unknown = new Error("mail-provider-metadata-cancelled")): Promise<void> {
    const client = this.imap;
    this.imap = null;
    this.uidValidity = null;
    this.selectedFolder = null;
    this.selectedUidValidity = null;
    const controller = this.metadataAbort;
    this.metadataAbort = new AbortController();
    try { client?.close?.(); } catch { /* Cancellation must settle even if socket cleanup fails. */ }
    controller.abort(cause);
  }

  async disconnect(): Promise<void> {
    const client = this.imap;
    this.imap = null;
    this.uidValidity = null;
    this.selectedFolder = null;
    this.selectedUidValidity = null;
    if (!client) return;
    this.detachClientLifecycleListeners(client);
    try {
      await client.logout();
    } catch {
      // logout may fail if the socket is already gone — not actionable
    }
  }

  supportsPushWatch(): boolean {
    return this.imap?.capabilities?.has("IDLE") ?? false;
  }

  async getMailboxStatus(): Promise<MailboxStatus> {
    if (!this.imap || this.uidValidity === null) await this.connect();
    const client = this.imap!;
    let lock: { release(): void } | undefined;
    try {
      lock = await client.getMailboxLock?.(this.folder);
      const status = typeof client.status === "function"
        ? await client.status(this.folder, {
            uidNext: true,
            uidValidity: true,
            highestModseq: true,
          })
        : undefined;
      return {
        path: status?.path ?? this.folder,
        uidValidity: Number(status?.uidValidity ?? this.uidValidity),
        uidNext: status?.uidNext ?? null,
        highestModseq: status?.highestModseq === undefined
          ? null
          : String(status.highestModseq),
        supportsIdle: this.imap?.capabilities?.has("IDLE") ?? false,
        supportsCondstore: this.imap?.capabilities?.has("CONDSTORE") ?? false,
        supportsQresync: this.imap?.capabilities?.has("QRESYNC") ?? false,
      };
    } finally {
      lock?.release();
    }
  }

  async waitForMailboxChange(signal?: AbortSignal): Promise<void> {
    if (!this.imap || this.uidValidity === null) await this.connect();
    const client = this.imap!;
    if (typeof client.on !== "function" || typeof client.off !== "function") {
      throw new Error("imap exists events not supported by client");
    }
    if (signal?.aborted) throw mailWatchAbortedError();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onExists = (event?: unknown) => {
        if (event && typeof event === "object" && "path" in event && event.path !== this.folder) return;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(mailWatchAbortedError());
      };
      const onClose = () => {
        cleanup();
        reject(new Error("imap connection closed"));
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const cleanup = () => {
        if (settled) return;
        settled = true;
        client.off!("exists", onExists);
        client.off!("close", onClose);
        client.off!("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };

      client.on!("exists", onExists);
      client.on!("close", onClose);
      client.on!("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });

      if (signal?.aborted) {
        onAbort();
        return;
      }

      // ImapFlow automatically enters and periodically refreshes IDLE while
      // the selected mailbox is otherwise inactive.
    });
  }

  async syncRecent(limit: number): Promise<MailMessage[]> {
    if (!this.imap || this.uidValidity === null) await this.connect();
    const client = this.imap!;
    const uidValidity = this.uidValidity!;
    const account = this.requireAccount();
    const folder = this.folder;

    let uids: number[] | false;
    try {
      uids = await client.search({ all: true }, { uid: true });
    } catch (error) {
      throw new MailProviderCommandError({ phase: "imap.search", cause: error });
    }
    if (!uids || uids.length === 0) return [];

    const recentUids = uids.slice(-Math.max(1, limit));
    return this.fetchMessagesByUid(client, recentUids, {
      accountId: account.id,
      folder,
      uidValidity,
    });
  }

  async syncSince(since: Date): Promise<MailMessage[]> {
    if (!this.imap || this.uidValidity === null) await this.connect();
    const client = this.imap!;
    const account = this.requireAccount();
    const folders = await this.withMetadataDeadline(client, () => this.listSyncFolders(client));
    const messages: MailMessage[] = [];

    try {
      for (const folder of folders) {
        const uidValidity = await this.openMailbox(client, folder);
        let uids: number[] | false;
        try {
          uids = await client.search({ since }, { uid: true });
        } catch (error) {
          throw new MailProviderCommandError({ phase: "imap.search", cause: error });
        }
        if (!uids || uids.length === 0) continue;

        const cappedUids = uids.slice(-MAX_SYNC_WINDOW_FETCH_UIDS);
        if (uids.length > cappedUids.length) {
          this.log(
            `imap sync window capped folder=${folder} matched=${uids.length} fetched=${cappedUids.length}`,
          );
        }

        messages.push(
          ...(await this.fetchMessagesByUid(client, cappedUids, {
            accountId: account.id,
            folder,
            uidValidity,
          })),
        );
      }
    } finally {
      await this.restoreDefaultMailbox(client);
    }

    return messages.sort(
      (a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime(),
    );
  }

  async *syncMetadataPages(
    options: MailMetadataPageOptions,
  ): AsyncIterable<MailMetadataPage> {
    if (!this.imap || this.uidValidity === null) await this.connect();
    const client = this.imap!;
    const account = this.requireAccount();
    const folders = await this.listSyncFolders(client);
    const pageSize = Math.min(100, Math.max(1, options.pageSize));

    try {
      const states: Array<{
        folder: string;
        uidValidity: number;
        afterUid: number;
        previousInternalDate?: string;
        pendingUids: number[];
      }> = [];
      for (const folder of folders) {
        const uidValidity = await this.openMailbox(client, folder);
        const previous = options.continuations?.[folder];
        if (previous?.completed && previous.uidValidity === uidValidity) continue;
        let uids: number[] | false;
        try {
          uids = await client.search({ since: options.since }, { uid: true });
        } catch (error) {
          throw new MailProviderCommandError({ phase: "imap.search", cause: error });
        }
        const afterUid = previous?.uidValidity === uidValidity ? previous.uid : 0;
        states.push({
          folder,
          uidValidity,
          afterUid,
          ...(previous?.internalDate ? { previousInternalDate: previous.internalDate } : {}),
          pendingUids: (uids || [])
            .filter((uid) => uid > afterUid)
            .sort((left, right) => left - right),
        });
      }

      for (const state of states) {
        if (state.pendingUids.length > 0) continue;
        const currentUidValidity = await this.openMailbox(client, state.folder);
        if (currentUidValidity !== state.uidValidity) {
          throw new MailProviderCommandError({
            phase: "imap.select",
            cause: new Error(
              `UIDVALIDITY changed folder=${state.folder} expected=${state.uidValidity} actual=${currentUidValidity}`,
            ),
          });
        }
        yield {
          folder: state.folder,
          messages: [],
          continuation: {
            uid: state.afterUid,
            uidValidity: state.uidValidity,
            internalDate: state.previousInternalDate ?? options.since.toISOString(),
            completed: true,
          },
        };
      }

      // Round-robin the newest page from every folder before taking a second
      // page from any folder. The runtime drains each page's body jobs before
      // requesting the next page, yielding global newest-first behavior in
      // bounded batches without retaining message payloads.
      while (states.some((state) => state.pendingUids.length > 0)) {
        for (const state of states) {
          if (state.pendingUids.length === 0) continue;
          const currentUidValidity = await this.openMailbox(client, state.folder);
          if (currentUidValidity !== state.uidValidity) {
            throw new MailProviderCommandError({
              phase: "imap.select",
              cause: new Error(
                `UIDVALIDITY changed folder=${state.folder} expected=${state.uidValidity} actual=${currentUidValidity}`,
              ),
            });
          }
          const start = Math.max(0, state.pendingUids.length - pageSize);
          const pageUids = state.pendingUids.splice(start);
          const messages = await this.fetchMessagesByUid(client, pageUids, {
            accountId: account.id,
            folder: state.folder,
            uidValidity: state.uidValidity,
          });
          const newest = messages.reduce<MailMessage | undefined>(
            (current, message) => !current || message.sync.uid > current.sync.uid
              ? message
              : current,
            undefined,
          );
          yield {
            folder: state.folder,
            messages,
            continuation: {
              uid: pageUids.at(-1)!,
              uidValidity: state.uidValidity,
              internalDate: newest?.sync.internalDate ?? options.since.toISOString(),
              completed: state.pendingUids.length === 0,
            },
          };
        }
      }
    } finally {
      await this.restoreDefaultMailbox(client);
    }
  }

  async listFolders(): Promise<MailFolder[]> {
    if (!this.imap || this.uidValidity === null) await this.connect();
    return this.listProviderFolders(this.imap!);
  }

  async *syncIncrementalPages(options: MailIncrementalPageOptions): MailIncrementalPageStream {
    await this.connect();
    const client = this.imap!;
    const accountId = this.requireAccount().id;
    const folders = await this.withMetadataDeadline(client, () => this.listSyncFolders(client));
    folders.sort((left, right) => Number(right === this.folder) - Number(left === this.folder));
    const states = folders.map((folder) => ({
      folder,
      previous: options.states[folder] ?? null as MailFolderSyncState | null,
      upper: null as number | null,
      after: 0,
      done: false,
    }));
    let nextFolder = 0;
    let recheckInbox = false;
    let allowInboxRecheck = true;
    try {
      while (states.some((state) => !state.done) || recheckInbox) {
        const inbox = states.find((candidate) => candidate.folder === this.folder);
        let selectedState: (typeof states)[number] | undefined;
        if (recheckInbox && allowInboxRecheck && inbox) {
          selectedState = inbox;
          recheckInbox = false;
          allowInboxRecheck = false;
        } else {
          for (let offset = 0; offset < states.length; offset++) {
            const index = (nextFolder + offset) % states.length;
            if (states[index].done) continue;
            selectedState = states[index];
            nextFolder = (index + 1) % states.length;
            break;
          }
          allowInboxRecheck = true;
        }
        const state = selectedState;
        if (!state) break;
        const page = await this.withMetadataDeadline(client, async () => {
          const lock = await client.getMailboxLock?.(state.folder);
          try {
            const box = await client.mailboxOpen(state.folder);
            const uidValidity = Number(box.uidValidity);
            this.selectedFolder = state.folder;
            this.selectedUidValidity = uidValidity;
            if (state.folder === this.folder) this.uidValidity = uidValidity;
            if (!Number.isSafeInteger(box.uidNext) || box.uidNext! < 1) {
              throw new Error("mail-provider-uidnext-unavailable");
            }
            const sameGeneration = state.previous?.uidValidity === uidValidity;
            if (state.upper === null) {
              state.upper = box.uidNext! - 1;
              if (options.repair) {
                if (sameGeneration && state.previous?.repair?.completed) {
                  state.done = true;
                  return null;
                }
                state.after = sameGeneration ? state.previous?.repair?.uid ?? 0 : 0;
              } else {
                // A recent realtime baseline is separate from durable historical coverage.
                state.after = sameGeneration ? state.previous!.uid : Math.max(0, state.upper - 50);
              }
            } else if (!sameGeneration && state.previous) {
              throw new Error("mail-provider-uidvalidity-changed-during-page");
            }
            const since = sameGeneration && state.previous?.repair
              ? state.previous.repair.since : options.since.toISOString();
            const rangeEnd = Math.min(state.upper, state.after + 512);
            const found = state.after < rangeEnd
              ? await client.search({
                  uid: `${state.after + 1}:${rangeEnd}`,
                  ...(options.repair ? { since: new Date(since) } : {}),
                }, { uid: true })
              : [];
            const uids = [...new Set(found || [])]
              .filter((uid) => uid > state.after && uid <= rangeEnd)
              .sort((left, right) => left - right);
            const selected = uids.slice(0, 50);
            const messages = await this.fetchMessagesByUid(client, selected, {
              accountId, folder: state.folder, uidValidity,
            });
            const returned = new Set(messages.map((message) => message.sync.uid));
            const missing = selected.filter((uid) => !returned.has(uid));
            if (missing.length > 0) {
              const stillPresent = await client.search({ uid: missing.join(",") }, { uid: true });
              if ((stillPresent || []).some((uid) => missing.includes(uid))) {
                throw new Error("mail-provider-metadata-fetch-incomplete");
              }
            }
            state.after = uids.length > selected.length ? selected.at(-1)! : Math.max(state.after, rangeEnd);
            state.done = state.after >= state.upper;
            const newest = messages.reduce<MailMessage | null>((current, message) =>
              !current || message.sync.uid > current.sync.uid ? message : current, null);
            const base: MailFolderSyncState = sameGeneration ? state.previous! : {
              uid: options.repair ? 0 : state.after,
              uidValidity,
              internalDate: newest?.sync.internalDate ?? options.since.toISOString(),
            };
            const next: MailFolderSyncState = options.repair ? {
              ...base,
              repair: { version: 1, since, uid: state.after, completed: state.done },
            } : {
              ...base,
              uid: state.after,
              internalDate: newest?.sync.internalDate ?? base.internalDate,
            };
            return {
              folder: state.folder,
              messages: messages.sort((left, right) => left.sync.uid - right.sync.uid),
              continuation: { ...next, completed: state.done },
              checkpoint: { folder: state.folder, previous: state.previous, next, mode: options.repair ? "repair" as const : "incremental" as const },
            };
          } finally {
            lock?.release();
            await this.restoreDefaultMailbox(client);
          }
        });
        if (!page) continue;
        // The consumer requests another page only after the current one is durable.
        const resume = yield page;
        state.previous = page.checkpoint!.next;
        if (resume) {
          for (const candidate of states) {
            const committed = resume.states[candidate.folder];
            const generationChanged = committed && committed.uidValidity !== candidate.previous?.uidValidity;
            if (committed) candidate.previous = committed;
            if (resume.recheckInbox || generationChanged) {
              candidate.upper = null;
              candidate.done = false;
            }
          }
          recheckInbox ||= resume.recheckInbox;
        }
      }
    } finally {
      await this.restoreDefaultMailbox(client);
    }
  }

  private async withMetadataDeadline<T>(client: ImapLikeClient, run: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const signal = this.metadataAbort.signal;
    let onAbort: (() => void) | undefined;
    try {
      const result = await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            try { client.close?.(); } catch { /* Includes a client still connecting, before this.imap is assigned. */ }
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            // Close the actual socket before another operation can own the session.
            if (this.imap === client) {
              this.imap = null;
              this.uidValidity = null;
              this.selectedFolder = null;
              this.selectedUidValidity = null;
            }
            try { client.close?.(); } catch { /* The deadline must settle even when close fails. */ }
            reject(new Error("mail-provider-metadata-timeout"));
          }, 30_000);
          timer.unref();
        }),
      ]);
      this.onSyncProgress?.();
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async syncAfterCursor(cursor: MailSyncCursor): Promise<MailMessage[] | null> {
    if (!this.imap || this.uidValidity === null) await this.connect();
    const client = this.imap!;
    const uidValidity = this.uidValidity!;
    if (uidValidity !== cursor.uidValidity) {
      this.log(
        `imap incremental cursor invalid folder=${this.folder} cursorUidValidity=${cursor.uidValidity} currentUidValidity=${uidValidity}`,
      );
      return null;
    }
    const account = this.requireAccount();
    const folder = this.folder;

    let uids: number[] | false;
    const uidRange = `${cursor.uid + 1}:*`;
    try {
      uids = await client.search({ uid: uidRange }, { uid: true });
    } catch (error) {
      throw new MailProviderCommandError({ phase: "imap.search", cause: error });
    }
    // RFC 3501 sequence ranges are normalized by some servers, so searching
    // past the current highest UID can still return that highest UID. Only
    // UIDVALIDITY invalidates the cursor; stale UIDs are safe to ignore.
    const incrementalUids = (uids || []).filter((uid) => uid > cursor.uid);

    const messages = await this.fetchMessagesByUid(client, incrementalUids, {
      accountId: account.id,
      folder,
      uidValidity,
    });

    const since = new Date(cursor.internalDate);
    if (Number.isNaN(since.getTime())) return messages;
    try {
      const folders = (await this.listSyncFolders(client)).filter(
        (candidate) => candidate !== folder,
      );
      for (const otherFolder of folders) {
        const otherUidValidity = await this.openMailbox(client, otherFolder);
        let otherUids: number[] | false;
        try {
          otherUids = await client.search({ since }, { uid: true });
        } catch (error) {
          throw new MailProviderCommandError({ phase: "imap.search", cause: error });
        }
        if (!otherUids || otherUids.length === 0) continue;
        messages.push(
          ...(await this.fetchMessagesByUid(client, otherUids, {
            accountId: account.id,
            folder: otherFolder,
            uidValidity: otherUidValidity,
          })),
        );
      }
    } finally {
      await this.restoreDefaultMailbox(client);
    }
    return messages.sort(
      (a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime(),
    );
  }

  async refreshFlags(emailIds: string[]): Promise<MailMessage[]> {
    if (emailIds.length === 0) return [];
    if (!this.imap || this.uidValidity === null) await this.connect();
    const client = this.imap!;
    const account = this.requireAccount();
    const groups = new Map<string, { folder: string; uidValidity: number; uids: number[] }>();
    for (const emailId of emailIds) {
      let locator: ReturnType<typeof parseMessageLocator>;
      try {
        locator = parseMessageLocator(emailId);
      } catch {
        this.log(`imap flag refresh skipped invalidId=${emailId}`);
        continue;
      }
      const key = `${locator.folder}\u0000${locator.uidValidity}`;
      const group = groups.get(key) ?? {
        folder: locator.folder,
        uidValidity: locator.uidValidity,
        uids: [],
      };
      group.uids.push(locator.uid);
      groups.set(key, group);
    }

    const messages: MailMessage[] = [];
    try {
      for (const group of groups.values()) {
        const currentUidValidity = await this.openMailbox(client, group.folder);
        if (currentUidValidity !== group.uidValidity) {
          this.log(
            `imap flag refresh skipped folder=${group.folder} expectedUidValidity=${group.uidValidity} currentUidValidity=${currentUidValidity}`,
          );
          continue;
        }
        messages.push(
          ...(await this.fetchMessagesByUid(client, group.uids, {
            accountId: account.id,
            folder: group.folder,
            uidValidity: currentUidValidity,
          })),
        );
      }
    } finally {
      await this.restoreDefaultMailbox(client);
    }
    return messages;
  }

  async updateFlags(emailId: string, patch: MailFlagsPatch): Promise<void> {
    const locator = parseMessageLocator(emailId);
    if (!this.imap) await this.connect();
    const client = this.imap!;
    const additions: string[] = [];
    const removals: string[] = [];
    const flagNames: Array<[keyof MailFlagsPatch, string]> = [
      ["seen", "\\Seen"],
      ["flagged", "\\Flagged"],
      ["answered", "\\Answered"],
      ["draft", "\\Draft"],
    ];
    for (const [key, imapFlag] of flagNames) {
      const value = patch[key];
      if (value === true) additions.push(imapFlag);
      if (value === false) removals.push(imapFlag);
    }

    try {
      const uidValidity = await this.openMailbox(client, locator.folder);
      if (uidValidity !== locator.uidValidity) {
        throw new Error(
          `uid validity changed for ${locator.folder}: expected ${locator.uidValidity}, received ${uidValidity}`,
        );
      }
      if (additions.length > 0) {
        if (typeof client.messageFlagsAdd !== "function") {
          throw new Error("IMAP flag updates are not supported by the client");
        }
        await client.messageFlagsAdd([locator.uid], additions, { uid: true });
      }
      if (removals.length > 0) {
        if (typeof client.messageFlagsRemove !== "function") {
          throw new Error("IMAP flag updates are not supported by the client");
        }
        await client.messageFlagsRemove([locator.uid], removals, { uid: true });
      }
    } catch (error) {
      if (error instanceof MailProviderCommandError) throw error;
      throw new MailProviderCommandError({ phase: "imap.store", cause: error });
    } finally {
      await this.restoreDefaultMailbox(client);
    }
  }

  async moveMessage(
    emailId: string,
    folder: string,
  ): Promise<{ folder: string; uid?: number; uidValidity?: number }> {
    const locator = parseMessageLocator(emailId);
    if (!this.imap) await this.connect();
    const client = this.imap!;
    try {
      const uidValidity = await this.openMailbox(client, locator.folder);
      if (uidValidity !== locator.uidValidity) {
        throw new Error(
          `uid validity changed for ${locator.folder}: expected ${locator.uidValidity}, received ${uidValidity}`,
        );
      }
      if (typeof client.messageMove !== "function") {
        throw new Error("IMAP message move is not supported by the client");
      }
      const moved = await client.messageMove([locator.uid], folder, { uid: true });
      return {
        folder,
        ...(moved && moved.uidMap?.get(locator.uid)
          ? { uid: moved.uidMap.get(locator.uid) }
          : {}),
        ...(moved && moved.uidValidity !== undefined
          ? { uidValidity: Number(moved.uidValidity) }
          : {}),
      };
    } catch (error) {
      if (error instanceof MailProviderCommandError) throw error;
      throw new MailProviderCommandError({ phase: "imap.move", cause: error });
    } finally {
      await this.restoreDefaultMailbox(client);
    }
  }

  async deleteMessage(emailId: string): Promise<void> {
    const locator = parseMessageLocator(emailId);
    if (!this.imap) await this.connect();
    const client = this.imap!;
    try {
      const uidValidity = await this.openMailbox(client, locator.folder);
      if (uidValidity !== locator.uidValidity) {
        throw new Error(
          `uid validity changed for ${locator.folder}: expected ${locator.uidValidity}, received ${uidValidity}`,
        );
      }
      if (typeof client.messageDelete !== "function") {
        throw new Error("IMAP message delete is not supported by the client");
      }
      await client.messageDelete([locator.uid], { uid: true });
    } catch (error) {
      if (error instanceof MailProviderCommandError) throw error;
      throw new MailProviderCommandError({ phase: "imap.delete", cause: error });
    } finally {
      await this.restoreDefaultMailbox(client);
    }
  }

  async resolveMessageLocator(
    folder: string,
    messageId: string,
  ): Promise<{ uid: number; uidValidity: number } | null> {
    if (!this.imap) await this.connect();
    const client = this.imap!;
    try {
      const uidValidity = await this.openMailbox(client, folder);
      const matches = await client.search(
        { header: { "message-id": messageId } },
        { uid: true },
      );
      const uid = Array.isArray(matches) && matches.length > 0 ? Math.max(...matches) : null;
      return uid === null ? null : { uid, uidValidity };
    } catch (error) {
      if (error instanceof MailProviderCommandError) throw error;
      throw new MailProviderCommandError({ phase: "imap.search", cause: error });
    } finally {
      await this.restoreDefaultMailbox(client);
    }
  }

  private async fetchMessagesByUid(
    client: ImapLikeClient,
    uids: number[],
    context: { accountId: string; folder: string; uidValidity: number },
  ): Promise<MailMessage[]> {
    const query = {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
      internalDate: true,
    } as const;
    const messages: MailMessage[] = [];
    try {
      for (let start = 0; start < uids.length; start += METADATA_FETCH_BATCH_SIZE) {
        const batch = uids.slice(start, start + METADATA_FETCH_BATCH_SIZE);
        for await (const raw of client.fetch(batch, query, { uid: true })) {
          const normalized = await normalizeMail(rawToImapMessage(raw, false), {
            accountId: context.accountId,
            folder: context.folder,
            uidValidity: context.uidValidity,
          });
          messages.push(normalized);
        }
      }
    } catch (error) {
      throw new MailProviderCommandError({ phase: "imap.fetch", cause: error });
    }
    return messages;
  }

  private async openMailbox(client: ImapLikeClient, folder: string): Promise<number> {
    try {
      const box = await client.mailboxOpen(folder);
      const uidValidity = Number(box.uidValidity);
      this.selectedFolder = folder;
      this.selectedUidValidity = uidValidity;
      if (folder === this.folder) this.uidValidity = uidValidity;
      return uidValidity;
    } catch (error) {
      throw new MailProviderCommandError({ phase: "imap.select", cause: error });
    }
  }

  private async listSyncFolders(client: ImapLikeClient): Promise<string[]> {
    try {
      const folders = (await this.listProviderFolders(client))
        .filter((folder) => !shouldSkipSyncFolder(folder))
        .map((folder) => folder.path);
      if (!folders.includes(this.folder)) folders.unshift(this.folder);
      return Array.from(new Set(folders));
    } catch (error) {
      this.log(
        `imap list folders failed folder=${this.folder} error=${String((error as Error).message ?? error)}`,
      );
      return [this.folder];
    }
  }

  private async listProviderFolders(
    client: ImapLikeClient,
  ): Promise<Array<MailFolder & Pick<ImapMailboxLike, "specialUse" | "flags">>> {
    if (typeof client.list !== "function") {
      return [{ path: this.folder, name: this.folder }];
    }
    const seen = new Set<string>();
    const folders: MailFolder[] = [];
    for (const mailbox of await client.list()) {
      const folder = toMailFolder(mailbox);
      if (!folder) continue;
      const key = folder.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      folders.push(folder);
    }
    if (!seen.has(this.folder.toLowerCase())) {
      folders.unshift({ path: this.folder, name: this.folder });
    }
    return folders;
  }

  private async restoreDefaultMailbox(client: ImapLikeClient): Promise<void> {
    if (this.imap !== client) return;
    if (this.selectedFolder === this.folder && this.selectedUidValidity !== null) {
      this.uidValidity = this.selectedUidValidity;
      return;
    }
    try {
      await this.withMetadataDeadline(client, () => this.openMailbox(client, this.folder));
    } catch (error) {
      this.log(
        `imap restore mailbox failed folder=${this.folder} error=${String((error as Error).message ?? error)}`,
      );
      if (this.imap === client) {
        this.imap = null;
        this.uidValidity = null;
        this.selectedFolder = null;
        this.selectedUidValidity = null;
      }
      try { client.close?.(); } catch { /* Preserve the failed restore as the retry reason. */ }
      throw error;
    }
  }

  async getMessage(
    emailId: string,
    options: { onDemand?: boolean } = {},
  ): Promise<MailMessage | null> {
    const locator = parseMessageLocator(emailId);
    const startedAt = Date.now();
    const coldConnection = !this.imap;
    let connectMs = 0;
    let selectMs = 0;
    let fetchMs = 0;
    let parseMs = 0;
    let restoreMs = 0;
    let sourceBytes = 0;
    let outcome: ImapMessageOperationTiming["outcome"] = "failure";
    if (!this.imap) {
      const connectStartedAt = Date.now();
      await this.connect();
      connectMs = Date.now() - connectStartedAt;
    }
    const client = this.imap!;
    const account = this.requireAccount();
    try {
      const selectStartedAt = Date.now();
      const uidValidity = await this.openMailbox(client, locator.folder);
      selectMs = Date.now() - selectStartedAt;
      if (uidValidity !== locator.uidValidity) {
        outcome = "missing";
        return null;
      }
      // Probe RFC822.SIZE before fetching the full source, so a single huge
      // email can't OOM the worker_thread (its raw source is buffered in full
      // then parsed synchronously).
      let probeSize: number | undefined;
      for await (const probe of client.fetch([locator.uid], { uid: true, size: true }, { uid: true })) {
        probeSize = probe.size;
      }
      this.log(`getMessage-probe emailId=${emailId} probeSize=${probeSize ?? "undefined"}`);
      if (typeof probeSize === "number" && probeSize > MAX_BODY_SOURCE_BYTES) {
        // Background hydration and a plain click both refuse oversized mail;
        // only an explicit "load body" action (onDemand) fetches the
        // renderable parts. This keeps a 5MB+ email from blocking the worker
        // event loop (sync MIME parse) past the heartbeat tolerance.
        if (!options.onDemand) {
          throw new MailProviderCommandError({
            phase: "imap.fetch",
            cause: new Error(
              `mail-provider-message-too-large:${probeSize}:${MAX_BODY_SOURCE_BYTES}`,
            ),
          });
        }
        const fetchStartedAt = Date.now();
        const oversized = await fetchMessageWithoutAttachments(client, locator.uid);
        fetchMs = Date.now() - fetchStartedAt;
        if (!oversized) {
          outcome = "missing";
          return null;
        }
        sourceBytes = byteLength(oversized.source);
        const parseStartedAt = Date.now();
        const message = await normalizeMail(rawToImapMessage(oversized), {
          accountId: account.id,
          folder: locator.folder,
          uidValidity,
        });
        parseMs = Date.now() - parseStartedAt;
        outcome = "success";
        this.log(
          `getMessage-body-parts emailId=${emailId} messageSize=${probeSize} bodyBytes=${sourceBytes}`,
        );
        return message;
      }
      const query = {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        source: true,
        internalDate: true,
      } as const;
      const fetchStartedAt = Date.now();
      for await (const raw of client.fetch([locator.uid], query, { uid: true })) {
        fetchMs = Date.now() - fetchStartedAt;
        sourceBytes = byteLength(raw.source);
        // Backstop: some IMAP servers don't return RFC822.SIZE, so probeSize can
        // be undefined and the pre-fetch cap is skipped. Refuse here too, before
        // the (memory-explosive) parse, if the actual source is oversized.
        if (sourceBytes > MAX_BODY_SOURCE_BYTES) {
          throw new MailProviderCommandError({
            phase: "imap.fetch",
            cause: new Error(`mail-provider-message-too-large:post-fetch:${sourceBytes}:${MAX_BODY_SOURCE_BYTES}`),
          });
        }
        const parseStartedAt = Date.now();
        const message = await normalizeMail(rawToImapMessage(raw), {
          accountId: account.id,
          folder: locator.folder,
          uidValidity,
        });
        parseMs = Date.now() - parseStartedAt;
        outcome = "success";
        return message;
      }
      fetchMs = Date.now() - fetchStartedAt;
      outcome = "missing";
      return null;
    } catch (error) {
      if (error instanceof MailProviderCommandError) throw error;
      throw new MailProviderCommandError({ phase: "imap.fetch", cause: error });
    } finally {
      const restoreStartedAt = Date.now();
      await this.restoreDefaultMailbox(client);
      restoreMs = Date.now() - restoreStartedAt;
      try {
        this.onOperationTiming?.({
          operation: "getMessage",
          emailId,
          folder: locator.folder,
          role: this.role,
          outcome,
          coldConnection,
          sourceBytes,
          connectMs,
          selectMs,
          fetchMs,
          parseMs,
          restoreMs,
          totalMs: Date.now() - startedAt,
        });
      } catch {
        // Observability must never change the mail fetch result.
      }
    }
  }

  async fetchAttachment(
    emailId: string,
    partId: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; mimetype: string } | null> {
    // emailId format: `${accountId}:${folder}:${uidValidity}:${uid}`.
    // The folder embedded in the id is the source-of-truth — connect
    // routes through the same mailbox the message was synced from.
    const parts = emailId.split(":");
    if (parts.length < 4) {
      throw new Error(`invalid attachment email id: ${emailId}`);
    }
    const folder = parts.slice(1, parts.length - 2).join(":");
    const uid = Number(parts[parts.length - 1]);
    if (!Number.isFinite(uid) || !folder) {
      throw new Error(`invalid attachment locator: ${emailId}`);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfAborted(signal);
      if (!this.imap) await this.connect();
      const client = this.imap!;
      if (typeof client.download !== "function") {
        throw new Error("attachment download is not supported by the IMAP client");
      }
      let shouldReconnect = false;

      // The provider was opened against `this.folder` at connect time —
      // re-open if we need a different folder (e.g. attachment came from
      // Sent or another label).
      if (folder !== this.folder) {
        try {
          await this.openMailbox(client, folder);
        } catch (error) {
          throw new MailProviderCommandError({ phase: "imap.select", cause: error });
        }
      }

      try {
        let lastVolumeLimitError: unknown;
        for (const chunkSize of ATTACHMENT_DOWNLOAD_CHUNK_SIZES) {
          throwIfAborted(signal);
          try {
            const result = await client.download(uid, partId, { uid: true, chunkSize });
            if (!result.content) {
              if (attempt === 0) {
                shouldReconnect = true;
                break;
              }
              throw new Error("attachment content unavailable");
            }
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            for await (const chunk of result.content) {
              throwIfAborted(signal);
              const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
              totalBytes += buf.byteLength;
              if (totalBytes > MAX_ATTACHMENT_DOWNLOAD_BYTES) {
                throw new Error(
                  `mail-provider-attachment-too-large:${totalBytes}:${MAX_ATTACHMENT_DOWNLOAD_BYTES}`,
                );
              }
              chunks.push(buf);
            }
            return {
              bytes: Buffer.concat(chunks),
              mimetype: result.meta?.contentType ?? "application/octet-stream",
            };
          } catch (error) {
            if (!isFetchVolumeLimitError(error)) throw error;
            lastVolumeLimitError = error;
          }
        }
        if (shouldReconnect) {
          await this.disconnect();
          continue;
        }
        throw lastVolumeLimitError;
      } catch (error) {
        if (attempt === 0 && isNoConnectionError(error)) {
          await this.disconnect();
          continue;
        }
        throw new MailProviderCommandError({ phase: "imap.fetch", cause: error });
      } finally {
        if (folder !== this.folder) {
          try {
            await this.restoreDefaultMailbox(client);
          } catch {
            // best-effort restore; caller already got their bytes
          }
        }
      }
    }
    throw new Error("attachment content unavailable");
  }

  async sendDraft(input: WemailDraftInput): Promise<{
    messageId: string;
    delivery?: WemailDeliveryResult;
  }> {
    enableSystemCertificateAuthorities();
    const { config, smtpPassword } = this.resolveSmtpCredentials();
    const transport = this.smtpFactory({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.username, pass: smtpPassword },
    });
    const result = await transport.sendMail({
      from: formatAddress({
        name: config.displayName,
        email: config.emailAddress,
      }),
      to: input.to.map((a) => formatAddress(a)).join(", "),
      cc: input.cc?.length ? input.cc.map(formatAddress).join(", ") : undefined,
      bcc: input.bcc?.length ? input.bcc.map(formatAddress).join(", ") : undefined,
      subject: input.subject,
      messageId: input.smtpMessageId,
      text: input.bodyText,
      html: input.bodyHtml || undefined,
      attachments: input.attachments?.map((attachment) => ({
        filename: attachment.filename,
        // Pass the original base64 payload through explicitly so the
        // generated MIME part always carries a stable transfer-encoding
        // and an attachment disposition across SMTP providers/clients.
        content: attachment.dataBase64,
        encoding: "base64",
        contentType: attachment.mimetype || "application/octet-stream",
        contentDisposition: "attachment",
      })),
    });
    const delivery = normalizeDeliveryResult(result);
    if (delivery && delivery.accepted.length === 0 && delivery.rejected.length > 0) {
      throw new Error(`SMTP rejected all recipients: ${delivery.rejected.join(", ")}`);
    }
    this.log(
      `smtp sent account=${config.id} messageId=${result.messageId} ` +
        `status=${delivery?.status ?? "unknown"} ` +
        `accepted=${JSON.stringify(delivery?.accepted ?? [])} ` +
        `rejected=${JSON.stringify(delivery?.rejected ?? [])} ` +
        `rejectedDetails=${JSON.stringify(delivery?.rejectedDetails ?? [])}`,
    );
    return { messageId: result.messageId, ...(delivery ? { delivery } : {}) };
  }

  private requireAccount() {
    const account = this.accountService.getCurrentAccount();
    if (!account) throw new Error("no account configured");
    return account;
  }

  private resolveImapCredentials() {
    const config = this.requireAccount();
    const imapPassword = this.secrets.getSecret(imapPasswordKey(config.id));
    if (!imapPassword) {
      throw new Error(`imap password missing for account ${config.id}`);
    }
    return { config, imapPassword };
  }

  private resolveSmtpCredentials() {
    const config = this.requireAccount();
    // No silent fallback to the IMAP password: providers commonly require
    // separate app passwords for SMTP, and reusing the IMAP secret hides
    // misconfiguration. Fail loud with a structured connect error so the
    // caller can surface the setup step.
    const smtpPassword = this.secrets.getSecret(smtpPasswordKey(config.id));
    if (!smtpPassword) {
      throw new MailProviderConnectError({
        phase: "smtp",
        cause: new Error("SMTP credentials not configured"),
      });
    }
    return { config, smtpPassword };
  }

  private attachClientLifecycleListeners(client: ImapLikeClient): void {
    if (typeof client.on !== "function" || this.clientErrorListeners.has(client)) return;
    const error = (cause?: unknown) => {
      const message =
        cause instanceof Error ? cause.message : String(cause ?? "unknown");
      this.log(`imap client error error=${message}`);
      if (this.imap === client) {
        this.imap = null;
        this.uidValidity = null;
        this.selectedFolder = null;
        this.selectedUidValidity = null;
      }
    };
    const close = () => {
      this.log("imap client closed");
      if (this.imap === client) {
        this.imap = null;
        this.uidValidity = null;
        this.selectedFolder = null;
        this.selectedUidValidity = null;
      }
    };
    client.on("error", error);
    client.on("close", close);
    this.clientErrorListeners.set(client, { error, close });
  }

  private detachClientLifecycleListeners(client: ImapLikeClient): void {
    const listeners = this.clientErrorListeners.get(client);
    if (!listeners) return;
    if (typeof client.off === "function") {
      client.off("error", listeners.error);
      client.off("close", listeners.close);
    }
    this.clientErrorListeners.delete(client);
  }
}

function formatAddress(a: { name?: string; email: string }): string {
  if (a.name) return `${a.name} <${a.email}>`;
  return a.email;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mailWatchAbortedError(): Error {
  return new Error("mail watch aborted");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("mail attachment fetch aborted");
  error.name = "AbortError";
  throw error;
}

function toMailFolder(
  mailbox: ImapMailboxLike,
): (MailFolder & Pick<ImapMailboxLike, "specialUse" | "flags">) | null {
  const path = (mailbox.path ?? mailbox.name ?? "").trim();
  if (!path) return null;
  const flags = Array.from(mailbox.flags ?? [], (flag) => flag.toLowerCase());
  if (flags.includes("\\noselect") || flags.includes("\\nonexistent")) return null;
  return {
    path,
    name: mailbox.name?.trim() || path,
    delimiter: mailbox.delimiter?.trim() || undefined,
    specialUse: mailbox.specialUse,
    flags: mailbox.flags,
  };
}

function getImapCommandErrorDetails(error: unknown): {
  message: string;
  responseStatus?: string;
  responseText?: string;
  code?: string;
  serverResponseCode?: string;
  executedCommand?: string;
  rendered: string;
} {
  if (!error || typeof error !== "object") {
    const message = String(error);
    return { message, rendered: message };
  }
  const record = error as {
    message?: unknown;
    responseStatus?: unknown;
    responseText?: unknown;
    code?: unknown;
    serverResponseCode?: unknown;
    executedCommand?: unknown;
  };
  const message = typeof record.message === "string" ? record.message : String(error);
  const responseStatus =
    typeof record.responseStatus === "string" ? record.responseStatus : undefined;
  const responseText =
    typeof record.responseText === "string" ? record.responseText : undefined;
  const code = typeof record.code === "string" ? record.code : undefined;
  const serverResponseCode =
    typeof record.serverResponseCode === "string"
      ? record.serverResponseCode
      : undefined;
  const executedCommand =
    typeof record.executedCommand === "string"
      ? record.executedCommand
      : undefined;
  const parts = [
    message,
    responseStatus ? `status=${responseStatus}` : "",
    responseText ? `response=${responseText}` : "",
    code ? `code=${code}` : "",
    serverResponseCode ? `serverCode=${serverResponseCode}` : "",
    executedCommand ? `executedCommand=${executedCommand}` : "",
  ].filter((part) => part.length > 0);
  return {
    message,
    responseStatus,
    responseText,
    code,
    serverResponseCode,
    executedCommand,
    rendered: parts.join(" "),
  };
}

function isFetchVolumeLimitError(error: unknown): boolean {
  return /fetch volume limit/i.test(getImapCommandErrorDetails(error).rendered);
}

function shouldSkipSyncFolder(mailbox: {
  path?: string;
  name?: string;
  specialUse?: string;
  flags?: Iterable<string>;
}): boolean {
  const path = (mailbox.path ?? mailbox.name ?? "").trim().toLowerCase();
  const flags = Array.from(mailbox.flags ?? [], (flag) => flag.toLowerCase());
  const specialUse = mailbox.specialUse?.toLowerCase();
  const markers = [path, specialUse ?? "", ...flags];
  return markers.some((marker) =>
    marker === "\\drafts" ||
    marker === "\\trash" ||
    marker === "\\junk" ||
    marker === "\\spam" ||
    marker.includes("draft") ||
    marker.includes("trash") ||
    marker.includes("junk") ||
    marker.includes("spam") ||
    marker.includes("deleted"),
  );
}

function isNoConnectionError(error: unknown): boolean {
  const details = getImapCommandErrorDetails(error);
  return (
    details.code === "NoConnection" ||
    /connection not available/i.test(details.rendered)
  );
}

interface FetchBodyStructureNode {
  part?: string;
  type?: string;
  subtype?: string;
  mimeType?: string;
  disposition?: string | null;
  parameters?: Record<string, string> | null;
  dispositionParameters?: Record<string, string> | null;
  childNodes?: FetchBodyStructureNode[];
}

async function fetchMessageWithoutAttachments(
  client: ImapLikeClient,
  uid: number,
): Promise<RawFetchLike | null> {
  let metadata: RawFetchLike | null = null;
  for await (const raw of client.fetch(
    [uid],
    {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
      internalDate: true,
    },
    { uid: true },
  )) {
    metadata = raw;
  }
  if (!metadata) return null;

  const renderableParts = collectRenderableBodyParts(metadata.bodyStructure).slice(
    0,
    MAX_RENDERABLE_BODY_PARTS,
  );
  if (renderableParts.length === 0) {
    throw new Error("mail-provider-renderable-body-parts-unavailable");
  }

  const requestedParts = renderableParts.flatMap(({ part }) => [
    { key: `${part}.mime`, maxLength: 64 * 1024 },
    { key: part, maxLength: MAX_RENDERABLE_BODY_PART_BYTES },
  ]);
  let fetchedParts: Map<string, Buffer> | undefined;
  for await (const raw of client.fetch(
    [uid],
    { uid: true, bodyParts: requestedParts },
    { uid: true },
  )) {
    fetchedParts = raw.bodyParts;
  }
  if (!fetchedParts) {
    throw new Error("mail-provider-renderable-body-parts-missing");
  }

  return {
    ...metadata,
    source: buildBodyOnlyMimeSource(renderableParts, fetchedParts),
  };
}

function collectRenderableBodyParts(
  bodyStructure: unknown,
): Array<{ part: string; mimeType: string }> {
  const found: Array<{ part: string; mimeType: string }> = [];
  const visit = (node: FetchBodyStructureNode | null | undefined) => {
    if (!node) return;
    for (const child of node.childNodes ?? []) visit(child);
    if (!node.part || (node.childNodes?.length ?? 0) > 0) return;
    const mimeType = resolveBodyPartMimeType(node);
    const disposition = String(node.disposition ?? "").toLowerCase();
    const hasFilename = Boolean(
      node.dispositionParameters?.filename ??
      node.dispositionParameters?.name ??
      node.parameters?.filename ??
      node.parameters?.name,
    );
    if (disposition === "attachment" || hasFilename) return;
    if (
      mimeType === "text/plain" ||
      mimeType === "text/html" ||
      mimeType === "text/calendar" ||
      mimeType === "text/x-vcalendar" ||
      mimeType === "application/ics"
    ) {
      found.push({ part: node.part, mimeType });
    }
  };
  visit(bodyStructure as FetchBodyStructureNode | null | undefined);
  return found;
}

function resolveBodyPartMimeType(node: FetchBodyStructureNode): string {
  const explicit = node.mimeType?.trim().toLowerCase();
  if (explicit) return explicit;
  const type = node.type?.trim().toLowerCase() ?? "";
  if (type.includes("/")) return type;
  const subtype = node.subtype?.trim().toLowerCase() ?? "";
  return subtype ? `${type}/${subtype}` : type;
}

function buildBodyOnlyMimeSource(
  parts: Array<{ part: string; mimeType: string }>,
  fetchedParts: Map<string, Buffer>,
): Buffer {
  const boundary = "wemail-body-only-boundary";
  const chunks: Buffer[] = [
    Buffer.from(
      `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`,
      "latin1",
    ),
  ];
  for (const { part, mimeType } of parts) {
    const content = fetchedParts.get(part);
    if (!content) continue;
    const fetchedMime = fetchedParts.get(`${part}.mime`)?.toString("latin1").trim();
    const mimeHeaders = fetchedMime || `Content-Type: ${mimeType}; charset=utf-8`;
    chunks.push(Buffer.from(`--${boundary}\r\n${mimeHeaders}\r\n\r\n`, "latin1"));
    chunks.push(content);
    chunks.push(Buffer.from("\r\n", "latin1"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "latin1"));
  return Buffer.concat(chunks);
}

function rawToImapMessage(raw: RawFetchLike, includeSource = true): RawImapMessage {
  const envelope =
    (raw.envelope as RawImapMessage["envelope"] | undefined) ?? {
      date: null,
      subject: null,
      messageId: null,
      from: null,
      to: null,
    };
  return {
    uid: raw.uid,
    flags: raw.flags ?? null,
    internalDate: raw.internalDate ?? null,
    envelope,
    bodyStructure: raw.bodyStructure ?? null,
    source: includeSource ? raw.source : undefined,
  };
}

function byteLength(source: RawFetchLike["source"]): number {
  if (source === undefined) return 0;
  if (typeof source === "string") return Buffer.byteLength(source);
  return source.byteLength;
}

function normalizeDeliveryResult(result: {
  accepted?: unknown[];
  rejected?: unknown[];
  rejectedErrors?: unknown[];
}): WemailDeliveryResult | undefined {
  if (!Array.isArray(result.accepted) && !Array.isArray(result.rejected)) {
    return undefined;
  }
  const accepted = normalizeRecipientValues(result.accepted);
  const rejected = normalizeRecipientValues(result.rejected);
  const rejectedDetails = (result.rejectedErrors ?? [])
    .map(normalizeDeliveryRejection)
    .filter((detail): detail is WemailDeliveryRejection => detail !== null);
  return {
    status: rejected.length > 0 ? "partial" : "sent",
    accepted,
    rejected,
    ...(rejectedDetails.length > 0 ? { rejectedDetails } : {}),
  };
}

function normalizeRecipientValues(values: unknown[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const recipient = normalizeRecipientValue(value);
    if (recipient) normalized.add(recipient);
  }
  return [...normalized];
}

function normalizeRecipientValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim().toLowerCase() || null;
  if (!value || typeof value !== "object") return null;
  const record = value as { address?: unknown };
  return typeof record.address === "string"
    ? record.address.trim().toLowerCase() || null
    : null;
}

function normalizeDeliveryRejection(value: unknown): WemailDeliveryRejection | null {
  if (!value || typeof value !== "object") return null;
  const record = value as {
    recipient?: unknown;
    response?: unknown;
    responseCode?: unknown;
  };
  const recipient = normalizeRecipientValue(record.recipient);
  if (!recipient) return null;
  return {
    recipient,
    ...(typeof record.response === "string" ? { response: record.response } : {}),
    ...(typeof record.responseCode === "number"
      ? { responseCode: record.responseCode }
      : {}),
  };
}

function parseMessageLocator(emailId: string): {
  folder: string;
  uidValidity: number;
  uid: number;
} {
  const parts = emailId.split(":");
  if (parts.length < 4) throw new Error(`invalid message id: ${emailId}`);
  const folder = parts.slice(1, parts.length - 2).join(":");
  const uidValidity = Number(parts[parts.length - 2]);
  const uid = Number(parts[parts.length - 1]);
  if (!folder || !Number.isFinite(uidValidity) || !Number.isFinite(uid)) {
    throw new Error(`invalid message locator: ${emailId}`);
  }
  return { folder, uidValidity, uid };
}
