/**
 * Versioned public contracts for WeMail's local MCP surface.
 *
 * Keep this module independent from the Pi runtime and renderer. The public
 * MCP registry, server settings UI, and protocol tests consume these types;
 * domain repositories must not depend on MCP protocol objects.
 */

import type {
  MailAttachment,
  MailFlags,
  WemailAddress,
} from "./mail.js";

export const WEMAIL_MCP_CONTRACT_VERSION = 1 as const;
export const WEMAIL_MCP_SERVER_NAME = "wemail-mail-mcp" as const;
export const WEMAIL_MCP_SERVER_VERSION = "1.0.0" as const;
export const WEMAIL_MCP_DEFAULT_PORT = 43129 as const;
export const WEMAIL_MCP_DEFAULT_BODY_CHARACTERS = 6_000 as const;
export const WEMAIL_MCP_DEFAULT_MAX_BODY_CHARACTERS = 20_000 as const;
export const WEMAIL_MCP_MAX_BODY_CHARACTERS = 1_000_000 as const;
export const WEMAIL_MCP_DEFAULT_PAGE_SIZE = 25 as const;
export const WEMAIL_MCP_DEFAULT_MAX_PAGE_SIZE = 100 as const;
export const WEMAIL_MCP_MAX_PAGE_SIZE = 1_000 as const;
export const WEMAIL_MCP_DEFAULT_MAX_RECIPIENTS = 200 as const;
export const WEMAIL_MCP_MAX_RECIPIENTS = 1_000 as const;
export const WEMAIL_MCP_DEFAULT_MAX_BATCH_MESSAGES = 100 as const;
export const WEMAIL_MCP_MAX_BATCH_MESSAGES = 1_000 as const;
export const WEMAIL_MCP_DEFAULT_MAX_PENDING_OPERATIONS = 100 as const;
export const WEMAIL_MCP_MAX_PENDING_OPERATIONS = 10_000 as const;
export const WEMAIL_MCP_DEFAULT_TOOL_TIMEOUT_SECONDS = 30 as const;
export const WEMAIL_MCP_MAX_TOOL_TIMEOUT_SECONDS = 600 as const;
export const WEMAIL_MCP_CONFIGURATION_TARGETS = ["codex", "claude"] as const;
export type WemailMcpConfigurationTarget =
  (typeof WEMAIL_MCP_CONFIGURATION_TARGETS)[number];

export const WEMAIL_MCP_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;

export type WemailMcpProtocolVersion =
  (typeof WEMAIL_MCP_PROTOCOL_VERSIONS)[number];

export const WEMAIL_MCP_V1_TOOL_NAMES = [
  "list_mail_accounts",
  "list_mail_folders",
  "sync_mail_account",
  "get_mail_sync_status",
  "list_mail_messages",
  "search_mail",
  "get_mail_message",
  "get_mail_thread",
  "get_mail_attachment",
  "upload_mail_attachment",
  "list_mail_drafts",
  "get_mail_draft",
  "create_mail_draft",
  "update_mail_draft",
  "set_mail_state",
  "prepare_mail_actions",
  "prepare_mail_send",
  "commit_mail_operation",
  "get_mail_operation_status",
  "cancel_mail_operation",
  "list_todos",
  "get_todo",
  "create_todo",
  "update_todo",
  "complete_todo",
  "restore_todo",
  "prepare_delete_entity",
  "get_mail_intelligence",
  "search_mail_semantic",
  "ask_mail_question",
  "record_tag_feedback",
  "list_agent_attention",
  "get_conversation_state",
  "search_directory_contacts",
] as const;

export type WemailMcpV1ToolName =
  (typeof WEMAIL_MCP_V1_TOOL_NAMES)[number];

export type WemailMcpToolDomain =
  | "discovery"
  | "read"
  | "attachment"
  | "draft"
  | "operation"
  | "todo";

export type WemailMcpToolRisk =
  | "read"
  | "local-write"
  | "prepared-high-risk"
  | "commit-high-risk";

export interface WemailMcpToolMetadata {
  name: WemailMcpV1ToolName;
  domain: WemailMcpToolDomain;
  risk: WemailMcpToolRisk;
  maxResponseBytes: number;
}
export type WemailMcpFolderModel = "folders" | "labels" | "hybrid";
export type WemailMcpThreading = "native" | "synthesized" | "none";
export type WemailMcpSyncMode = "full" | "cursor" | "delta";
export type WemailMcpRealtimeMode = "idle" | "push" | "poll" | "none";

export interface WemailMcpAccountCapabilities {
  schemaVersion: typeof WEMAIL_MCP_CONTRACT_VERSION;
  folderModel: WemailMcpFolderModel;
  threading: WemailMcpThreading;
  serverSearch: boolean;
  providerDrafts: boolean;
  sendAs: boolean;
  outboundAttachments: boolean;
  syncMode: WemailMcpSyncMode;
  realtimeMode: WemailMcpRealtimeMode;
  maxAttachmentBytes: number;
  maxRecipients: number;
}

export interface WemailMcpAccount {
  id: string;
  provider: string;
  email: string;
  displayName?: string;
  capabilities: WemailMcpAccountCapabilities;
}

export type WemailMcpFolderRole =
  | "inbox"
  | "sent"
  | "drafts"
  | "archive"
  | "trash"
  | "spam"
  | "system"
  | "custom";

export interface WemailMcpFolder {
  id: string;
  name: string;
  role: WemailMcpFolderRole;
  selectable: boolean;
  model: "folder" | "label";
}

export interface WemailMcpCursorPage {
  nextCursor?: string;
}

export interface WemailMcpEnvelope {
  id: string;
  accountId: string;
  threadId?: string;
  folder: string;
  labels?: string[];
  from: WemailAddress;
  to: WemailAddress[];
  cc?: WemailAddress[];
  subject: string;
  snippet: string;
  receivedAt: string;
  sentAt?: string;
  flags: MailFlags;
  hasAttachments: boolean;
  attachments: MailAttachment[];
}

export interface WemailMcpTruncation {
  truncated: boolean;
  returnedCharacters: number;
  originalCharacters?: number;
}

export interface WemailMcpMessageDetail extends WemailMcpEnvelope {
  bodyText: string;
  bodyHtml?: string;
  bodyTextLimit: WemailMcpTruncation;
  bodyHtmlLimit?: WemailMcpTruncation;
  contentTrust: "untrusted-provider-content";
}

export interface WemailMcpThreadPage extends WemailMcpCursorPage {
  accountId: string;
  threadId: string;
  messages: WemailMcpMessageDetail[];
}

export interface WemailMcpAttachmentResource {
  uri: string;
  filename: string;
  mimeType: string;
  size: number;
  sessionBound: true;
}

export type WemailMcpDraftMode = "new" | "reply" | "reply_all" | "forward";

export interface WemailMcpDraftSummary {
  id: string;
  accountId: string;
  mode: WemailMcpDraftMode;
  to: WemailAddress[];
  cc: WemailAddress[];
  bcc: WemailAddress[];
  subject: string;
  bodyExcerpt: string;
  createdAt: string;
  updatedAt: string;
}

export interface WemailMcpDraftDetail extends WemailMcpDraftSummary {
  bodyText: string;
  bodyHtml?: string;
  attachments: MailAttachment[];
  sourceMessageId?: string;
  threadId?: string;
}

export type WemailMcpTodoPriority = "low" | "medium" | "high";
export type WemailMcpTodoStatus = "suggested" | "confirmed" | "completed";

export interface WemailMcpTodo {
  id: string;
  accountId: string;
  title: string;
  description?: string;
  priority: WemailMcpTodoPriority;
  status: WemailMcpTodoStatus;
  done: boolean;
  startTime?: string;
  dueTime?: string;
  timezone?: string;
  source: "ai" | "user" | "agent" | "mcp";
  mail?: Pick<WemailMcpEnvelope, "id" | "threadId" | "subject" | "from" | "receivedAt">;
  createdAt: string;
  updatedAt: string;
}

export type WemailMcpOperationState =
  | "prepared"
  | "awaiting_confirmation"
  | "approved"
  | "committing"
  | "succeeded"
  | "failed_retryable"
  | "cancelled"
  | "expired"
  | "outcome_unknown";

export type WemailMcpOperationType =
  | "send"
  | "mail_action"
  | "delete_draft"
  | "delete_todo";

export interface WemailMcpPreparedOperation {
  id: string;
  accountId: string;
  type: WemailMcpOperationType;
  state: WemailMcpOperationState;
  risk: "high";
  preview: string;
  payloadHash: string;
  createdAt: string;
  expiresAt: string;
  executed: false;
}

export interface WemailMcpOperationStatus {
  id: string;
  accountId: string;
  type: WemailMcpOperationType;
  state: WemailMcpOperationState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  resultCode?: string;
  retryable: boolean;
}

export type WemailMcpSyncState =
  | "accepted"
  | "shared"
  | "running"
  | "completed"
  | "failed";

export interface WemailMcpSyncStatus {
  id: string;
  accountId: string;
  folderId?: string;
  state: WemailMcpSyncState;
  phase: string;
  processed: number;
  total?: number;
  checkpoint?: string;
  errorCode?: string;
  updatedAt: string;
}

export const WEMAIL_MCP_ERROR_CODES = [
  "authentication_required",
  "origin_forbidden",
  "request_too_large",
  "invalid_request",
  "invalid_arguments",
  "account_not_found",
  "account_mismatch",
  "capability_not_supported",
  "invalid_cursor",
  "message_not_found",
  "thread_not_found",
  "attachment_not_found",
  "attachment_too_large",
  "draft_not_found",
  "todo_not_found",
  "confirmation_required",
  "operation_not_found",
  "operation_expired",
  "operation_not_approved",
  "operation_not_cancellable",
  "idempotency_conflict",
  "outcome_unknown",
  "response_too_large",
  "rate_limited",
  "provider_error",
  "internal_error",
] as const;

export type WemailMcpErrorCode = (typeof WEMAIL_MCP_ERROR_CODES)[number];

export interface WemailMcpError {
  code: WemailMcpErrorCode;
  message: string;
  retryable: boolean;
}

export type WemailMcpListenerState = "disabled" | "starting" | "listening" | "error";

export interface WemailMcpTokenView {
  id: string;
  kind: "legacy" | "managed";
  fingerprint: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface WemailMcpSessionView {
  sessionHash: string;
  protocolVersion: WemailMcpProtocolVersion;
  initialized: boolean;
  createdAt: string;
  lastUsedAt: string;
  inFlightCalls: number;
}

export interface WemailMcpManagementState {
  enabled: boolean;
  port: number;
  defaultBodyCharacters: number;
  maxBodyCharacters: number;
  defaultPageSize: number;
  maxPageSize: number;
  maxRecipients: number;
  maxBatchMessages: number;
  maxPendingOperations: number;
  toolTimeoutSeconds: number;
  endpoint: string;
  listenerState: WemailMcpListenerState;
  errorCode?:
    | "port_conflict"
    | "listener_failed"
    | "emergency_disabled"
    | "credential_unavailable"
    | "credential_corrupt";
  credentialState: "unavailable" | "provisioning" | "ready" | "error";
  protocols: readonly WemailMcpProtocolVersion[];
  tools: Array<WemailMcpToolMetadata & {
    title: string;
    description: string;
    available: boolean;
    unavailableReason?: "provider_unavailable" | "not_implemented";
  }>;
  token: WemailMcpTokenView | null;
  legacyTokens: WemailMcpTokenView[];
  sessions: WemailMcpSessionView[];
  pendingOperationCount: number;
  operations: Array<{
    id: string;
    type: WemailMcpOperationType;
    state: WemailMcpOperationState;
    preview: string;
    expiresAt: string;
    updatedAt: string;
    resultCode?: string;
  }>;
}

export type WemailMcpSettingsInput = { enabled: boolean } & Partial<Pick<
  WemailMcpManagementState,
  | "port"
  | "defaultBodyCharacters"
  | "maxBodyCharacters"
  | "defaultPageSize"
  | "maxPageSize"
  | "maxRecipients"
  | "maxBatchMessages"
  | "maxPendingOperations"
  | "toolTimeoutSeconds"
>>;

export interface WemailMcpOneTimeTokenResult {
  token: string;
  metadata: WemailMcpTokenView;
  configuration: {
    type: "streamablehttp";
    url: string;
    headers: { Authorization: string };
  };
}

export interface WemailMcpConfigurationCopyResult {
  ok: boolean;
  target: WemailMcpConfigurationTarget;
  error?:
    | "desktop_required"
    | "unsupported_target"
    | "mcp_not_ready"
    | "credential_unavailable"
    | "credential_corrupt";
}

export function formatWemailMcpConfiguration(input: {
  target: WemailMcpConfigurationTarget;
  endpoint: string;
  token: string;
}): string {
  const connection = {
    type: input.target === "claude" ? "http" : "streamablehttp",
    url: input.endpoint,
    headers: { Authorization: `Bearer ${input.token}` },
  };
  const value = input.target === "claude"
    ? { mcpServers: { [WEMAIL_MCP_SERVER_NAME]: connection } }
    : { [WEMAIL_MCP_SERVER_NAME]: connection };
  return JSON.stringify(value, null, 2);
}
