export type MailDigestKind = "manual" | "inactivity" | "daily";
export type MailDigestScopeKind = "folder" | "view";
export type DailyDigestWindowMode = "day-start-to-now" | "previous-daily-time";

export interface MailDigestScope {
  scopeKind: MailDigestScopeKind;
  scopeKey: string;
}

export const DEFAULT_DIGEST_SCOPE: MailDigestScope = {
  scopeKind: "folder",
  scopeKey: "INBOX",
};

export interface MailDigestSettings {
  manualEnabled: boolean;
  manualWindowHours: number;
  inactivityEnabled: boolean;
  inactivityHours: number;
  dailyEnabled: boolean;
  dailyTime: string;
  dailyWindowMode: DailyDigestWindowMode;
  lastOpenedAt?: string | null;
  lastDailyDigestDate?: string | null;
}

export const DEFAULT_DIGEST_SETTINGS: MailDigestSettings = {
  manualEnabled: true,
  manualWindowHours: 8,
  inactivityEnabled: true,
  inactivityHours: 8,
  dailyEnabled: false,
  dailyTime: "18:00",
  dailyWindowMode: "day-start-to-now",
  lastOpenedAt: null,
  lastDailyDigestDate: null,
};

export interface MailDigestTheme {
  title: string;
  summary: string;
  emailIds: string[];
  count: number;
}

export interface MailDigestActionItem {
  text: string;
  priority: "low" | "normal" | "high";
  emailIds: string[];
}

export interface MailDigestResult {
  type: "mailDigest";
  overview: string[];
  themes: MailDigestTheme[];
  actionItems: MailDigestActionItem[];
  stats: {
    totalEmails: number;
    includedEmails: number;
    truncated: boolean;
  };
}

export interface MailDigestRecord {
  id: string;
  accountId: string;
  kind: MailDigestKind;
  scopeKind: MailDigestScopeKind;
  scopeKey: string;
  windowStart: string;
  windowEnd: string;
  emailCount: number;
  result: MailDigestResult;
  model?: string | null;
  createdAt: string;
}

export type MailDigestStatusReason = "manual" | "inactivity" | "daily" | "none";

export interface MailDigestStatus {
  state: "hidden" | "available" | "ready" | "needs-llm-settings";
  reason: MailDigestStatusReason;
  scopeKind?: MailDigestScopeKind;
  scopeKey?: string;
  windowStart?: string;
  windowEnd?: string;
  emailCount: number;
  digest?: MailDigestRecord | null;
}

export interface GenerateMailDigestRequest {
  accountId: string;
  kind: MailDigestKind;
  scopeKind?: MailDigestScopeKind;
  scopeKey?: string;
  windowStart?: string;
  windowEnd?: string;
}
