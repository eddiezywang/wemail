import type { WemailMcpError, WemailMcpErrorCode } from "../../../shared/wemail/mcp.js";

export class McpDomainError extends Error {
  constructor(
    readonly code: WemailMcpErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "McpDomainError";
  }
}

const SAFE_MESSAGES: Record<WemailMcpErrorCode, string> = {
  authentication_required: "Authentication is required.",
  origin_forbidden: "The request Origin is not allowed.",
  request_too_large: "The request body exceeds the allowed size.",
  invalid_request: "The request is invalid.",
  invalid_arguments: "The tool arguments are invalid.",
  account_not_found: "The mail account was not found.",
  account_mismatch: "The requested object is not owned by this account.",
  capability_not_supported: "The provider does not support this capability.",
  invalid_cursor: "The cursor is invalid or expired.",
  message_not_found: "The message was not found.",
  thread_not_found: "The thread was not found.",
  attachment_not_found: "The attachment was not found.",
  attachment_too_large: "The attachment exceeds the allowed size.",
  draft_not_found: "The draft was not found.",
  todo_not_found: "The todo was not found.",
  confirmation_required: "Separate confirmation in WeMail is required.",
  operation_not_found: "The operation was not found.",
  operation_expired: "The operation has expired.",
  operation_not_approved: "The operation has not been approved.",
  operation_not_cancellable: "The operation can no longer be cancelled.",
  idempotency_conflict: "The idempotency key is already bound to another operation.",
  outcome_unknown: "The provider outcome is unknown and must not be retried automatically.",
  response_too_large: "The response exceeds the tool limit.",
  rate_limited: "The request limit was exceeded.",
  provider_error: "The mail provider could not complete the request.",
  internal_error: "WeMail could not complete the request.",
};

export function mapMcpError(error: unknown): WemailMcpError {
  if (error instanceof McpDomainError) {
    return { code: error.code, message: SAFE_MESSAGES[error.code], retryable: error.retryable };
  }
  return { code: "internal_error", message: SAFE_MESSAGES.internal_error, retryable: false };
}
