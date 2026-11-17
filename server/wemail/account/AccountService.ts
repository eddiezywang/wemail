import { EventEmitter } from "node:events";
import type { AccountConfig } from "../../../shared/wemail/account.js";
import type { MailDatabaseAccountRecord } from "../../../shared/wemail/mailDatabaseProtocol.js";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import type { SecretStore } from "../security/SecretStore.js";
import {
  type SaveAccountInput,
  imapPasswordKey,
  smtpPasswordKey,
} from "./AccountTypes.js";

export interface AccountServiceOptions {
  mailDatabase: MailDatabaseClient;
  secrets: SecretStore;
  /** Already-fetched DB Service snapshot for synchronous consumers. */
  initialAccounts?: MailDatabaseAccountRecord[];
  /** Override for tests. Defaults to `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * Event payload emitted by {@link AccountService.onAccountChanged}.
 *
 *  - `login`    → `saveAccount` persisted a new/updated active account.
 *  - `logout`   → session credentials deleted; local caches preserved.
 */
export interface AccountChangedEvent {
  kind: "login" | "logout";
  account: AccountConfig | null;
}

/**
 * Public seam for subscribing to account transitions. Keeps `EventEmitter`
 * out of the .d.ts so consumers only see a typed, narrowly-shaped surface.
 */
export interface AccountChangedSubscribable {
  onAccountChanged(listener: (event: AccountChangedEvent) => void): () => void;
}

/**
 * Single-account facade for WeMail phase one.
 *
 * Phase-one constraints (see Handoff §2 and proposal/design docs):
 *  - ONE active account only.
 *  - Passwords MUST NOT land in the `accounts` table — they route
 *    through {@link SecretStore} under namespaced keys.
 *  - Logout deletes secrets but preserves local mail/intelligence
 *    caches so the user's data is not lost when re-logging in.
 */
export class AccountService implements AccountChangedSubscribable {
  private readonly mailDatabase: MailDatabaseClient;
  private readonly secrets: SecretStore;
  private readonly now: () => string;
  private readonly emitter = new EventEmitter();
  private accounts: MailDatabaseAccountRecord[] = [];

  constructor(options: AccountServiceOptions) {
    this.mailDatabase = options.mailDatabase;
    this.secrets = options.secrets;
    this.accounts = [...(options.initialAccounts ?? [])];
    this.now = options.now ?? (() => new Date().toISOString());
    // Default maxListeners of 10 is too low for a long-lived app where
    // each composition root (plus tests) attaches a listener and then
    // detaches on teardown — bump the ceiling so a flaky unsubscribe
    // doesn't cause a silent memory-leak warning in production logs.
    this.emitter.setMaxListeners(20);
  }

  async initialize(): Promise<void> {
    this.accounts = await this.mailDatabase.listAccounts();
  }

  /**
   * Subscribe to login/logout transitions. The composition root uses
   * this seam to (re)build the mail provider + sync service without
   * restarting the whole app. Returns an unsubscribe fn.
   */
  onAccountChanged(listener: (event: AccountChangedEvent) => void): () => void {
    this.emitter.on("changed", listener);
    return () => this.emitter.off("changed", listener);
  }

  private emitChanged(event: AccountChangedEvent): void {
    this.emitter.emit("changed", event);
  }

  async saveAccount(input: SaveAccountInput): Promise<AccountConfig> {
    const { config, secrets } = input;
    // Server owns the timestamps. Any createdAt/updatedAt supplied by the
    // caller is ignored — trusting client clocks leads to ordering bugs
    // and makes "recently modified" semantics meaningless.
    const now = this.now();
    const existing = this.accounts.find((record) =>
      record.account.id === config.id ||
      record.account.emailAddress.toLowerCase() === config.emailAddress.toLowerCase()
    );
    const accountId = existing?.account.id ?? config.id;
    const persisted: AccountConfig = {
      ...config,
      id: accountId,
      createdAt: existing?.account.createdAt ?? now,
      updatedAt: now,
    };

    // safeStorage is authoritative: commit the secret before advancing the
    // generation stored by the canonical Writer.
    this.secrets.saveSecret(imapPasswordKey(accountId), secrets.imapPassword);
    if (secrets.smtpPassword !== undefined) {
      this.secrets.saveSecret(smtpPasswordKey(accountId), secrets.smtpPassword);
    }
    const credentialGeneration = (existing?.credentialGeneration ?? 0) + 1;
    const credentialRef = `safe-storage:mailbox:${accountId}`;
    await this.mailDatabase.configureAccount({
      account: persisted,
      credentialRef,
      credentialGeneration,
    });
    const record: MailDatabaseAccountRecord = {
      account: persisted,
      credentialRef,
      credentialGeneration,
      state: "active",
    };
    this.accounts = [
      record,
      ...this.accounts.filter((candidate) => candidate.account.id !== accountId),
    ];
    this.emitChanged({ kind: "login", account: persisted });
    return persisted;
  }

  getCurrentAccount(): AccountConfig | null {
    const record = this.accounts.find((candidate) =>
      candidate.state !== "disabled" &&
      this.secrets.getSecret(imapPasswordKey(candidate.account.id)) !== undefined
    );
    return record?.account ?? null;
  }

  listAccounts(): AccountConfig[] {
    return this.accounts
      .filter((record) => record.state !== "disabled")
      .map((record) => record.account);
  }

  async updateAccount(
    patch: Partial<Omit<AccountConfig, "id" | "createdAt">>,
  ): Promise<AccountConfig | null> {
    const current = this.getCurrentAccount();
    if (!current) return null;
    const updatedAt = this.now();
    const merged: AccountConfig = {
      ...current,
      ...patch,
      imap: { ...current.imap, ...(patch.imap ?? {}) },
      smtp: { ...current.smtp, ...(patch.smtp ?? {}) },
      id: current.id,
      createdAt: current.createdAt,
      updatedAt,
    };

    const existing = this.accounts.find((record) => record.account.id === current.id);
    if (!existing) return null;
    await this.mailDatabase.configureAccount({
      account: merged,
      credentialRef: existing.credentialRef,
      credentialGeneration: existing.credentialGeneration,
    });
    this.accounts = this.accounts.map((record) =>
      record.account.id === current.id ? { ...record, account: merged } : record
    );
    return merged;
  }

  /**
   * Remove session credentials for the current account. Local mail,
   * intelligence results, tag feedback, and WeCLI audit rows are kept
   * intact per Handoff §2 ("退出登录不清理本地数据").
   */
  logout(): void {
    const current = this.getCurrentAccount();
    if (!current) return;
    this.secrets.deleteSecret(imapPasswordKey(current.id));
    this.secrets.deleteSecret(smtpPasswordKey(current.id));
    // Preserve canonical mail and derived product state; only the session
    // credentials are cleared. See Handoff §2.
    this.emitChanged({ kind: "logout", account: null });
  }

}
