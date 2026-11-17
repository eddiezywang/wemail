import type { AutomationDataset } from "../../../shared/wemail/automation.js";
import type {
  DesignRecipe,
  InsightReportFormatPreferences,
  InsightReportSummary,
  InsightReportVersionSummary,
} from "../../../shared/wemail/designArtifacts.js";
import type { MailDatabase } from "../database/Database.js";

interface ReportRow {
  id: string;
  account_id: string;
  current_version: number;
  scope: "single" | "multi";
  title: string;
  application_message_id: string;
  created_at: string;
  updated_at: string;
  preferences_json: string;
}

export class InsightReportRepository {
  constructor(private readonly db: MailDatabase, private readonly now = () => new Date().toISOString()) {}

  findCurrentByEmail(accountId: string, emailId: string): InsightReportSummary | null {
    const row = this.db.prepare(`
      SELECT report.*, version.preferences_json
      FROM insight_report_sources source
      JOIN insight_reports report ON report.id = source.report_id
      JOIN insight_report_versions version
        ON version.report_id = report.id AND version.version = report.current_version
      WHERE source.account_id = ? AND source.email_id = ? AND source.active = 1
      ORDER BY report.updated_at DESC LIMIT 1
    `).get(accountId, emailId) as ReportRow | undefined;
    return row ? this.map(row) : null;
  }

  get(accountId: string, reportId: string): InsightReportSummary | null {
    const row = this.db.prepare(`
      SELECT report.*, version.preferences_json
      FROM insight_reports report
      JOIN insight_report_versions version
        ON version.report_id = report.id AND version.version = report.current_version
      WHERE report.account_id = ? AND report.id = ?
    `).get(accountId, reportId) as ReportRow | undefined;
    return row ? this.map(row) : null;
  }

  listVersions(accountId: string, reportId: string): InsightReportVersionSummary[] {
    const ownsReport = this.db.prepare(
      "SELECT 1 FROM insight_reports WHERE account_id = ? AND id = ?",
    ).get(accountId, reportId);
    if (!ownsReport) return [];
    const rows = this.db.prepare(`
      SELECT report_id, version, application_message_id, preferences_json, created_at
      FROM insight_report_versions
      WHERE report_id = ?
      ORDER BY version DESC
    `).all(reportId) as Array<{
      report_id: string;
      version: number;
      application_message_id: string;
      preferences_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      reportId: row.report_id,
      version: row.version,
      applicationMessageId: row.application_message_id,
      preferences: JSON.parse(row.preferences_json || "{}") as InsightReportFormatPreferences,
      createdAt: row.created_at,
    }));
  }

  recordVersion(input: {
    reportId: string;
    version: number;
    accountId: string;
    scope: "single" | "multi";
    title: string;
    applicationMessageId: string;
    sourceEmailIds: string[];
    recipe: DesignRecipe;
    dataset: AutomationDataset;
    preferences?: InsightReportFormatPreferences;
  }): InsightReportSummary {
    const timestamp = this.now();
    const sourceEmailIds = [...new Set(input.sourceEmailIds.filter(Boolean))];
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO insight_reports
          (id, account_id, current_version, scope, title, application_message_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          current_version = excluded.current_version,
          scope = excluded.scope,
          title = excluded.title,
          application_message_id = excluded.application_message_id,
          updated_at = excluded.updated_at
      `).run(input.reportId, input.accountId, input.version, input.scope, input.title, input.applicationMessageId, timestamp, timestamp);
      this.db.prepare(`
        INSERT INTO insight_report_versions
          (report_id, version, recipe_json, dataset_json, preferences_json, application_message_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.reportId, input.version, JSON.stringify(input.recipe), JSON.stringify(input.dataset), JSON.stringify(input.preferences ?? {}), input.applicationMessageId, timestamp);
      if (sourceEmailIds.length > 0) {
        this.db.prepare(`
          UPDATE insight_report_sources SET active = 0, superseded_at = ?
          WHERE account_id = ? AND email_id IN (${sourceEmailIds.map(() => "?").join(",")})
            AND active = 1 AND report_id <> ?
        `).run(timestamp, input.accountId, ...sourceEmailIds, input.reportId);
      }
      this.db.prepare(`
        UPDATE insight_report_sources SET active = 0, superseded_at = ?
        WHERE report_id = ? AND active = 1
      `).run(timestamp, input.reportId);
      const link = this.db.prepare(`
        INSERT INTO insight_report_sources
          (report_id, account_id, email_id, active, linked_at, superseded_at)
        VALUES (?, ?, ?, 1, ?, NULL)
      `);
      for (const emailId of sourceEmailIds) link.run(input.reportId, input.accountId, emailId, timestamp);
    });
    transaction();
    return this.get(input.accountId, input.reportId)!;
  }

  private map(row: ReportRow): InsightReportSummary {
    const sources = this.db.prepare(`
      SELECT email_id FROM insight_report_sources
      WHERE report_id = ? AND active = 1 ORDER BY linked_at, email_id
    `).all(row.id) as Array<{ email_id: string }>;
    return {
      id: row.id,
      accountId: row.account_id,
      currentVersion: row.current_version,
      scope: row.scope,
      title: row.title,
      applicationMessageId: row.application_message_id,
      sourceEmailIds: sources.map((item) => item.email_id),
      preferences: JSON.parse(row.preferences_json || "{}") as InsightReportFormatPreferences,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

}
