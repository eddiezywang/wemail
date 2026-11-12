import type {
  MailFlagsPatch,
  MailMessage,
  MailSyncCursor,
  WemailDraftInput,
} from "../../../shared/wemail/mail.js";
import type {
  FetchAttachmentResult,
  MailFolder,
  MailMoveResult,
  MailMetadataPage,
  MailMetadataPageOptions,
  MailIncrementalPageOptions,
  MailIncrementalPageStream,
  MailMetadataPageResume,
  MailProvider,
  MailboxStatus,
  SendDraftResult,
} from "./MailProvider.js";

type TransferPriority = "interactive" | "background";

interface PendingTransfer<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  generation: number | null;
  cancelled?: boolean;
  removeAbortListener?: () => void;
}

export class BackgroundSessionInvalidatedError extends Error {
  readonly code = "NoConnection";

  constructor() {
    super("background IMAP session was invalidated before queued work started");
    this.name = "BackgroundSessionInvalidatedError";
  }
}

/**
 * Serializes the existing background IMAP connection at bounded operation
 * boundaries. Interactive body/attachment work is selected before the next
 * historical metadata page; the foreground IDLE connection is never involved.
 */
export class BackgroundTransferMailProvider implements MailProvider {
  readonly role = "background-transfer" as const;
  readonly syncMetadataPages?: (
    options: MailMetadataPageOptions,
  ) => AsyncIterable<MailMetadataPage>;
  readonly syncIncrementalPages?: (options: MailIncrementalPageOptions) => MailIncrementalPageStream;
  private readonly interactive: PendingTransfer<unknown>[] = [];
  private readonly background: PendingTransfer<unknown>[] = [];
  private active = false;
  private sessionGeneration = 0;

  constructor(private readonly provider: MailProvider) {
    if (provider.syncMetadataPages) {
      this.syncMetadataPages = (options) => this.pages(options);
    }
    if (provider.syncIncrementalPages) {
      this.syncIncrementalPages = (options) => this.scheduledPages(provider.syncIncrementalPages!(options));
    }
  }

  connect(): Promise<void> {
    return this.scheduleLifecycle(() => this.provider.connect());
  }

  disconnect(): Promise<void> {
    return this.scheduleLifecycle(async () => {
      this.sessionGeneration++;
      await this.provider.disconnect();
    });
  }

  invalidateConnection(_cause?: unknown): Promise<void> {
    return this.scheduleLifecycle(async () => {
      this.sessionGeneration++;
      await this.provider.disconnect();
    });
  }

  syncRecent(limit: number): Promise<MailMessage[]> {
    return this.schedule("background", () => this.provider.syncRecent(limit));
  }

  syncSince(since: Date): Promise<MailMessage[]> {
    return this.schedule("background", () => this.provider.syncSince(since));
  }

  syncAfterCursor(cursor: MailSyncCursor): Promise<MailMessage[] | null> {
    if (!this.provider.syncAfterCursor) return Promise.resolve(null);
    return this.schedule("background", () => this.provider.syncAfterCursor!(cursor));
  }

  refreshFlags(emailIds: string[]): Promise<MailMessage[]> {
    if (!this.provider.refreshFlags) return Promise.resolve([]);
    return this.schedule("background", () => this.provider.refreshFlags!(emailIds));
  }

  updateFlags(emailId: string, patch: MailFlagsPatch): Promise<void> {
    if (!this.provider.updateFlags) return Promise.resolve();
    return this.schedule("interactive", () => this.provider.updateFlags!(emailId, patch));
  }

  listFolders(): Promise<MailFolder[]> {
    if (!this.provider.listFolders) return Promise.resolve([]);
    return this.schedule("background", () => this.provider.listFolders!());
  }

  getMessage(
    emailId: string,
    options?: { onDemand?: boolean },
  ): Promise<MailMessage | null> {
    return this.schedule("interactive", () =>
      this.provider.getMessage(emailId, options),
    );
  }

  fetchAttachment(
    emailId: string,
    partId: string,
    signal?: AbortSignal,
  ): Promise<FetchAttachmentResult | null> {
    if (!this.provider.fetchAttachment) return Promise.resolve(null);
    return this.schedule(
      "interactive",
      () => this.provider.fetchAttachment!(emailId, partId, signal),
      signal,
    );
  }

  getMailboxStatus(): Promise<MailboxStatus> {
    if (!this.provider.getMailboxStatus) {
      return Promise.reject(new Error("mailbox status is unavailable"));
    }
    return this.schedule("background", () => this.provider.getMailboxStatus!());
  }

  supportsPushWatch(): boolean {
    return false;
  }

  sendDraft(input: WemailDraftInput): Promise<SendDraftResult> {
    return this.schedule("interactive", () => this.provider.sendDraft(input));
  }

  private async *pages(
    options: MailMetadataPageOptions,
  ): AsyncIterable<MailMetadataPage> {
    yield* this.scheduledPages(this.provider.syncMetadataPages!(options));
  }

  private async *scheduledPages(pages: AsyncIterable<MailMetadataPage>): MailIncrementalPageStream {
    const iterator = pages[Symbol.asyncIterator]();
    let resume: MailMetadataPageResume | undefined;
    let completed = false;
    try {
      while (true) {
        const step = await this.schedule("background", () => iterator.next(resume));
        if (step.done) {
          completed = true;
          return;
        }
        resume = yield step.value;
      }
    } finally {
      if (!completed) await this.scheduleLifecycle(async () => { await iterator.return?.(); });
    }
  }

  private schedule<T>(
    priority: TransferPriority,
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(transferAbortedError());
    return new Promise<T>((resolve, reject) => {
      const pending: PendingTransfer<T> = {
        run,
        resolve,
        reject,
        generation: this.sessionGeneration,
      };
      const onAbort = () => {
        if (pending.cancelled) return;
        pending.cancelled = true;
        reject(transferAbortedError());
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
      const queue = priority === "interactive" ? this.interactive : this.background;
      queue.push(pending as PendingTransfer<unknown>);
      this.pump();
    });
  }

  moveMessage(emailId: string, folder: string): Promise<MailMoveResult | void> {
    if (!this.provider.moveMessage) return Promise.resolve();
    return this.schedule("interactive", () => this.provider.moveMessage!(emailId, folder));
  }

  deleteMessage(emailId: string): Promise<void> {
    if (!this.provider.deleteMessage) return Promise.resolve();
    return this.schedule("interactive", () => this.provider.deleteMessage!(emailId));
  }

  resolveMessageLocator(
    folder: string,
    messageId: string,
  ): Promise<{ uid: number; uidValidity: number } | null> {
    if (!this.provider.resolveMessageLocator) return Promise.resolve(null);
    return this.schedule(
      "interactive",
      () => this.provider.resolveMessageLocator!(folder, messageId),
    );
  }

  private scheduleLifecycle<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.interactive.push({
        run,
        resolve,
        reject,
        generation: null,
      } as PendingTransfer<unknown>);
      this.pump();
    });
  }

  private pump(): void {
    if (this.active) return;
    const next = this.interactive.shift() ?? this.background.shift();
    if (!next) return;
    if (next.cancelled) {
      next.removeAbortListener?.();
      this.pump();
      return;
    }
    if (
      next.generation !== null &&
      next.generation !== this.sessionGeneration
    ) {
      next.reject(new BackgroundSessionInvalidatedError());
      this.pump();
      return;
    }
    this.active = true;
    void next.run()
      .then(next.resolve, next.reject)
      .finally(() => {
        next.removeAbortListener?.();
        this.active = false;
        this.pump();
      });
  }
}

function transferAbortedError(): Error {
  const error = new Error("mail transfer aborted");
  error.name = "AbortError";
  return error;
}
