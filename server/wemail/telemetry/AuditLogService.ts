/**
 * Audit logging service for intelligence operations. Records every
 * trigger, retry, confirm, reject, etc. with caller context
 * (system/agent/user) so we can trace who did what and when.
 *
 * Uses the `intelligence_audit_log` table (migration 6).
 */

import { randomUUID } from "node:crypto";
import type { CallerContext } from "../../../shared/wemail/intelligence.js";
import type { MailDatabase } from "../database/Database.js";

export interface IntelligenceAuditEntry {
  id: string;
  emailId: string;
  action: string;
  processor?: string | null;
  source: CallerContext["source"];
  sessionId?: string | null;
  userId?: string | null;
  resultJson?: string | null;
  createdAt: string;
}

export class AuditLogService {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Record an intelligence operation in the audit log.
   */
  log(params: {
    emailId: string;
    action: string;
    processor?: string;
    caller: CallerContext;
    result?: unknown;
  }): void {
    const id = `audit-${randomUUID()}`;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO intelligence_audit_log (
          id, email_id, action, processor, source, session_id, user_id, result_json, created_at
        ) VALUES (
          @id, @emailId, @action, @processor, @source, @sessionId, @userId, @resultJson, @createdAt
        )`,
      )
      .run({
        id,
        emailId: params.emailId,
        action: params.action,
        processor: params.processor ?? null,
        source: params.caller.source,
        sessionId: params.caller.sessionId ?? null,
        userId: params.caller.userId ?? null,
        resultJson: params.result !== undefined ? JSON.stringify(params.result) : null,
        createdAt: now,
      });
  }

  /**
   * Find audit entries for a specific email, newest first.
   */
  findByEmailId(emailId: string, limit = 50): IntelligenceAuditEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM intelligence_audit_log
         WHERE email_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(emailId, limit) as any[];
    return rows.map(this.rowToEntry);
  }

  /**
   * Find audit entries by source (system/agent/user), newest first.
   */
  findBySource(source: CallerContext["source"], limit = 50): IntelligenceAuditEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM intelligence_audit_log
         WHERE source = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(source, limit) as any[];
    return rows.map(this.rowToEntry);
  }

  private rowToEntry(row: any): IntelligenceAuditEntry {
    return {
      id: row.id,
      emailId: row.email_id,
      action: row.action,
      processor: row.processor,
      source: row.source,
      sessionId: row.session_id,
      userId: row.user_id,
      resultJson: row.result_json,
      createdAt: row.created_at,
    };
  }
}
