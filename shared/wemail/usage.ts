export type UsageCategory =
  | "summary"
  | "agent_chat"
  | "compose"
  | "todo"
  | "translation"
  | "automation"
  | "other";

export interface AiUsageRecord {
  accountId: string;
  category: UsageCategory;
  processor: string;
  emailId?: string;
  inputTokens: number;
  outputTokens: number;
  model?: string;
  provider?: string;
  callerSource?: string;
  sessionId?: string;
  durationMs?: number;
  processorVersion?: number;
}

export interface AiUsageRecorder {
  record(input: AiUsageRecord): void | Promise<void>;
}

export type UsagePeriod = "30d" | "90d" | "180d" | "365d";

/** Time bucket granularity for throughput monitoring. */
export type UsageTimeseriesGranularity = "minute" | "hour";

/** One per-category series across a usage timeseries window. */
export interface UsageTimeseriesSeries {
  category: UsageCategory;
  label: string;
  /** tokens per bucket, aligned to `buckets`, zero-filled. */
  tokens: number[];
  /** call count per bucket, aligned to `buckets`, zero-filled. */
  calls: number[];
}

export interface UsageTimeseriesResult {
  granularity: UsageTimeseriesGranularity;
  /** ordered, zero-filled bucket labels (local time). */
  buckets: string[];
  from: string;
  to: string;
  series: UsageTimeseriesSeries[];
  totals: { tokens: number; calls: number };
}

/**
 * One AI usage row for a single email. The `ai_usage` table records every
 * AI call that carries an `email_id`, so retries and regenerations appear as
 * separate rows (newest first). Consumed by the per-mail token display in the
 * intelligence card.
 */
export interface EmailUsageRow {
  id: string;
  category: UsageCategory;
  processor: string;
  model: string | null;
  provider: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number | null;
  createdAt: string;
}

export interface UsageSummaryItem {
  category: UsageCategory;
  label: string;
  tokens: number;
  calls: number;
}

export type AgentSuggestionAction =
  | {
      type: "open_digest_center";
      filter?: "pending" | "attention" | "history";
    }
  | {
      type: "agent_prompt";
      prompt: string;
    }
  | {
      type: "open_compose";
      purpose: "weekly_report";
    }
  | {
      type: "open_settings";
      section: "ai-summary";
    };

export type AgentSemanticActionKind = "extracted" | "aggregate";

export interface AgentActionDiscovery {
  emailIds: string[];
  primaryWindow: "24h" | "7d";
  mailState: "unread";
}

export interface AgentActionScopeQuery {
  receivedWithin?: "24h" | "7d";
  mailState?: "unread" | "all";
  folder?: "inbox";
  category?: string;
  sender?: string;
  subject?: string;
  threadIds?: string[];
}

export type AgentActionScope =
  | {
      mode: "fixed";
      emailIds: string[];
    }
  | {
      mode: "query";
      query: AgentActionScopeQuery;
    };

export interface AccountSuggestionContext {
  digest: {
    state: "hidden" | "available" | "ready" | "needs-llm-settings";
    reason: "manual" | "inactivity" | "daily" | "none";
    emailCount: number;
  };
  summaryHealth: {
    failed: number;
    missing: number;
    invalid: number;
    pending: number;
    running: number;
    retryable: number;
  };
}

export interface AgentSuggestion {
  id: string;
  label: string;
  prompt: string;
  /** Exact account-owned messages that the suggested intent was derived from. */
  emailIds?: string[];
  action?: AgentSuggestionAction;
  kind?: AgentSemanticActionKind;
  discovery?: AgentActionDiscovery;
  executionScope?: AgentActionScope;
}

export interface AgentSuggestionResponse {
  suggestions: AgentSuggestion[];
  contextLine?: string;
  source?: "rules" | "cached-ai";
  candidateFingerprint?: string;
  refreshPending?: boolean;
}

export interface ListCategory {
  id: string;
  label: string;
  count: number;
}
