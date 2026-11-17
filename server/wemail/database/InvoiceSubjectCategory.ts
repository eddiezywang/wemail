import type { MailDatabase } from "./Database.js";

/** Materialize the subject rule on writes; historical repair runs once in migrations. */
export function materializeInvoiceSubjectCategory(db: MailDatabase, messageId?: bigint): void {
  if (messageId !== undefined) {
    db.prepare(`
      DELETE FROM mail_message_system_categories
      WHERE message_id = ? AND classifier_version = 'invoice-subject-v1'
        AND NOT EXISTS (SELECT 1 FROM mail_messages
          WHERE id = ? AND deleted_at_ms IS NULL AND instr(subject, '发票') > 0)
    `).run(messageId, messageId);
  }
  db.prepare(`
    INSERT INTO mail_message_system_categories (
      account_id, category_id, message_id, received_at_ms, source, score,
      classifier_version, is_seen, is_flagged, has_attachments, row_version
    )
    SELECT messages.account_id, categories.id, messages.id, messages.received_at_ms,
      'rule', 1, 'invoice-subject-v1', messages.is_seen, messages.is_flagged,
      messages.has_attachments, 1
    FROM mail_messages messages
    JOIN mail_system_categories categories ON categories.key = 'invoice'
    WHERE messages.deleted_at_ms IS NULL AND instr(messages.subject, '发票') > 0
      ${messageId === undefined ? "" : "AND messages.id = @messageId"}
    ON CONFLICT(account_id, category_id, message_id) DO UPDATE SET
      source = excluded.source, score = excluded.score,
      classifier_version = excluded.classifier_version,
      received_at_ms = excluded.received_at_ms, is_seen = excluded.is_seen,
      is_flagged = excluded.is_flagged, has_attachments = excluded.has_attachments,
      row_version = mail_message_system_categories.row_version + 1
    WHERE mail_message_system_categories.source <> 'user'
  `).run(messageId === undefined ? {} : { messageId });
}
