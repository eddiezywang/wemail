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
export const WEMAIL_MCP_CONFIGURATION_TARGETS = [
  "claude",
  "cursor",
  "trae",
  "vscode",
  "windsurf",
  "codex",
  "opencode",
  "pi",
  "cherrystudio",
] as const;
export type WemailMcpConfigurationTarget =
  (typeof WEMAIL_MCP_CONFIGURATION_TARGETS)[number];

export const WEMAIL_MCP_CONFIGURATION_LABELS: Record<
  WemailMcpConfigurationTarget,
  string
> = {
  claude: "Claude Code",
  cursor: "Cursor",
  trae: "TRAE",
  vscode: "VS Code",
  windsurf: "Windsurf",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  cherrystudio: "Cherry Studio",
};

export const WEMAIL_MCP_CONFIGURATION_HINTS: Record<
  WemailMcpConfigurationTarget,
  string
> = {
  claude: "保存到项目 .mcp.json 或 ~/.claude.json，重启 Claude Code 后生效。",
  cursor: "保存到 ~/.cursor/mcp.json，重启 Cursor 后生效。",
  trae: "在 TRAE 的 MCP 设置中导入此 JSON，保存后重新加载。",
  vscode: "保存到工作区 .vscode/mcp.json，在 Copilot Chat 的 MCP 列表中确认已连接。",
  windsurf: "保存到 ~/.codeium/windsurf/mcp_config.json，重启 Windsurf 后生效。",
  codex: "按 Codex 的 MCP 配置格式粘贴；若使用 config.toml，请转换为 [mcp_servers.wemail] 下的 url 与 bearer_token_env_var 字段。",
  opencode: "保存到 opencode.json 的 mcp 节点，重启 OpenCode 后生效。",
  pi: "保存到 ~/.pi/agent/mcp.json（全局）或 .pi/mcp.json（项目），运行 /mcp 确认、/reload 生效。",
  cherrystudio: "在 Cherry Studio 的 MCP 设置中新建远程服务器，粘贴 URL 与请求头。",
};

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

export type WemailMcpListenerState = "disabled" | "starting" | "listening" | "attached" | "error";

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
  const headers = { Authorization: `Bearer ${input.token}` };
  const target = input.target;
  if (target === "codex") {
    // Legacy Codex/generic shape kept byte-for-byte for existing users.
    return JSON.stringify(
      {
        [WEMAIL_MCP_SERVER_NAME]: {
          type: "streamablehttp",
          url: input.endpoint,
          headers,
        },
      },
      null,
      2,
    );
  }
  if (target === "opencode") {
    return JSON.stringify(
      {
        mcp: {
          [WEMAIL_MCP_SERVER_NAME]: { type: "remote", url: input.endpoint, headers },
        },
      },
      null,
      2,
    );
  }
  if (target === "vscode") {
    return JSON.stringify(
      {
        servers: {
          [WEMAIL_MCP_SERVER_NAME]: { type: "http", url: input.endpoint, headers },
        },
      },
      null,
      2,
    );
  }
  if (target === "windsurf") {
    return JSON.stringify(
      {
        mcpServers: {
          [WEMAIL_MCP_SERVER_NAME]: { serverUrl: input.endpoint, headers },
        },
      },
      null,
      2,
    );
  }
  // claude/pi document "type: http"; cursor/trae/cherrystudio use bare url+headers.
  const withType = target === "claude" || target === "pi";
  const connection = withType
    ? { type: "http", url: input.endpoint, headers }
    : { url: input.endpoint, headers };
  return JSON.stringify(
    { mcpServers: { [WEMAIL_MCP_SERVER_NAME]: connection } },
    null,
    2,
  );
}
