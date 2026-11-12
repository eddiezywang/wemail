import { randomUUID } from "node:crypto";
import type {
  IntelligenceJobType,
  LearningSummary,
} from "../../../shared/wemail/intelligence.js";
import type { MailDatabase } from "../database/Database.js";

interface LearningSummaryRow {
  public_id: string;
  account_public_id: string;
  feature: string;
  signals_json: string;
  updated_at_ms: bigint;
}

function rowToSummary(row: LearningSummaryRow): LearningSummary {
  return {
    feature: row.feature as IntelligenceJobType,
    accountId: row.account_public_id,
    signals: JSON.parse(row.signals_json) as Record<string, unknown>,
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
  };
}

export interface LearningSummaryServiceDeps {
  db: MailDatabase;
  now?: () => string;
}

/**
 * Service for managing per-feature learning summaries aggregated from
 * raw feedback events. Learning summaries are bounded (aggregated signals
 * only, never raw private feedback text).
 */
export class LearningSummaryService {
  private readonly db: MailDatabase;
  private readonly now: () => string;

  constructor(deps: LearningSummaryServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Get the learning summary for a specific account and feature.
   * Returns null if no summary exists.
   */
  get(accountId: string, feature: IntelligenceJobType): LearningSummary | null {
    const row = this.db
      .prepare(
        `SELECT summaries.public_id, accounts.public_id AS account_public_id,
                summaries.feature, summaries.signals_json, summaries.updated_at_ms
         FROM mail_learning_summaries summaries
         JOIN mail_accounts accounts ON accounts.id = summaries.account_id
         WHERE accounts.public_id = @accountId AND summaries.feature = @feature`,
      )
      .get({ accountId, feature }) as LearningSummaryRow | undefined;
    return row ? rowToSummary(row) : null;
  }

  /**
   * Get all learning summaries for an account.
   */
  listByAccount(accountId: string): LearningSummary[] {
    const rows = this.db
      .prepare(
        `SELECT summaries.public_id, accounts.public_id AS account_public_id,
                summaries.feature, summaries.signals_json, summaries.updated_at_ms
         FROM mail_learning_summaries summaries
         JOIN mail_accounts accounts ON accounts.id = summaries.account_id
         WHERE accounts.public_id = @accountId ORDER BY summaries.feature`,
      )
      .all({ accountId }) as LearningSummaryRow[];
    return rows.map(rowToSummary);
  }

  /**
   * Save or update a learning summary. Upserts by (accountId, feature).
   */
  save(input: {
    accountId: string;
    feature: IntelligenceJobType;
    signals: Record<string, unknown>;
  }): LearningSummary {
    const now = this.now();
    const publicId = `ls-${randomUUID()}`;
    const updatedAtMs = Date.parse(now);
    if (!Number.isFinite(updatedAtMs)) throw new Error("invalid-learning-summary-time");
    this.db
      .prepare(
        `INSERT INTO mail_learning_summaries (
           public_id, account_id, feature, signals_json, updated_at_ms, row_version
         )
         SELECT @publicId, accounts.id, @feature, @signalsJson, @updatedAtMs, 1
         FROM mail_accounts accounts WHERE accounts.public_id = @accountId
         ON CONFLICT(account_id, feature) DO UPDATE SET
           signals_json = excluded.signals_json,
           updated_at_ms = excluded.updated_at_ms,
           row_version = mail_learning_summaries.row_version + 1`,
      )
      .run({
        publicId,
        accountId: input.accountId,
        feature: input.feature,
        signalsJson: JSON.stringify(input.signals),
        updatedAtMs,
      });
    return this.get(input.accountId, input.feature)!;
  }

  /**
   * Compute a learning summary for a feature by aggregating feedback events.
   * Produces bounded signals (counts, patterns) — never raw feedback text.
   */
  computeFromFeedback(
    accountId: string,
    feature: IntelligenceJobType,
    feedbackEvents: Array<{ eventType: string; payload: Record<string, unknown> }>,
  ): LearningSummary {
    const signals: Record<string, unknown> = {};

    // Count events by type
    const counts: Record<string, number> = {};
    for (const event of feedbackEvents) {
      counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
    }
    signals.eventCounts = counts;
    signals.totalEvents = feedbackEvents.length;

    // Feature-specific aggregation
    if (feature === "tags") {
      // Aggregate rejected tag names for suppression signals
      const rejectedTags: string[] = [];
      for (const event of feedbackEvents) {
        if (event.eventType === "reject" && event.payload.tagName) {
          rejectedTags.push(event.payload.tagName as string);
        }
      }
      if (rejectedTags.length > 0) {
        signals.suppressedTags = [...new Set(rejectedTags)];
      }
    }

    if (feature === "replyDraft") {
      // Aggregate tone preferences from edit feedback
      const editCount = counts["edit"] ?? 0;
      const acceptCount = counts["accept"] ?? 0;
      if (editCount > 0 || acceptCount > 0) {
        signals.writingFeedback = {
          editCount,
          acceptCount,
          editRatio: editCount / (editCount + acceptCount || 1),
        };
      }
    }

    if (feature === "summary") {
      const rateEvents = feedbackEvents.filter((e) => e.eventType === "rate");
      if (rateEvents.length > 0) {
        const ratings = rateEvents
          .map((e) => e.payload.rating as number)
          .filter((r) => typeof r === "number");
        if (ratings.length > 0) {
          signals.averageRating =
            Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100;
        }
      }
    }

    return this.save({ accountId, feature, signals });
  }

  /**
   * Reset (clear) the learning summary for an account.
   * After reset, the learning summary will be empty for future prompt building.
   */
  reset(accountId: string): void {
    this.db
      .prepare(`DELETE FROM mail_learning_summaries
        WHERE account_id = (SELECT id FROM mail_accounts WHERE public_id = @accountId)`)
      .run({ accountId });
  }

  /**
   * Reset the learning summary for a specific feature and account.
   */
  resetFeature(accountId: string, feature: IntelligenceJobType): void {
    this.db
      .prepare(
        `DELETE FROM mail_learning_summaries
         WHERE account_id = (SELECT id FROM mail_accounts WHERE public_id = @accountId)
           AND feature = @feature`,
      )
      .run({ accountId, feature });
  }
}
