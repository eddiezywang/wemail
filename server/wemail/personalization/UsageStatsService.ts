import type { UsageBucketStats } from "../../../shared/wemail/intelligence.js";
import type {
  UsageCategory,
  UsagePeriod,
  UsageTimeseriesGranularity,
  UsageTimeseriesResult,
} from "../../../shared/wemail/usage.js";
import { USAGE_BUCKETS } from "../settings/AiUsageRepository.js";
import type { MailDatabase } from "../database/Database.js";

interface BucketRow {
  category: UsageCategory;
  tokens: number;
  input_tokens: number;
  output_tokens: number;
  calls: number;
}

interface DetailRow {
  category: UsageCategory;
  processor: string;
  processor_version: number;
  model: string;
  tokens: number;
  input_tokens: number;
  output_tokens: number;
  calls: number;
  avg_duration_ms: number;
}

interface ModelRow {
  category: UsageCategory;
  provider: string;
  model: string;
  tokens: number;
  input_tokens: number;
  output_tokens: number;
  calls: number;
}

interface TsRow {
  bucket_index: number;
  category: UsageCategory;
  tokens: number;
  calls: number;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export interface UsageStatsServiceDeps {
  db: MailDatabase;
  now?: () => string;
}

const USAGE_EVENTS_CTE = `
  WITH usage_events AS (
    SELECT category,
           processor,
           processor_version,
           COALESCE(model, 'unknown') AS model,
           COALESCE(provider, 'unknown') AS provider,
           input_tokens AS input_tokens,
           output_tokens AS output_tokens,
           input_tokens + output_tokens AS tokens,
           COALESCE(duration_ms, 0) AS duration_ms
      FROM ai_usage
     WHERE account_id = @accountId
       AND created_at >= @from

    UNION ALL

    SELECT CASE artifacts.artifact_kind
             WHEN 'summary' THEN 'summary'
             WHEN 'replyDecision' THEN 'compose'
             WHEN 'replyDraft' THEN 'compose'
             ELSE 'other'
           END AS category,
           COALESCE(
             json_extract(artifacts.json_value, '$._metadata.processor'),
             artifacts.artifact_kind
           ) AS processor,
           CAST(COALESCE(NULLIF(artifacts.processor_version, ''), '1') AS INTEGER)
             AS processor_version,
           COALESCE(artifacts.model_id, 'unknown') AS model,
           'unknown' AS provider,
           CAST(COALESCE(
             json_extract(artifacts.json_value, '$._metadata.tokenUsage.inputTokens'),
             0
           ) AS INTEGER) AS input_tokens,
           CAST(COALESCE(
             json_extract(artifacts.json_value, '$._metadata.tokenUsage.outputTokens'),
             0
           ) AS INTEGER) AS output_tokens,
           CAST(COALESCE(
             json_extract(artifacts.json_value, '$._metadata.tokenUsage.inputTokens'),
             0
           ) AS INTEGER) +
           CAST(COALESCE(
             json_extract(artifacts.json_value, '$._metadata.tokenUsage.outputTokens'),
             0
           ) AS INTEGER) AS tokens,
           CAST(COALESCE(
             json_extract(artifacts.json_value, '$._metadata.durationMs'),
             0
           ) AS REAL) AS duration_ms
      FROM mail_ai_artifacts artifacts
      JOIN mail_accounts accounts ON accounts.id = artifacts.account_id
     WHERE accounts.public_id = @accountId
       AND artifacts.completed_at_ms >= @fromMs
       AND artifacts.json_value IS NOT NULL
       AND artifacts.state IN ('ready', 'stale')
  )
`;

/**
 * Service for computing usage statistics grouped by stable UI buckets
 * and processor version. Returns fixed UI buckets for the frontend
 * plus detailed processor-version rows for diagnostics.
 */
export class UsageStatsService {
  private readonly db: MailDatabase;
  private readonly now: () => string;

  constructor(deps: UsageStatsServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Get usage statistics for an account, grouped by stable UI buckets
   * and detailed processor-version rows.
   */
  getStats(input: { accountId: string; period: UsagePeriod }): UsageBucketStats[] {
    const nowMs = Date.parse(this.now());
    const days = Number.parseInt(input.period, 10);
    const fromMs = nowMs - days * 24 * 60 * 60 * 1000;
    const from = new Date(fromMs).toISOString();
    const queryParams = { accountId: input.accountId, from, fromMs };

    // Aggregate by category (stable UI buckets)
    const bucketRows = this.db
      .prepare(
        `${USAGE_EVENTS_CTE}
         SELECT category,
                SUM(tokens) AS tokens,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                COUNT(*) AS calls
           FROM usage_events
          GROUP BY category`,
      )
      .all(queryParams) as BucketRow[];

    const byCategory = new Map(bucketRows.map((row) => [row.category, row]));

    // Aggregate by processor + processor_version for detailed rows
    const detailRows = this.db
      .prepare(
        `${USAGE_EVENTS_CTE}
         SELECT category,
                processor,
                processor_version,
                model,
                SUM(tokens) AS tokens,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                COUNT(*) AS calls,
                AVG(duration_ms) AS avg_duration_ms
           FROM usage_events
          GROUP BY category, processor, processor_version, model`,
      )
      .all(queryParams) as DetailRow[];

    // Group details by category
    const detailsByCategory = new Map<string, UsageBucketStats["details"]>();
    for (const row of detailRows) {
      const cat = row.category;
      if (!detailsByCategory.has(cat)) {
        detailsByCategory.set(cat, []);
      }
      detailsByCategory.get(cat)!.push({
        processor: row.processor,
        processorVersion: row.processor_version,
        model: row.model ?? "unknown",
        tokens: row.tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        calls: row.calls,
        avgDurationMs: Math.round(row.avg_duration_ms),
      });
    }

    // Aggregate by provider + model name for the model dimension
    const modelRows = this.db
      .prepare(
        `${USAGE_EVENTS_CTE}
         SELECT category,
                provider,
                model,
                SUM(tokens) AS tokens,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                COUNT(*) AS calls
           FROM usage_events
          GROUP BY category, provider, model`,
      )
      .all(queryParams) as ModelRow[];

    const modelsByCategory = new Map<string, UsageBucketStats["models"]>();
    for (const row of modelRows) {
      const cat = row.category;
      if (!modelsByCategory.has(cat)) {
        modelsByCategory.set(cat, []);
      }
      modelsByCategory.get(cat)!.push({
        provider: row.provider ?? "unknown",
        model: row.model ?? "unknown",
        tokens: row.tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        calls: row.calls,
      });
    }

    // Build stable UI buckets
    return USAGE_BUCKETS.map(({ category, label }) => {
      const row = byCategory.get(category);
      return {
        category,
        label,
        tokens: row?.tokens ?? 0,
        inputTokens: row?.input_tokens ?? 0,
        outputTokens: row?.output_tokens ?? 0,
        calls: row?.calls ?? 0,
        details: detailsByCategory.get(category) ?? [],
        models: modelsByCategory.get(category) ?? [],
      };
    });
  }

  /**
   * Timeseries of AI throughput (tokens + calls) grouped by category and
   * bucket. Buckets are zero-filled across the whole window so the frontend
   * gets a contiguous X axis. Bucket index is derived from the absolute
   * Unix epoch (timezone-agnostic); labels are rendered in local time.
   */
  getTimeseries(input: {
    accountId: string;
    granularity: UsageTimeseriesGranularity;
    window: number;
  }): UsageTimeseriesResult {
    const bucketSeconds = input.granularity === "minute" ? 60 : 3600;
    const nowMs = Date.parse(this.now());
    const fromMs = nowMs - input.window * bucketSeconds * 1000;
    const fromIso = new Date(fromMs).toISOString();
    const fromIndex = Math.floor(fromMs / 1000 / bucketSeconds);
    const nowIndex = Math.floor(nowMs / 1000 / bucketSeconds);
    const positions = nowIndex - fromIndex + 1;

    const rows = this.db
      .prepare(
        `SELECT CAST(strftime('%s', datetime(created_at)) AS INTEGER) / ${bucketSeconds} AS bucket_index,
                category,
                SUM(input_tokens + output_tokens) AS tokens,
                COUNT(*) AS calls
           FROM ai_usage
          WHERE account_id = @accountId AND created_at >= @fromIso
          GROUP BY bucket_index, category`,
      )
      .all({ accountId: input.accountId, fromIso }) as TsRow[];

    const map = new Map<string, TsRow>();
    const seen = new Set<UsageCategory>();
    for (const r of rows) {
      map.set(`${r.bucket_index}|${r.category}`, r);
      seen.add(r.category);
    }

    const buckets: string[] = [];
    for (let pos = 0; pos < positions; pos++) {
      const d = new Date((fromIndex + pos) * bucketSeconds * 1000);
      buckets.push(
        input.granularity === "minute"
          ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
          : `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:00`,
      );
    }

    // ponytail: only known categories are emitted; unknown ai_usage.category
    // values (none expected) would be counted in `totals` but not charted.
    const orderedCats = USAGE_BUCKETS.filter((b) => seen.has(b.category));
    const series = orderedCats.map(({ category, label }) => ({
      category,
      label,
      tokens: Array.from({ length: positions }, (_, pos) =>
        map.get(`${fromIndex + pos}|${category}`)?.tokens ?? 0),
      calls: Array.from({ length: positions }, (_, pos) =>
        map.get(`${fromIndex + pos}|${category}`)?.calls ?? 0),
    }));

    return {
      granularity: input.granularity,
      buckets,
      from: fromIso,
      to: this.now(),
      series,
      totals: {
        tokens: rows.reduce((s, r) => s + r.tokens, 0),
        calls: rows.reduce((s, r) => s + r.calls, 0),
      },
    };
  }
}
