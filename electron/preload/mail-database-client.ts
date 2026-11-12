import {
  MailCoreCategoryResultSchema,
  MailCoreFolderResultSchema,
  MailCoreListResultSchema,
  MailCoreMutationResultSchema,
  MailSnapshotResultSchema,
  type MailCoreCategoryResult,
  type MailCoreFolderResult,
  type MailCoreListParams,
  type MailCoreListResult,
  type MailCoreMutationParams,
  type MailCoreMutationResult,
  type MailSnapshotResult,
} from "../../shared/wemail/mailCoreProtocol.js";
import {
  MAIL_DATABASE_PROTOCOL_VERSION,
  type MailDatabaseHealthResult,
  type MailDatabaseAccountRecord,
  type MailDatabaseConfigureAccountParams,
  type MailDatabaseDeleteDraftParams,
  type MailDatabaseGetDraftParams,
  type MailDatabaseListDraftsParams,
  type MailDatabaseChangeEvent,
  type MailDatabaseChangesSinceResult,
  type MailDatabaseMethod,
  type MailDatabaseResponse,
  type MailDatabaseSearchParams,
  type MailDatabaseMutationResult,
  type MailDatabaseRequestIntelligenceParams,
  type MailDatabaseEnqueueSendParams,
  type MailDatabaseEnqueueSendResult,
  type MailDatabaseSaveDraftParams,
  type MailDatabaseSaveDraftResult,
  type MailDatabaseWriteResult,
  type MailDatabaseScheduledSendRecord,
  type MailDatabaseScheduledSendPage,
  type MailDatabaseSetSnoozeParams,
} from "../../shared/wemail/mailDatabaseProtocol.js";
import type { MailDraftRecord, MailMessage } from "../../shared/wemail/mail.js";
import type { MailCoreClientPort } from "./mail-core-client.js";
import type { EmailIntelligenceState } from "../../shared/wemail/intelligence.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  method: MailDatabaseMethod;
}

export class MailDatabaseClient {
  private port: MailCoreClientPort | null = null;
  private sequence = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly changeListeners = new Set<(event: MailDatabaseChangeEvent) => void>();
  private lastCommitVersion = 0;
  private readonly onMessage = (event: MessageEvent<unknown>) => {
    this.handleResponse(event.data);
  };

  replacePort(port: MailCoreClientPort): void {
    this.disconnect(new Error("DB Service connection was replaced"));
    this.port = port;
    port.addEventListener("message", this.onMessage);
    port.start();
    void this.recoverChanges();
  }

  disconnect(reason = new Error("DB Service is unavailable")): void {
    const port = this.port;
    this.port = null;
    if (port) {
      port.removeEventListener("message", this.onMessage);
      port.close();
    }
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(reason);
    }
    this.pending.clear();
  }

  isConnected(): boolean {
    return this.port !== null;
  }

  async health(timeoutMs = 2_000): Promise<MailDatabaseHealthResult> {
    const result = await this.call("database.health", {}, timeoutMs);
    if (
      !result ||
      typeof result !== "object" ||
      (result as Partial<MailDatabaseHealthResult>).protocolVersion !==
        MAIL_DATABASE_PROTOCOL_VERSION ||
      (result as Partial<MailDatabaseHealthResult>).state !== "ready"
    ) {
      throw new Error("DB Service returned an invalid health response");
    }
    return result as MailDatabaseHealthResult;
  }

  async getMailSnapshot(
    id: string,
    timeoutMs = 1_000,
    traceId?: string,
    requestId?: string,
  ): Promise<MailSnapshotResult> {
    return MailSnapshotResultSchema.parse(
      await this.call("mail.getSnapshot", { id }, timeoutMs, traceId, requestId),
    ) as MailSnapshotResult;
  }

  cancelRequest(requestId: string): void {
    const request = this.pending.get(requestId);
    if (request) {
      this.pending.delete(requestId);
      clearTimeout(request.timeout);
      const error = new Error("DB Service request was cancelled");
      error.name = "AbortError";
      request.reject(error);
    }
    this.port?.postMessage({
      version: MAIL_DATABASE_PROTOCOL_VERSION,
      type: "mail-database.cancel",
      requestId,
    });
  }

  async listMail(
    params: MailCoreListParams,
    timeoutMs = 2_000,
  ): Promise<MailCoreListResult> {
    return MailCoreListResultSchema.parse(
      await this.call("mail.list", params, timeoutMs),
    ) as MailCoreListResult;
  }

  async listFolders(
    accountId: string,
    timeoutMs = 2_000,
  ): Promise<MailCoreFolderResult[]> {
    return MailCoreFolderResultSchema.parse(
      await this.call("mail.listFolders", { accountId }, timeoutMs),
    ) as MailCoreFolderResult[];
  }

  async listCategories(
    accountId: string,
    timeoutMs = 2_000,
  ): Promise<MailCoreCategoryResult> {
    return MailCoreCategoryResultSchema.parse(
      await this.call("mail.listCategories", { accountId }, timeoutMs),
    ) as MailCoreCategoryResult;
  }

  async search(
    params: MailDatabaseSearchParams,
    timeoutMs = 5_000,
  ): Promise<MailCoreListResult> {
    return MailCoreListResultSchema.parse(
      await this.call("mail.search", params, timeoutMs),
    ) as MailCoreListResult;
  }

  async mutateMail(
    params: MailCoreMutationParams,
    idempotencyKey: string,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseMutationResult> {
    const result = await this.call("mail.mutate", {
      ...params,
      idempotencyKey,
    }, timeoutMs) as Partial<MailDatabaseMutationResult>;
    if (
      typeof result.commitVersion !== "number" ||
      !Array.isArray(result.changes)
    ) {
      throw new Error("DB Service returned an invalid mutation result");
    }
    return {
      value: MailCoreMutationResultSchema.parse(result.value) as MailCoreMutationResult,
      commitVersion: result.commitVersion,
      changes: result.changes,
    };
  }

  onChanged(listener: (event: MailDatabaseChangeEvent) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async listAccounts(timeoutMs = 2_000): Promise<MailDatabaseAccountRecord[]> {
    return await this.call("mail.listAccounts", {}, timeoutMs) as MailDatabaseAccountRecord[];
  }

  async configureAccount(
    params: MailDatabaseConfigureAccountParams,
    timeoutMs = 5_000,
  ): Promise<MailDatabaseWriteResult<{ accountId: string }>> {
    return await this.call("mail.configureAccount", params, timeoutMs) as
      MailDatabaseWriteResult<{ accountId: string }>;
  }

  async getIntelligenceState(
    id: string,
    timeoutMs = 5_000,
  ): Promise<EmailIntelligenceState> {
    return await this.call("mail.getIntelligence", { id }, timeoutMs) as
      EmailIntelligenceState;
  }

  async requestIntelligence(
    params: MailDatabaseRequestIntelligenceParams,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseWriteResult<{ jobIds: number[] }>> {
    return await this.call("mail.requestIntelligence", params, timeoutMs) as
      MailDatabaseWriteResult<{ jobIds: number[] }>;
  }

  async saveDraft(
    params: MailDatabaseSaveDraftParams,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseSaveDraftResult> {
    return await this.call("mail.saveDraft", params, timeoutMs) as MailDatabaseSaveDraftResult;
  }

  async getDraft(
    params: MailDatabaseGetDraftParams,
    timeoutMs = 2_000,
  ): Promise<MailDraftRecord | null> {
    return await this.call("mail.getDraft", params, timeoutMs) as MailDraftRecord | null;
  }

  async listDrafts(
    params: MailDatabaseListDraftsParams,
    timeoutMs = 2_000,
  ): Promise<MailDraftRecord[]> {
    return await this.call("mail.listDrafts", params, timeoutMs) as MailDraftRecord[];
  }

  async listSnoozed(accountId: string, timeoutMs = 2_000): Promise<MailMessage[]> {
    return await this.call("mail.listSnoozed", { accountId }, timeoutMs) as MailMessage[];
  }

  async deleteDraft(
    params: MailDatabaseDeleteDraftParams,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseWriteResult<boolean>> {
    return await this.call("mail.deleteDraft", params, timeoutMs) as MailDatabaseWriteResult<boolean>;
  }

  async setSnooze(
    params: MailDatabaseSetSnoozeParams,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseWriteResult<import("../../shared/wemail/mail.js").MailMessage | null>> {
    return await this.call("mail.setSnooze", params, timeoutMs) as
      MailDatabaseWriteResult<import("../../shared/wemail/mail.js").MailMessage | null>;
  }

  async enqueueSend(
    params: MailDatabaseEnqueueSendParams,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseWriteResult<MailDatabaseEnqueueSendResult>> {
    return await this.call("mail.enqueueSend", params, timeoutMs) as
      MailDatabaseWriteResult<MailDatabaseEnqueueSendResult>;
  }

  async listScheduled(
    accountId: string,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseScheduledSendRecord[]> {
    return await this.call("mail.listScheduled", { accountId }, timeoutMs) as
      MailDatabaseScheduledSendRecord[];
  }

  async listScheduledPage(accountId: string, page = 1, limit = 50, timeoutMs = 2_000): Promise<MailDatabaseScheduledSendPage> {
    return await this.call("mail.listScheduledPage", { accountId, page, limit }, timeoutMs) as MailDatabaseScheduledSendPage;
  }

  async cancelScheduled(
    accountId: string,
    id: string,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseWriteResult<boolean>> {
    return await this.call("mail.cancelScheduled", { accountId, id }, timeoutMs) as
      MailDatabaseWriteResult<boolean>;
  }

  async deleteScheduled(
    accountId: string,
    id: string,
    timeoutMs = 2_000,
  ): Promise<MailDatabaseWriteResult<boolean>> {
    return await this.call("mail.deleteScheduled", { accountId, id }, timeoutMs) as
      MailDatabaseWriteResult<boolean>;
  }

  private async recoverChanges(): Promise<void> {
    try {
      const result = await this.call(
        "database.changesSince",
        { afterVersion: this.lastCommitVersion, limit: 500 },
        2_000,
      ) as MailDatabaseChangesSinceResult;
      if (result.commitVersion <= this.lastCommitVersion) return;
      this.lastCommitVersion = result.commitVersion;
      const event: MailDatabaseChangeEvent = {
        type: "mail-database.changed",
        commitVersion: result.commitVersion,
        changes: result.changes,
        ...(result.resetRequired ? { resetRequired: true } : {}),
      };
      for (const listener of this.changeListeners) listener(event);
    } catch {
      // A later committed change or explicit query will retry through the
      // normal connection lifecycle; reconnect must never block preload.
    }
  }

  private async waitForPort(timeoutMs: number): Promise<MailCoreClientPort> {
    const deadline = Date.now() + timeoutMs;
    while (!this.port) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("DB Service is unavailable");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(50, remaining));
      });
    }
    return this.port;
  }

  private async call(
    method: MailDatabaseMethod,
    params: unknown,
    timeoutMs: number,
    traceId?: string,
    requestedId?: string,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const port = await this.waitForPort(timeoutMs);
    const requestId = requestedId ?? `db-${Date.now().toString(36)}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`DB Service request timed out: ${method}`));
      }, Math.max(1, timeoutMs - (Date.now() - startedAt)));
      this.pending.set(requestId, { resolve, reject, timeout, method });
      port.postMessage({
        version: MAIL_DATABASE_PROTOCOL_VERSION,
        requestId,
        traceId: traceId ?? requestId,
        method,
        params,
        deadlineMs: Date.now() + timeoutMs,
      });
    });
  }

  private handleResponse(input: unknown): void {
    if (!input || typeof input !== "object") return;
    const event = input as Partial<MailDatabaseChangeEvent>;
    if (
      event.type === "mail-database.changed" &&
      typeof event.commitVersion === "number" &&
      Array.isArray(event.changes)
    ) {
      if (event.commitVersion <= this.lastCommitVersion) return;
      this.lastCommitVersion = event.commitVersion;
      for (const listener of this.changeListeners) {
        listener(event as MailDatabaseChangeEvent);
      }
      return;
    }
    const response = input as Partial<MailDatabaseResponse>;
    if (
      response.version !== MAIL_DATABASE_PROTOCOL_VERSION ||
      typeof response.requestId !== "string" ||
      typeof response.ok !== "boolean"
    ) {
      return;
    }
    const request = this.pending.get(response.requestId);
    if (!request) return;
    this.pending.delete(response.requestId);
    clearTimeout(request.timeout);
    if (response.ok) {
      if (request.method === "mail.getSnapshot") {
        const t = (
          response as {
            timing?: { totalMs?: number; queueMs?: number; handlerMs?: number; lane?: string };
          }
        ).timing;
        if (t && typeof t.totalMs === "number") {
          // Decomposes the snapshot round-trip on the db-service side.
          // transport = (renderer metadata-ready) − total. Compare with the
          // [mail-open] metadata-ready line to see whether the wait is SQL
          // (handler), reader-lane queue, or IPC transport.
          console.debug(
            `[snapshot-timing] total=${Math.round(t.totalMs)}ms queue=${Math.round(t.queueMs ?? 0)}ms handler=${Math.round(t.handlerMs ?? 0)}ms lane=${t.lane ?? "?"}`,
          );
        }
      }
      request.resolve(response.result);
      return;
    }
    const failure = response as Extract<MailDatabaseResponse, { ok: false }>;
    const error = new Error(failure.error.message);
    error.name = failure.error.code;
    request.reject(error);
  }
}
