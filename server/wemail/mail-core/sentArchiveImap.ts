import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { EditionModules } from "../bootstrap/editionModules.js";
import type { MailboxCredentialEnvelope } from "../../../shared/wemail/mailCoreProtocol.js";
import type { WemailAddress, WemailDraftInput } from "../../../shared/wemail/mail.js";
import { enableSystemCertificateAuthorities } from "../security/SystemCa.js";

/**
 * Open-edition sent-archive: after SMTP send, APPEND the raw sent message to
 * the account's IMAP Sent folder so the mailbox's "Sent" view stays complete.
 *
 * Target folder resolution (non-required config, first match wins):
 *   1. `WEMAIL_SENT_FOLDER` env override (exact IMAP folder path);
 *   2. server-declared special-use `\Sent` mailbox (RFC 6154);
 *   3. common names ("Sent", "Sent Items", "已发送").
 * If no Sent folder is found the archive is skipped silently — the send
 * itself has already succeeded by the time this runs.
 *
 * Internal editions may rebind `#edition-modules` to override this (e.g.
 * provider-specific folder conventions); provider presets and enterprise
 * directory config stay in each edition's own repository.
 */

const FOLDER_OVERRIDE = process.env.WEMAIL_SENT_FOLDER?.trim() || null;
const COMMON_SENT_NAMES = ["sent", "sent items", "sent messages", "已发送"];

function toNodemailerAddresses(addresses: WemailAddress[] | undefined) {
  return (addresses ?? []).map((a) => ({ ...(a.name ? { name: a.name } : {}), address: a.email }));
}

function buildRawMessage(credential: MailboxCredentialEnvelope, draft: WemailDraftInput, messageId: string) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const mailObject: Record<string, unknown> = {
    from: {
      ...(credential.account.displayName ? { name: credential.account.displayName } : {}),
      address: credential.account.emailAddress,
    },
    to: toNodemailerAddresses(draft.to),
    ...(draft.cc?.length ? { cc: toNodemailerAddresses(draft.cc) } : {}),
    ...(draft.bcc?.length ? { bcc: toNodemailerAddresses(draft.bcc) } : {}),
    subject: draft.subject ?? "",
    text: draft.bodyText ?? "",
    ...(draft.bodyHtml ? { html: draft.bodyHtml } : {}),
    messageId,
    date: new Date(),
    ...(draft.smtpInReplyTo ? { inReplyTo: draft.smtpInReplyTo } : {}),
    ...(draft.smtpReferences?.length ? { references: draft.smtpReferences.join(" ") } : {}),
    ...(draft.attachments?.length
      ? {
          attachments: draft.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.mimetype,
            content: Buffer.from(a.dataBase64, "base64"),
          })),
        }
      : {}),
  };
  return transport.sendMail(mailObject).then((info) => (info as { message: Buffer }).message);
}

async function detectSentFolder(client: ImapFlow): Promise<string | null> {
  if (FOLDER_OVERRIDE) return FOLDER_OVERRIDE;
  const boxes = await client.list();
  for (const box of boxes ?? []) {
    if ((box as { specialUse?: string }).specialUse === "\\Sent") {
      return (box as { path: string }).path;
    }
  }
  for (const box of boxes ?? []) {
    const path = (box as { path: string }).path ?? "";
    if (COMMON_SENT_NAMES.includes(path.toLowerCase().trim())) return path;
  }
  return null;
}

async function save(
  credential: MailboxCredentialEnvelope,
  draft: WemailDraftInput,
  messageId: string,
): Promise<void> {
  if (!credential.imapPassword) return; // receive path not configured — nothing to write back to
  enableSystemCertificateAuthorities();
  const raw = await buildRawMessage(credential, draft, messageId);
  const account = credential.account;
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.imap.username, pass: credential.imapPassword },
    logger: false,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 30_000,
  });
  try {
    await client.connect();
    const sentPath = await detectSentFolder(client);
    if (!sentPath) return; // no Sent folder declared — skip write-back silently
    await client.append(sentPath, raw, ["\\Seen"], new Date());
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        // already closed
      }
    }
  }
}

export const SENT_ARCHIVE_IMAP: EditionModules["sentArchive"] = {
  supports: (credential) => Boolean(credential.imapPassword),
  save: (input) => save(input.credential, input.draft, input.messageId),
};
