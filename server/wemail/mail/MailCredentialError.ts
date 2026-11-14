import { MailProviderCommandError } from "./ImapSmtpMailProvider.js";

export const MAIL_CREDENTIAL_INVALID = "MAIL_CREDENTIAL_INVALID" as const;

export interface MailCredentialInvalidEvent {
  accountId: string;
  code: typeof MAIL_CREDENTIAL_INVALID;
  stage: "imap.login";
}

// Login-NO wordings that are transient rather than auth rejections. Anything
// else the server explicitly refuses at imap.login (any language, e.g.
// "登录错误或密码错误") is treated as a credential failure so the user is
// prompted to re-login instead of the sync retrying forever.
// ponytail: whitelist-of-transient instead of blacklist-of-auth — a newly
// worded transient NO misclassifies as credential-required (recoverable by
// re-login); add it here when seen.
const TRANSIENT_LOGIN_NO = /unavailable|busy|temporar|try again|later|limit/i;

export function isMailCredentialInvalidError(error: unknown): boolean {
  if (!(error instanceof MailProviderCommandError)) return false;
  if (error.phase !== "imap.login") return false;
  if (error.responseStatus?.toUpperCase() !== "NO") return false;
  const providerText = error.responseText ?? error.message;
  if (TRANSIENT_LOGIN_NO.test(providerText)) return false;
  return true;
}
