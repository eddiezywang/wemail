export const MAIL_CREDENTIAL_INVALID = "MAIL_CREDENTIAL_INVALID" as const;
export const MAIL_PASSWORD_EXPIRED = "MAIL_PASSWORD_EXPIRED" as const;
export const MAIL_AUTH_REQUIRED_EVENT = "wemail:mail-auth-required";

export interface MailAuthRequiredDetail {
  accountId: string;
  code: typeof MAIL_CREDENTIAL_INVALID;
  source: "background" | "manual" | "send";
}

export function dispatchMailAuthRequired(detail: MailAuthRequiredDetail): void {
  window.dispatchEvent(
    new CustomEvent<MailAuthRequiredDetail>(MAIL_AUTH_REQUIRED_EVENT, { detail }),
  );
}

export function isMailCredentialInvalidBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    ((body as { code?: unknown }).code === MAIL_CREDENTIAL_INVALID ||
      (body as { code?: unknown }).code === MAIL_PASSWORD_EXPIRED)
  );
}
