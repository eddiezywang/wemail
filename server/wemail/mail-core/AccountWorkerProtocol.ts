import type {
  MailMessage,
  MailSyncCursor,
  WemailDeliveryResult,
  WemailDraftInput,
} from "../../../shared/wemail/mail.js";
import type { MailCoreRemoteOperation } from "./MailCoreMutation.js";
import type { MailCoreRemoteRelocation } from "./MailCoreMutation.js";
import type { MailCoreSyncOrigin } from "./MailCoreMetadata.js";
import type { WorkerHeartbeatMetrics } from "./WorkerRuntimeMetrics.js";
import type { MailboxCredentialEnvelope } from "../../../shared/wemail/mailCoreProtocol.js";
import type { MailFolderSyncStates, MailSyncCheckpoint } from "../../../shared/wemail/mailSync.js";

export interface AccountWorkerData {
  accountId: string;
  dataDir: string;
  e2eMode: boolean;
  credential: MailboxCredentialEnvelope;
  initialCursor?: MailSyncCursor;
}

export type AccountWorkerCommand =
  | {
      type: "account-worker.fetch-body";
      jobId: number;
      emailId: string;
      lane: "interactive" | "background";
      traceId?: string;
      /** Explicit user "load body" action: bypasses the oversized-message refusal. */
      onDemand?: boolean;
    }
  | {
      type: "account-worker.fetch-attachment";
      requestId: string;
      remoteEmailId: string;
      partPath: string;
      source?: "inline" | "download";
      viewId?: string;
    }
  | {
      type: "account-worker.cancel-attachment";
      requestId: string;
    }
  | {
      type: "account-worker.execute-operation";
      outboxId: number;
      operation: MailCoreRemoteOperation;
    }
  | {
      type: "account-worker.send-draft";
      outboxId: number;
      draft: WemailDraftInput;
      messageIdHeader: string;
    }
  | {
      type: "account-worker.sync-metadata";
      jobId: number;
      origin: MailCoreSyncOrigin;
      cursor?: MailSyncCursor | null;
      syncStates?: MailFolderSyncStates;
      recheckInbox?: boolean;
    }
  | {
      type: "account-worker.metadata-ack";
      jobId: number;
      continue: boolean;
    }
  | { type: "account-worker.cancel-metadata"; jobId: number }
  | { type: "account-worker.shutdown" };

export type AccountWorkerEvent =
  | { type: "account-worker.ready"; accountId: string; threadId: number; metrics?: WorkerHeartbeatMetrics }
  | { type: "account-worker.heartbeat"; accountId: string; threadId: number; at: number; metrics?: WorkerHeartbeatMetrics }
  | {
      type: "account-worker.body-result";
      accountId: string;
      jobId: number;
      emailId: string;
      traceId?: string;
      providerMs?: number;
      ok: true;
      message: MailMessage;
    }
  | {
      type: "account-worker.body-result";
      accountId: string;
      jobId: number;
      emailId: string;
      traceId?: string;
      providerMs?: number;
      ok: false;
      errorCode: string;
      retryable: boolean;
      credentialRequired?: boolean;
    }
  | {
      type: "account-worker.attachment-result";
      accountId: string;
      requestId: string;
      ok: true;
      bytes: Uint8Array;
      mediaType: string;
    }
  | {
      type: "account-worker.attachment-result";
      accountId: string;
      requestId: string;
      ok: false;
      errorCode: string;
      retryable: boolean;
      credentialRequired?: boolean;
    }
  | {
      type: "account-worker.operation-result";
      accountId: string;
      outboxId: number;
      ok: true;
      relocation?: MailCoreRemoteRelocation;
    }
  | {
      type: "account-worker.operation-result";
      accountId: string;
      outboxId: number;
      ok: false;
      errorCode: string;
      retryable: boolean;
    }
  | {
      type: "account-worker.send-result";
      accountId: string;
      outboxId: number;
      ok: true;
      messageId: string;
      delivery?: WemailDeliveryResult;
    }
  | {
      type: "account-worker.send-result";
      accountId: string;
      outboxId: number;
      ok: false;
      errorCode: string;
      retryable: boolean;
      credentialRequired?: boolean;
    }
  | {
      type: "account-worker.sync-request";
      accountId: string;
      origin: "live-idle" | "live-poll";
    }
  | {
      type: "account-worker.metadata-progress";
      accountId: string;
      jobId: number;
    }
  | { type: "account-worker.metadata-cancelled"; accountId: string; jobId: number }
  | {
      type: "account-worker.metadata-result";
      accountId: string;
      jobId: number;
      origin: MailCoreSyncOrigin;
      ok: true;
      messages: MailMessage[];
      replaceCursors: boolean;
      completed: boolean;
      checkpoint?: MailSyncCheckpoint;
      providerMs?: number;
    }
  | {
      type: "account-worker.metadata-result";
      accountId: string;
      jobId: number;
      origin: MailCoreSyncOrigin;
      ok: false;
      errorCode: string;
      retryable: boolean;
      retryAfterMs?: number;
    }
  | { type: "account-worker.shutdown-complete"; accountId: string };
