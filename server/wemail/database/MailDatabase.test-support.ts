import type { MailDatabase } from "./Database.js";

export function insertCanonicalTestAccount(
  db: MailDatabase,
  input: {
    id: string;
    email?: string;
    displayName?: string | null;
    nowMs?: number;
  },
): void {
  const email = input.email ?? `${input.id}@example.test`;
  const nowMs = input.nowMs ?? 0;
  db.prepare(`
    INSERT INTO mail_accounts (
      public_id, email_address, display_name, provider_kind,
      imap_host, imap_port, imap_secure, imap_username,
      smtp_host, smtp_port, smtp_secure, smtp_username,
      credential_ref, credential_generation, state,
      created_at_ms, updated_at_ms, row_version
    ) VALUES (
      @id, @email, @displayName, 'imap-smtp',
      'imap.example.test', 993, 1, @email,
      'smtp.example.test', 465, 1, @email,
      @credentialRef, 0, 'active', @nowMs, @nowMs, 1
    )
  `).run({
    id: input.id,
    email,
    displayName: input.displayName ?? null,
    credentialRef: `test:${input.id}`,
    nowMs,
  });
  db.prepare(`
    INSERT OR IGNORE INTO db_commits (
      version, committed_at_ms, source, change_count
    ) VALUES (1, @nowMs, 'test-fixture', 0)
  `).run({ nowMs });
}

export function insertCanonicalTestMessage(
  db: MailDatabase,
  input: {
    id: string;
    accountId: string;
    subject?: string;
    receivedAtMs?: number;
  },
): void {
  const receivedAtMs = input.receivedAtMs ?? 1;
  db.prepare(`
    INSERT INTO mail_messages (
      public_id, account_id, normalized_subject, subject, snippet,
      sender_preview, recipient_preview, received_at_ms, internal_date_ms,
      size_bytes, has_attachments, is_seen, is_flagged, importance,
      content_version, row_version
    ) SELECT
      @id, accounts.id, @normalizedSubject, @subject, '', '', '',
      @receivedAtMs, @receivedAtMs, 0, 0, 0, 0, 0, 0, 1
    FROM mail_accounts accounts WHERE accounts.public_id = @accountId
  `).run({
    id: input.id,
    accountId: input.accountId,
    subject: input.subject ?? "Test message",
    normalizedSubject: (input.subject ?? "Test message").toLowerCase(),
    receivedAtMs,
  });
}
