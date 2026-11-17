import { randomUUID } from "node:crypto";
import type { AutomationRulePreviewResult } from "../../../shared/wemail/automation.js";
import type { AutomationRule } from "../../../shared/wemail/automation.js";
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

  commitOnce(
    id: string, accountId: string,
    commit: (preview: AutomationRulePreviewResult) => AutomationRule,
    find: (id: string) => AutomationRule | null,
    revision: (rule: AutomationRule) => string,
  ): AutomationRule {
    return this.db.transaction(() => {
      const preview = this.get(id, accountId) as (AutomationRulePreviewResult & { committedRuleId?: string; committedRuleRevision?: string }) | null;
      if (!preview) throw new Error("automation-preview-not-found-or-expired");
      if (preview.committedRuleId) {
        const existing = find(preview.committedRuleId);
        if (!existing || existing.accountId !== accountId) throw new Error("automation-committed-rule-unavailable");
        const state = this.db.prepare("SELECT archived_at FROM automation_rules WHERE id = ?").get(existing.id) as { archived_at: string | null } | undefined;
        if (!state || state.archived_at) throw new Error("automation-committed-rule-changed");
        if (!preview.committedRuleRevision || revision(existing) !== preview.committedRuleRevision) throw new Error("automation-committed-rule-changed");
        return existing;
      }
      const rule = commit(preview);
      this.db.prepare("UPDATE automation_rule_previews SET preview_json = ? WHERE id = ? AND account_id = ?")
        .run(JSON.stringify({ ...preview, committedRuleId: rule.id, committedRuleRevision: revision(rule) }), id, accountId);
      return rule;
    }).immediate();
  }

  cleanupExpired(): number {
    return this.db.prepare("DELETE FROM automation_rule_previews WHERE expires_at <= ?").run(this.now()).changes;
  }
}
