import type {
  PublicErrorEnvelope,
  PublicErrorMessageKey,
  PublicErrorRecoveryAction,
} from "../../../shared/wemail/presentation.js";

const PUBLIC_COPY: Record<PublicErrorMessageKey, string> = {
  cancelled: "操作已取消。",
  timeout: "等待响应超时，请稍后重试。",
  authentication: "身份验证失败，请检查账号设置后重试。",
  network: "暂时无法连接服务，请检查网络后重试。",
  rate_limit: "请求过于频繁，请稍后再试。",
  permission: "当前账号没有完成此操作的权限。",
  not_found: "相关内容已不存在或暂时不可用。",
  conflict: "内容状态已经变化，请刷新后重试。",
  service_unavailable: "服务暂时不可用，请稍后重试。",
  unknown: "操作没有完成，请稍后重试。",
};

const REDACTED_METADATA_KEYS = /^(?:error|detail|message|stack|cause|stage|stdout|stderr|command|input|output|path|logPath|provider|endpoint|host|body|bodyHtml|authorization|cookie|token|secret|password|errorId|requestId|toolCallId|runId)$/i;

export function projectPublicErrorResponse(
  status: number,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const rawText = [body.error, body.detail, body.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const code = safeCode(body.code) ?? codeForStatus(status);
  const messageKey = code === "ROUTE_NOT_FOUND"
    ? "service_unavailable"
    : classifyPublicError(status, rawText);
  const retryable = [
    "timeout",
    "network",
    "rate_limit",
    "conflict",
    "service_unavailable",
    "unknown",
  ].includes(messageKey);
  const recoveryAction: PublicErrorRecoveryAction = messageKey === "authentication"
    ? "sign_in"
    : messageKey === "conflict"
      ? "refresh"
      : retryable
        ? "retry"
        : "none";
  const correlationId = safeCorrelationId(body.errorId) ?? safeCorrelationId(body.requestId);
  const envelope: PublicErrorEnvelope = {
    code,
    messageKey,
    retryable,
    recoveryAction,
    ...(correlationId ? { correlationId } : {}),
  };

  return {
    ...sanitizeMetadata(body),
    ok: false,
    error: PUBLIC_COPY[messageKey],
    code,
    publicError: envelope,
  };
}

function classifyPublicError(status: number, text: string): PublicErrorMessageKey {
  if (/abort|cancel|取消/i.test(text)) return "cancelled";
  if (/timeout|timed out|超时/i.test(text)) return "timeout";
  if (status === 401 || /auth|credential|login|密码|凭据|授权码/i.test(text)) {
    return "authentication";
  }
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "service_unavailable";
  if (/network|socket|econn|fetch failed|dns|tls|ssl/i.test(text)) return "network";
  return "unknown";
}

function codeForStatus(status: number): string {
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVICE_UNAVAILABLE";
  return `HTTP_${status}`;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(value)
    ? value
    : undefined;
}

function safeCorrelationId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(value)
    ? value
    : undefined;
}

function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (key === "ok" || key === "code" || key === "publicError") return [];
      if (REDACTED_METADATA_KEYS.test(key)) return [];
      return [[key, sanitizeValue(item)]];
    }),
  );
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      REDACTED_METADATA_KEYS.test(key) ? [] : [[key, sanitizeValue(item)]],
    ),
  );
}
