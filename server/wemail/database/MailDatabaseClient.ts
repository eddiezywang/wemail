import type { ChannelDelivery, LeasedChannelInbound } from "../../../shared/wemail/channels.js";
import type { ActionExecutionCommand, ActionExecutionReply } from "../../../shared/wemail/actionExecution.js";
import type { DirectoryWriteParams } from "../../../shared/wemail/directoryDatabase.js";
import type { DirectoryReadParams, DirectoryReadResult } from "../../../shared/wemail/directoryDatabase.js";
import type { DatabaseRetentionBatchParams, DatabaseRetentionBatchResult } from "../../../shared/wemail/retention.js";
import type { BusinessPreferences, BusinessPreferencesSnapshot } from "../../../shared/wemail/businessPreferences.js";
import type {
  MailCoreCategoryResult,
  MailCoreFolderResult,
  MailCoreListParams,
  MailCoreListResult,
  MailCoreMutationParams,
  MailSnapshotResult,
} from "../../../shared/wemail/mailCoreProtocol.js";
import type {
  MailDatabaseChangeEvent,
  MailDatabaseAccountRecord,
  MailDatabaseConfigureAccountParams,
  MailDatabaseDeleteDraftParams,
  MailDatabaseEnqueueSendParams,
  MailDatabaseEnqueueSendResult,
  MailDatabaseHealthResult,
  MailDatabaseIntegrityResult,
  MailDatabaseGetDraftParams,
  MailDatabaseListDraftsParams,
  MailDatabaseMutationResult,
  MailDatabasePendingActionsParams,
  MailDatabaseRequestIntelligenceParams,
  MailDatabaseSaveDraftParams,
  MailDatabaseSaveDraftResult,
  MailDatabaseScheduledSendRecord,
  MailDatabaseScheduledSendPage,
  MailDatabaseSetSnoozeParams,
  MailDatabaseSearchParams,
  MailDatabaseWriteResult,
} from "../../../shared/wemail/mailDatabaseProtocol.js";
import type { MailDraftRecord, MailMessage } from "../../../shared/wemail/mail.js";
import type { AgentPendingAction, EmailIntelligenceState } from "../../../shared/wemail/intelligence.js";

/** SQL-free trusted client contract for consumers outside DB Service. */
export interface MailDatabaseClient {
  actionExecution?(command: ActionExecutionCommand): Promise<ActionExecutionReply>;
  readDirectory?<P extends DirectoryReadParams>(input: P, timeoutMs?: number): Promise<DirectoryReadResult<P>>;
  writeDirectory?(input: DirectoryWriteParams, timeoutMs?: number): Promise<number>;
  leaseChannelInbound?(workerId: string, timeoutMs?: number): Promise<LeasedChannelInbound | undefined>;
  leaseChannelDelivery?(workerId: string, timeoutMs?: number): Promise<ChannelDelivery | undefined>;
  checkIntegrity?(timeoutMs?: number): Promise<MailDatabaseIntegrityResult>;
  runRetentionBatch?(params: DatabaseRetentionBatchParams, timeoutMs?: number): Promise<DatabaseRetentionBatchResult>;
  getBusinessPreferences?(timeoutMs?: number): Promise<BusinessPreferencesSnapshot>;
  saveBusinessPreferences?(patch: Partial<BusinessPreferences>, timeoutMs?: number): Promise<MailDatabaseWriteResult<BusinessPreferences>>;
  /** Optional during the domain-by-domain migration of platform repositories. */
  listPendingActions?(params: MailDatabasePendingActionsParams, timeoutMs?: number): Promise<AgentPendingAction[]>;
  health(timeoutMs?: number): Promise<MailDatabaseHealthResult>;
  listAccounts(timeoutMs?: number): Promise<MailDatabaseAccountRecord[]>;
  configureAccount(
    params: MailDatabaseConfigureAccountParams,
    timeoutMs?: number,
  ): Promise<MailDatabaseWriteResult<{ accountId: string }>>;
  getMailSnapshot(id: string, timeoutMs?: number, traceId?: string): Promise<MailSnapshotResult>;
  getIntelligenceState(id: string, timeoutMs?: number): Promise<EmailIntelligenceState>;
  requestIntelligence(
    params: MailDatabaseRequestIntelligenceParams,
    timeoutMs?: number,
  ): Promise<MailDatabaseWriteResult<{ jobIds: number[] }>>;
  listMail(params: MailCoreListParams, timeoutMs?: number): Promise<MailCoreListResult>;
  listFolders(accountId: string, timeoutMs?: number): Promise<MailCoreFolderResult[]>;
  listCategories(accountId: string, timeoutMs?: number): Promise<MailCoreCategoryResult>;
  search(params: MailDatabaseSearchParams, timeoutMs?: number): Promise<MailCoreListResult>;
  mutateMail(
    params: MailCoreMutationParams,
    idempotencyKey: string,
    timeoutMs?: number,
  ): Promise<MailDatabaseMutationResult>;
  saveDraft(params: MailDatabaseSaveDraftParams, timeoutMs?: number): Promise<MailDatabaseSaveDraftResult>;
  getDraft(params: MailDatabaseGetDraftParams, timeoutMs?: number): Promise<MailDraftRecord | null>;
  listDrafts(params: MailDatabaseListDraftsParams, timeoutMs?: number): Promise<MailDraftRecord[]>;
  listSnoozed(accountId: string, timeoutMs?: number): Promise<MailMessage[]>;
  deleteDraft(params: MailDatabaseDeleteDraftParams, timeoutMs?: number): Promise<MailDatabaseWriteResult<boolean>>;
  setSnooze(params: MailDatabaseSetSnoozeParams, timeoutMs?: number): Promise<MailDatabaseWriteResult<MailMessage | null>>;
  enqueueSend(
    params: MailDatabaseEnqueueSendParams,
    timeoutMs?: number,
  ): Promise<MailDatabaseWriteResult<MailDatabaseEnqueueSendResult>>;
  listScheduled(accountId: string, timeoutMs?: number): Promise<MailDatabaseScheduledSendRecord[]>;
  listScheduledPage(accountId: string, page?: number, limit?: number, timeoutMs?: number): Promise<MailDatabaseScheduledSendPage>;
  cancelScheduled(accountId: string, id: string, timeoutMs?: number): Promise<MailDatabaseWriteResult<boolean>>;
  deleteScheduled(accountId: string, id: string, timeoutMs?: number): Promise<MailDatabaseWriteResult<boolean>>;
  onChanged(listener: (event: MailDatabaseChangeEvent) => void): () => void;
}
