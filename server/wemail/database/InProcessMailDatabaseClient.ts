import {
  MAIL_DATABASE_PROTOCOL_VERSION,
  type MailDatabaseChangeEvent,
  type MailDatabaseAccountRecord,
  type MailDatabaseConfigureAccountParams,
  type MailDatabaseDeleteDraftParams,
  type MailDatabaseEnqueueSendParams,
  type MailDatabaseEnqueueSendResult,
  type MailDatabaseGetDraftParams,
  type MailDatabaseHealthResult,
  type MailDatabaseListDraftsParams,
  type MailDatabaseMutationResult,
  type MailDatabaseSaveDraftParams,
  type MailDatabaseSaveDraftResult,
  type MailDatabaseScheduledSendRecord,
  type MailDatabaseScheduledSendPage,
  type MailDatabaseSearchParams,
  type MailDatabaseSetSnoozeParams,
  type MailDatabaseWriteResult,
} from "../../../shared/wemail/mailDatabaseProtocol.js";
import type {
  BusinessPreferences,
  BusinessPreferencesSnapshot,
} from "../../../shared/wemail/businessPreferences.js";
import { DEFAULT_BUSINESS_PREFERENCES } from "../../../shared/wemail/businessPreferences.js";
import type { EmailIntelligenceState } from "../../../shared/wemail/intelligence.js";
import type { MailDraftRecord, MailMessage } from "../../../shared/wemail/mail.js";
import { MAIL_DATABASE_SCHEMA_VERSION } from "./Schema.generated.js";
import { type MailDatabase } from "./Database.js";
import { MailDatabaseQueryRepository } from "./MailDatabaseQueryRepository.js";
import { MailDatabaseWriter } from "./MailDatabaseWriter.js";
import type { MailDatabaseClient } from "./MailDatabaseClient.js";
import type {
  MailCoreCategoryResult,
  MailCoreFolderResult,
  MailCoreListParams,
  MailCoreListResult,
  MailCoreMutationParams,
  MailSnapshotResult,
} from "../../../shared/wemail/mailCoreProtocol.js";

/**
 * In-process `MailDatabaseClient` for consumers that run the canonical
 * database inside their own process instead of talking to the desktop
 * DB Service over its supervisor protocol.
 *
 * `composeApp()` requires this seam (`mailDatabase` is a required
 * option). The Electron desktop supplies a MessagePort producer into
 * the DB Service; the headless MCP server reuses the canonical
 * writer/query repositories against the same SQLite handle it opens,
 * so no Electron worker or second database is involved.
 *
 * Business preferences are held in memory: the headless server does not
 * render the preferences UI, and the desktop's persisted copy lives in
 * its own process. Persistence follows when this client gains a second
 * consumer that needs it.
 */
export class InProcessMailDatabaseClient {
  readonly writer: MailDatabaseWriter;
  private readonly queries: MailDatabaseQueryRepository;
  private readonly listeners = new Set<(event: MailDatabaseChangeEvent) => void>();
  private readonly openedAt = Date.now();
  private preferences: BusinessPreferencesSnapshot = {
    stored: true,
    preferences: { ...DEFAULT_BUSINESS_PREFERENCES },
  };

  constructor(readonly db: MailDatabase) {
    this.writer = new MailDatabaseWriter(db);
    this.queries = new MailDatabaseQueryRepository(db);
  }

  asClient(): MailDatabaseClient {
    return this as unknown as MailDatabaseClient;
  }

  private emitChange(): void {
    const event: MailDatabaseChangeEvent = {
      type: "mail-database.changed",
      commitVersion: this.queries.commitVersion(),
      changes: [{ entityType: "message", entityPublicId: "*", operation: "update" }],
    };
    for (const listener of [...this.listeners]) listener(event);
  }

  async health(): Promise<MailDatabaseHealthResult> {
    return {
      protocolVersion: MAIL_DATABASE_PROTOCOL_VERSION,
      state: "ready",
      pid: process.pid,
      uptimeMs: Date.now() - this.openedAt,
      schemaVersion: MAIL_DATABASE_SCHEMA_VERSION,
      commitVersion: this.queries.commitVersion(),
      lanes: [],
    };
  }

  async checkIntegrity() {
    return { valid: true, schemaVersion: MAIL_DATABASE_SCHEMA_VERSION };
  }

  async listAccounts(): Promise<MailDatabaseAccountRecord[]> {
    return this.queries.listAccounts();
  }

  async configureAccount(params: MailDatabaseConfigureAccountParams) {
    const result = this.writer.configureAccount(params);
    this.emitChange();
    return result;
  }

  async getMailSnapshot(id: string): Promise<MailSnapshotResult> {
    return this.queries.getSnapshot(id);
  }

  async getIntelligenceState(id: string): Promise<EmailIntelligenceState> {
    return this.queries.getIntelligenceState(id);
  }

  async requestIntelligence(params: Parameters<MailDatabaseWriter["requestIntelligence"]>[0]) {
    return this.writer.requestIntelligence(params);
  }

  async listMail(params: MailCoreListParams): Promise<MailCoreListResult> {
    return this.queries.list(params);
  }

  async listFolders(accountId: string): Promise<MailCoreFolderResult[]> {
    return this.queries.listFolders(accountId);
  }

  async listCategories(accountId: string): Promise<MailCoreCategoryResult> {
    return this.queries.listCategories(accountId);
  }

  async search(params: MailDatabaseSearchParams): Promise<MailCoreListResult> {
    return this.queries.search(params);
  }

  async mutateMail(params: MailCoreMutationParams, idempotencyKey: string): Promise<MailDatabaseMutationResult> {
    const result = this.writer.mutate({ ...params, idempotencyKey } as Parameters<MailDatabaseWriter["mutate"]>[0]);
    this.emitChange();
    return result;
  }

  async saveDraft(params: MailDatabaseSaveDraftParams): Promise<MailDatabaseSaveDraftResult> {
    const result = this.writer.saveDraft(params);
    this.emitChange();
    return result;
  }

  async getDraft(params: MailDatabaseGetDraftParams): Promise<MailDraftRecord | null> {
    return this.queries.getDraft(params.accountId, params.id);
  }

  async listDrafts(params: MailDatabaseListDraftsParams): Promise<MailDraftRecord[]> {
    return this.queries.listDrafts(params.accountId, params.limit);
  }

  async listSnoozed(accountId: string): Promise<MailMessage[]> {
    return this.queries.listSnoozed(accountId);
  }

  async deleteDraft(params: MailDatabaseDeleteDraftParams): Promise<MailDatabaseWriteResult<boolean>> {
    const result = this.writer.deleteDraft(params.accountId, params.id);
    this.emitChange();
    return result;
  }

  async setSnooze(params: MailDatabaseSetSnoozeParams): Promise<MailDatabaseWriteResult<MailMessage | null>> {
    const result = this.writer.setSnooze(params);
    this.emitChange();
    return result;
  }

  async enqueueSend(params: MailDatabaseEnqueueSendParams): Promise<MailDatabaseWriteResult<MailDatabaseEnqueueSendResult>> {
    return this.writer.enqueueSend(params);
  }

  async listScheduled(accountId: string): Promise<MailDatabaseScheduledSendRecord[]> {
    return this.queries.listScheduled(accountId);
  }

  async listScheduledPage(
    accountId: string,
    page?: number,
    limit?: number,
  ): Promise<MailDatabaseScheduledSendPage> {
    return this.queries.listScheduledPage(accountId, page ?? 1, limit ?? 50);
  }

  async cancelScheduled(accountId: string, id: string): Promise<MailDatabaseWriteResult<boolean>> {
    const result = this.writer.cancelScheduled(accountId, id);
    this.emitChange();
    return result;
  }

  async deleteScheduled(accountId: string, id: string): Promise<MailDatabaseWriteResult<boolean>> {
    const result = this.writer.deleteScheduled(accountId, id);
    this.emitChange();
    return result;
  }

  async getBusinessPreferences(): Promise<BusinessPreferencesSnapshot> {
    return this.preferences;
  }

  async saveBusinessPreferences(patch: Partial<BusinessPreferences>): Promise<MailDatabaseWriteResult<BusinessPreferences>> {
    this.preferences = {
      stored: true,
      preferences: { ...this.preferences.preferences, ...patch },
    };
    this.emitChange();
    return {
      value: this.preferences.preferences,
      commitVersion: this.queries.commitVersion(),
      changes: [{ entityType: "setting", entityPublicId: "business-preferences", operation: "update" }],
    };
  }

  async listPendingActions() {
    return [];
  }

  onChanged(listener: (event: MailDatabaseChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
