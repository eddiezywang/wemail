import type { ChannelDelivery, LeasedChannelInbound } from "../../shared/wemail/channels.js";
import type { MailFolderSyncStates } from "../../shared/wemail/mailSync.js";
import type { DatabaseRetentionBatchParams, DatabaseRetentionBatchResult } from "../../shared/wemail/retention.js";
import type { BusinessPreferences, BusinessPreferencesSnapshot } from "../../shared/wemail/businessPreferences.js";
import type { MessagePortMain } from "electron";
import { randomUUID } from "node:crypto";
import {
  MAIL_DATABASE_PROTOCOL_VERSION,
  type MailDatabaseFailBodyParams,
  type MailDatabaseConfigureAccountParams,
  type MailDatabaseDeleteDraftParams,
  type MailDatabaseGetDraftParams,
  type MailDatabaseListDraftsParams,
  type MailDatabaseAccountRecord,
  type MailDatabasePersistBodyParams,
  type MailDatabasePersistBodyResult,
  type MailDatabasePersistMetadataParams,
  type MailDatabaseChangeEvent,
  type MailDatabaseResponse,
  type MailDatabaseWriteResult,
  type MailDatabaseReconcileBodyHydrationResult,
  type MailDatabaseClaimJobParams,
  type MailDatabaseResetAiJobsResult,
  type MailDatabaseEnqueueJobParams,
  type MailDatabaseJob,
  type MailDatabaseSyncCursorResult,
  type MailDatabaseClaimedSend,
  type MailDatabaseCompleteSendParams,
  type MailDatabaseCompleteRemoteMutationParams,
  type MailDatabaseCompleteAiArtifactParams,
  type MailDatabaseCompleteAiArtifactBatchParams,
  type MailSnapshotResult,
  type MailDatabaseMethod,
  type MailDatabaseHealthResult,
  type MailDatabaseIntegrityResult,
  type MailDatabaseSearchParams,
  type MailDatabaseMutationResult,
  type MailDatabasePendingActionsParams,
  type MailDatabaseRequestIntelligenceParams,
  type MailDatabaseEnqueueSendParams,
  type MailDatabaseEnqueueSendResult,
  type MailDatabaseSaveDraftParams,
  type MailDatabaseSaveDraftResult,
  type MailDatabaseScheduledSendRecord,
  type MailDatabaseScheduledSendPage,
  type MailDatabaseSetSnoozeParams,
} from "../../shared/wemail/mailDatabaseProtocol.js";
import type { MailDraftRecord, MailMessage } from "../../shared/wemail/mail.js";
import type {
  MailCoreCategoryResult,
  MailCoreFolderResult,
  MailCoreListParams,
  MailCoreListResult,
  MailCoreMutationParams,
} from "../../shared/wemail/mailCoreProtocol.js";
import type { AgentPendingAction, EmailIntelligenceState } from "../../shared/wemail/intelligence.js";
import type { ActionExecutionCommand, ActionExecutionReply } from "../../shared/wemail/actionExecution.js";
import type { MailDatabaseClient } from "../../server/wemail/database/MailDatabaseClient.js";
import type { UserTag } from "../../shared/wemail/userTags.js";
import type { AiUsageRecord } from "../../shared/wemail/usage.js";

import type { DirectoryWriteParams } from "../../shared/wemail/directoryDatabase.js";
import type { DirectoryReadParams, DirectoryReadResult } from "../../shared/wemail/directoryDatabase.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class MailDatabaseProducer implements MailDatabaseClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly dynamicChangeListeners = new Set<
    (event: MailDatabaseChangeEvent) => void
  >();
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly port: MessagePortMain,
    private readonly onDatabaseChanged?: (event: MailDatabaseChangeEvent) => void,
  ) {
    port.on("message", (event) => this.handleMessage(event.data));
    port.once("close", () => this.close(new Error("DB Service producer port closed")));
    port.start();
  }

  readDirectory<P extends DirectoryReadParams>(input: P, timeoutMs = 5_000): Promise<DirectoryReadResult<P>> {
    return this.call("directory.read", input, timeoutMs);
  }

  async writeDirectory(input: DirectoryWriteParams, timeoutMs = 60_000): Promise<number> {
    if (input.operation !== "replaceSnapshot") return this.call("directory.write", input, timeoutMs);
    const snapshotId = randomUUID();
    const identity = { accountId: input.accountId, snapshotId };
    try {
      await this.call("directory.write", { operation: "beginSnapshot", ...identity,
        departmentCount: input.departments.length, contactCount: input.contacts.length }, timeoutMs);
      let sequence = 0;
      for (let offset = 0; offset < Math.max(input.departments.length, input.contacts.length); offset += 100) {
        await this.call("directory.write", { operation: "appendSnapshot", ...identity, sequence: sequence++,
          departments: input.departments.slice(offset, offset + 100),
          contacts: input.contacts.slice(offset, offset + 100) }, timeoutMs);
      }
      const result = await this.call<number>("directory.write", { operation: "commitSnapshot", ...identity }, timeoutMs);
      void this.cleanupDirectorySnapshots();
      return result;
    } catch (error) {
      await this.call("directory.write", { operation: "abortSnapshot", ...identity }, 5_000).catch(() => undefined);
      void this.cleanupDirectorySnapshots();
      throw error;
    }
  }

  private async cleanupDirectorySnapshots(): Promise<void> {
    try {
      while (await this.call<number>("directory.write", { operation: "cleanupSnapshots" }, 5_000) === 100) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch {
      // Daily retention also reclaims retired/expired snapshots after interruptions.
    }
  }

  configureAccount(
    input: MailDatabaseConfigureAccountParams,
  ): Promise<MailDatabaseWriteResult<{ accountId: string }>> {
    return this.call("mail.configureAccount", input, 5_000);
  }

  listAccounts(): Promise<MailDatabaseAccountRecord[]> {
    return this.call("mail.listAccounts", {}, 2_000);
  }

  persistMetadata(
    input: MailDatabasePersistMetadataParams,
    traceId?: string,
  ): Promise<MailDatabaseWriteResult<{
    insertedCount: number;
    updatedCount: number;
    insertedIds: string[];
    updatedIds: string[];
  }>> {
    return this.call("mail.persistMetadata", input, 60_000, traceId);
  }

  persistBody(
    input: MailDatabasePersistBodyParams,
    traceId?: string,
  ): Promise<MailDatabaseWriteResult<MailDatabasePersistBodyResult>> {
    return this.call("mail.persistBody", input, 10_000, traceId);
  }

  failBody(
    input: MailDatabaseFailBodyParams,
  ): Promise<MailDatabaseWriteResult<{
    attempts: number;
    nextRetryAt?: string;
    jobCompleted: boolean;
  }>> {
    return this.call("mail.failBody", input, 5_000);
  }

  resetBodyFailure(accountId: string, emailId: string): Promise<MailDatabaseWriteResult<boolean>> {
    return this.call("mail.resetBodyFailure", { accountId, emailId }, 5_000);
  }

  enqueueJob(input: MailDatabaseEnqueueJobParams): Promise<MailDatabaseJob> {
    return this.call("queue.enqueueJob", input, 5_000);
  }

  reconcileAiJobs(limit = 100): Promise<number> {
    return this.call("queue.reconcileAiJobs", { limit }, 10_000);
  }

  reconcileBodyHydration(
    accountId: string,
    options: {
      limit?: number;
      nowMs?: number;
      base?: number;
      minuteMs?: number;
      maxPriority?: number;
    } = {},
  ): Promise<MailDatabaseReconcileBodyHydrationResult> {
    return this.call(
      "queue.reconcileBodyHydration",
      { accountId, ...options },
      10_000,
    );
  }

  async resetTerminalAiJobsForRetry(): Promise<number> {
    let afterId = 0;
    let throughId: number | undefined;
    let count = 0;
    do {
      const batch = await this.call<MailDatabaseResetAiJobsResult>("queue.resetTerminalAiJobs", { afterId, throughId }, 10_000);
      count += batch.count;
      afterId = batch.afterId;
      throughId = batch.throughId;
      if (afterId < throughId) await new Promise<void>((resolve) => setImmediate(resolve));
    } while (afterId < throughId);
    return count;
  }

  claimJob(
    owner: string,
    leaseMs?: number,
    filter?: MailDatabaseClaimJobParams["filter"],
  ): Promise<MailDatabaseJob | null> {
    return this.call("queue.claimJob", { owner, leaseMs, filter }, 5_000);
  }

  completeJob(id: number, owner: string): Promise<boolean> {
    return this.call("queue.completeJob", { id, owner }, 5_000);
  }

  completeAiArtifact(
    input: MailDatabaseCompleteAiArtifactParams,
  ): Promise<MailDatabaseWriteResult<{ artifactId: string; current: boolean }>> {
    return this.call("queue.completeAiArtifact", input, 10_000);
  }

  /**
   * Phase B batched completion. Coalesces N artifact completions into one IPC
   * call and one writer transaction. The AiCompletionBuffer drives this; direct
   * callers are rare (real-time priority writes go through `completeAiArtifact`).
   */
  completeAiArtifactBatch(
    items: MailDatabaseCompleteAiArtifactBatchParams["items"],
  ): Promise<
    MailDatabaseWriteResult<{
      results: Array<{
        jobId: number;
        artifactId?: string;
        current?: boolean;
        skipped?: boolean;
      }>;
    }>
  > {
    return this.call("queue.completeAiArtifactBatch", { items }, 10_000);
  }

  getSnapshot(emailId: string): Promise<MailSnapshotResult> {
    return this.call("mail.getSnapshot", { id: emailId }, 5_000);
  }

  listUserTags(accountId: string): Promise<UserTag[]> {
    return this.call("intelligence.listUserTags", { accountId }, 2_000);
  }

  async recordAiUsage(params: AiUsageRecord): Promise<void> {
    await this.call("intelligence.recordUsage", params, 5_000);
  }

  getTodoPrompt(): Promise<string | undefined> {
    return this.call("intelligence.getTodoPrompt", {}, 2_000);
  }

  listPendingActions(params: MailDatabasePendingActionsParams, timeoutMs = 2_000): Promise<AgentPendingAction[]> {
    return this.call("agent.listPendingActions", params, timeoutMs);
  }

  actionExecution(command: ActionExecutionCommand): Promise<ActionExecutionReply> {
    return this.call(command.op === "get" || command.op === "preflight" ? "agent.getActionExecution" : "agent.writeActionExecution", command, 5_000);
  }

  leaseChannelInbound(workerId: string, timeoutMs = 5_000): Promise<LeasedChannelInbound | undefined> {
    return this.call("channels.leaseNext", { queue: "inbound", workerId }, timeoutMs);
  }

  leaseChannelDelivery(workerId: string, timeoutMs = 5_000): Promise<ChannelDelivery | undefined> {
    return this.call("channels.leaseNext", { queue: "delivery", workerId }, timeoutMs);
  }

  getBusinessPreferences(timeoutMs = 2_000): Promise<BusinessPreferencesSnapshot> {
    return this.call("settings.getBusinessPreferences", {}, timeoutMs);
  }

  saveBusinessPreferences(patch: Partial<BusinessPreferences>, timeoutMs = 2_000): Promise<MailDatabaseWriteResult<BusinessPreferences>> {
    return this.call("settings.saveBusinessPreferences", patch, timeoutMs);
  }

  checkIntegrity(timeoutMs = 300_000): Promise<MailDatabaseIntegrityResult> {
    return this.call("database.checkIntegrity", {}, timeoutMs);
  }

  health(timeoutMs = 2_000): Promise<MailDatabaseHealthResult> {
    return this.call("database.health", {}, timeoutMs);
  }

  runRetentionBatch(params: DatabaseRetentionBatchParams, timeoutMs = 5_000): Promise<DatabaseRetentionBatchResult> {
    return this.call("maintenance.runRetentionBatch", params, timeoutMs);
  }

  startCjkSearchIndexBuild(): Promise<boolean> {
    return this.call("maintenance.startCjkSearchIndexBuild", {}, 5_000);
  }

  getMailSnapshot(id: string, timeoutMs = 1_000, traceId?: string): Promise<MailSnapshotResult> {
    return this.call("mail.getSnapshot", { id }, timeoutMs, traceId);
  }

  getIntelligenceState(id: string, timeoutMs = 5_000): Promise<EmailIntelligenceState> {
    return this.call("mail.getIntelligence", { id }, timeoutMs);
  }

  requestIntelligence(
    params: MailDatabaseRequestIntelligenceParams,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseWriteResult<{ jobIds: number[] }>> {
    return this.call("mail.requestIntelligence", params, timeoutMs);
  }

  listMail(params: MailCoreListParams, timeoutMs = 2_000): Promise<MailCoreListResult> {
    return this.call("mail.list", params, timeoutMs);
  }

  listFolders(accountId: string, timeoutMs = 2_000): Promise<MailCoreFolderResult[]> {
    return this.call("mail.listFolders", { accountId }, timeoutMs);
  }

  listCategories(accountId: string, timeoutMs = 2_000): Promise<MailCoreCategoryResult> {
    return this.call("mail.listCategories", { accountId }, timeoutMs);
  }

  search(params: MailDatabaseSearchParams, timeoutMs = 5_000): Promise<MailCoreListResult> {
    return this.call("mail.search", params, timeoutMs);
  }

  mutateMail(
    params: MailCoreMutationParams,
    idempotencyKey: string,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseMutationResult> {
    return this.call("mail.mutate", { ...params, idempotencyKey }, timeoutMs);
  }

  saveDraft(params: MailDatabaseSaveDraftParams, timeoutMs = 2_000): Promise<MailDatabaseSaveDraftResult> {
    return this.call("mail.saveDraft", params, timeoutMs);
  }

  getDraft(params: MailDatabaseGetDraftParams, timeoutMs = 2_000): Promise<MailDraftRecord | null> {
    return this.call("mail.getDraft", params, timeoutMs);
  }

  listDrafts(params: MailDatabaseListDraftsParams, timeoutMs = 2_000): Promise<MailDraftRecord[]> {
    return this.call("mail.listDrafts", params, timeoutMs);
  }

  listSnoozed(accountId: string, timeoutMs = 2_000): Promise<MailMessage[]> {
    return this.call("mail.listSnoozed", { accountId }, timeoutMs);
  }

  deleteDraft(
    params: MailDatabaseDeleteDraftParams,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseWriteResult<boolean>> {
    return this.call("mail.deleteDraft", params, timeoutMs);
  }

  setSnooze(
    params: MailDatabaseSetSnoozeParams,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseWriteResult<MailMessage | null>> {
    return this.call("mail.setSnooze", params, timeoutMs);
  }

  enqueueSend(
    params: MailDatabaseEnqueueSendParams,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseWriteResult<MailDatabaseEnqueueSendResult>> {
    return this.call("mail.enqueueSend", params, timeoutMs);
  }

  listScheduled(accountId: string, timeoutMs = 2_000): Promise<MailDatabaseScheduledSendRecord[]> {
    return this.call("mail.listScheduled", { accountId }, timeoutMs);
  }

  listScheduledPage(accountId: string, page = 1, limit = 50, timeoutMs = 2_000): Promise<MailDatabaseScheduledSendPage> {
    return this.call("mail.listScheduledPage", { accountId, page, limit }, timeoutMs);
  }

  cancelScheduled(
    accountId: string,
    id: string,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseWriteResult<boolean>> {
    return this.call("mail.cancelScheduled", { accountId, id }, timeoutMs);
  }

  deleteScheduled(
    accountId: string,
    id: string,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseWriteResult<boolean>> {
    return this.call("mail.deleteScheduled", { accountId, id }, timeoutMs);
  }

  onChanged(listener: (event: MailDatabaseChangeEvent) => void): () => void {
    this.dynamicChangeListeners.add(listener);
    return () => this.dynamicChangeListeners.delete(listener);
  }

  failJob(
    id: number,
    owner: string,
    error: string,
    retryDelayMs?: number,
  ): Promise<boolean> {
    return this.call("queue.failJob", { id, owner, error, retryDelayMs }, 5_000);
  }

  deferJob(
    id: number,
    owner: string,
    reason: string,
    delayMs: number,
  ): Promise<boolean> {
    return this.call("queue.deferJob", { id, owner, reason, delayMs }, 5_000);
  }

  terminalJob(id: number, owner: string, error: string): Promise<boolean> {
    return this.call("queue.terminalJob", { id, owner, error }, 5_000);
  }

  nextMailDue(accountId: string): Promise<number | null> {
    return this.call("queue.nextMailDue", { accountId }, 5_000);
  }

  nextJobDue(kinds: readonly string[]): Promise<number | null> {
    return this.call("queue.nextJobDue", { kinds }, 5_000);
  }

  getSyncCursor(
    accountId: string,
    folder = "INBOX",
  ): Promise<MailDatabaseSyncCursorResult | null> {
    return this.call("mail.getSyncCursor", { accountId, folder }, 5_000);
  }

  getSyncStates(accountId: string): Promise<MailFolderSyncStates> {
    return this.call("mail.getSyncStates", { accountId }, 5_000);
  }

  claimRemoteMutation(
    accountId: string,
    owner: string,
    leaseMs?: number,
  ): Promise<MailDatabaseJob | null> {
    return this.call(
      "queue.claimRemoteMutation",
      { accountId, owner, leaseMs },
      5_000,
    );
  }

  completeRemoteMutation(
    input: MailDatabaseCompleteRemoteMutationParams,
  ): Promise<MailDatabaseWriteResult<boolean>> {
    return this.call("queue.completeRemoteMutation", input, 5_000);
  }

  failRemoteMutation(
    id: number,
    owner: string,
    error: string,
    retryDelayMs?: number,
  ): Promise<boolean> {
    return this.call(
      "queue.failRemoteMutation",
      { id, owner, error, retryDelayMs },
      5_000,
    );
  }

  claimSend(
    accountId: string,
    owner: string,
    leaseMs?: number,
  ): Promise<MailDatabaseClaimedSend | null> {
    return this.call("queue.claimSend", { accountId, owner, leaseMs }, 5_000);
  }

  completeSend(
    input: MailDatabaseCompleteSendParams,
  ): Promise<MailDatabaseWriteResult<{ outboxId: string; messageId: string }>> {
    return this.call("queue.completeSend", input, 10_000);
  }

  failSend(
    id: number,
    owner: string,
    error: string,
    retryDelayMs?: number,
  ): Promise<boolean> {
    return this.call("queue.failSend", { id, owner, error, retryDelayMs }, 5_000);
  }

  close(reason = new Error("DB Service producer stopped")): void {
    if (this.closed) return;
    this.closed = true;
    this.port.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.dynamicChangeListeners.clear();
  }

  private call<T>(
    method: MailDatabaseMethod,
    params: unknown,
    timeoutMs: number,
    traceId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("DB Service producer is closed"));
    const requestId = `producer-${++this.sequence}-${randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`DB Service producer timeout:${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.port.postMessage({
        version: MAIL_DATABASE_PROTOCOL_VERSION,
        requestId,
        traceId: traceId ?? requestId,
        method,
        params,
        deadlineMs: Date.now() + timeoutMs,
      });
    });
  }

  private handleMessage(input: unknown): void {
    if (!input || typeof input !== "object") return;
    if ((input as { type?: unknown }).type === "mail-database.changed") {
      const event = input as MailDatabaseChangeEvent;
      this.onDatabaseChanged?.(event);
      for (const listener of this.dynamicChangeListeners) listener(event);
      return;
    }
    const response = input as Partial<MailDatabaseResponse>;
    if (
      response.version !== MAIL_DATABASE_PROTOCOL_VERSION ||
      typeof response.requestId !== "string" ||
      typeof response.ok !== "boolean"
    ) return;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.result);
    else {
      const failure = response as Partial<Extract<MailDatabaseResponse, { ok: false }>>;
      pending.reject(new Error(failure.error?.message ?? "DB Service producer failed"));
    }
  }
}
