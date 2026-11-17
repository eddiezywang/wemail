export type PublicErrorMessageKey =
	| "cancelled"
	| "timeout"
	| "authentication"
	| "network"
	| "rate_limit"
	| "permission"
	| "not_found"
	| "conflict"
	| "outcome_unknown"
	| "service_unavailable"
	| "unknown";

export type PublicErrorRecoveryAction =
	| "retry"
	| "sign_in"
	| "open_settings"
	| "refresh"
	| "none";

/** Renderer-safe error data. Raw messages, stacks, paths and provider details
 * must never be copied into this envelope. */
export interface PublicErrorEnvelope {
	code: string;
	messageKey: PublicErrorMessageKey;
	retryable: boolean;
	recoveryAction: PublicErrorRecoveryAction;
	correlationId?: string;
}
