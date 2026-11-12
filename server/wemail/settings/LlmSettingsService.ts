import type { MailDatabase } from "../database/Database.js";
import type { SecretStore } from "../security/SecretStore.js";
import type { LlmReasoningEffort } from "../../../shared/wemail/settings.js";

export type LlmProvider = "openai" | "anthropic";

/**
 * 用户自定义 LLM 配置（主配置，永不被免费额度覆盖）。
 * freeTrial=false 时生效。
 */
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

/** 免费额度配置（独立存储，不覆盖自定义配置）。 */
export interface FreeTrialSettingsInput {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  expiresAt?: string;
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
  /** true = 当前生效的是免费额度（AI 调用走免费配置）。 */
  freeTrial: boolean;
  /** 免费额度信息（展示用，不含密钥）。 */
  freeTrialModel?: string;
  freeTrialExpiresAt?: string;
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
  /** true = 当前走免费额度配置。 */
  freeTrial?: boolean;
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
  free_trial_base_url: string | null;
  free_trial_model: string | null;
  free_trial_expires_at: string | null;
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
    // 仅当主密钥槽为空或被免费 Key 污染时才恢复；
    // 若用户已保存新的自定义 Key，保留现状不覆盖。
    if (!current || (freeKey !== undefined && current === freeKey)) {
      this.secrets.saveSecret(SECRET_KEY, legacyBackup);
    }
    this.secrets.deleteSecret(LEGACY_CUSTOM_KEY_BACKUP);
  }

  /** 当前配置视图：自定义配置为主，附免费额度状态与展示信息。 */
  get(): LlmSettingsView | null {
    const row = this.getRow();
    return row ? this.toView(row) : null;
  }

  /**
   * AI 运行配置：按当前生效模式返回。
   * free_trial=1 → 免费额度配置；否则 → 用户自定义配置。
   */
  getRuntimeSettings(): LlmRuntimeSettings | null {
    const row = this.getRow();
    if (!row) return null;
    if (row.free_trial === 1) {
      const apiKey = this.secrets.getSecret(FREE_TRIAL_SECRET_KEY);
      if (!apiKey || !row.free_trial_base_url || !row.free_trial_model) return null;
      return {
        provider: "openai",
        apiKey,
        baseUrl: row.free_trial_base_url,
        defaultModel: row.free_trial_model,
        freeTrial: true,
      };
    }
    const apiKey = this.secrets.getSecret(SECRET_KEY);
    if (!apiKey) return null;
    const settings: LlmRuntimeSettings = {
      provider: row.provider,
      apiKey,
      defaultModel: row.default_model,
      freeTrial: false,
    };
    if (row.base_url) settings.baseUrl = row.base_url;
    if (row.summary_model) settings.summaryModel = row.summary_model;
    if (row.draft_model) settings.draftModel = row.draft_model;
    if (row.agent_model) settings.agentModel = row.agent_model;
    if (row.reasoning_effort) settings.reasoningEffort = row.reasoning_effort;
    return settings;
  }

  /** 保存用户自定义配置（主配置）。不影响免费额度，并切回自定义生效。 */
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
      free_trial: 0,
      free_trial_base_url: existing?.free_trial_base_url ?? null,
      free_trial_model: existing?.free_trial_model ?? null,
      free_trial_expires_at: existing?.free_trial_expires_at ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO llm_settings (
           id, provider, base_url, default_model, summary_model, draft_model, agent_model, reasoning_effort,
           free_trial, free_trial_base_url, free_trial_model, free_trial_expires_at, created_at, updated_at
         ) VALUES (
           @id, @provider, @base_url, @default_model, @summary_model, @draft_model, @agent_model, @reasoning_effort,
           @free_trial, @free_trial_base_url, @free_trial_model, @free_trial_expires_at, @created_at, @updated_at
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

    return this.toView(row);
  }

  /**
   * 激活免费额度：免费配置单独存储，切回免费生效。
   * 用户自定义配置（主配置）原样保留，绝不被覆盖。
   */
  saveFreeTrial(input: FreeTrialSettingsInput): LlmSettingsView {
    const existing = this.getRow();
    const now = this.now();
    const row: LlmSettingsRow = {
      id: ROW_ID,
      provider: existing?.provider ?? "openai",
      base_url: existing?.base_url ?? null,
      default_model: existing?.default_model ?? "deepseek-v4-flash",
      summary_model: existing?.summary_model ?? null,
      draft_model: existing?.draft_model ?? null,
      agent_model: existing?.agent_model ?? null,
      reasoning_effort: existing?.reasoning_effort ?? null,
      free_trial: 1,
      free_trial_base_url: input.baseUrl,
      free_trial_model: input.defaultModel,
      free_trial_expires_at: input.expiresAt ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO llm_settings (
           id, provider, base_url, default_model, summary_model, draft_model, agent_model, reasoning_effort,
           free_trial, free_trial_base_url, free_trial_model, free_trial_expires_at, created_at, updated_at
         ) VALUES (
           @id, @provider, @base_url, @default_model, @summary_model, @draft_model, @agent_model, @reasoning_effort,
           @free_trial, @free_trial_base_url, @free_trial_model, @free_trial_expires_at, @created_at, @updated_at
         )
         ON CONFLICT(id) DO UPDATE SET
           free_trial = excluded.free_trial,
           free_trial_base_url = excluded.free_trial_base_url,
           free_trial_model = excluded.free_trial_model,
           free_trial_expires_at = excluded.free_trial_expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(row);

    this.secrets.saveSecret(FREE_TRIAL_SECRET_KEY, input.apiKey);

    return this.toView(row);
  }

  private getRow(): LlmSettingsRow | undefined {
    return this.db
      .prepare(
        `SELECT id, provider, base_url, default_model, summary_model, draft_model, agent_model, reasoning_effort,
                free_trial, free_trial_base_url, free_trial_model, free_trial_expires_at, created_at, updated_at
         FROM llm_settings
         WHERE id = ?`,
      )
      .get(ROW_ID) as LlmSettingsRow | undefined;
  }

  private toView(row: LlmSettingsRow): LlmSettingsView {
    const view: LlmSettingsView = {
      provider: row.provider,
      defaultModel: row.default_model,
      hasApiKey: !!this.secrets.getSecret(SECRET_KEY),
      freeTrial: row.free_trial === 1,
      updatedAt: row.updated_at,
    };
    if (row.base_url) view.baseUrl = row.base_url;
    if (row.summary_model) view.summaryModel = row.summary_model;
    if (row.draft_model) view.draftModel = row.draft_model;
    if (row.agent_model) view.agentModel = row.agent_model;
    if (row.reasoning_effort) view.reasoningEffort = row.reasoning_effort;
    if (row.free_trial_model) view.freeTrialModel = row.free_trial_model;
    if (row.free_trial_expires_at) view.freeTrialExpiresAt = row.free_trial_expires_at;
    return view;
  }
}
