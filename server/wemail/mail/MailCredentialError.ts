import { MailProviderCommandError } from "./ImapSmtpMailProvider.js";

export const MAIL_CREDENTIAL_INVALID = "MAIL_CREDENTIAL_INVALID" as const;

export interface MailCredentialInvalidEvent {
  accountId: string;
  code: typeof MAIL_CREDENTIAL_INVALID;
  stage: "imap.login";
}

export function isMailCredentialInvalidError(error: unknown): boolean {
  if (!(error instanceof MailProviderCommandError)) return false;
  if (error.phase !== "imap.login") return false;
  if (error.responseStatus?.toUpperCase() !== "NO") return false;
  const providerText = error.responseText ?? error.message;
  return /login error or password error/i.test(providerText);
}
