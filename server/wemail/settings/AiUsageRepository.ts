import { randomUUID } from "node:crypto";
import type {
  AiUsageRecord,
  EmailUsageRow,
  UsageCategory,
  UsageSummaryItem,
} from "../../../shared/wemail/usage.js";
import type { MailDatabase } from "../database/Database.js";

export const USAGE_BUCKETS: ReadonlyArray<{
  category: UsageCategory;
  label: string;
}> = Object.freeze([
  { category: "summary", label: "摘要" },
  { category: "agent_chat", label: "AI 聊天" },
  { category: "compose", label: "撰写" },
  { category: "todo", label: "待办" },
  { category: "translation", label: "AI 翻译" },
  { category: "automation", label: "自动化" },
  { category: "other", label: "标签 / 其他" },
]);

interface UsageRow {
  category: UsageCategory;
  tokens: number;
  calls: number;
}

export class AiUsageRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  record(input: AiUsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO ai_usage (
           id, account_id, category, processor, email_id, input_tokens, output_tokens,
           model, provider, caller_source, session_id, duration_ms, processor_version, created_at
         ) VALUES (
           @id, @accountId, @category, @processor, @emailId, @inputTokens, @outputTokens,
           @model, @provider, @callerSource, @sessionId, @durationMs, @processorVersion, @createdAt
         )`,
      )
      .run({
        id: `usage-${randomUUID()}`,
        accountId: input.accountId,
        category: input.category,
        processor: input.processor,
        emailId: input.emailId ?? null,
        inputTokens: Math.max(0, input.inputTokens),
        outputTokens: Math.max(0, input.outputTokens),
        model: input.model ?? null,
        provider: input.provider ?? null,
        callerSource: input.callerSource ?? null,
        sessionId: input.sessionId ?? null,
        durationMs: input.durationMs ?? null,
        processorVersion: input.processorVersion ?? 1,
        createdAt: this.now(),
      });
  }

  summarize(input: {
    accountId: string;
    period: "30d";
    now?: string;
  }): UsageSummaryItem[] {
    const nowMs = Date.parse(input.now ?? this.now());
    const from = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT category,
                SUM(input_tokens + output_tokens) AS tokens,
                COUNT(*) AS calls
           FROM ai_usage
          WHERE account_id = @accountId
            AND created_at >= @from
          GROUP BY category`,
      )
      .all({ accountId: input.accountId, from }) as UsageRow[];
    const byCategory = new Map(rows.map((row) => [row.category, row]));
    return USAGE_BUCKETS.map(({ category, label }) => {
      const row = byCategory.get(category);
      return {
        category,
        label,
        tokens: row?.tokens ?? 0,
        calls: row?.calls ?? 0,
      };
    });
  }

  /**
   * Summarize usage grouped by processor, processor_version, and model.
   * Returns detailed rows for diagnostics, grouped under stable UI buckets.
   */
  summarizeByProcessorVersion(input: {
    accountId: string;
    period: "30d";
    now?: string;
  }): Array<{
    category: UsageCategory;
    processor: string;
    processor_version: number;
    model: string;
    tokens: number;
    calls: number;
    avg_duration_ms: number;
  }> {
    const nowMs = Date.parse(input.now ?? this.now());
    const from = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT category,
                processor,
                processor_version,
                model,
                SUM(input_tokens + output_tokens) AS tokens,
                COUNT(*) AS calls,
                AVG(COALESCE(duration_ms, 0)) AS avg_duration_ms
           FROM ai_usage
          WHERE account_id = @accountId
            AND created_at >= @from
          GROUP BY category, processor, processor_version, model`,
      )
      .all({ accountId: input.accountId, from }) as Array<{
        category: UsageCategory;
        processor: string;
        processor_version: number;
        model: string | null;
        tokens: number;
        calls: number;
        avg_duration_ms: number;
      }>;
    return rows.map((row) => ({
      ...row,
      model: row.model ?? "unknown",
      avg_duration_ms: Math.round(row.avg_duration_ms),
    }));
  }

  /**
   * List every recorded AI call for one email, newest first. Each row is one
   * request, so retries and regenerations appear as separate entries. Used by
   * the per-mail token display.
   *
   * ponytail: filters by `email_id` with no supporting index — `ai_usage` is
   * bounded by AI-call count, not mail count, and a single email yields a
   * handful of rows. Add `idx_ai_usage_email` if this path ever scans hot data.
   */
  listByEmail(emailId: string, limit = 100): EmailUsageRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, category, processor, model, provider,
                input_tokens, output_tokens, duration_ms, created_at
           FROM ai_usage
          WHERE email_id = @emailId
          ORDER BY created_at DESC
          LIMIT @limit`,
      )
      .all({ emailId, limit }) as Array<{
        id: string;
        category: string;
        processor: string;
        model: string | null;
        provider: string | null;
        input_tokens: number;
        output_tokens: number;
        duration_ms: number | null;
        created_at: string;
      }>;
    return rows.map((row) => ({
      id: row.id,
      category: row.category as UsageCategory,
      processor: row.processor,
      model: row.model,
      provider: row.provider,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    }));
  }
}
