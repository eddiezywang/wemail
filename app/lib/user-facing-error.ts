import type {
	PublicErrorEnvelope,
	PublicErrorMessageKey,
} from "../../shared/wemail/presentation";
import { publicErrorCopy } from "~/copy/zh-CN";

const AUTH_PATTERNS = [
	/auth(?:entication|orization)?/i,
	/credential/i,
	/invalid password/i,
	/login failed/i,
	/用户名|密码|授权码|凭据/,
];

const NETWORK_PATTERNS = [
	/network/i,
	/socket/i,
	/econn(?:reset|refused|aborted)/i,
	/fetch failed/i,
	/tls/i,
	/ssl/i,
	/dns/i,
];

const INTERNAL_PATTERNS = [
	/no such table/i,
	/sqlite/i,
	/database/i,
	/stack/i,
	/stage:/i,
	/errorid/i,
	/uuid/i,
	/localhost/i,
	/browser preview/i,
	/浏览器预览|后端|数据库|数据表|调用栈/,
];

/** True when the failure looks like a mailbox credential problem (expired
 *  password, rejected login, stale authorization code). Callers use this to
 *  open the update-password dialog instead of a dead-end toast. */
export function isCredentialError(error: unknown): boolean {
	const text = errorText(error);
	if (!text) return false;
	const code = (error as { body?: { code?: unknown } })?.body?.code;
	if (code === "MAIL_CREDENTIAL_INVALID" || code === "MAIL_PASSWORD_EXPIRED") return true;
	return AUTH_PATTERNS.some((pattern) => pattern.test(text));
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message.trim();
	if (typeof error === "string") return error.trim();
	return "";
}

function errorBody(error: unknown): Record<string, unknown> | undefined {
	if (!error || typeof error !== "object") return undefined;
	const body = (error as { body?: unknown }).body;
	return body && typeof body === "object" ? body as Record<string, unknown> : undefined;
}

function correlationId(error: unknown): string | undefined {
	const body = errorBody(error);
	for (const key of ["correlationId", "errorId", "requestId"]) {
		const value = body?.[key];
		if (typeof value === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(value)) return value;
	}
	return undefined;
}

function structuredPublicError(error: unknown): PublicErrorEnvelope | undefined {
	const candidate = errorBody(error)?.publicError;
	if (!candidate || typeof candidate !== "object") return undefined;
	const value = candidate as Record<string, unknown>;
	if (
		typeof value.code !== "string" ||
		typeof value.messageKey !== "string" ||
		!(value.messageKey in publicErrorCopy) ||
		typeof value.retryable !== "boolean" ||
		!["retry", "sign_in", "open_settings", "refresh", "none"].includes(String(value.recoveryAction))
	) return undefined;
	const safeCorrelationId = typeof value.correlationId === "string" &&
		/^[A-Za-z0-9_-]{6,80}$/.test(value.correlationId)
		? value.correlationId
		: undefined;
	return {
		code: value.code.slice(0, 80),
		messageKey: value.messageKey as PublicErrorMessageKey,
		retryable: value.retryable,
		recoveryAction: value.recoveryAction as PublicErrorEnvelope["recoveryAction"],
		...(safeCorrelationId ? { correlationId: safeCorrelationId } : {}),
	};
}

export function resolvePublicError(error: unknown): PublicErrorEnvelope {
	const structured = structuredPublicError(error);
	if (structured) return structured;
	const message = errorText(error);
	const body = errorBody(error);
	const bodyCode = typeof body?.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(body.code)
		? body.code
		: undefined;
	const status = typeof (error as { status?: unknown })?.status === "number"
		? (error as { status: number }).status
		: undefined;
	let messageKey: PublicErrorMessageKey = "unknown";
	if (bodyCode === "ROUTE_NOT_FOUND") messageKey = "service_unavailable";
	else if (/abort(?:ed)?|cancel(?:led|ed)/i.test(message)) messageKey = "cancelled";
	else if (/timeout|timed out|超时/i.test(message)) messageKey = "timeout";
	else if (status === 401 || AUTH_PATTERNS.some((pattern) => pattern.test(message))) messageKey = "authentication";
	else if (NETWORK_PATTERNS.some((pattern) => pattern.test(message))) messageKey = "network";
	else if (status === 429 || /rate limit|too many requests|请求过于频繁/i.test(message)) messageKey = "rate_limit";
	else if (status === 403 || /forbidden|permission denied|没有权限|无权/i.test(message)) messageKey = "permission";
	else if (status === 404 || /not found|不存在/i.test(message)) messageKey = "not_found";
	else if (status === 409 || /conflict|状态已变化/i.test(message)) messageKey = "conflict";
	else if ((status !== undefined && status >= 500) || INTERNAL_PATTERNS.some((pattern) => pattern.test(message))) messageKey = "service_unavailable";
	const retryable = ["timeout", "network", "rate_limit", "conflict", "service_unavailable", "unknown"].includes(messageKey);
	return {
		code: bodyCode ?? (status ? `HTTP_${status}` : "UNKNOWN"),
		messageKey,
		retryable,
		recoveryAction: messageKey === "authentication"
			? "sign_in"
			: messageKey === "conflict"
				? "refresh"
				: retryable ? "retry" : "none",
		...(correlationId(error) ? { correlationId: correlationId(error) } : {}),
	};
}

export function publicErrorMessage(
	envelope: PublicErrorEnvelope,
	fallback?: string,
): string {
	return envelope.messageKey === "unknown" && fallback
		? fallback
		: publicErrorCopy[envelope.messageKey];
}

/**
 * Converts implementation-facing failures into stable, actionable copy.
 * Raw backend messages belong in diagnostics and logs, never in the main UI.
 */
export function getUserFacingError(
	error: unknown,
	fallback = "操作没有完成，请稍后重试。",
): string {
	return publicErrorMessage(resolvePublicError(error), fallback);
}
