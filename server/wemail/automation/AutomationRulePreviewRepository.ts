import { randomUUID } from "node:crypto";
import type { AutomationRulePreviewResult } from "../../../shared/wemail/automation.js";
import type { MailDatabase } from "../database/Database.js";

interface PreviewRow {
  id: string; account_id: string; source_rule_id: string | null; source_rule_version: string | null;
  normalized_rule_json: string; rule_hash: string; capability_fingerprint: string;
  preview_json: string; created_at: string; expires_at: string;
}

export class AutomationRulePreviewRepository {
  constructor(private readonly db: MailDatabase, private readonly now = () => new Date().toISOString()) {}

  create(input: Omit<AutomationRulePreviewResult, "previewId" | "expiresAt"> & { accountId: string; ttlMinutes?: number }): AutomationRulePreviewResult {
    const previewId = `automation-preview-${randomUUID()}`;
    const expiresAt = new Date(Date.parse(this.now()) + (input.ttlMinutes ?? 15) * 60_000).toISOString();
    const result: AutomationRulePreviewResult = { ...input, previewId, expiresAt };
    this.db.prepare(`INSERT INTO automation_rule_previews (
      id, account_id, source_rule_id, source_rule_version, normalized_rule_json,
      rule_hash, capability_fingerprint, preview_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      previewId, input.accountId, input.sourceRuleId ?? null, input.sourceRuleVersion ?? null,
      JSON.stringify(input.normalizedRule), input.ruleHash, input.capabilityFingerprint,
      JSON.stringify(result), this.now(), expiresAt,
    );
    return result;
  }

  get(id: string, accountId: string): AutomationRulePreviewResult | null {
    const row = this.db.prepare("SELECT * FROM automation_rule_previews WHERE id = ? AND account_id = ?").get(id, accountId) as PreviewRow | undefined;
    if (!row || row.expires_at <= this.now()) return null;
    return JSON.parse(row.preview_json) as AutomationRulePreviewResult;
  }

  cleanupExpired(): number {
    return this.db.prepare("DELETE FROM automation_rule_previews WHERE expires_at <= ?").run(this.now()).changes;
  }
}
