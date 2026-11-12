import type {
  DirectoryContactQueryOptions,
  DirectoryContactSearchResult,
  DirectoryContactSummary,
  DirectorySyncStatus,
  RecipientResolution,
  RecipientValidation,
} from "../../../shared/wemail/directory.js";
import type { AccountService } from "../account/AccountService.js";
import { imapPasswordKey } from "../account/AccountTypes.js";
import type { SecretStore } from "../security/SecretStore.js";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import type { DirectoryWriteParams, DirectoryReadParams, DirectoryReadResult } from "../../../shared/wemail/directoryDatabase.js";
import {
  DirectoryRemoteError,
  directoryRemoteErrorCode,
  type DirectoryRemoteClient,
  type DirectoryRemoteClientFactory,
  type DirectoryRemoteContact,
  type DirectoryRemoteDirectoryNode,
} from "./DirectoryRemoteClient.js";
import {
  DirectoryRepository,
  type DirectoryContactInput,
} from "./DirectoryRepository.js";
import {
  extractChineseDirectoryName,
  isOriginalEmailDisplayName,
} from "../../../shared/wemail/signature.js";

export interface DirectoryServiceOptions {
  repository: DirectoryRepository;
  mailDatabase?: Pick<MailDatabaseClient, "writeDirectory" | "readDirectory">;
  accounts: AccountService;
  secrets: SecretStore;
  logger?: { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void };
  clientFactory?: DirectoryRemoteClientFactory;
  /**
   * Edition-configured enterprise directory domain (e.g. "@corp.example",
   * from edition.enterpriseDirectory.autoInitDomain). Only accounts whose
   * email ends with this domain may use the remote directory client; every
   * other mailbox is rejected before its IMAP credential is read, so a
   * foreign provider's password can never be handed to the enterprise
   * endpoint. Unset (open edition) = no account is directory-eligible and
   * no email is treated as internal.
   */
  internalDomain?: string;
  now?: () => string;
}

export class DirectoryService {
  private readonly running = new Map<string, Promise<DirectorySyncStatus>>();
  private readonly clients = new Map<string, DirectoryRemoteClient>();
  private readonly remoteSearches = new Map<string, Promise<DirectoryContactSummary[]>>();
  private readonly refreshedQueries = new Map<string, number>();
  private readonly snapshotAvailableListeners = new Set<(accountId: string) => void>();
  private readonly remoteRefreshTtlMs = 60_000;
  private readonly now: () => string;

  constructor(private readonly options: DirectoryServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async initialize(accountId: string): Promise<DirectorySyncStatus> {
    let indexedContacts = 0;
    while (true) {
      const indexed = await this.write({ operation: "indexPinyinBatch", accountId });
      indexedContacts += indexed;
      if (indexed === 0) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (indexedContacts > 0) {
      this.options.logger?.info("directory.pinyin-index.completed", {
        accountId,
        contacts: indexedContacts,
      });
    }
    const contactCount = (await this.read({ operation: "searchContacts", accountId, query: "", options: { limit: 1 } })).total;
    if (contactCount > 0) {
      this.notifySnapshotAvailable(accountId);
      await this.promoteDefaultDisplayName(accountId);
    }
    await this.warmup(accountId);
    // First mailbox entry: backfill the full address book once, in the
    // background, when no snapshot has ever been committed. refresh() is
    // coalesced (concurrent callers share one run) and status-tracked, so the
    // existing UI status poller surfaces progress with no extra wiring. It
    // re-triggers on later entries only while it keeps failing to produce a
    // snapshot, i.e. effectively "sync once until it sticks".
    if (contactCount === 0) {
      void this.refresh(accountId).catch((error) => {
        this.options.logger?.warn("directory.backfill.failed", {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return this.getStatus(accountId);
  }

  onSnapshotAvailable(listener: (accountId: string) => void): () => void {
    this.snapshotAvailableListeners.add(listener);
    return () => this.snapshotAvailableListeners.delete(listener);
  }

  async warmup(accountId: string): Promise<void> {
    await this.clientFor(accountId).warmup();
  }

  invalidate(accountId?: string): void {
    if (accountId) {
      this.clients.delete(accountId);
      for (const key of this.refreshedQueries.keys()) {
        if (key.startsWith(`${accountId}\n`)) this.refreshedQueries.delete(key);
      }
      return;
    }
    this.clients.clear();
    this.refreshedQueries.clear();
  }

  refresh(accountId: string): Promise<DirectorySyncStatus> {
    const existing = this.running.get(accountId);
    if (existing) return existing;
    // Re-read the active SecretStore credential for each explicit refresh.
    // Account ids are stable across password updates, so retaining the old
    // client here would otherwise keep retrying a stale password forever.
    this.clients.delete(accountId);
    const promise = this.runRefresh(accountId).finally(() => this.running.delete(accountId));
    this.running.set(accountId, promise);
    return promise;
  }

  async getStatus(accountId: string): Promise<DirectorySyncStatus> {
    const status = await this.read({ operation: "getStatus", accountId });
    return this.running.has(accountId) && status.state !== "running"
      ? { ...status, state: "running", phase: "login", errorCode: undefined, errorMessage: undefined }
      : status;
  }

  async listDepartments(accountId: string, parentId?: string) {
    return this.read({ operation: "listDepartments", accountId, parentId });
  }

  async searchContacts(
    accountId: string,
    query: string,
    options: DirectoryContactQueryOptions = {},
  ): Promise<DirectoryContactSearchResult> {
    const limit = Math.min(1_000, Math.max(1, Math.floor(Number.isFinite(options.limit) ? options.limit! : 20)));
    const offset = Math.max(0, Math.floor(Number.isFinite(options.offset) ? options.offset! : 0));
    const trimmed = query.trim();
    const { contacts: local, total: localTotal } = await this.read({
      operation: "searchContacts", accountId, query: trimmed, options: { ...options, limit, offset },
    });
    if (!trimmed || options.departmentId || offset > 0) {
      return { contacts: local, total: localTotal, remoteAvailable: true };
    }

    const key = this.remoteSearchKey(accountId, trimmed, limit);
    if (local.length > 0 || this.wasRecentlyRefreshed(key)) {
      return { contacts: local, total: localTotal, remoteAvailable: true };
    }

    try {
      const contacts = await this.refreshRemoteSearch(accountId, trimmed, limit, key);
      return {
        contacts,
        total: (await this.read({ operation: "searchContacts", accountId, query: trimmed, options: { limit: 1 } })).total,
        remoteAvailable: true,
      };
    } catch (error) {
      this.options.logger?.warn("directory.search.remote-failed", {
        accountId,
        queryLength: [...trimmed].length,
        code: directoryRemoteErrorCode(error) ?? "directory-unavailable",
      });
      return { contacts: local, total: localTotal, remoteAvailable: false };
    }
  }

  private refreshRemoteSearch(
    accountId: string,
    query: string,
    limit: number,
    key = this.remoteSearchKey(accountId, query, limit),
  ): Promise<DirectoryContactSummary[]> {
    const running = this.remoteSearches.get(key);
    if (running) return running;
    const promise = (async () => {
      const remoteByEmail = new Map<string, DirectoryContactInput>();
      for (const raw of await this.clientFor(accountId).autoMatch(query, limit)) {
        const contact = normalizeContact(raw, undefined, undefined, [query]);
        if (!contact) continue;
        const emailKey = contact.email.toLocaleLowerCase();
        if (!remoteByEmail.has(emailKey)) remoteByEmail.set(emailKey, contact);
      }
      const remote = Array.from(remoteByEmail.values()).slice(0, limit);
      await this.write({ operation: "upsertContacts", accountId, contacts: remote });
      this.refreshedQueries.set(key, Date.now());
      return (await Promise.all(remote.map((contact) => this.getContact(accountId, contact.email))))
        .filter((contact): contact is DirectoryContactSummary => !!contact);
    })().finally(() => this.remoteSearches.delete(key));
    this.remoteSearches.set(key, promise);
    return promise;
  }

  private remoteSearchKey(accountId: string, query: string, limit: number): string {
    return `${accountId}\n${query.toLocaleLowerCase()}\n${limit}`;
  }

  private async write(input: DirectoryWriteParams): Promise<number> {
    return this.options.mailDatabase?.writeDirectory
      ? this.options.mailDatabase.writeDirectory(input)
      : this.options.repository.write(input);
  }

  private async read<P extends DirectoryReadParams>(input: P): Promise<DirectoryReadResult<P>> {
    return this.options.mailDatabase?.readDirectory
      ? this.options.mailDatabase.readDirectory(input)
      : this.options.repository.read(input) as DirectoryReadResult<P>;
  }

  private wasRecentlyRefreshed(key: string): boolean {
    const refreshedAt = this.refreshedQueries.get(key);
    return refreshedAt !== undefined && Date.now() - refreshedAt < this.remoteRefreshTtlMs;
  }

  async getContact(accountId: string, idOrEmail: string): Promise<DirectoryContactSummary | null> {
    return this.read({ operation: "getContact", accountId, idOrEmail });
  }

  async resolveRecipients(accountId: string, inputs: string[]): Promise<RecipientResolution[]> {
    const resolutions: RecipientResolution[] = [];
    for (const raw of inputs) {
      resolutions.push(await this.resolveRecipient(accountId, raw));
    }
    return resolutions;
  }

  private async resolveRecipient(accountId: string, raw: string): Promise<RecipientResolution> {
    const input = raw.trim();
    if (isEmail(input)) {
      const contact = await this.getContact(accountId, input);
      if (contact) return { input: raw, status: "exact", contact };
      if (!this.isInternalEmail(input)) return { input: raw, status: "external", email: input };
      return { input: raw, status: "not_found" };
    }
    const { contacts: candidates } = await this.read({ operation: "searchContacts", accountId, query: input, options: { limit: 20 } });
    const exact = candidates.filter((candidate) => candidate.name.localeCompare(input, undefined, { sensitivity: "base" }) === 0);
    if (exact.length === 1) return { input: raw, status: "exact", contact: exact[0]! };
    const relevant = exact.length > 1 ? exact : candidates;
    if (relevant.length === 1) return { input: raw, status: "exact", contact: relevant[0]! };
    if (relevant.length > 1) return { input: raw, status: "ambiguous", candidates: relevant.slice(0, 10) };
    return { input: raw, status: "not_found" };
  }

  async validateRecipients(accountId: string, emails: string[]): Promise<RecipientValidation[]> {
    const unique = Array.from(new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean)));
    const results = new Map<string, RecipientValidation>();
    const unresolved: string[] = [];
    for (const email of unique) {
      if (!this.isInternalEmail(email)) {
        results.set(email, { email, status: "external" });
        continue;
      }
      const contact = await this.getContact(accountId, email);
      if (contact) results.set(email, { email, status: "valid", contact });
      else unresolved.push(email);
    }
    if (unresolved.length > 0) {
      try {
        const remote = await this.clientFor(accountId).getContacts(unresolved);
        const found = new Set(remote.map(contactEmail).filter((value): value is string => !!value).map((value) => value.toLowerCase()));
        for (const email of unresolved) {
          results.set(email, found.has(email) ? { email, status: "valid" } : { email, status: "invalid" });
        }
      } catch (error) {
        const reason = directoryRemoteErrorCode(error) ?? "directory-unavailable";
        for (const email of unresolved) results.set(email, { email, status: "unavailable", reason });
      }
    }
    return unique.map((email) => results.get(email)!);
  }

  private async runRefresh(accountId: string): Promise<DirectorySyncStatus> {
    const previous = await this.getStatus(accountId);
    let status: DirectorySyncStatus = {
      accountId,
      state: "running",
      phase: "login",
      processedDepartments: 0,
      processedContacts: 0,
      lastSuccessfulAt: previous.lastSuccessfulAt,
      updatedAt: this.now(),
    };
    await this.write({ operation: "setStatus", status });
    try {
      const client = this.clientFor(accountId);
      status = { ...status, phase: "departments", updatedAt: this.now() };
      await this.write({ operation: "setStatus", status });
      const departments = await collectDepartments(client);
      status = { ...status, processedDepartments: departments.length, phase: "contacts", updatedAt: this.now() };
      await this.write({ operation: "setStatus", status });

      const contactsByEmail = new Map<string, DirectoryContactInput>();
      for (const department of departments) {
        let start = 0;
        const limit = 500;
        do {
          let page;
          try {
            page = await client.listContacts({ dn: department.id, start, limit });
          } catch (error) {
            // A remote directory can expose multiple top-level directories
            // granting the current user access to only some of them.
            if (directoryRemoteErrorCode(error) === "FA_FORBIDDEN") break;
            throw error;
          }
          for (const raw of page.contacts) {
            const contact = normalizeContact(raw, department.id, department.path);
            if (contact) contactsByEmail.set(contact.email.toLowerCase(), contact);
          }
          start += page.contacts.length;
          status = { ...status, processedContacts: contactsByEmail.size, updatedAt: this.now() };
          await this.write({ operation: "setStatus", status });
          if (page.contacts.length < limit || (page.total !== undefined && start >= page.total)) break;
        } while (true);
      }

      if (contactsByEmail.size === 0) {
        throw new DirectoryRemoteError(
          "directory-empty",
          "Remote directory returned no readable contacts",
        );
      }

      status = { ...status, phase: "commit", updatedAt: this.now() };
      await this.write({ operation: "setStatus", status });
      await this.write({ operation: "replaceSnapshot", accountId, departments,
        contacts: Array.from(contactsByEmail.values()) });
      this.notifySnapshotAvailable(accountId);
      await this.promoteDefaultDisplayName(accountId);
      status = {
        ...status,
        state: "completed",
        phase: undefined,
        lastSuccessfulAt: this.now(),
        updatedAt: this.now(),
        errorCode: undefined,
        errorMessage: undefined,
      };
      await this.write({ operation: "setStatus", status });
      this.options.logger?.info("directory.sync.completed", {
        accountId,
        departments: departments.length,
        contacts: contactsByEmail.size,
      });
      return status;
    } catch (error) {
      const code = directoryRemoteErrorCode(error) ?? "directory-sync-failed";
      status = {
        ...status,
        state: "failed",
        phase: undefined,
        updatedAt: this.now(),
        errorCode: code,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      await this.write({ operation: "setStatus", status });
      this.options.logger?.warn("directory.sync.failed", { accountId, code });
      return status;
    }
  }

  private clientFor(accountId: string): DirectoryRemoteClient {
    const existing = this.clients.get(accountId);
    if (existing) return existing;
    const account = this.options.accounts.getCurrentAccount();
    if (!account || account.id !== accountId) throw new DirectoryRemoteError("account-not-active", "Directory account is not active");
    // Edition domain gate: the enterprise directory client serves exactly the
    // edition-configured domain. Any other mailbox must fail here — before
    // its IMAP credential is read — so a foreign provider's password is
    // never handed to the enterprise endpoint (blocking review item 2).
    // Reuses the established "directory-not-configured" code: for this
    // account the build has no usable enterprise directory, and the HTTP
    // layer already maps every directory error code the same way.
    if (!this.isInternalEmail(account.emailAddress)) {
      throw new DirectoryRemoteError(
        "directory-not-configured",
        "Enterprise directory is not configured for this account domain",
      );
    }
    // No default remote client: the open edition ships without any enterprise
    // directory endpoint. Remote directory work reports "not configured"
    // until an internal edition injects clientFactory with a real baseUrl.
    if (!this.options.clientFactory) {
      throw new DirectoryRemoteError(
        "directory-not-configured",
        "Enterprise directory is not configured in this build",
      );
    }
    const password = this.options.secrets.getSecret(imapPasswordKey(accountId));
    if (!password) throw new DirectoryRemoteError("credential-missing", "Mailbox credential is missing");
    const client = this.options.clientFactory({ username: account.emailAddress, password });
    this.clients.set(accountId, client);
    return client;
  }

  /**
   * Domain semantics follow the injected edition domain. Without a
   * configured directory no address is internal — the open edition must not
   * keep any enterprise-domain default (review suggestion 5).
   */
  private isInternalEmail(value: string): boolean {
    const domain = this.options.internalDomain?.toLowerCase();
    if (!domain) return false;
    return value.toLowerCase().endsWith(domain);
  }

  private async promoteDefaultDisplayName(accountId: string): Promise<void> {
    const account = this.options.accounts.getCurrentAccount();
    if (
      !account ||
      account.id !== accountId ||
      !isOriginalEmailDisplayName(account.displayName, account.emailAddress)
    ) {
      return;
    }

    const contact = await this.getContact(accountId, account.emailAddress);
    const chineseName = extractChineseDirectoryName(contact?.name);
    if (!chineseName || chineseName === account.displayName) return;
    const updateAccount = this.options.accounts.updateAccount;
    if (typeof updateAccount !== "function") return;

    try {
      await updateAccount.call(this.options.accounts, { displayName: chineseName });
      this.options.logger?.info("directory.account-display-name.updated", {
        accountId,
        displayName: chineseName,
      });
    } catch (error) {
      this.options.logger?.warn("directory.account-display-name.update-failed", {
        accountId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private notifySnapshotAvailable(accountId: string): void {
    for (const listener of this.snapshotAvailableListeners) {
      try {
        listener(accountId);
      } catch (error) {
        this.options.logger?.warn("directory.snapshot-listener.failed", {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

async function collectDepartments(client: DirectoryRemoteClient) {
  const found = new Map<string, { id: string; parentId?: string; name: string; path: string; childCount: number }>();
  const visited = new Set<string>();

  async function visit(dn?: string, parentPath = ""): Promise<void> {
    let nodes: DirectoryRemoteDirectoryNode[];
    try {
      nodes = await client.getDirectories(dn);
    } catch (error) {
      if (directoryRemoteErrorCode(error) === "FA_FORBIDDEN") return;
      throw error;
    }
    const namespace = dn?.split("/", 1)[0];
    for (const node of nodes) flattenNode(node, dn, parentPath, namespace);
    for (const item of Array.from(found.values())) {
      if (item.childCount > 0 && !visited.has(item.id)) {
        visited.add(item.id);
        await visit(item.id, item.path);
      }
    }
  }

  function flattenNode(
    node: DirectoryRemoteDirectoryNode,
    parentId?: string,
    parentPath = "",
    namespace?: string,
  ): void {
    const rawId = String(node.dn ?? node.id ?? "").trim();
    if (!rawId) return;
    const id = namespace && !rawId.includes("/") ? `${namespace}/${rawId}` : rawId;
    const name = String(node.name ?? node.email ?? id).trim();
    const path = parentPath ? `${parentPath}/${name}` : name;
    const children = Array.isArray(node.ou) ? node.ou : [];
    found.set(id, { id, parentId, name, path, childCount: Number(node.childCount ?? children.length) });
    const childNamespace = namespace ?? rawId.split("/", 1)[0];
    for (const child of children) flattenNode(child, id, path, childNamespace);
  }

  await visit();
  return Array.from(found.values());
}

function normalizeContact(
  raw: DirectoryRemoteContact,
  departmentId?: string,
  departmentPath?: string,
  additionalSearchTerms: string[] = [],
): DirectoryContactInput | null {
  const email = contactEmail(raw);
  if (!email) return null;
  const trueName = stringField(raw, "true_name");
  const nickName = stringField(raw, "nick_name");
  const fullPinyin = stringField(raw, "fullPY");
  const name = trueName ?? nickName ?? email;
  const aliases = arrayField(raw, "alias_emails").filter((value) => value.toLowerCase() !== email.toLowerCase());
  return {
    id: stringField(raw, "@id") ?? email,
    name,
    email,
    aliases,
    departmentId,
    departmentPath: stringField(raw, "@location") ?? stringField(raw, "location") ?? stringField(raw, "@ou") ?? departmentPath,
    title: stringField(raw, "@duty") ?? stringField(raw, "duty"),
    fullPinyin,
    mobile: stringField(raw, "mobile_number"),
    companyPhone: stringField(raw, "company_phone"),
    searchTerms: [nickName, fullPinyin, ...additionalSearchTerms]
      .filter((value): value is string => !!value),
  };
}

function contactEmail(raw: DirectoryRemoteContact): string | undefined {
  return stringField(raw, "email") ?? stringField(raw, "emailaddr") ?? stringField(raw, "@id")?.match(/^[^\s@]+@[^\s@]+$/)?.[0];
}

function stringField(raw: DirectoryRemoteContact, key: string): string | undefined {
  const value = raw[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string" && !!item.trim())?.trim();
  return undefined;
}

function arrayField(raw: DirectoryRemoteContact, key: string): string[] {
  const value = raw[key];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim());
  return typeof value === "string" ? value.split(/[;,]/).map((item) => item.trim()).filter(Boolean) : [];
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
