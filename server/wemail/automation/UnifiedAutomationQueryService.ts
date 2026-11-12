import type {
  AutomationAccountScope,
  AutomationDetail,
  AutomationHealth,
  AutomationLatestOutput,
  AutomationListItem,
  AutomationOwner,
  AutomationRunOutcome,
  AutomationRunSummary,
  AutomationWorkflowStage,
  AutomationWorkflowStageSummary,
  UnifiedAutomationListResponse,
} from "../../../shared/wemail/automationCenter.js";
import type {
  AutomationAction,
  AutomationRule,
  AutomationRuleV2,
  AutomationTrigger,
} from "../../../shared/wemail/automation.js";
import type { MailDatabase } from "../database/Database.js";
import type { AutomationRuleRepository } from "./AutomationRuleRepository.js";
import { projectAutomationDeliveries } from "./AutomationDeliveryProjection.js";

interface RuleIdentityRow {
  id: string;
  schema_version: 1 | 2;
  account_id: string;
  owner_type: "account" | "local_profile";
  owner_profile_id: string | null;
  archived_at: string | null;
}

interface RuntimeRow {
  next_run_at: string | null;
  consecutive_failures: number;
  paused_reason: string | null;
}

interface RunRow {
  id: string;
  rule_id: string;
  account_id: string;
  dry_run: number;
  matched_count: number;
  applied_count: number;
  status: string | null;
  created_at: string;
  completed_at: string | null;
  run_revision: number;
  rule_version: number | null;
  resolved_accounts_json: string | null;
}

interface AutomationVisibility {
  accountId: string;
  profileId?: "default";
}

export class AutomationNotVisibleError extends Error {
  constructor() {
    super("automation-not-found");
  }
}

export class AutomationDeleteBlockedError extends Error {
  constructor(readonly references: Array<{ type: string; count: number }>) {
    super("automation-delete-blocked");
  }
}

export class UnifiedAutomationQueryService {
  constructor(
    private readonly db: MailDatabase,
    private readonly rules: AutomationRuleRepository,
  ) {}

  list(visibility: AutomationVisibility): UnifiedAutomationListResponse {
    const rows = this.visibleRows(visibility);
    return {
      automations: rows.map((row) => this.projectListItem(row)),
      recommendedTemplates: [],
    };
  }

  detail(id: string, visibility: AutomationVisibility): AutomationDetail {
    const identity = this.visibleRows(visibility).find((row) => row.id === id);
    if (!identity) throw new AutomationNotVisibleError();
    const item = this.projectListItem(identity);
    const source = this.loadRule(identity);
    return {
      ...item,
      trigger: source.trigger,
      configuration: projectConfiguration(source),
      sourceRule: publicSourceRule(source),
      recentRuns: this.listRuns(identity.id, item.owner, 20),
    };
  }

  archive(id: string, visibility: AutomationVisibility): AutomationListItem {
    const identity = this.visibleRows(visibility, true).find(
      (row) => row.id === id,
    );
    if (!identity) throw new AutomationNotVisibleError();
    const archivedAt = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE automation_rules SET enabled = 0, archived_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(archivedAt, archivedAt, id);
    return this.projectListItem({ ...identity, archived_at: archivedAt });
  }

  setEnabled(
    id: string,
    visibility: AutomationVisibility,
    enabled: boolean,
  ): AutomationListItem {
    const identity = this.visibleRows(visibility, true).find(
      (row) => row.id === id,
    );
    if (!identity) throw new AutomationNotVisibleError();
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE automation_rules SET enabled = ?, updated_at = ? WHERE id = ?",
      )
      .run(enabled ? 1 : 0, updatedAt, id);
    return this.projectListItem(identity);
  }

  deletePermanently(id: string, visibility: AutomationVisibility): void {
    const identity = this.visibleRows(visibility, true).find(
      (row) => row.id === id,
    );
    if (!identity) throw new AutomationNotVisibleError();
    const references = this.referenceCounts(id);
    if (references.length > 0) throw new AutomationDeleteBlockedError(references);

    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM automation_rule_runtime_state WHERE rule_id = ?")
        .run(id);
      this.db
        .prepare("DELETE FROM automation_rule_versions WHERE rule_id = ?")
        .run(id);
      this.db.prepare("DELETE FROM automation_rules WHERE id = ?").run(id);
    })();
  }

  private visibleRows(
    visibility: AutomationVisibility,
    includeArchived = false,
  ): RuleIdentityRow[] {
    const profileId = visibility.profileId ?? "default";
    const archivedClause = includeArchived ? "" : "AND archived_at IS NULL";
    return this.db
      .prepare(
        `SELECT id, schema_version, account_id, owner_type, owner_profile_id,
                archived_at
           FROM automation_rules
          WHERE (
                (owner_type = 'account' AND account_id = ?)
             OR (owner_type = 'local_profile' AND owner_profile_id = ?)
          )
          ${archivedClause}
          ORDER BY created_at ASC, id ASC`,
      )
      .all(visibility.accountId, profileId) as RuleIdentityRow[];
  }

  private projectListItem(identity: RuleIdentityRow): AutomationListItem {
    const source = this.loadRule(identity);
    const owner = ownerFor(identity);
    const runtime = this.db
      .prepare(
        `SELECT next_run_at, consecutive_failures, paused_reason
           FROM automation_rule_runtime_state WHERE rule_id = ?`,
      )
      .get(identity.id) as RuntimeRow | undefined;
    const latestRun = this.listRuns(identity.id, owner, 1)[0];
    const stages = projectStages(source, latestRun);
    const v2 = isV2(source) ? source : undefined;

    return {
      id: source.id,
      schemaVersion: identity.schema_version,
      version: v2?.version ?? 1,
      owner,
      accountScope: accountScopeFor(source),
      name: source.name,
      description: v2?.description,
      enabled: source.enabled,
      archivedAt: identity.archived_at ?? undefined,
      template: v2?.templateBinding,
      triggerSummary: summarizeTrigger(source.trigger),
      workflowSummary: summarizeWorkflow(source),
      deliverySummary: summarizeDelivery(source),
      health: deriveHealth(source.enabled, runtime, latestRun),
      stages,
      nextRunAt: runtime?.next_run_at ?? triggerNextRun(source.trigger),
      latestRun,
      latestOutput: this.latestOutput(identity.id),
      upgrade: v2?.templateBinding
        ? {
            available: false,
            currentVersion: v2.templateBinding.templateVersion,
            requiresPreview: true,
          }
        : isLegacyUpgradeEligible(source)
          ? {
              available: true,
              currentVersion: "V1",
              targetVersion: "V2",
              summary: [
                "转换为可预览、可评审、可回退的版本化工作流",
                "现有规则在最终确认前继续运行且不会被修改",
              ],
              requiresPreview: true,
            }
          : undefined,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
  }

  private loadRule(
    identity: RuleIdentityRow,
  ): AutomationRule | AutomationRuleV2 {
    const source =
      identity.schema_version === 2
        ? this.rules.getV2(identity.id)
        : this.rules.get(identity.id);
    if (!source) throw new AutomationNotVisibleError();
    return source;
  }

  private listRuns(
    ruleId: string,
    owner: AutomationOwner,
    limit: number,
  ): AutomationRunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, rule_id, account_id, dry_run, matched_count, applied_count,
                status, created_at, completed_at, run_revision, rule_version,
                resolved_accounts_json
           FROM automation_rule_runs
          WHERE rule_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(ruleId, limit) as RunRow[];
    return rows.map((row) => ({
      id: row.id,
      ruleId: row.rule_id,
      ruleVersion: row.rule_version ?? 1,
      owner,
      dryRun: row.dry_run === 1,
      outcome: mapOutcome(row.status),
      startedAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
      inputCount: row.matched_count,
      resultCount: row.applied_count,
      truncated: false,
      deliveries: projectAutomationDeliveries(this.db, row.id),
      revision: row.run_revision,
    }));
  }

  private latestOutput(ruleId: string): AutomationLatestOutput | undefined {
    const message = this.db
      .prepare(
        `SELECT id, title, preview
           FROM application_messages
          WHERE source_rule_id = ? AND archived_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(ruleId) as
      | { id: string; title: string; preview: string }
      | undefined;
    if (message) {
      return {
        type: "application_message",
        id: message.id,
        title: message.title,
        preview: message.preview,
        availability: "available",
      };
    }
    const artifact = this.db
      .prepare(
        `SELECT id, version, title, preview, expires_at
           FROM message_artifacts
          WHERE source_rule_id = ?
          ORDER BY created_at DESC, version DESC LIMIT 1`,
      )
      .get(ruleId) as
      | {
          id: string;
          version: number;
          title: string;
          preview: string;
          expires_at: string | null;
        }
      | undefined;
    if (!artifact) return undefined;
    return {
      type: "artifact",
      title: artifact.title,
      preview: artifact.preview,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      availability:
        artifact.expires_at && artifact.expires_at <= new Date().toISOString()
          ? "expired"
          : "available",
    };
  }

  private referenceCounts(
    ruleId: string,
  ): Array<{ type: string; count: number }> {
    const counts: Array<{ type: string; count: number }> = [];
    for (const query of [
      {
        type: "run",
        sql: "SELECT COUNT(*) AS count FROM automation_rule_runs WHERE rule_id = ?",
      },
      {
        type: "application_message",
        sql: "SELECT COUNT(*) AS count FROM application_messages WHERE source_rule_id = ?",
      },
      {
        type: "artifact",
        sql: "SELECT COUNT(*) AS count FROM message_artifacts WHERE source_rule_id = ?",
      },
      {
        type: "explicit_reference",
        sql: "SELECT COUNT(*) AS count FROM automation_rule_references WHERE rule_id = ?",
      },
    ]) {
      const row = this.db.prepare(query.sql).get(ruleId) as { count: number };
      if (row.count > 0) counts.push({ type: query.type, count: row.count });
    }
    return counts;
  }
}

function isLegacyUpgradeEligible(
  source: AutomationRule | AutomationRuleV2,
): source is AutomationRule {
  if (isV2(source)) return false;
  return (
    source.processing?.mode === "collection" &&
    (source.processing.processors?.some(
      (processor) =>
        processor.type === "mailDigest" ||
        processor.type === "invoiceReadinessAnalysis",
    ) ??
      false) &&
    source.actions.some(
      (action) =>
        action.type === "publishApplicationMessage" ||
        action.type === "publishBotMessage",
    )
  );
}

function ownerFor(identity: RuleIdentityRow): AutomationOwner {
  return identity.owner_type === "local_profile"
    ? { type: "localProfile", profileId: "default" }
    : { type: "account", accountId: identity.account_id };
}

function accountScopeFor(
  source: AutomationRule | AutomationRuleV2,
): AutomationAccountScope {
  return isV2(source) && source.accountScope
    ? source.accountScope
    : { type: "currentAccount", accountId: source.accountId };
}

function summarizeTrigger(trigger: AutomationTrigger): string {
  if (trigger.type === "manual") return "手动运行";
  if (trigger.type === "mailReceived") {
    const execution = trigger.execution;
    if (!execution || execution.type === "immediate") return "收到匹配邮件时";
    if (execution.type === "delay") {
      const unit =
        execution.unit === "minute"
          ? "分钟"
          : execution.unit === "hour"
            ? "小时"
            : "天";
      return `收到匹配邮件 ${execution.amount} ${unit}后`;
    }
    if (execution.type === "nextDayAt") {
      return `收到匹配邮件后的次日 ${execution.localTime}`;
    }
    return "收到匹配邮件后按邮件时间触发";
  }
  if (trigger.schedule?.type === "daily") {
    return `每天 ${trigger.schedule.localTime}`;
  }
  const minutes =
    trigger.schedule?.type === "interval"
      ? trigger.schedule.intervalMinutes
      : trigger.intervalMinutes;
  return minutes ? `每 ${minutes} 分钟` : "定时运行";
}

function summarizeWorkflow(source: AutomationRule | AutomationRuleV2): string {
  if (isV2(source)) {
    const stages = [
      source.dataSelectionRecipe ? "筛选数据" : undefined,
      source.analysisRecipe ? "分析" : undefined,
      source.artifactRecipe ? "生成内容" : undefined,
    ].filter(Boolean);
    return stages.join("、") || `执行 ${source.pipeline.length} 个步骤`;
  }
  if (source.processing?.mode === "collection") return "汇总并处理一批邮件";
  return "处理每封匹配邮件";
}

function summarizeDelivery(source: AutomationRule | AutomationRuleV2): string {
  if (isV2(source)) {
    const destinations = source.deliveryPlan?.destinations ?? [];
    if (destinations.length === 0) return "保存在应用内";
    return destinations
      .map((destination) => destination.type)
      .join("、");
  }
  return summarizeLegacyActions(source.actions);
}

function summarizeLegacyActions(actions: AutomationAction[]): string {
  if (actions.some((action) => action.type === "publishBotMessage")) {
    return "发送到已连接 Bot";
  }
  if (actions.some((action) => action.type === "publishApplicationMessage")) {
    return "发送到消息中心";
  }
  return actions.length > 0 ? `执行 ${actions.length} 个邮件动作` : "无投递";
}

function projectStages(
  source: AutomationRule | AutomationRuleV2,
  latestRun?: AutomationRunSummary,
): AutomationWorkflowStageSummary[] {
  const runStatus = latestRun?.outcome;
  const status =
    runStatus === "running"
      ? "running"
      : runStatus === "failed" || runStatus === "outcome_unknown"
        ? "failed"
        : runStatus === "partial"
          ? "partial"
          : runStatus === "empty"
            ? "empty"
            : runStatus === "succeeded"
              ? "succeeded"
              : "configured";
  const definitions: Array<{
    stage: AutomationWorkflowStage;
    label: string;
    summary: string;
  }> = [
    { stage: "trigger", label: "触发", summary: summarizeTrigger(source.trigger) },
    {
      stage: "data",
      label: "数据",
      summary:
        isV2(source) && source.dataSelectionRecipe
          ? "按已确认范围读取邮件"
          : !isV2(source) && source.processing?.mode === "collection"
            ? "读取时间窗口内的匹配邮件"
            : "读取匹配邮件",
    },
    {
      stage: "analysis",
      label: "分析",
      summary:
        isV2(source) && source.analysisRecipe
          ? "按已确认方法分析"
          : "按规则处理",
    },
    {
      stage: "artifact",
      label: "产出",
      summary:
        isV2(source) && source.artifactRecipe
          ? "生成已确认格式的内容"
          : "生成执行结果",
    },
    {
      stage: "delivery",
      label: "投递",
      summary: summarizeDelivery(source),
    },
  ];
  return definitions.map((definition) => ({ ...definition, status }));
}

function deriveHealth(
  enabled: boolean,
  runtime: RuntimeRow | undefined,
  latestRun: AutomationRunSummary | undefined,
): AutomationHealth {
  if (!enabled) return "disabled";
  if (runtime?.paused_reason) return "paused";
  if (latestRun?.outcome === "running") return "running";
  if (
    latestRun?.outcome === "failed" ||
    latestRun?.outcome === "partial" ||
    latestRun?.outcome === "outcome_unknown" ||
    (runtime?.consecutive_failures ?? 0) > 0
  ) {
    return "needs_attention";
  }
  return latestRun ? "healthy" : "never_run";
}

function triggerNextRun(trigger: AutomationTrigger): string | undefined {
  return trigger.type === "scheduled" ? trigger.nextRunAt : undefined;
}

function mapOutcome(status: string | null): AutomationRunOutcome {
  if (
    status === "running" ||
    status === "succeeded" ||
    status === "empty" ||
    status === "partial" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "outcome_unknown"
  ) {
    return status;
  }
  if (status === "applied" || status === "matched") return "succeeded";
  if (status === "skipped") return "empty";
  if (status === "evaluation_failed") return "failed";
  return "outcome_unknown";
}

function projectConfiguration(source: AutomationRule | AutomationRuleV2) {
  if (!isV2(source)) {
    return {
      data: {
        conditions: source.conditions,
        conditionMode: source.conditionMode,
        conditionRules: source.conditionRules,
        processing: source.processing,
      },
      delivery: { actions: source.actions },
      advanced: {
        naturalLanguageCondition: source.naturalLanguageCondition,
      },
    };
  }
  return {
    data: source.dataSelectionRecipe ?? source.collection,
    analysis: source.analysisRecipe,
    artifact: source.artifactRecipe,
    delivery: source.deliveryPlan,
    advanced: {
      compiledPipelineHash: source.compiledPipelineHash,
      acceptedReviews: source.acceptedReviews,
    },
  };
}

function publicSourceRule(
  source: AutomationRule | AutomationRuleV2,
): AutomationRule | AutomationRuleV2 {
  if (!isV2(source)) return source;
  return {
    ...source,
    pipeline: [],
    authorization: { capabilities: [] },
    capabilitySnapshots: [],
  };
}

function isV2(
  source: AutomationRule | AutomationRuleV2,
): source is AutomationRuleV2 {
  return "schemaVersion" in source && source.schemaVersion === 2;
}
