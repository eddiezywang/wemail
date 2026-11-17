import {
  isMailCredentialInvalidError,
} from "./MailCredentialError.js";
import { MailProviderCommandError } from "./ImapSmtpMailProvider.js";

export type MailProviderFailureKind =
  | "item"
  | "mailbox"
  | "connection"
  | "credential"
  | "throttling"
  | "protocol";

export function classifyMailProviderFailure(
  error: unknown,
): MailProviderFailureKind {
  if (isMailCredentialInvalidError(error)) return "credential";
  if (isMailBodyMissingError(error)) return "item";

  const details = errorDetails(error);
  if (
    details.code === "NoConnection" ||
    /connection not available|not connected|connection closed|socket closed|econnreset|econnaborted|etimedout|mail-provider-metadata-timeout/i.test(
      details.text,
    )
  ) {
    return "connection";
  }
  if (/uidvalidity|mailbox.*(?:missing|removed|not found)|no such mailbox/i.test(details.text)) {
    return "mailbox";
  }
  if (/rate limit|too many requests|server busy|try again later|temporarily unavailable/i.test(details.text)) {
    return "throttling";
  }
  if (
    error instanceof MailProviderCommandError &&
    error.phase === "imap.fetch" &&
    /message.*(?:missing|not found)|vanished|no such message|invalid uid/i.test(details.text)
  ) {
    return "item";
  }
  return "protocol";
}

export function mailProviderRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { retryAfterMs?: unknown; retryAfter?: unknown; cause?: unknown };
  const delay = typeof record.retryAfterMs === "number" ? record.retryAfterMs
    : typeof record.retryAfter === "number" ? record.retryAfter * 1_000 : undefined;
  if (delay !== undefined && Number.isFinite(delay) && delay >= 0) return delay;
  if (record.cause && record.cause !== error && typeof record.cause === "object") {
    const cause = record.cause as { retryAfterMs?: unknown; retryAfter?: unknown };
    const causeDelay = typeof cause.retryAfterMs === "number" ? cause.retryAfterMs
      : typeof cause.retryAfter === "number" ? cause.retryAfter * 1_000 : undefined;
    if (causeDelay !== undefined && Number.isFinite(causeDelay) && causeDelay >= 0) return causeDelay;
  }
  return undefined;
}

export function isMailBodyMissingError(error: unknown): boolean {
  return error instanceof Error && error.message === "mail-body-missing";
}

function errorDetails(error: unknown): { code: string; text: string } {
  if (!error || typeof error !== "object") {
    return { code: "", text: String(error) };
  }
  const record = error as {
    code?: unknown;
    message?: unknown;
    responseText?: unknown;
    cause?: unknown;
  };
  const cause = record.cause && typeof record.cause === "object"
    ? record.cause as { code?: unknown; message?: unknown }
    : undefined;
  return {
    code: String(record.code ?? cause?.code ?? ""),
    text: [record.message, record.responseText, cause?.message]
      .map((value) => String(value ?? ""))
      .join(" "),
  };
}

