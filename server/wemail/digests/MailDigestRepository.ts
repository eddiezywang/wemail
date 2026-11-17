import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_DIGEST_SCOPE,
  DEFAULT_DIGEST_SETTINGS,
  type MailDigestKind,
  type MailDigestRecord,
  type MailDigestResult,
  type MailDigestScope,
  type MailDigestScopeKind,
  type MailDigestSettings,
} from "../../../shared/wemail/digests.js";
import type { MailDatabase } from "../database/Database.js";

interface DigestSettingsRow {
  manual_enabled: number;
  manual_window_hours: number;
  inactivity_enabled: number;
  inactivity_hours: number;
  daily_enabled: number;
  daily_local_time: string;
  daily_window_mode: string;
  last_opened_at_ms: number | null;
  last_daily_digest_key: string | null;
}

interface DigestRow {
  public_id: string;
  account_public_id: string;
  digest_kind: MailDigestKind;
  scope_kind: MailDigestScopeKind;
  scope_key: string;
  window_start_ms: number;
  window_end_ms: number;
  item_count: number;
  result_json: string;
  model_id: string | null;
  created_at_ms: number;
}

export class MailDigestRepository {
  private readonly db: MailDatabase;
  private readonly now: () => string;

  constructor(options: { db: MailDatabase; now?: () => string }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  getSettings(): MailDigestSettings {
    const row = this.getSettingsRow("default");
    return row ? rowToSettings(row) : { ...DEFAULT_DIGEST_SETTINGS };
  }

  getSettingsForAccount(accountId: string): MailDigestSettings {
    const globalSettings = this.getSettings();
    const row = this.getSettingsRow(accountSettingsId(accountId));
    return {
      ...globalSettings,
      lastOpenedAt: iso(row?.last_opened_at_ms),
      lastDailyDigestDate: row?.last_daily_digest_key ?? null,
    };
  }

  saveAccountRuntimeState(
    accountId: string,
    runtime: Pick<MailDigestSettings, "lastOpenedAt" | "lastDailyDigestDate">,
  ): MailDigestSettings {
    const settings = this.getSettings();
    const current = this.getSettingsForAccount(accountId);
    this.upsertSettings({
      publicId: accountSettingsId(accountId),
      accountId,
      settings,
      lastOpenedAt: hasOwn(runtime, "lastOpenedAt")
        ? runtime.lastOpenedAt ?? null
        : current.lastOpenedAt ?? null,
      lastDailyDigestDate: hasOwn(runtime, "lastDailyDigestDate")
        ? runtime.lastDailyDigestDate ?? null
        : current.lastDailyDigestDate ?? null,
    });
    return this.getSettingsForAccount(accountId);
  }

  saveSettings(settings: MailDigestSettings): MailDigestSettings {
    this.upsertSettings({
      publicId: "default",
      settings,
      lastOpenedAt: settings.lastOpenedAt ?? null,
      lastDailyDigestDate: settings.lastDailyDigestDate ?? null,
    });
    return this.getSettings();
  }

  saveDigest(input: {
    accountId: string;
    kind: MailDigestKind;
    scopeKind?: MailDigestScopeKind;
    scopeKey?: string;
    windowStart: string;
    windowEnd: string;
    emailCount: number;
    result: MailDigestResult;
    model?: string | null;
  }): MailDigestRecord {
    const scope = normalizeScope(input);
    const resultJson = JSON.stringify(input.result);
    const windowStartMs = parseTime(input.windowStart);
    const windowEndMs = parseTime(input.windowEnd);
    const createdAtMs = parseTime(this.now());
    const contentHash = createHash("sha256")
      .update(`${input.accountId}\0${input.kind}\0${scope.scopeKind}\0${scope.scopeKey}\0${input.windowStart}\0${input.windowEnd}\0${resultJson}`)
      .digest("hex");
    this.db.prepare(`
      INSERT OR IGNORE INTO mail_digests (
        public_id, account_id, scope_kind, scope_key,
        folder_id, thread_id, category_id, tag_id,
        digest_kind, window_start_ms, window_end_ms,
        source_commit_version, source_content_hash, item_count,
        result_json, model_id, processor_version, created_at_ms
      )
      SELECT @publicId, accounts.id, @scopeKind, @scopeKey,
        NULL, NULL, NULL, NULL,
        @kind, @windowStartMs, @windowEndMs,
        (SELECT MAX(version) FROM db_commits), @contentHash, @emailCount,
        @resultJson, @model, 'digest-v1', @createdAtMs
      FROM mail_accounts accounts WHERE accounts.public_id = @accountId
    `).run({
      publicId: `digest-${randomUUID()}`,
      accountId: input.accountId,
      scopeKind: scope.scopeKind,
      scopeKey: scope.scopeKey,
      kind: input.kind,
      windowStartMs,
      windowEndMs,
      contentHash,
      emailCount: input.emailCount,
      resultJson,
      model: input.model ?? null,
      createdAtMs,
    });
    const digest = this.findByWindow(input);
    if (!digest) throw new Error("mail-digest-save-failed");
    return digest;
  }

  findByWindow(input: {
    accountId: string;
    kind: MailDigestKind;
    scopeKind?: MailDigestScopeKind;
    scopeKey?: string;
    windowStart: string;
    windowEnd: string;
  }): MailDigestRecord | null {
    const scope = normalizeScope(input);
    const row = this.db.prepare(`${digestSelect()}
      WHERE accounts.public_id = @accountId AND digests.digest_kind = @kind
        AND digests.scope_kind = @scopeKind AND digests.scope_key = @scopeKey
        AND digests.window_start_ms = @windowStartMs
        AND digests.window_end_ms = @windowEndMs
      LIMIT 1
    `).get({
      accountId: input.accountId,
      kind: input.kind,
      scopeKind: scope.scopeKind,
      scopeKey: scope.scopeKey,
      windowStartMs: parseTime(input.windowStart),
      windowEndMs: parseTime(input.windowEnd),
    }) as DigestRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  latest(accountId: string, scope?: Partial<MailDigestScope>, kind?: MailDigestKind): MailDigestRecord | null {
    const normalized = normalizeScope(scope);
    const row = this.db.prepare(`${digestSelect()}
      WHERE accounts.public_id = @accountId
        AND digests.scope_kind = @scopeKind AND digests.scope_key = @scopeKey
        AND (@kind IS NULL OR digests.digest_kind = @kind)
      ORDER BY digests.created_at_ms DESC, digests.window_end_ms DESC, digests.id DESC
      LIMIT 1
    `).get({ accountId, scopeKind: normalized.scopeKind, scopeKey: normalized.scopeKey, kind: kind ?? null }) as DigestRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(input: { accountId: string; scope?: Partial<MailDigestScope>; kind?: MailDigestKind; limit?: number }): MailDigestRecord[] {
    const normalized = normalizeScope(input.scope);
    const rows = this.db.prepare(`${digestSelect()}
      WHERE accounts.public_id = @accountId
        AND digests.scope_kind = @scopeKind AND digests.scope_key = @scopeKey
        AND (@kind IS NULL OR digests.digest_kind = @kind)
      ORDER BY digests.window_end_ms DESC, digests.created_at_ms DESC, digests.id DESC
      LIMIT @limit
    `).all({
      accountId: input.accountId,
      scopeKind: normalized.scopeKind,
      scopeKey: normalized.scopeKey,
      kind: input.kind ?? null,
      limit: Math.max(1, Math.min(100, input.limit ?? 20)),
    }) as DigestRow[];
    return rows.map(rowToRecord);
  }

  private getSettingsRow(publicId: string): DigestSettingsRow | undefined {
    return this.db.prepare(`SELECT manual_enabled, manual_window_hours,
      inactivity_enabled, inactivity_hours, daily_enabled, daily_local_time,
      daily_window_mode, last_opened_at_ms, last_daily_digest_key
      FROM mail_digest_settings WHERE public_id = ?`).get(publicId) as DigestSettingsRow | undefined;
  }

  private upsertSettings(input: {
    publicId: string;
    accountId?: string;
    settings: MailDigestSettings;
    lastOpenedAt: string | null;
    lastDailyDigestDate: string | null;
  }): void {
    const nowMs = parseTime(this.now());
    this.db.prepare(`
      INSERT INTO mail_digest_settings (
        public_id, account_id, manual_enabled, manual_window_hours,
        inactivity_enabled, inactivity_hours, daily_enabled,
        daily_local_time, daily_window_mode, last_opened_at_ms,
        last_daily_digest_key, created_at_ms, updated_at_ms, row_version
      ) VALUES (
        @publicId, (SELECT id FROM mail_accounts WHERE public_id = @accountId),
        @manualEnabled, @manualWindowHours, @inactivityEnabled, @inactivityHours,
        @dailyEnabled, @dailyTime, @dailyWindowMode, @lastOpenedAtMs,
        @lastDailyDigestDate, @nowMs, @nowMs, 1
      ) ON CONFLICT(public_id) DO UPDATE SET
        manual_enabled = excluded.manual_enabled,
        manual_window_hours = excluded.manual_window_hours,
        inactivity_enabled = excluded.inactivity_enabled,
        inactivity_hours = excluded.inactivity_hours,
        daily_enabled = excluded.daily_enabled,
        daily_local_time = excluded.daily_local_time,
        daily_window_mode = excluded.daily_window_mode,
        last_opened_at_ms = excluded.last_opened_at_ms,
        last_daily_digest_key = excluded.last_daily_digest_key,
        updated_at_ms = excluded.updated_at_ms,
        row_version = mail_digest_settings.row_version + 1
    `).run({
      publicId: input.publicId,
      accountId: input.accountId ?? null,
      manualEnabled: input.settings.manualEnabled ? 1 : 0,
      manualWindowHours: input.settings.manualWindowHours,
      inactivityEnabled: input.settings.inactivityEnabled ? 1 : 0,
      inactivityHours: input.settings.inactivityHours,
      dailyEnabled: input.settings.dailyEnabled ? 1 : 0,
      dailyTime: input.settings.dailyTime,
      dailyWindowMode: input.settings.dailyWindowMode,
      lastOpenedAtMs: input.lastOpenedAt ? parseTime(input.lastOpenedAt) : null,
      lastDailyDigestDate: input.lastDailyDigestDate,
      nowMs,
    });
  }
}

function digestSelect(): string {
  return `SELECT digests.public_id, accounts.public_id AS account_public_id,
    digests.digest_kind, digests.scope_kind, digests.scope_key,
    digests.window_start_ms, digests.window_end_ms, digests.item_count,
    digests.result_json, digests.model_id, digests.created_at_ms
    FROM mail_digests digests
    JOIN mail_accounts accounts ON accounts.id = digests.account_id`;
}

function rowToRecord(row: DigestRow): MailDigestRecord {
  return {
    id: row.public_id,
    accountId: row.account_public_id,
    kind: row.digest_kind,
    scopeKind: row.scope_kind,
    scopeKey: row.scope_key,
    windowStart: new Date(row.window_start_ms).toISOString(),
    windowEnd: new Date(row.window_end_ms).toISOString(),
    emailCount: row.item_count,
    result: JSON.parse(row.result_json) as MailDigestResult,
    model: row.model_id,
    createdAt: new Date(row.created_at_ms).toISOString(),
  };
}

function accountSettingsId(accountId: string): string { return `account:${accountId}`; }
function normalizeScope(scope?: Partial<MailDigestScope>): MailDigestScope {
  return { scopeKind: scope?.scopeKind ?? DEFAULT_DIGEST_SCOPE.scopeKind, scopeKey: scope?.scopeKey?.trim() || DEFAULT_DIGEST_SCOPE.scopeKey };
}
function hasOwn<T extends object, K extends PropertyKey>(value: T, key: K): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid-digest-time");
  return parsed;
}
function iso(value: number | null | undefined): string | null { return value == null ? null : new Date(value).toISOString(); }
function rowToSettings(row: DigestSettingsRow): MailDigestSettings {
  return {
    manualEnabled: row.manual_enabled === 1,
    manualWindowHours: row.manual_window_hours,
    inactivityEnabled: row.inactivity_enabled === 1,
    inactivityHours: row.inactivity_hours,
    dailyEnabled: row.daily_enabled === 1,
    dailyTime: row.daily_local_time,
    dailyWindowMode: row.daily_window_mode === "previous-daily-time" ? "previous-daily-time" : "day-start-to-now",
    lastOpenedAt: iso(row.last_opened_at_ms),
    lastDailyDigestDate: row.last_daily_digest_key,
  };
}
