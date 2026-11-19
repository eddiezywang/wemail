import { z } from "zod";
import { MailSyncCheckpointSchema, type MailSyncCheckpoint } from "./mailSync.js";
import type {
  MailCoreCategoryResult,
  MailCoreFolderResult,
  MailCoreListParams,
  MailCoreListResult,
  MailSnapshotResult,
} from "./mailCoreProtocol.js";
import {
  MailCoreMutationParamsSchema,
  type MailCoreMutationParams,
  type MailCoreMutationResult,
} from "./mailCoreProtocol.js";
import type {
  MailDraftRecord,
  MailMessage,
  WemailDeliveryResult,
  WemailDraftInput,
  WemailDraftSaveInput,
} from "./mail.js";
import type { AccountConfig } from "./account.js";
import type { EmailIntelligenceState } from "./intelligence.js";

export const MAIL_DATABASE_PROTOCOL_VERSION = 12 as const;

export const MailDatabaseMethodSchema = z.enum([
  "database.health",
  "database.checkIntegrity",
  "database.changesSince",
  "agent.listPendingActions",
  "agent.writeActionExecution",
  "agent.getActionExecution",
  "channels.leaseNext",
  "directory.write",
  "directory.read",
  "settings.getBusinessPreferences",
  "settings.saveBusinessPreferences",
  "intelligence.listUserTags",
  "intelligence.recordUsage",
  "intelligence.getTodoPrompt",
  "maintenance.startCjkSearchIndexBuild",
  "maintenance.runRetentionBatch",
  "mail.getSnapshot",
  "mail.getIntelligence",
  "mail.requestIntelligence",
  "mail.getSyncCursor",
  "mail.getSyncStates",
  "mail.listAccounts",
  "mail.list",
  "mail.listFolders",
  "mail.listCategories",
  "mail.search",
  "mail.mutate",
  "mail.configureAccount",
  "mail.persistMetadata",
  "mail.persistBody",
  "mail.failBody",
  "mail.resetBodyFailure",
  "mail.saveDraft",
  "mail.getDraft",
  "mail.listDrafts",
  "mail.listSnoozed",
  "mail.deleteDraft",
  "mail.setSnooze",
  "mail.enqueueSend",
  "mail.listScheduled",
  "mail.listScheduledPage",
  "mail.cancelScheduled",
  "mail.deleteScheduled",
  "queue.enqueueJob",
  "queue.reconcileAiJobs",
  "queue.reconcileBodyHydration",
  "queue.resetTerminalAiJobs",
  "queue.claimJob",
  "queue.completeJob",
  "queue.failJob",
  "queue.deferJob",
  "queue.terminalJob",
  "queue.completeAiArtifact",
  "queue.completeAiArtifactBatch",
  "queue.nextMailDue",
  "queue.nextJobDue",
  "queue.claimRemoteMutation",
  "queue.completeRemoteMutation",
  "queue.failRemoteMutation",
  "queue.claimSend",
  "queue.completeSend",
  "queue.failSend",
]);

export type MailDatabaseMethod = z.infer<typeof MailDatabaseMethodSchema>;

export const MailDatabasePendingActionsParamsSchema = z.object({
  accountId: z.string().min(1).max(500),
  conversationId: z.string().min(1).max(500).optional(),
}).strict();

export type MailDatabasePendingActionsParams = z.infer<typeof MailDatabasePendingActionsParamsSchema>;

export const MailDatabaseAccountQuerySchema = z.object({
  accountId: z.string().min(1).max(500),
}).strict();

export const MailDatabaseChannelLeaseParamsSchema = z.object({
  queue: z.enum(["inbound", "delivery"]),
  workerId: z.string().min(1).max(200),
  leaseMs: z.number().int().min(1_000).max(300_000).default(60_000),
}).strict();

export type MailDatabaseChannelLeaseParams = z.input<typeof MailDatabaseChannelLeaseParamsSchema>;

export const MailDatabaseContentTopicTagsSchema = z.array(z.object({
  name: z.string().min(1).max(200),
  confidence: z.number().min(0).max(1),
  source: z.enum(["ai", "user"]),
  tier: z.enum(["auto", "suggested"]),
  topicId: z.string().max(500).optional(),
}).strict()).max(3);

export const MailDatabaseRecordAiUsageParamsSchema = z.object({
  accountId: z.string().min(1).max(500),
  category: z.enum(["summary", "agent_chat", "compose", "todo", "translation", "automation", "other"]),
  processor: z.string().min(1).max(200),
  emailId: z.string().max(500).optional(),
  inputTokens: z.number().finite().nonnegative(),
  outputTokens: z.number().finite().nonnegative(),
  model: z.string().max(500).optional(),
  provider: z.string().max(200).optional(),
  callerSource: z.string().max(200).optional(),
  sessionId: z.string().max(500).optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  processorVersion: z.number().int().nonnegative().optional(),
}).strict();

export const MailDatabasePersistTodoSuggestionsParamsSchema = z.object({
  accountId: z.string().min(1).max(500),
  emailId: z.string().min(1).max(500),
  todos: z.array(z.object({
    title: z.string().min(1).max(2_000),
    description: z.string().max(10_000).optional(),
    dueDate: z.string().max(200).optional(),
    startTime: z.string().max(200).optional(),
    confidence: z.number().min(0).max(1),
    status: z.literal("suggested"),
    evidence: z.array(z.string().max(200)).max(3).optional(),
    extractionReason: z.string().max(10_000).optional(),
    extractionConfidence: z.number().min(0).max(1).optional(),
  }).strict()).max(20),
}).strict();

export const MailDatabaseRequestIntelligenceParamsSchema = z.object({
  emailId: z.string().min(1).max(500),
  kinds: z.array(z.enum(["summary", "tags", "replyDecision", "todo"])).min(1).max(4),
  revive: z.boolean().optional(),
  context: z.object({
    smartTagBackfillRunId: z.string().min(1).max(200).optional(),
  }).optional(),
});

export interface MailDatabaseRequestIntelligenceParams {
  emailId: string;
  kinds: Array<"summary" | "tags" | "replyDecision" | "todo">;
  revive?: boolean;
  context?: { smartTagBackfillRunId?: string };
}

export const MailDatabaseConfigureAccountParamsSchema = z.object({
  account: z.object({
    id: z.string().min(1),
    displayName: z.string().optional(),
    emailAddress: z.string().min(1),
    imap: z.object({
      host: z.string().min(1),
      port: z.number().int().positive(),
      secure: z.boolean(),
      username: z.string().min(1),
    }),
    smtp: z.object({
      host: z.string().min(1),
      port: z.number().int().positive(),
      secure: z.boolean(),
      username: z.string().min(1),
    }),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  }),
  credentialRef: z.string().min(1).max(200),
  credentialGeneration: z.number().int().nonnegative(),
});

export interface MailDatabaseConfigureAccountParams {
  account: AccountConfig;
  credentialRef: string;
  credentialGeneration: number;
}

export interface MailDatabaseSetSnoozeParams {
  accountId: string;
  emailId: string;
  until?: string;
}

export interface MailDatabaseAccountRecord {
  account: AccountConfig;
  credentialRef: string;
  credentialGeneration: number;
  state: "active" | "auth_required" | "disabled";
}

const MailDatabaseDraftAddressSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().max(300).optional(),
  directoryName: z.string().max(300).optional(),
});

const MailDatabaseDraftBaseSchema = z.object({
  accountId: z.string().min(1),
  composeType: z.enum(["new", "reply", "forward"]).optional(),
  originalEmailId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  to: z.array(MailDatabaseDraftAddressSchema).max(500),
  cc: z.array(MailDatabaseDraftAddressSchema).max(500).optional(),
  bcc: z.array(MailDatabaseDraftAddressSchema).max(500).optional(),
  subject: z.string().max(2_000),
  bodyText: z.string().max(2 * 1024 * 1024),
  bodyHtml: z.string().max(4 * 1024 * 1024),
  // Attachment bytes must be staged into managed blob storage first. They
  // are deliberately forbidden on this ordinary JSON RPC boundary.
  attachments: z.array(z.never()).max(0).optional(),
});

export const MailDatabaseSaveDraftParamsSchema = MailDatabaseDraftBaseSchema.extend({
  id: z.string().min(1).max(200).optional(),
  to: z.array(MailDatabaseDraftAddressSchema).max(500).optional(),
});

export interface MailDatabaseSaveDraftParams extends Omit<WemailDraftSaveInput, "attachments"> {
  attachments?: never[];
}

export const MailDatabaseEnqueueSendParamsSchema = MailDatabaseDraftBaseSchema.extend({
  idempotencyKey: z.string().min(1).max(300),
  draftId: z.string().min(1).max(200).optional(),
  scheduledAt: z.string().datetime().optional(),
});

export interface MailDatabaseEnqueueSendParams extends Omit<WemailDraftInput, "attachments"> {
  attachments?: never[];
  idempotencyKey: string;
  draftId?: string;
  scheduledAt?: string;
}

export interface MailDatabaseEnqueueSendResult {
  outboxId: string;
  state: "pending";
  messageIdHeader: string;
}

export interface MailDatabaseScheduledSendRecord {
  id: string;
  accountId: string;
  payload: WemailDraftInput;
  sendAt: string;
  status: "pending" | "sending" | "sent" | "partial" | "failed" | "cancelled";
  isScheduled?: boolean;
  delivery?: WemailDeliveryResult;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MailDatabaseClaimedSend {
  id: number;
  publicId: string;
  accountId: string;
  draft: WemailDraftInput;
  messageIdHeader: string;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string;
}

export const MailDatabaseDeliveryResultSchema = z.object({
  status: z.enum(["sent", "partial"]),
  accepted: z.array(z.string()),
  rejected: z.array(z.string()),
  rejectedDetails: z.array(z.object({
    recipient: z.string(),
    response: z.string().optional(),
    responseCode: z.number().optional(),
  })).optional(),
});

export const MailDatabaseCompleteSendParamsSchema = z.object({
  id: z.number().int().positive(),
  owner: z.string().min(1),
  messageId: z.string(),
  delivery: MailDatabaseDeliveryResultSchema.optional(),
  archiveSent: z.boolean().optional(),
});

export interface MailDatabaseCompleteSendParams {
  id: number;
  owner: string;
  messageId: string;
  delivery?: WemailDeliveryResult;
  archiveSent?: boolean;
}

export type MailDatabaseSaveDraftResult = MailDatabaseWriteResult<MailDraftRecord>;

export interface MailDatabaseDeleteDraftParams {
  accountId: string;
  id: string;
}

export interface MailDatabaseGetDraftParams {
  accountId: string;
  id: string;
}

export interface MailDatabaseListDraftsParams {
  accountId: string;
  limit?: number;
}

export interface MailDatabaseSearchParams {
  accountId: string;
  query?: string;
  scope?: "default" | "subject" | "address" | "body" | "summary";
  mailScope?: "all" | "starred" | "snoozed" | "newsletter" | "todos";
  folder?: string;
  category?: string;
  smartTagId?: string;
  from?: string;
  to?: string;
  subject?: string;
  dateFrom?: string;
  dateTo?: string;
  receivedFromMs?: number;
  receivedToMs?: number;
  read?: boolean;
  starred?: boolean;
  hasAttachment?: boolean;
  unread?: boolean;
  toMe?: boolean;
  ccMe?: boolean;
  olderThan?: "7d" | "30d" | "180d";
  limit?: number;
  page?: number;
  cursor?: string;
}

export interface MailDatabaseScheduledSendPage {
  scheduled: MailDatabaseScheduledSendRecord[];
  totalCount: number;
  hasMore: boolean;
}

export const MailDatabaseMutationParamsSchema = MailCoreMutationParamsSchema.extend({
  idempotencyKey: z.string().min(1).max(200),
});

export interface MailDatabaseMutationParams extends MailCoreMutationParams {
  idempotencyKey: string;
}

const MailDatabaseAddressSchema = z.object({
  email: z.string(),
  name: z.string().optional(),
  directoryName: z.string().optional(),
});

const MailDatabaseMessageSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["provider", "local"]).optional(),
  accountId: z.string().min(1),
  folder: z.string().min(1),
  messageId: z.string(),
  threadId: z.string().optional(),
  parentMessageId: z.string().optional(),
  from: MailDatabaseAddressSchema,
  to: z.array(MailDatabaseAddressSchema),
  cc: z.array(MailDatabaseAddressSchema),
  bcc: z.array(MailDatabaseAddressSchema),
  delivery: MailDatabaseDeliveryResultSchema.optional(),
  subject: z.string(),
  snippet: z.string(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  bodyCachedUntil: z.string().nullable().optional(),
  bodyVersion: z.number().int().nonnegative().optional(),
  receivedAt: z.string().min(1),
  sentAt: z.string().optional(),
  hasAttachments: z.boolean(),
  attachments: z.array(z.object({
    id: z.string().min(1),
    filename: z.string(),
    mimetype: z.string().min(1),
    size: z.number().int().nonnegative(),
    contentId: z.string().nullable().optional(),
    disposition: z.enum(["inline", "attachment"]).nullable().optional(),
  })),
  flags: z.object({
    seen: z.boolean(),
    flagged: z.boolean(),
    answered: z.boolean(),
    draft: z.boolean(),
  }),
  sync: z.object({
    uid: z.number().int(),
    uidValidity: z.number().int().nonnegative(),
    internalDate: z.string().min(1),
    flagsAuthoritative: z.boolean().optional(),
  }),
  headers: z.record(z.string(), z.string()).optional(),
  snoozedUntil: z.string().optional(),
});

export const MailDatabasePersistMetadataParamsSchema = z.object({
  accountId: z.string().min(1),
  origin: z.enum(["bootstrap", "historical", "live-idle", "live-poll", "manual"]),
  messages: z.array(MailDatabaseMessageSchema).max(500),
  // Set only on the final historical metadata batch of the first sync. The
  // writer handles this idempotently and never recomputes the initial window
  // on later startups or regular syncs.
  initialSyncCompleted: z.boolean().optional(),
  checkpoint: MailSyncCheckpointSchema.optional(),
  lease: z.object({ id: z.number().int().positive(), owner: z.string().min(1).max(300) }).optional(),
}).refine(
  (value) => value.messages.every((message) => message.accountId === value.accountId),
  { message: "metadata batch contains another account" },
).refine(
  (value) => !value.checkpoint || (value.lease && value.messages.length <= 50 && value.messages.every(
    (message) => message.folder === value.checkpoint!.folder &&
      message.sync.uidValidity === value.checkpoint!.next.uidValidity &&
      message.sync.uid <= (value.checkpoint!.mode === "repair"
        ? value.checkpoint!.next.repair?.uid ?? -1 : value.checkpoint!.next.uid),
  )),
  { message: "checkpoint page requires a lease and at most 50 messages from its folder generation" },
);

export interface MailDatabasePersistMetadataParams {
  accountId: string;
  origin: "bootstrap" | "historical" | "live-idle" | "live-poll" | "manual";
  messages: MailMessage[];
  initialSyncCompleted?: boolean;
  checkpoint?: MailSyncCheckpoint;
  lease?: { id: number; owner: string };
}

export const MailDatabasePersistBodyParamsSchema = z.object({
  message: MailDatabaseMessageSchema,
  completedAt: z.string().min(1),
  jobId: z.number().int().positive(),
  jobOwner: z.string().min(1).max(300),
});

export interface MailDatabasePersistBodyParams {
  message: MailMessage;
  completedAt: string;
  jobId: number;
  jobOwner: string;
}

/**
 * Result of `mail.persistBody`. `messagePublicId` + `inlineImagePublicIds`
 * let the mail-core process seed the attachment disk cache for inline images
 * (bytes captured at parse) using the same key the HTTP route reads with.
 * Shared by the Writer, the IPC producer, and the mail-core runtime/entry.
 */
export interface MailDatabasePersistBodyResult {
  emailId: string;
  bodyCached: boolean;
  jobCompleted: boolean;
  messagePublicId: string;
  inlineImagePublicIds: Array<{ contentId: string; publicId: string }>;
}

export const MailDatabaseFailBodyParamsSchema = z.object({
  accountId: z.string().min(1),
  emailId: z.string().min(1),
  errorCode: z.string().min(1).max(200),
  failedAt: z.string().min(1),
  retryAt: z.string().optional(),
  retryable: z.boolean(),
  jobId: z.number().int().positive(),
  jobOwner: z.string().min(1).max(300),
});

export interface MailDatabaseFailBodyParams {
  accountId: string;
  emailId: string;
  errorCode: string;
  failedAt: string;
  retryAt?: string;
  retryable: boolean;
  jobId: number;
  jobOwner: string;
}

export interface MailDatabaseSyncCursorResult {
  uid: number;
  uidValidity: number;
  internalDate: string;
}

/**
 * Upper bound for job priority values (inclusive). Lower priority is claimed
 * first. Values 0–4 are reserved for foreground/incremental/metadata/AI
 * demand; background body hydration uses a continuous time-weighted value
 * ≥ 10 (newer messages get smaller numbers, see bodyHydrationPriority).
 */
export const MAIL_JOB_PRIORITY_MAX = 900_000;
export type MailDatabaseJobPriority = number;

export interface MailDatabaseEnqueueJobParams {
  kind: string;
  accountId: string;
  payload?: unknown;
  priority: MailDatabaseJobPriority;
  availableAt?: string;
  maxAttempts?: number;
  idempotencyKey?: string;
  terminalPolicy?: "reuse" | "revive";
}

export interface MailDatabaseClaimJobParams {
  owner: string;
  leaseMs?: number;
  filter?: {
    accountId?: string;
    kinds?: readonly string[];
    priorities?: readonly MailDatabaseJobPriority[];
    /** Claim only jobs whose priority is >= this value (lower = higher precedence). */
    minPriority?: number;
    subjectPublicId?: string;
    /**
     * Tie-break among rows sharing priority. "fifo" (default) uses due time
     * then oldest id; "lifo" uses message received time descending when the
     * subject is a mail message, with newest id as the fallback. The AI worker
     * uses "lifo" for newest-mail-first consumption within each tier.
     */
    order?: "fifo" | "lifo";
  };
}

export interface MailDatabaseJob {
  id: number;
  kind: string;
  accountId: string;
  payload: unknown;
  priority: MailDatabaseJobPriority;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  idempotencyKey: string | null;
}

export interface MailDatabaseReconcileBodyHydrationResult {
  reprioritized: number;
  enqueued: number;
  revived: number;
  skippedPermanent: number;
}

export interface MailDatabaseCompleteAiArtifactParams {
  jobId: number;
  owner: string;
  accountId: string;
  emailId: string;
  artifactKind: "summary" | "tags" | "replyDecision" | "replyDraft" | "todoExtraction";
  sourceContentSha256: string;
  sourceVersion: number;
  processorVersion: string;
  promptVersion?: string;
  modelId?: string;
  result: unknown;
  textValue?: string;
  completedAt: string;
}

/**
 * Batched AI artifact completion (Phase B write-coalescing). Each item is the
 * same shape as {@link MailDatabaseCompleteAiArtifactParams}; the writer applies
 * them in ONE transaction with a single commit, skipping any item whose lease
 * is no longer owned (stale) instead of aborting the whole batch. Safe to
 * replay/retry because each item's lease guard rolls back cleanly.
 */
export interface MailDatabaseCompleteAiArtifactBatchParams {
  items: MailDatabaseCompleteAiArtifactParams[];
}

export const MailDatabaseCompleteRemoteMutationParamsSchema = z.object({
  id: z.number().int().positive(),
  owner: z.string().min(1).max(300),
  emailId: z.string().min(1),
  relocation: z.object({
    folder: z.string().min(1).max(2_000),
    uid: z.number().int().positive().optional(),
    uidValidity: z.number().int().positive().optional(),
    state: z.enum(["ready", "unknown"]),
  }).optional(),
});

export interface MailDatabaseCompleteRemoteMutationParams {
  id: number;
  owner: string;
  emailId: string;
  relocation?: {
    folder: string;
    uid?: number;
    uidValidity?: number;
    state: "ready" | "unknown";
  };
}

export const MailDatabaseEnqueueJobParamsSchema = z.object({
  kind: z.string().min(1),
  accountId: z.string().min(1),
  payload: z.unknown(),
  priority: z.number().int().min(0).max(MAIL_JOB_PRIORITY_MAX),
  availableAt: z.string().optional(),
  maxAttempts: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1).max(300).optional(),
  terminalPolicy: z.enum(["reuse", "revive"]).optional(),
});

export const MailDatabaseClaimJobParamsSchema = z.object({
  owner: z.string().min(1),
  leaseMs: z.number().int().positive().optional(),
  filter: z.object({
    accountId: z.string().min(1).optional(),
    kinds: z.array(z.string().min(1)).optional(),
    priorities: z.array(z.number().int().min(0).max(MAIL_JOB_PRIORITY_MAX)).optional(),
    minPriority: z.number().int().min(0).max(MAIL_JOB_PRIORITY_MAX).optional(),
    subjectPublicId: z.string().min(1).max(500).optional(),
    order: z.enum(["fifo", "lifo"]).optional(),
  }).optional(),
});

export const MailDatabaseResetAiJobsParamsSchema = z.object({
  afterId: z.number().int().nonnegative().safe().default(0),
  throughId: z.number().int().nonnegative().safe().optional(),
}).strict().refine((input) => input.throughId === undefined || input.throughId >= input.afterId);

export interface MailDatabaseResetAiJobsResult {
  count: number;
  afterId: number;
  throughId: number;
}

export interface MailDatabaseChange {
  entityType:
    | "account"
    | "message"
    | "thread"
    | "content"
    | "attachment"
    | "folder"
    | "category"
    | "tag"
    | "search"
    | "ai_artifact"
    | "ai_job"
    | "todo"
    | "remote_mutation"
    | "draft"
    | "outbox"
    | "setting";
  entityPublicId: string;
  operation: "insert" | "update" | "delete";
  scopeHint?: string;
}

export interface MailDatabaseWriteResult<T = unknown> {
  value: T;
  commitVersion: number;
  changes: MailDatabaseChange[];
}

export type MailDatabaseMutationResult = MailDatabaseWriteResult<MailCoreMutationResult>;

export interface MailDatabaseChangeEvent {
  type: "mail-database.changed";
  commitVersion: number;
  changes: MailDatabaseChange[];
  resetRequired?: boolean;
}

export interface MailDatabaseChangesSinceResult {
  commitVersion: number;
  changes: MailDatabaseChange[];
  resetRequired: boolean;
}

export interface MailDatabaseRequest {
  version: typeof MAIL_DATABASE_PROTOCOL_VERSION;
  requestId: string;
  traceId: string;
  method: MailDatabaseMethod;
  params: unknown;
  deadlineMs: number;
}

export interface MailDatabaseCancelRequest {
  version: typeof MAIL_DATABASE_PROTOCOL_VERSION;
  type: "mail-database.cancel";
  requestId: string;
}

export interface MailDatabaseTiming {
  queueMs: number;
  handlerMs: number;
  totalMs: number;
  lane: string;
}

export type MailDatabaseResponse =
  | {
      version: typeof MAIL_DATABASE_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      result: unknown;
      timing: MailDatabaseTiming;
    }
  | {
      version: typeof MAIL_DATABASE_PROTOCOL_VERSION;
      requestId: string;
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
      };
    };

export interface MailDatabaseIntegrityResult {
  valid: boolean;
  schemaVersion: number | null;
}

export interface MailDatabaseHealthResult {
  protocolVersion: typeof MAIL_DATABASE_PROTOCOL_VERSION;
  state: "ready";
  pid: number;
  uptimeMs: number;
  schemaVersion: number;
  commitVersion: number;
  lanes: Array<{
    label: string;
    state: "idle" | "starting" | "ready" | "degraded";
    threadId: number | null;
    lastHeartbeatAt: number | null;
    restartCount: number;
  }>;
}

export type MailDatabaseQueryResult =
  | MailDatabaseHealthResult
  | MailSnapshotResult
  | EmailIntelligenceState
  | MailCoreListResult
  | MailCoreFolderResult[]
  | MailCoreCategoryResult;

export type MailDatabaseWorkload = "interactive" | "background";

export type MailDatabaseControlMessage =
  | {
      type: "mail-database.bootstrap";
      protocolVersion: number;
      databasePath: string;
      editionFeatures?: import("./edition.js").EditionFeatures;
    }
  | {
      type: "mail-database.ready";
      protocolVersion: number;
      pid: number;
      schemaVersion: number;
    }
  | {
      type: "mail-database.bootstrap-failed";
      code: "INCOMPATIBLE_SCHEMA" | "BOOTSTRAP_FAILED";
      message: string;
    }
  | {
      type: "mail-database.request-trace";
      method: MailDatabaseMethod;
      requestId: string;
      traceId: string;
      outcome: "success" | "failure" | "deadline-expired";
      totalMs: number;
      queueMs?: number;
      handlerMs?: number;
      lane?: string;
      found?: boolean;
      bodyState?: "ready" | "missing" | "fetching" | "failed";
      errorCode?: string;
    }
  | { type: "mail-database.heartbeat"; at: number; pid: number }
  | {
      type: "mail-database.ping";
      probeId: string;
      at: number;
    }
  | {
      type: "mail-database.pong";
      probeId: string;
      at: number;
      pid: number;
    }
  | { type: "mail-database.attach-client"; workload?: MailDatabaseWorkload }
  | { type: "mail-database.shutdown" }
  | { type: "mail-database.shutdown-complete" };

export interface MailDatabaseWorkerData {
  databasePath: string;
  label: "maintenance" | "background" | "detail" | "list-a" | "list-b" | "search" | "aggregate" | "writer";
  mode: "reader" | "writer";
  editionFeatures?: import("./edition.js").EditionFeatures;
}

export type MailDatabaseWorkerRequest =
  | {
      type: "query";
      request: MailDatabaseRequest;
      queuedAt: number;
    }
  | { type: "health"; requestId: string }
  | { type: "shutdown"; requestId: string };

export type MailDatabaseWorkerEvent =
  | {
      type: "ready";
      label: string;
      threadId: number;
      commitVersion?: number;
      queueDepth?: number;
    }
  | {
      type: "heartbeat";
      label: string;
      threadId: number;
      at: number;
      commitVersion?: number;
      queueDepth?: number;
    }
  | {
      type: "response";
      requestId: string;
      ok: true;
      result: unknown;
      queueMs: number;
      handlerMs: number;
    }
  | {
      type: "response";
      requestId: string;
      ok: false;
      error: string;
    };

export type {
  MailCoreCategoryResult,
  MailCoreFolderResult,
  MailCoreListParams,
  MailCoreListResult,
  MailSnapshotResult,
};
