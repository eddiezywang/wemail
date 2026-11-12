import { createHash, randomUUID } from "node:crypto";
import type {
  AutomationAction,
  AutomationConditionMode,
  AutomationConditionRule,
  AutomationConditions,
  AutomationProcessing,
  AutomationRule,
  AutomationTrigger,
  AutomationRuleV2,
} from "../../../shared/wemail/automation.js";
import type { MailDatabase } from "../database/Database.js";

interface AutomationRuleRow {
  id: string;
  account_id: string;
  name: string;
  enabled: number;
  conditions_json: string;
  actions_json: string;
  trigger_json: string | null;
  natural_language_condition: string | null;
  condition_mode: string | null;
  condition_rules_json: string | null;
  processing_json: string | null;
  created_at: string;
  updated_at: string;
  schema_version?: number; current_version?: number; description?: string | null;
  pipeline_json?: string | null; authorization_json?: string | null; capability_snapshots_json?: string | null;
  skill_snapshots_json?: string | null;
  data_selection_recipe_json?: string | null;
  analysis_recipe_json?: string | null;
  artifact_recipe_json?: string | null;
  delivery_plan_json?: string | null;
  accepted_reviews_json?: string | null;
  compiled_pipeline_hash?: string | null;
  owner_type?: "account" | "local_profile";
  owner_profile_id?: string | null;
  account_scope_json?: string | null;
  template_id?: string | null;
  template_version?: string | null;
  template_hash?: string | null;
  result_schema_id?: string | null;
  result_schema_version?: string | null;
  renderer_id?: string | null;
  renderer_version?: string | null;
  archived_at?: string | null;
}

export type AutomationRunStatus =
  | "matched"
  | "applied"
  | "skipped"
  | "evaluation_failed"
  | "failed";

export type AutomationActionRunResult = Record<string, unknown>;

export interface AutomationRuleRunSummary {
  id: string;
  ruleId: string;
  accountId: string;
  dryRun: boolean;
  matchedCount: number;
  appliedCount: number;
  triggerKind?: string;
  status?: AutomationRunStatus;
  actionResults: AutomationActionRunResult[];
  createdAt: string;
}

export class AutomationRuleRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  create(input: {
    accountId: string;
    name: string;
    enabled?: boolean;
    trigger?: AutomationTrigger;
    naturalLanguageCondition?: string;
    conditions: AutomationConditions;
    conditionMode?: AutomationConditionMode;
    conditionRules?: AutomationConditionRule[];
    processing?: AutomationProcessing;
    actions: AutomationAction[];
  }): AutomationRule {
    const now = this.now();
    const id = `rule-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO automation_rules (
           id, account_id, name, enabled, conditions_json, actions_json,
           trigger_json, natural_language_condition, condition_mode,
           condition_rules_json, processing_json, created_at, updated_at
         ) VALUES (
           @id, @accountId, @name, @enabled, @conditions, @actions,
           @trigger, @naturalLanguageCondition, @conditionMode,
           @conditionRules, @processing, @now, @now
         )`,
      )
      .run({
        id,
        accountId: input.accountId,
        name: input.name,
        enabled: input.enabled === false ? 0 : 1,
        conditions: JSON.stringify(input.conditions),
        actions: JSON.stringify(input.actions),
        trigger: JSON.stringify(input.trigger ?? defaultTrigger()),
        naturalLanguageCondition: normalizeOptionalString(input.naturalLanguageCondition),
        conditionMode: normalizeConditionMode(input.conditionMode),
        conditionRules: JSON.stringify(input.conditionRules ?? []),
        processing: input.processing ? JSON.stringify(input.processing) : null,
        now,
      });
    const rule = this.get(id);
    if (!rule) throw new Error("automation rule insert failed");
    return rule;
  }

  createV2(input: Omit<AutomationRuleV2, "id" | "version" | "createdAt" | "updatedAt">): AutomationRuleV2 {
    const id = `rule-${randomUUID()}`;
    const now = this.now();
    const rule: AutomationRuleV2 = { ...input, schemaVersion: 2, id, version: 1, createdAt: now, updatedAt: now };
    const hash = ruleVersionHash(rule);
    const transaction = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO automation_rules (
        id, account_id, name, enabled, conditions_json, actions_json, trigger_json,
        natural_language_condition, condition_mode, condition_rules_json, processing_json,
        schema_version, current_version, description, pipeline_json, authorization_json,
        capability_snapshots_json, skill_snapshots_json, data_selection_recipe_json,
        analysis_recipe_json, artifact_recipe_json, delivery_plan_json,
        accepted_reviews_json, compiled_pipeline_hash, created_at, updated_at
        , owner_type, owner_profile_id, account_scope_json, template_id,
        template_version, template_hash, result_schema_id, result_schema_version,
        renderer_id, renderer_version, archived_at
      ) VALUES (
        @id, @accountId, @name, @enabled, @conditions, @actions, @trigger,
        @naturalLanguageCondition, @conditionMode, @conditionRules, @processing,
        2, 1, @description, @pipeline, @authorization, @capabilitySnapshots,
        @skillSnapshots, @dataSelectionRecipe, @analysisRecipe, @artifactRecipe,
        @deliveryPlan, @acceptedReviews, @compiledPipelineHash, @now, @now,
        @ownerType, @ownerProfileId, @accountScope, @templateId,
        @templateVersion, @templateHash, @resultSchemaId, @resultSchemaVersion,
        @rendererId, @rendererVersion, NULL
      )`)
        .run({
          id,
          accountId: input.accountId,
          name: input.name,
          enabled: input.enabled ? 1 : 0,
          conditions: JSON.stringify(input.conditions),
          actions: "[]",
          trigger: JSON.stringify(input.trigger),
          naturalLanguageCondition: input.naturalLanguageCondition ?? null,
          conditionMode: input.conditionMode ?? null,
          conditionRules: JSON.stringify(input.conditionRules ?? []),
          processing: input.collection ? JSON.stringify(input.collection) : null,
          description: input.description ?? null,
          pipeline: JSON.stringify(input.pipeline),
          authorization: JSON.stringify(input.authorization),
          capabilitySnapshots: JSON.stringify(input.capabilitySnapshots),
          skillSnapshots: JSON.stringify(input.skillSnapshots ?? []),
          dataSelectionRecipe: input.dataSelectionRecipe
            ? JSON.stringify(input.dataSelectionRecipe)
            : null,
          analysisRecipe: input.analysisRecipe
            ? JSON.stringify(input.analysisRecipe)
            : null,
          artifactRecipe: input.artifactRecipe
            ? JSON.stringify(input.artifactRecipe)
            : null,
          deliveryPlan: input.deliveryPlan
            ? JSON.stringify(input.deliveryPlan)
            : null,
          acceptedReviews: JSON.stringify(input.acceptedReviews ?? []),
          compiledPipelineHash: input.compiledPipelineHash ?? null,
          ownerType: input.owner?.type === "localProfile" ? "local_profile" : "account",
          ownerProfileId:
            input.owner?.type === "localProfile" ? input.owner.profileId : null,
          accountScope: input.accountScope
            ? JSON.stringify(input.accountScope)
            : JSON.stringify({
                type: "currentAccount",
                accountId: input.accountId,
              }),
          templateId: input.templateBinding?.templateId ?? null,
          templateVersion: input.templateBinding?.templateVersion ?? null,
          templateHash: input.templateBinding?.templateHash ?? null,
          resultSchemaId: input.templateBinding?.resultSchemaId ?? null,
          resultSchemaVersion:
            input.templateBinding?.resultSchemaVersion?.toString() ?? null,
          rendererId: input.templateBinding?.rendererId ?? null,
          rendererVersion: input.templateBinding?.rendererVersion ?? null,
          now,
        });
      this.db.prepare(`INSERT INTO automation_rule_versions (
        rule_id, version, account_id, schema_version, rule_json, rule_hash,
        created_at, owner_type, owner_profile_id, account_scope_json,
        template_id, template_version, template_hash, result_schema_id,
        result_schema_version, renderer_id, renderer_version
      ) VALUES (?, 1, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        input.accountId,
        JSON.stringify(rule),
        hash,
        now,
        input.owner?.type === "localProfile" ? "local_profile" : "account",
        input.owner?.type === "localProfile" ? input.owner.profileId : null,
        input.accountScope
          ? JSON.stringify(input.accountScope)
          : JSON.stringify({
              type: "currentAccount",
              accountId: input.accountId,
            }),
        input.templateBinding?.templateId ?? null,
        input.templateBinding?.templateVersion ?? null,
        input.templateBinding?.templateHash ?? null,
        input.templateBinding?.resultSchemaId ?? null,
        input.templateBinding?.resultSchemaVersion?.toString() ?? null,
        input.templateBinding?.rendererId ?? null,
        input.templateBinding?.rendererVersion ?? null,
      );
    });
    transaction();
    return rule;
  }

  replaceV2(
    id: string,
    input: Omit<
      AutomationRuleV2,
      "id" | "version" | "createdAt" | "updatedAt"
    >,
    expectedVersion: number,
  ): AutomationRuleV2 {
    const existing = this.getV2(id);
    if (!existing) throw new Error("automation-rule-not-found");
    if (existing.version !== expectedVersion) {
      throw new Error("automation-rule-version-conflict");
    }
    const now = this.now();
    const version = existing.version + 1;
    const rule: AutomationRuleV2 = {
      ...input,
      schemaVersion: 2,
      id,
      version,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
    const ruleHash = ruleVersionHash(rule);
    this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE automation_rules SET
        account_id = @accountId, name = @name, enabled = @enabled,
        conditions_json = @conditions, trigger_json = @trigger,
        natural_language_condition = @naturalLanguageCondition,
        condition_mode = @conditionMode, condition_rules_json = @conditionRules,
        processing_json = @processing, current_version = @version,
        description = @description, pipeline_json = @pipeline,
        authorization_json = @authorization,
        capability_snapshots_json = @capabilitySnapshots,
        skill_snapshots_json = @skillSnapshots,
        data_selection_recipe_json = @dataSelectionRecipe,
        analysis_recipe_json = @analysisRecipe,
        artifact_recipe_json = @artifactRecipe,
        delivery_plan_json = @deliveryPlan,
        accepted_reviews_json = @acceptedReviews,
        compiled_pipeline_hash = @compiledPipelineHash,
        owner_type = @ownerType, owner_profile_id = @ownerProfileId,
        account_scope_json = @accountScope, template_id = @templateId,
        template_version = @templateVersion, template_hash = @templateHash,
        result_schema_id = @resultSchemaId,
        result_schema_version = @resultSchemaVersion,
        renderer_id = @rendererId, renderer_version = @rendererVersion,
        updated_at = @updatedAt
        WHERE id = @id AND schema_version = 2 AND current_version = @expectedVersion`)
        .run({
          id,
          expectedVersion,
          version,
          accountId: input.accountId,
          name: input.name,
          enabled: input.enabled ? 1 : 0,
          conditions: JSON.stringify(input.conditions),
          trigger: JSON.stringify(input.trigger),
          naturalLanguageCondition: input.naturalLanguageCondition ?? null,
          conditionMode: input.conditionMode ?? null,
          conditionRules: JSON.stringify(input.conditionRules ?? []),
          processing: input.collection ? JSON.stringify(input.collection) : null,
          description: input.description ?? null,
          pipeline: JSON.stringify(input.pipeline),
          authorization: JSON.stringify(input.authorization),
          capabilitySnapshots: JSON.stringify(input.capabilitySnapshots),
          skillSnapshots: JSON.stringify(input.skillSnapshots ?? []),
          dataSelectionRecipe: input.dataSelectionRecipe
            ? JSON.stringify(input.dataSelectionRecipe)
            : null,
          analysisRecipe: input.analysisRecipe
            ? JSON.stringify(input.analysisRecipe)
            : null,
          artifactRecipe: input.artifactRecipe
            ? JSON.stringify(input.artifactRecipe)
            : null,
          deliveryPlan: input.deliveryPlan
            ? JSON.stringify(input.deliveryPlan)
            : null,
          acceptedReviews: JSON.stringify(input.acceptedReviews ?? []),
          compiledPipelineHash: input.compiledPipelineHash ?? null,
          ownerType:
            input.owner?.type === "localProfile"
              ? "local_profile"
              : "account",
          ownerProfileId:
            input.owner?.type === "localProfile" ? input.owner.profileId : null,
          accountScope: JSON.stringify(
            input.accountScope ?? {
              type: "currentAccount",
              accountId: input.accountId,
            },
          ),
          templateId: input.templateBinding?.templateId ?? null,
          templateVersion: input.templateBinding?.templateVersion ?? null,
          templateHash: input.templateBinding?.templateHash ?? null,
          resultSchemaId: input.templateBinding?.resultSchemaId ?? null,
          resultSchemaVersion:
            input.templateBinding?.resultSchemaVersion?.toString() ?? null,
          rendererId: input.templateBinding?.rendererId ?? null,
          rendererVersion: input.templateBinding?.rendererVersion ?? null,
          updatedAt: now,
        });
      if (result.changes !== 1) {
        throw new Error("automation-rule-version-conflict");
      }
      this.db.prepare(`INSERT INTO automation_rule_versions (
        rule_id, version, account_id, schema_version, rule_json, rule_hash,
        created_at, owner_type, owner_profile_id, account_scope_json,
        template_id, template_version, template_hash, result_schema_id,
        result_schema_version, renderer_id, renderer_version
      ) VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        version,
        input.accountId,
        JSON.stringify(rule),
        ruleHash,
        now,
        input.owner?.type === "localProfile" ? "local_profile" : "account",
        input.owner?.type === "localProfile" ? input.owner.profileId : null,
        JSON.stringify(
          input.accountScope ?? {
            type: "currentAccount",
            accountId: input.accountId,
          },
        ),
        input.templateBinding?.templateId ?? null,
        input.templateBinding?.templateVersion ?? null,
        input.templateBinding?.templateHash ?? null,
        input.templateBinding?.resultSchemaId ?? null,
        input.templateBinding?.resultSchemaVersion?.toString() ?? null,
        input.templateBinding?.rendererId ?? null,
        input.templateBinding?.rendererVersion ?? null,
      );
    })();
    return rule;
  }

  getV2(id: string): AutomationRuleV2 | null {
    const row = this.db.prepare("SELECT * FROM automation_rules WHERE id = ? AND schema_version = 2").get(id) as AutomationRuleRow | undefined;
    return row ? rowToRuleV2(row) : null;
  }

  listV2(accountId: string): AutomationRuleV2[] {
    return (this.db.prepare("SELECT * FROM automation_rules WHERE account_id = ? AND schema_version = 2 AND archived_at IS NULL ORDER BY created_at ASC").all(accountId) as AutomationRuleRow[]).map(rowToRuleV2);
  }

  get(id: string): AutomationRule | null {
    const row = this.db
      .prepare("SELECT * FROM automation_rules WHERE id = ? AND schema_version = 1")
      .get(id) as AutomationRuleRow | undefined;
    return row ? rowToRule(row) : null;
  }

  list(accountId?: string): AutomationRule[] {
    const rows = accountId
      ? this.db
          .prepare("SELECT * FROM automation_rules WHERE account_id = ? AND schema_version = 1 ORDER BY created_at ASC")
          .all(accountId)
      : this.db.prepare("SELECT * FROM automation_rules WHERE schema_version = 1 ORDER BY created_at ASC").all();
    return (rows as AutomationRuleRow[]).map(rowToRule);
  }

  update(id: string, patch: {
    name?: string;
    enabled?: boolean;
    trigger?: AutomationTrigger;
    naturalLanguageCondition?: string;
    conditions?: AutomationConditions;
    conditionMode?: AutomationConditionMode;
    conditionRules?: AutomationConditionRule[];
    processing?: AutomationProcessing;
    actions?: AutomationAction[];
  }): AutomationRule | null {
    const existing = this.get(id);
    if (!existing) return null;
    const updated = {
      name: patch.name ?? existing.name,
      enabled: patch.enabled ?? existing.enabled,
      trigger: patch.trigger ?? existing.trigger,
      naturalLanguageCondition:
        patch.naturalLanguageCondition ?? existing.naturalLanguageCondition,
      conditions: patch.conditions ?? existing.conditions,
      conditionMode: patch.conditionMode ?? existing.conditionMode,
      conditionRules: patch.conditionRules ?? existing.conditionRules,
      processing: patch.processing ?? existing.processing,
      actions: patch.actions ?? existing.actions,
      updatedAt: this.now(),
    };
    this.db
      .prepare(
        `UPDATE automation_rules SET
           name = @name,
           enabled = @enabled,
           conditions_json = @conditions,
           actions_json = @actions,
           trigger_json = @trigger,
           natural_language_condition = @naturalLanguageCondition,
           condition_mode = @conditionMode,
           condition_rules_json = @conditionRules,
           processing_json = @processing,
           updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        name: updated.name,
        enabled: updated.enabled ? 1 : 0,
        conditions: JSON.stringify(updated.conditions),
        actions: JSON.stringify(updated.actions),
        trigger: JSON.stringify(updated.trigger),
        naturalLanguageCondition: normalizeOptionalString(
          updated.naturalLanguageCondition,
        ),
        conditionMode: normalizeConditionMode(updated.conditionMode),
        conditionRules: JSON.stringify(updated.conditionRules ?? []),
        processing: updated.processing ? JSON.stringify(updated.processing) : null,
        updatedAt: updated.updatedAt,
      });
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM automation_rules WHERE id = ?").run(id);
    return result.changes > 0;
  }

  hasRun(ruleId: string, triggerKey: string): boolean {
    const row = this.db
      .prepare(
        "SELECT id FROM automation_rule_runs WHERE rule_id = ? AND trigger_key = ? LIMIT 1",
      )
      .get(ruleId, triggerKey) as { id: string } | undefined;
    return !!row;
  }

  logRun(input: {
    ruleId: string;
    accountId: string;
    dryRun: boolean;
    matchedCount: number;
    appliedCount: number;
    triggerKind?: string;
    triggerKey?: string;
    status?: AutomationRunStatus;
    actionResults?: AutomationActionRunResult[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO automation_rule_runs (
           id, rule_id, account_id, dry_run, matched_count, applied_count,
           trigger_kind, trigger_key, status, action_results_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(rule_id, trigger_key) DO NOTHING`,
      )
      .run(
        `rule-run-${randomUUID()}`,
        input.ruleId,
        input.accountId,
        input.dryRun ? 1 : 0,
        input.matchedCount,
        input.appliedCount,
        input.triggerKind ?? null,
        input.triggerKey ?? null,
        input.status ?? null,
        input.actionResults ? JSON.stringify(input.actionResults) : null,
        this.now(),
      );
  }

  listRuns(accountId: string, limit = 100): AutomationRuleRunSummary[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT id, rule_id, account_id, dry_run, matched_count, applied_count,
                trigger_kind, status, action_results_json, created_at
         FROM automation_rule_runs
         WHERE account_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(accountId, boundedLimit) as Array<{
        id: string;
        rule_id: string;
        account_id: string;
        dry_run: number;
        matched_count: number;
        applied_count: number;
        trigger_kind: string | null;
        status: AutomationRunStatus | null;
        action_results_json: string | null;
        created_at: string;
      }>;
    return rows.map((row) => ({
      id: row.id,
      ruleId: row.rule_id,
      accountId: row.account_id,
      dryRun: row.dry_run === 1,
      matchedCount: row.matched_count,
      appliedCount: row.applied_count,
      triggerKind: row.trigger_kind ?? undefined,
      status: row.status ?? undefined,
      actionResults: parseRunResults(row.action_results_json),
      createdAt: row.created_at,
    }));
  }
}

function defaultTrigger(): AutomationTrigger {
  return { type: "manual" };
}

function parseTrigger(value: string | null | undefined): AutomationTrigger {
  if (!value) return defaultTrigger();
  try {
    const parsed = JSON.parse(value) as AutomationTrigger;
    if (parsed && typeof parsed === "object" && "type" in parsed) {
      return parsed;
    }
  } catch {
    return defaultTrigger();
  }
  return defaultTrigger();
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeConditionMode(value: AutomationConditionMode | undefined): string | null {
  return value === "all" || value === "any" ? value : null;
}

function parseConditionMode(value: string | null | undefined): AutomationConditionMode | undefined {
  return value === "all" || value === "any" ? value : undefined;
}

function parseConditionRules(value: string | null | undefined): AutomationConditionRule[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(isConditionRule);
    }
  } catch {
    return [];
  }
  return [];
}

function isConditionRule(value: unknown): value is AutomationConditionRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    isConditionField(row.field) &&
    isConditionOperator(row.operator) &&
    (row.value === undefined ||
      typeof row.value === "string" ||
      typeof row.value === "boolean")
  );
}

function isConditionField(value: unknown): value is AutomationConditionRule["field"] {
  return (
    value === "sender" ||
    value === "recipient" ||
    value === "cc" ||
    value === "subject" ||
    value === "body" ||
    value === "hasAttachment" ||
    value === "aiTag"
  );
}

function isConditionOperator(value: unknown): value is AutomationConditionRule["operator"] {
  return (
    value === "contains" ||
    value === "notContains" ||
    value === "equals" ||
    value === "notEquals" ||
    value === "exists" ||
    value === "notExists"
  );
}

function rowToRule(row: AutomationRuleRow): AutomationRule {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    enabled: !!row.enabled,
    trigger: parseTrigger(row.trigger_json),
    naturalLanguageCondition: row.natural_language_condition ?? undefined,
    conditions: JSON.parse(row.conditions_json) as AutomationConditions,
    conditionMode: parseConditionMode(row.condition_mode),
    conditionRules: parseConditionRules(row.condition_rules_json),
    processing: parseProcessing(row.processing_json),
    actions: JSON.parse(row.actions_json) as AutomationAction[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseProcessing(value: string | null | undefined): AutomationProcessing | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as AutomationProcessing;
    return parsed && (parsed.mode === "perMessage" || parsed.mode === "collection")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function rowToRuleV2(row: AutomationRuleRow): AutomationRuleV2 {
  return {
    schemaVersion: 2,
    id: row.id,
    version: row.current_version ?? 1,
    accountId: row.account_id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: !!row.enabled,
    trigger: parseTrigger(row.trigger_json),
    naturalLanguageCondition: row.natural_language_condition ?? undefined,
    conditions: JSON.parse(row.conditions_json) as AutomationConditions,
    conditionMode: parseConditionMode(row.condition_mode),
    conditionRules: parseConditionRules(row.condition_rules_json),
    collection: parseProcessing(row.processing_json),
    pipeline: JSON.parse(row.pipeline_json ?? "[]") as AutomationRuleV2["pipeline"],
    authorization: JSON.parse(row.authorization_json ?? '{"capabilities":[]}') as AutomationRuleV2["authorization"],
    capabilitySnapshots: JSON.parse(row.capability_snapshots_json ?? "[]") as AutomationRuleV2["capabilitySnapshots"],
    skillSnapshots: JSON.parse(row.skill_snapshots_json ?? "[]") as AutomationRuleV2["skillSnapshots"],
    dataSelectionRecipe: parseOptionalJson<NonNullable<AutomationRuleV2["dataSelectionRecipe"]>>(
      row.data_selection_recipe_json,
    ),
    analysisRecipe: parseOptionalJson<NonNullable<AutomationRuleV2["analysisRecipe"]>>(
      row.analysis_recipe_json,
    ),
    artifactRecipe: parseOptionalJson<NonNullable<AutomationRuleV2["artifactRecipe"]>>(
      row.artifact_recipe_json,
    ),
    deliveryPlan: parseOptionalJson<NonNullable<AutomationRuleV2["deliveryPlan"]>>(
      row.delivery_plan_json,
    ),
    acceptedReviews: JSON.parse(row.accepted_reviews_json ?? "[]") as AutomationRuleV2["acceptedReviews"],
    compiledPipelineHash: row.compiled_pipeline_hash ?? undefined,
    owner:
      row.owner_type === "local_profile"
        ? { type: "localProfile", profileId: "default" }
        : { type: "account", accountId: row.account_id },
    accountScope:
      parseOptionalJson<NonNullable<AutomationRuleV2["accountScope"]>>(
        row.account_scope_json,
      ) ?? { type: "currentAccount", accountId: row.account_id },
    templateBinding:
      row.template_id &&
      row.template_version &&
      row.template_hash &&
      row.result_schema_id &&
      row.result_schema_version &&
      row.renderer_id &&
      row.renderer_version
        ? {
            templateId: row.template_id,
            templateVersion: row.template_version,
            templateHash: row.template_hash,
            resultSchemaId: row.result_schema_id,
            resultSchemaVersion: Number(row.result_schema_version),
            rendererId: row.renderer_id,
            rendererVersion: row.renderer_version,
            configuration: {},
          }
        : undefined,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseRunResults(value: string | null): AutomationActionRunResult[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is AutomationActionRunResult =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];
  } catch {
    return [];
  }
}

function parseOptionalJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function ruleVersionHash(rule: AutomationRuleV2): string {
  return createHash("sha256").update(JSON.stringify(rule)).digest("hex");
}
