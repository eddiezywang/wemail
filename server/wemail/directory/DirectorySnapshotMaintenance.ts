import type { MailDatabase } from "../database/Database.js";

// Caller owns the transaction; retired/abandoned snapshots never affect the published head.
export function cleanupDirectorySnapshots(db: MailDatabase, nowMs: number, limit = 100): number {
  const contacts = db.prepare(`DELETE FROM directory_contacts WHERE storage_id IN (
    SELECT c.storage_id FROM directory_snapshots s JOIN directory_contacts c
      ON c.account_id = s.account_id AND c.snapshot_id = s.id
    WHERE s.state = 'retired' OR (s.state = 'staging' AND s.expires_at_ms <= ?) LIMIT ?
  )`).run(nowMs, limit).changes;
  const departments = db.prepare(`DELETE FROM directory_departments WHERE rowid IN (
    SELECT d.rowid FROM directory_snapshots s JOIN directory_departments d
      ON d.account_id = s.account_id AND d.snapshot_id = s.id
    WHERE s.state = 'retired' OR (s.state = 'staging' AND s.expires_at_ms <= ?) LIMIT ?
  )`).run(nowMs, limit).changes;
  const snapshots = db.prepare(`DELETE FROM directory_snapshots WHERE rowid IN (
    SELECT s.rowid FROM directory_snapshots s WHERE (s.state = 'retired' OR (s.state = 'staging' AND s.expires_at_ms <= ?))
      AND NOT EXISTS (SELECT 1 FROM directory_contacts c WHERE c.account_id = s.account_id AND c.snapshot_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM directory_departments d WHERE d.account_id = s.account_id AND d.snapshot_id = s.id)
      LIMIT ?
  )`).run(nowMs, limit).changes;
  return Math.max(contacts, departments, snapshots);
}
