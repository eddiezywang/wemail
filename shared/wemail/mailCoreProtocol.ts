import { z } from "zod";
import { MailReceiptHealthSchema, type MailReceiptHealth } from "./mailSync.js";
import type { AccountConfig } from "./account.js";
import type { InvoiceMailState, InvoiceMailStatusSummary } from "./invoice.js";
import type { MailFlags, MailMessage, WemailAddress } from "./mail.js";
import type { InboxCategory } from "./intelligence.js";
import type { WemailMcpConfigurationTarget } from "./mcp.js";

export const MAIL_CORE_PROTOCOL_VERSION = 1 as const;

export const CoreMethodSchema = z.enum([
  "core.health",
  "mail.ensureBody",
  "mail.retryBody",
  "mail.focus",
  "mail.blur",
  "mail.refresh",
]);

export type CoreMethod = z.infer<typeof CoreMethodSchema>;

export const CoreRequestSchema = z.object({
  version: z.literal(MAIL_CORE_PROTOCOL_VERSION),
  requestId: z.string().min(1),
  traceId: z.string().min(1),
  method: CoreMethodSchema,
  params: z.unknown(),
  deadlineMs: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1).optional(),
});

export type CoreRequest = z.infer<typeof CoreRequestSchema>;

export const CoreTimingSchema = z.object({
  queueMs: z.number().nonnegative(),
  handlerMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative(),
});

export type CoreTiming = z.infer<typeof CoreTimingSchema>;

export const CoreErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});

export type CoreError = z.infer<typeof CoreErrorSchema>;

export const CoreSuccessResponseSchema = z.object({
  version: z.literal(MAIL_CORE_PROTOCOL_VERSION),
  requestId: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown(),
  timing: CoreTimingSchema,
});

export const CoreFailureResponseSchema = z.object({
  version: z.literal(MAIL_CORE_PROTOCOL_VERSION),
  requestId: z.string().min(1),
  ok: z.literal(false),
  error: CoreErrorSchema,
});

export const CoreResponseSchema = z.discriminatedUnion("ok", [
  CoreSuccessResponseSchema,
  CoreFailureResponseSchema,
]);

export type CoreResponse = z.infer<typeof CoreResponseSchema>;

export const CoreEventSchema = z.object({
  version: z.literal(MAIL_CORE_PROTOCOL_VERSION),
  sequence: z.number().int().nonnegative(),
  type: z.string().min(1),
  accountId: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  entityVersion: z.number().int().nonnegative().optional(),
  payload: z.unknown(),
});

export type CoreEvent = z.infer<typeof CoreEventSchema>;

export const WorkerRuntimeMetricsSchema = z.object({
  rssBytes: z.number().int().nonnegative(),
  heapUsedBytes: z.number().int().nonnegative(),
  heapTotalBytes: z.number().int().nonnegative(),
  externalBytes: z.number().int().nonnegative(),
  arrayBuffersBytes: z.number().int().nonnegative(),
  threadId: z.number().int().positive().nullable(),
  queueDepth: z.number().int().nonnegative(),
  activeJobKind: z.string().min(1).nullable(),
  activeJobAgeMs: z.number().nonnegative().nullable(),
  restartCount: z.number().int().nonnegative(),
  restartBackoffMs: z.number().int().nonnegative(),
  lastHeartbeatAt: z.number().nonnegative().nullable(),
});

export const CoreHealthResultSchema = z.object({
  protocolVersion: z.literal(MAIL_CORE_PROTOCOL_VERSION),
  state: z.literal("ready"),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
  uptimeMs: z.number().nonnegative(),
  dbWriter: z.object({
    state: z.enum(["starting", "ready", "degraded", "stopped"]),
    pid: z.number().int().positive().nullable(),
    lastHeartbeatAt: z.number().nonnegative().nullable(),
    metrics: WorkerRuntimeMetricsSchema.nullable().optional(),
  }).optional(),
  accountRuntime: z.object({
    state: z.enum(["starting", "ready", "degraded", "stopped", "credential-required"]),
    accountId: z.string().min(1),
    threadId: z.number().int().positive().nullable(),
    lastHeartbeatAt: z.number().nonnegative().nullable(),
    currentJobId: z.number().int().positive().nullable(),
    currentOutboxId: z.number().int().positive().nullable(),
    metrics: WorkerRuntimeMetricsSchema.nullable().optional(),
    receipt: MailReceiptHealthSchema.optional(),
  }).nullable().optional(),
  backgroundRuntime: z.object({
    state: z.enum(["starting", "ready", "degraded", "stopped"]),
    threadId: z.number().int().positive().nullable(),
    currentJobId: z.number().int().positive().nullable(),
    currentJobKind: z.string().min(1).nullable(),
    lastHeartbeatAt: z.number().nonnegative().nullable(),
  }).nullable().optional(),
  maintenanceRuntime: z.object({
    state: z.enum(["starting", "ready", "stopped"]),
    currentJobId: z.number().int().positive().nullable(),
    currentJobKind: z.string().min(1).nullable(),
    currentJobAgeMs: z.number().nonnegative().nullable(),
    completedJobs: z.number().int().nonnegative(),
    failedJobs: z.number().int().nonnegative(),
    lastYieldAt: z.number().nonnegative().nullable(),
  }).nullable().optional(),
  intelligenceRuntime: z.object({
    state: z.enum(["starting", "ready", "degraded", "stopped"]),
    threadId: z.number().int().positive().nullable(),
    lastHeartbeatAt: z.number().nonnegative().nullable(),
    memory: z.object({
      rssBytes: z.number().int().nonnegative().optional(),
      heapUsedBytes: z.number().int().nonnegative(),
      heapTotalBytes: z.number().int().nonnegative(),
      externalBytes: z.number().int().nonnegative(),
      arrayBuffersBytes: z.number().int().nonnegative(),
      queueDepth: z.number().int().nonnegative().optional(),
      activeJobKind: z.string().min(1).nullable().optional(),
      activeJobAgeMs: z.number().nonnegative().nullable().optional(),
    }).nullable(),
    metrics: WorkerRuntimeMetricsSchema.nullable().optional(),
    circuitBreaker: z.object({
      state: z.enum(["closed", "open", "half-open"]),
      consecutiveFailures: z.number().int().nonnegative(),
      nextProbeAt: z.number().nonnegative().nullable(),
    }).optional(),
  }).nullable().optional(),
  apiRuntime: z.object({
    state: z.enum(["starting", "ready", "degraded", "stopped"]),
    threadId: z.number().int().positive().nullable(),
    port: z.number().int().positive().max(65_535).nullable(),
    lastHeartbeatAt: z.number().nonnegative().nullable(),
  }).nullable().optional(),
  snapshotRuntime: z.object({
    state: z.enum(["ready", "stopped"]),
    requestCount: z.number().int().nonnegative(),
    slowQueryCount: z.number().int().nonnegative(),
    lastQueryDurationMs: z.number().nonnegative(),
    maxQueryDurationMs: z.number().nonnegative(),
    queryBudgetMs: z.number().nonnegative().optional(),
    overBudgetCount: z.number().int().nonnegative().optional(),
    lastQueryKind: z.string().min(1).nullable().optional(),
    p50QueryDurationMs: z.number().nonnegative().optional(),
    p95QueryDurationMs: z.number().nonnegative().optional(),
    countCacheHits: z.number().int().nonnegative().optional(),
    countCacheMisses: z.number().int().nonnegative().optional(),
  }).nullable().optional(),
  readers: z.array(z.object({
    state: z.enum(["starting", "ready", "degraded", "stopped"]),
    label: z.string().min(1),
    threadId: z.number().int().positive().nullable(),
    lastHeartbeatAt: z.number().nonnegative().nullable(),
  })).optional(),
});

export type CoreHealthResult = z.infer<typeof CoreHealthResultSchema>;

export interface MailSnapshotResult {
  message: MailMessage | null;
  bodyState: "ready" | "missing" | "fetching" | "failed";
  bodyErrorCode?: string;
  bodyAttempts?: number;
  bodyNextRetryAt?: string;
  bodyRetryable?: boolean;
  sentArchiveState?: "pending" | "succeeded" | "failed";
  invoiceDetected: boolean;
  invoiceStatus: InvoiceMailStatusSummary | null;
}

export const MailSnapshotResultSchema = z.object({
  message: z.unknown().nullable(),
  bodyState: z.enum(["ready", "missing", "fetching", "failed"]),
  bodyErrorCode: z.string().min(1).optional(),
  bodyAttempts: z.number().int().nonnegative().optional(),
  bodyNextRetryAt: z.string().datetime().optional(),
  bodyRetryable: z.boolean().optional(),
  sentArchiveState: z.enum(["pending", "succeeded", "failed"]).optional(),
  invoiceDetected: z.boolean(),
  invoiceStatus: z.unknown().nullable(),
});

export interface MailEnsureBodyResult {
  status: "ready" | "queued" | "failed" | "not-found" | "account-unavailable";
  jobId?: number;
}

export const MailEnsureBodyResultSchema = z.object({
  status: z.enum(["ready", "queued", "failed", "not-found", "account-unavailable"]),
  jobId: z.number().int().positive().optional(),
});

export interface MailFocusResult {
  status: "focused" | "blurred" | "account-unavailable";
}

export const MailFocusResultSchema = z.object({
  status: z.enum(["focused", "blurred", "account-unavailable"]),
});

export interface MailRefreshResult {
  status: "queued" | "account-unavailable";
  accountId?: string;
  jobId?: number;
  receiptVersion?: number;
  runtimeId?: string;
}

export const MailRefreshResultSchema = z.object({
  status: z.enum(["queued", "account-unavailable"]),
  accountId: z.string().min(1).optional(),
  jobId: z.number().int().positive().optional(),
  receiptVersion: z.number().int().nonnegative().optional(),
  runtimeId: z.string().min(1).optional(),
});

export type MailCoreMutation =
  | { type: "flags"; patch: Partial<MailFlags> }
  | { type: "move"; folder: string }
  | { type: "trash" }
  | { type: "delete" };

export interface MailCoreMutationParams {
  accountId: string;
  emailId: string;
  mutation: MailCoreMutation;
}

export interface MailCoreMutationResult {
  status: "applied";
  message: MailMessage | null;
  deleted: boolean;
  outboxId: number;
}

export const MailCoreMutationParamsSchema = z.object({
  accountId: z.string().min(1),
  emailId: z.string().min(1),
  mutation: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("flags"),
      patch: z.object({
        seen: z.boolean().optional(),
        flagged: z.boolean().optional(),
        answered: z.boolean().optional(),
        draft: z.boolean().optional(),
      }).refine((patch) => Object.keys(patch).length > 0),
    }),
    z.object({ type: z.literal("move"), folder: z.string().trim().min(1) }),
    z.object({ type: z.literal("trash") }),
    z.object({ type: z.literal("delete") }),
  ]),
});

export const MailCoreMutationResultSchema = z.object({
  status: z.literal("applied"),
  message: z.unknown().nullable(),
  deleted: z.boolean(),
  outboxId: z.number().int().positive(),
});

export interface MailCoreListParams {
  accountId: string;
  accountEmail?: string;
  folder?: string;
  limit?: number;
  before?: string;
  cursor?: string;
  allMail?: boolean;
  scope?: "all" | "starred" | "snoozed" | "newsletter" | "todos";
  category?: string;
  smartTagId?: string;
  unread?: boolean;
  toMe?: boolean;
  ccMe?: boolean;
  hasAttachment?: boolean;
  olderThan?: "7d" | "30d" | "180d";
}

export interface MailCoreMessageSummary {
  id: string;
  accountId: string;
  folder: string;
  messageId: string;
  threadId?: string;
  from: WemailAddress;
  to: WemailAddress[];
  subject: string;
  snippet: string;
  receivedAt: string;
  sentAt?: string;
  hasAttachments: boolean;
  flags: MailFlags;
  invoiceDetected?: boolean;
  invoiceStatusTag?: string;
  invoiceStatusState?: InvoiceMailState;
}

export interface MailCoreListResult {
  messages: MailCoreMessageSummary[];
  totalCount: number;
  unreadCount: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface MailCoreFolderResult {
  id: string;
  name: string;
  unreadCount: number;
  totalCount: number;
}

export type MailCoreCategoryResult = InboxCategory[];
const MailCoreAddressSchema = z.object({
  email: z.string().min(1),
  name: z.string().optional(),
  directoryName: z.string().optional(),
});
const MailCoreFlagsSchema = z.object({
  seen: z.boolean(),
  flagged: z.boolean(),
  answered: z.boolean(),
  draft: z.boolean(),
});
export const MailCoreListResultSchema = z.object({
  messages: z.array(z.object({
    id: z.string().min(1),
    accountId: z.string().min(1),
    folder: z.string(),
    messageId: z.string(),
    threadId: z.string().optional(),
    from: MailCoreAddressSchema,
    to: z.array(MailCoreAddressSchema),
    subject: z.string(),
    snippet: z.string(),
    receivedAt: z.string(),
    sentAt: z.string().optional(),
    hasAttachments: z.boolean(),
    flags: MailCoreFlagsSchema,
    invoiceDetected: z.boolean().optional(),
    invoiceStatusTag: z.string().optional(),
    invoiceStatusState: z.string().optional(),
  })),
  totalCount: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
  hasMore: z.boolean().default(false),
  nextCursor: z.string().optional(),
});
export const MailCoreFolderResultSchema = z.array(z.object({
  id: z.string().min(1),
  name: z.string(),
  unreadCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
}));
export const MailCoreCategoryResultSchema = z.array(z.object({
  id: z.string().min(1),
  label: z.string(),
  count: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
  system: z.boolean(),
}));

export interface MailCoreAttachmentFetchParams {
  accountId: string;
  remoteEmailId: string;
  partPath: string;
  source?: "inline" | "download";
  viewId?: string;
}

export interface MailCoreAttachmentFetchResult {
  bytes: Uint8Array;
  mediaType: string;
}

export type MailCoreControlMessage =
  | { type: "mail-core.ready"; protocolVersion: number; pid: number; apiPort?: number }
  | { type: "mail-core.heartbeat"; at: number; pid: number; receipt?: { accountId: string; health: MailReceiptHealth } | null }
  | { type: "mail-core.attach-client" }
  | { type: "mail-core.attach-database-writer" }
  | { type: "mail-core.reload-account" }
  | {
      type: "mail-core.configure-account";
      credential: MailboxCredentialEnvelope | null;
    }
  | {
      type: "mail-core.mail-changed";
      accountId: string;
      origin: "live-idle" | "live-poll" | "manual";
      inserted: Array<{ id: string; subject: string; from: string }>;
    }
  | {
      type: "mail-core.mail-credential-invalid";
      accountId: string;
      code: "MAIL_CREDENTIAL_INVALID";
      stage: "imap.login";
    }
  | {
      type: "mail-core.mcp-credential-save";
      credential: {
        version: 1;
        accountId: string;
        tokenId: string;
        token: string;
      };
    }
  | { type: "mail-core.mcp-credential-delete"; accountId: string }
  | {
      type: "mail-core.mcp-configuration-request";
      requestId: string;
      target: WemailMcpConfigurationTarget;
    }
  | {
      type: "mail-core.mcp-configuration-response";
      requestId: string;
      ok: true;
      configuration: string;
    }
  | {
      type: "mail-core.mcp-configuration-response";
      requestId: string;
      ok: false;
      error: string;
    }
  | {
      type: "mail-core.attachment-request";
      requestId: string;
      params: MailCoreAttachmentFetchParams;
    }
  | {
      type: "mail-core.attachment-response";
      requestId: string;
      ok: true;
      result: MailCoreAttachmentFetchResult;
    }
  | {
      type: "mail-core.attachment-response";
      requestId: string;
      ok: false;
      error: string;
      retryable: boolean;
    }
  | {
      type: "mail-core.attachment-cancel";
      requestId: string;
    }
  | {
      type: "mail-core.refresh-request";
      requestId: string;
      accountId: string;
    }
  | {
      type: "mail-core.refresh-response";
      requestId: string;
      ok: true;
      result: MailRefreshResult;
    }
  | {
      type: "mail-core.refresh-response";
      requestId: string;
      ok: false;
      error: string;
    }
  | { type: "mail-core.shutdown" }
  | { type: "mail-core.shutdown-complete" };

export interface MailboxCredentialEnvelope {
  version: 1;
  generation: number;
  account: AccountConfig;
  imapPassword: string;
  smtpPassword?: string;
}
