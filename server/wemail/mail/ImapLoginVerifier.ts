import { ImapFlow } from "imapflow";
import type { AccountConfig } from "../../../shared/wemail/account.js";
import { enableSystemCertificateAuthorities } from "../security/SystemCa.js";
import { MailProviderCommandError } from "./ImapSmtpMailProvider.js";

export interface VerifyImapLoginInput {
  config: AccountConfig;
  imapPassword: string;
}

export async function verifyImapLogin(input: VerifyImapLoginInput): Promise<void> {
  enableSystemCertificateAuthorities();
  const client = new ImapFlow({
    host: input.config.imap.host,
    port: input.config.imap.port,
    secure: input.config.imap.secure,
    auth: {
      user: input.config.imap.username,
      pass: input.imapPassword,
    },
    verifyOnly: true,
    logger: false,
  });
  try {
    await client.connect();
  } catch (error) {
    throw new MailProviderCommandError({
      phase: "imap.login",
      cause: error,
    });
  } finally {
    try {
      await client.logout();
    } catch {
      // verifyOnly logs out automatically after success; failed logouts are not actionable.
    }
  }
}
