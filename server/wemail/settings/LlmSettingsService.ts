import type { MailDatabase } from "../database/Database.js";
import type { SecretStore } from "../security/SecretStore.js";
import type { LlmReasoningEffort } from "../../../shared/wemail/settings.js";

export type LlmProvider = "openai" | "anthropic";

/** 用户自定义 LLM 配置。 */
export interface LlmSettingsInput {
  provider: LlmProvider;
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
  summaryModel?: string;
  draftModel?: string;
  agentModel?: string;
  reasoningEffort?: LlmReasoningEffort;
}

export interface LlmSettingsView {
  /** 用户自定义配置（主配置，始终完整返回，供表单恢复）。 */
  provider: LlmProvider;
  baseUrl?: string;
  defaultModel: string;
  summaryModel?: string;
  draftModel?: string;
  agentModel?: string;
  reasoningEffort?: LlmReasoningEffort;
  hasApiKey: boolean;
  updatedAt: string;
}

export interface LlmRuntimeSettings {
  provider: LlmProvider;
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
  summaryModel?: string;
  draftModel?: string;
  agentModel?: string;
  reasoningEffort?: LlmReasoningEffort;
}

interface LlmSettingsRow {
  id: string;
  provider: LlmProvider;
  base_url: string | null;
  default_model: string;
  summary_model: string | null;
  draft_model: string | null;
  agent_model: string | null;
  reasoning_effort: LlmReasoningEffort | null;
  free_trial: number;
  created_at: string;
  updated_at: string;
}

const ROW_ID = "default";
/** 用户自定义 API Key（主配置密钥）。 */
const SECRET_KEY = "wemail:settings:llm:api-key";
/** 免费额度 API Key（独立密钥，与自定义互不影响）。 */
const FREE_TRIAL_SECRET_KEY = "wemail:settings:llm:api-key:free-trial";
/** 旧版（备份方案）遗留的用户自定义 Key 备份槽。 */
const LEGACY_CUSTOM_KEY_BACKUP = "wemail:settings:llm:api-key:custom-backup";

export class LlmSettingsService {
  private readonly db: MailDatabase;
  private readonly secrets: SecretStore;
  private readonly now: () => string;

  constructor(options: {
    db: MailDatabase;
    secrets: SecretStore;
    now?: () => string;
  }) {
    this.db = options.db;
    this.secrets = options.secrets;
    this.now = options.now ?? (() => new Date().toISOString());
    this.migrateLegacyCustomKey();
  }

  /**
   * 一次性迁移：旧版（备份方案）在激活免费额度时把免费 Key 写进了主密钥槽
   * （SECRET_KEY），用户自定义 Key 被存到 LEGACY_CUSTOM_KEY_BACKUP。
   * 恢复自定义 Key 到主密钥槽，切回自定义模型时无需重新输入。
   */
  private migrateLegacyCustomKey(): void {
    const legacyBackup = this.secrets.getSecret(LEGACY_CUSTOM_KEY_BACKUP);
    if (!legacyBackup) return;
    const current = this.secrets.getSecret(SECRET_KEY);
    const freeKey = this.secrets.getSecret(FREE_TRIAL_SECRET_KEY);
    // 无法辨认主槽的密钥时，保留备份，避免不可逆地丢失用户凭据。
    if (current && !freeKey) return;
    // 仅当主密钥槽为空或被免费 Key 污染时才恢复；
    // 若用户已保存新的自定义 Key，保留现状不覆盖。
    if (!current || (freeKey !== undefined && current === freeKey)) {
      this.secrets.saveSecret(SECRET_KEY, legacyBackup);
    }
    this.secrets.deleteSecret(LEGACY_CUSTOM_KEY_BACKUP);
  }

  /** 当前用户自定义配置视图。 */
  get(): LlmSettingsView | null {
    const row = this.getRow();
    return row ? this.toView(row) : null;
  }

  isRetiredKey(key: string): boolean {
    const oldFreeKey = this.secrets.getSecret(FREE_TRIAL_SECRET_KEY);
    return !!oldFreeKey && key === oldFreeKey;
  }

  /**
   * 旧免费额度已下线，只返回用户自定义配置。
   */
  getRuntimeSettings(): LlmRuntimeSettings | null {
    const row = this.getRow();
    if (!row) return null;
    const apiKey = this.secrets.getSecret(SECRET_KEY);
    // 旧版可能把免费 Key 写入主槽；不要把它当成用户自己的 Key。
    if (!apiKey || this.isUntrustedLegacyKey(row, apiKey)) return null;
    const settings: LlmRuntimeSettings = {
      provider: row.provider,
      apiKey,
      defaultModel: row.default_model,
    };
    if (row.base_url) settings.baseUrl = row.base_url;
    if (row.summary_model) settings.summaryModel = row.summary_model;
    if (row.draft_model) settings.draftModel = row.draft_model;
    if (row.agent_model) settings.agentModel = row.agent_model;
    if (row.reasoning_effort) settings.reasoningEffort = row.reasoning_effort;
    return settings;
  }

  /** 保存用户自定义配置。 */
  save(input: LlmSettingsInput): LlmSettingsView {
    const existing = this.getRow();
    const now = this.now();
    const row: LlmSettingsRow = {
      id: ROW_ID,
      provider: input.provider,
      base_url: input.baseUrl ?? null,
      default_model: input.defaultModel,
      summary_model: input.summaryModel ?? null,
      draft_model: input.draftModel ?? null,
      agent_model: input.agentModel ?? null,
      reasoning_effort: input.reasoningEffort ?? existing?.reasoning_effort ?? null,
      // 保留旧标记直到用户提供新密钥，避免保存其他字段后误用旧免费密钥。
      free_trial: existing && !input.apiKey && this.isUntrustedLegacyKey(existing, this.secrets.getSecret(SECRET_KEY)) ? 1 : 0,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    // Apply the database write before replacing the secret, but do not commit
    // it until the secret write succeeds. A database write failure therefore
    // cannot pair a new credential with the previous endpoint, and a secret
    // write failure rolls back the legacy-key guard and other settings. The
    // stores still cannot be atomic if the process or SQLite commit fails.
    this.db.transaction(() => {
      this.db
        .prepare(
        `INSERT INTO llm_settings (
           id, provider, base_url, default_model, summary_model, draft_model, agent_model, reasoning_effort,
           free_trial, created_at, updated_at
         ) VALUES (
           @id, @provider, @base_url, @default_model, @summary_model, @draft_model, @agent_model, @reasoning_effort,
           @free_trial, @created_at, @updated_at
         )
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           base_url = excluded.base_url,
           default_model = excluded.default_model,
           summary_model = excluded.summary_model,
           draft_model = excluded.draft_model,
           agent_model = excluded.agent_model,
           reasoning_effort = excluded.reasoning_effort,
           free_trial = excluded.free_trial,
           updated_at = excluded.updated_at`,
        )
        .run(row);
      if (input.apiKey !== undefined) {
        this.secrets.saveSecret(SECRET_KEY, input.apiKey);
      }
    })();

    return this.toView(row);
  }

  private getRow(): LlmSettingsRow | undefined {
    return this.db
      .prepare(
        `SELECT id, provider, base_url, default_model, summary_model, draft_model, agent_model, reasoning_effort,
                free_trial, created_at, updated_at
         FROM llm_settings
         WHERE id = ?`,
      )
      .get(ROW_ID) as LlmSettingsRow | undefined;
  }

  private isUntrustedLegacyKey(row: LlmSettingsRow, key: string | undefined): boolean {
    if (!key) return false;
    const oldFreeKey = this.secrets.getSecret(FREE_TRIAL_SECRET_KEY);
    if (oldFreeKey && key === oldFreeKey) return true;
    return row.free_trial === 1 && !oldFreeKey;
  }

  private toView(row: LlmSettingsRow): LlmSettingsView {
    const key = this.secrets.getSecret(SECRET_KEY);
    const view: LlmSettingsView = {
      provider: row.provider,
      defaultModel: row.default_model,
      hasApiKey: !!key && !this.isUntrustedLegacyKey(row, key),
      updatedAt: row.updated_at,
    };
    if (row.base_url) view.baseUrl = row.base_url;
    if (row.summary_model) view.summaryModel = row.summary_model;
    if (row.draft_model) view.draftModel = row.draft_model;
    if (row.agent_model) view.agentModel = row.agent_model;
    if (row.reasoning_effort) view.reasoningEffort = row.reasoning_effort;
    return view;
  }
}
