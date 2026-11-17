import { randomUUID } from "node:crypto";
import type {
  AutomationAction,
  AutomationConditionMode,
  AutomationConditionRule,
  AutomationConditions,
  AutomationDataset,
  AutomationFieldDefinition,
  AutomationTrigger,
  AutomationProcessing,
  TemporalExpression,
} from "../../../shared/wemail/automation.js";
import type {
  WemailAddress,
  WemailOutboundAttachment,
} from "../../../shared/wemail/mail.js";
import type {
  AgentPendingAction,
  HighRiskActionType,
} from "../../../shared/wemail/intelligence.js";
import type { AutomationRuleRepository } from "../automation/AutomationRuleRepository.js";
import type { RuleDryRunner } from "../automation/RuleDryRunner.js";
import type { AutomationRuleService } from "../automation/AutomationRuleService.js";
import type { UserTagRepository } from "../intelligence/UserTagRepository.js";
import type { EmailSmartTagRepository } from "../intelligence/EmailSmartTagRepository.js";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import type { ScheduledSendService } from "../mail/ScheduledSendService.js";
import type { SnoozeService } from "../mail/SnoozeService.js";
import type { AiProfileSettingsService } from "../settings/AiProfileSettingsService.js";
import type { BusinessPreferenceService } from "../settings/BusinessPreferenceService.js";
import type { DirectoryService } from "../directory/DirectoryService.js";
import type { AgentPendingActionRepository } from "./AgentPendingActionRepository.js";
import {
  createPendingActionAuthorization,
  deriveRiskLevel,
  rowToAction,
} from "./AgentPendingActionRepository.js";
import type { AgentTool, AgentToolContext } from "./AgentRuntime.js";
import type { ToolInput } from "./AgentTypes.js";
import { AUTOMATION_FIELD_DEFINITIONS } from "../automation/AutomationFieldCatalog.js";
import { assertValidAutomationRuleDraft } from "../automation/AutomationRuleValidation.js";
import { automationCapabilityDiscovery } from "../automation/AutomationCapabilityRegistry.js";
import type { AutomationProviderRegistry } from "../automation/providers/AutomationProviderRegistry.js";
import type { AutomationRuleV2Draft, PipelineAutomationRuleService } from "../automation/PipelineAutomationRuleService.js";
import type { ConfigurationWorkflowService } from "../configuration/ConfigurationWorkflowService.js";
import { ConfigurationFailureAdapter } from "../configuration/ConfigurationFailureAdapter.js";
import { ConfigurationOutcomeProjector } from "../configuration/ConfigurationOutcomeProjector.js";
import type { AutomationAuthoringAgentService } from "../configuration/AutomationAuthoringAgentService.js";
import type { AgentArtifactDeliveryService } from "../design/AgentArtifactDeliveryService.js";
import { assertAggregatedInsightDataset } from "../design/InsightDatasetContract.js";
import { htmlTableDataset } from "../analysis/extractHtmlTables.js";
import { deriveReportTitle } from "../analysis/generatePivots.js";
import type { DesignAnalysisPlan } from "../../../shared/wemail/designArtifacts.js";
import type { SkillSnapshot } from "../../../shared/wemail/skillCenter.js";
import type { SkillDraftService } from "../skill-center/SkillDraftService.js";
import type { AllowanceInvoicePort } from "./allowancePort.js";

// In-process dataset registries keep parsed mail data out of model/tool payloads.
// Multi-mail extraction first creates a run-scoped temporary batch. Aggregation
// consumes that batch, stores only the final dataset, and releases the raw parses.
// Both registries are bounded so a long-lived process cannot leak indefinitely.
const PENDING_DATASETS_CAP = 32;
const PENDING_DATASET_BATCHES_CAP = 16;
type PendingDatasetStage = "single" | "aggregated";
interface PendingDataset {
  id: string;
  dataset: AutomationDataset;
  accountId: string;
  scopeKey?: string;
  stage: PendingDatasetStage;
}

interface ParsedEmailDataset {
  emailId: string;
  receivedAt: string;
  dataset: AutomationDataset;
}

interface DatasetParseFailure {
  emailId: string;
  error: string;
}

interface PendingDatasetBatch {
  id: string;
  datasets: ParsedEmailDataset[];
  requestedEmailIds: string[];
  parseFailures: DatasetParseFailure[];
  accountId: string;
  scopeKey?: string;
}

const pendingDatasets = new Map<string, PendingDataset>();
const pendingDatasetBatches = new Map<string, PendingDatasetBatch>();

function datasetScopeKey(ctx: AgentToolContext): string | undefined {
  const runId = stringValue(ctx.runContext?.runId);
  if (runId) return `run:${runId}`;
  const sessionId = stringValue(ctx.sessionId);
  return sessionId ? `session:${sessionId}` : undefined;
}

function rememberDataset(
  id: string,
  dataset: AutomationDataset,
  accountId: string,
  ctx: AgentToolContext,
  stage: PendingDatasetStage = "single",
): void {
  pendingDatasets.set(id, {
    id,
    dataset,
    accountId,
    scopeKey: datasetScopeKey(ctx),
    stage,
  });
  while (pendingDatasets.size > PENDING_DATASETS_CAP) {
    const oldest = pendingDatasets.keys().next().value;
    if (oldest === undefined) break;
    pendingDatasets.delete(oldest);
  }
}

function resolvePendingDataset(
  datasetId: string | undefined,
  accountId: string,
  ctx: AgentToolContext,
): PendingDataset | undefined {
  const scopeKey = datasetScopeKey(ctx);
  if (datasetId) {
    const entry = pendingDatasets.get(datasetId);
    return entry?.accountId === accountId && entry.scopeKey === scopeKey
      ? entry
      : undefined;
  }
  if (!scopeKey) return undefined;
  return [...pendingDatasets.values()].reverse().find(
    (entry) => entry.accountId === accountId && entry.scopeKey === scopeKey,
  );
}

export type AgentCapabilityRisk = "read" | "draft" | "configuration" | "high";

export const WEMAIL_AGENT_CAPABILITIES = [
  { domain: "directory", tool: "search_directory_contacts", batch: 1, risk: "read" },
  { domain: "directory", tool: "get_directory_contact", batch: 1, risk: "read" },
  { domain: "directory", tool: "list_directory_departments", batch: 1, risk: "read" },
  { domain: "directory", tool: "resolve_directory_recipients", batch: 1, risk: "read" },
  { domain: "directory", tool: "get_directory_status", batch: 1, risk: "read" },
  { domain: "directory", tool: "refresh_directory", batch: 1, risk: "read" },
  { domain: "smart-tag", tool: "list_smart_tags", batch: 1, risk: "read" },
  { domain: "smart-tag", tool: "propose_smart_tag_change", batch: 1, risk: "configuration" },
  { domain: "automation", tool: "list_automation_rules", batch: 1, risk: "read" },
  { domain: "automation", tool: "start_automation_configuration", batch: 1, risk: "configuration" },
  { domain: "automation", tool: "discover_automation_capabilities", batch: 1, risk: "read" },
  { domain: "automation", tool: "preview_automation_rule", batch: 1, risk: "read" },
  { domain: "automation", tool: "preview_pipeline_automation_rule", batch: 1, risk: "read" },
  { domain: "automation", tool: "propose_automation_rule_change", batch: 1, risk: "configuration" },
  { domain: "workflow", tool: "inspect_workflow_capabilities", batch: 1, risk: "read" },
  { domain: "workflow", tool: "create_execution_pipeline", batch: 1, risk: "configuration" },
  { domain: "workflow", tool: "create_skill_draft_from_pipeline", batch: 1, risk: "draft" },
  { domain: "workflow", tool: "validate_skill_draft", batch: 1, risk: "draft" },
  { domain: "workflow", tool: "install_skill_draft", batch: 1, risk: "configuration" },
  { domain: "workflow", tool: "review_pipeline_preview", batch: 1, risk: "read" },
  { domain: "workflow", tool: "revise_pipeline_preview", batch: 1, risk: "draft" },
  { domain: "workflow", tool: "execute_one_shot_pipeline", batch: 1, risk: "configuration" },
  { domain: "workflow", tool: "list_recent_emails", batch: 1, risk: "read" },
  { domain: "workflow", tool: "extract_email_tables", batch: 1, risk: "read" },
  { domain: "workflow", tool: "aggregate_email_datasets", batch: 1, risk: "read" },
  { domain: "workflow", tool: "publish_design_artifact", batch: 1, risk: "configuration" },
  { domain: "workflow", tool: "complete_automation_configuration", batch: 1, risk: "configuration" },
  { domain: "mail", tool: "compose_mail", batch: 1, risk: "draft" },
  { domain: "mail", tool: "propose_send_mail", batch: 1, risk: "high" },
  { domain: "mail", tool: "set_mail_state", batch: 2, risk: "draft" },
  { domain: "mail", tool: "set_mail_smart_tag", batch: 2, risk: "draft" },
  { domain: "mail", tool: "save_mail_draft", batch: 2, risk: "draft" },
  { domain: "mail", tool: "list_mail_drafts", batch: 2, risk: "read" },
  { domain: "mail", tool: "get_mail_draft", batch: 2, risk: "read" },
  { domain: "mail", tool: "propose_delete_draft", batch: 2, risk: "high" },
  { domain: "mail", tool: "list_scheduled_mail", batch: 2, risk: "read" },
  { domain: "mail", tool: "propose_schedule_mail", batch: 2, risk: "high" },
  { domain: "mail", tool: "propose_cancel_scheduled_mail", batch: 2, risk: "high" },
  { domain: "mail", tool: "propose_mail_operation", batch: 2, risk: "high" },
  { domain: "writing-style", tool: "list_writing_styles", batch: 2, risk: "read" },
  { domain: "writing-style", tool: "propose_writing_style_change", batch: 2, risk: "configuration" },
  { domain: "preferences", tool: "get_business_preferences", batch: 2, risk: "read" },
  { domain: "preferences", tool: "propose_business_preference_change", batch: 2, risk: "configuration" },
] as const satisfies ReadonlyArray<{
  domain: string;
  tool: string;
  batch: 1 | 2;
  risk: AgentCapabilityRisk;
}>;

/**
 * P2.4: the six directory tools consume only this minimal slice of
 * DirectoryService (the same `Pick<DirectoryService, ...>` style used by
 * MailActionExecutor), so the tool factory never depends on the snapshot
 * engine's concrete class or on any enterprise directory implementation.
 */
export type DirectoryToolService = Pick<
  DirectoryService,
  | "searchContacts"
  | "getContact"
  | "listDepartments"
  | "resolveRecipients"
  | "getStatus"
  | "refresh"
>;

export interface WemailAgentToolDeps {
  rules: AutomationRuleRepository;
  dryRunner: RuleDryRunner;
  ruleService?: AutomationRuleService;
  providers?: AutomationProviderRegistry;
  pipelineRuleService?: PipelineAutomationRuleService;
  configurationWorkflow?: ConfigurationWorkflowService;
  automationAuthoring?: AutomationAuthoringAgentService;
  skillDrafts?: SkillDraftService;
  resolveSkillSnapshots?: (
    context: Record<string, unknown> | undefined,
  ) => SkillSnapshot[];
  artifactDelivery?: AgentArtifactDeliveryService;
  userTags: UserTagRepository;
  pendingActions: AgentPendingActionRepository;
  getActiveAccountId?: () => string | undefined;
  mailDatabase: MailDatabaseClient;
  emailSmartTags: EmailSmartTagRepository;
  scheduledSend: ScheduledSendService;
  snooze: SnoozeService;
  aiProfile: AiProfileSettingsService;
  businessPreferences: BusinessPreferenceService;
  directoryService: DirectoryToolService;
  /**
   * Edition switch for the six enterprise-directory tools. The open edition
   * leaves it off (no directory module registered); the internal edition
   * enables it via `edition.features.enterpriseDirectory && modules.directory`
   * in AppComposition. Tool definitions remain in the open tree so the
   * mechanism layer is preserved.
   */
  directoryToolsEnabled?: boolean;
  /**
   * P2.6 round-up: the structured allowance-upload adapter clauses in the
   * automation tool descriptions resolve under the SAME contract as the
   * three allowance tools — effective capability = feature flag AND the
   * per-composition service (`allowanceToolsEnabled` is computed as
   * feature && module in AppComposition; `allowance` is the service built
   * from this composition's `allowanceModules` override). Before this
   * input existed the descriptions fell back to the global edition
   * registration, so an internal module with the feature flag off (or a
   * composition override diverging from the global registry) still exposed
   * the adapter text. The open edition passes neither, so the clause
   * disappears.
   */
  allowance?: AllowanceInvoicePort;
  allowanceToolsEnabled?: boolean;
  describeEditionAction?: (action: AutomationAction) => string | undefined;
  describeWecliAction?: (action: AutomationAction) => string | undefined;
  editionPreviewSuffix?: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rememberDatasetBatch(
  id: string,
  datasets: ParsedEmailDataset[],
  accountId: string,
  ctx: AgentToolContext,
  requestedEmailIds: string[],
  parseFailures: DatasetParseFailure[],
): void {
  pendingDatasetBatches.set(id, {
    id,
    datasets,
    requestedEmailIds,
    parseFailures,
    accountId,
    scopeKey: datasetScopeKey(ctx),
  });
  while (pendingDatasetBatches.size > PENDING_DATASET_BATCHES_CAP) {
    const oldest = pendingDatasetBatches.keys().next().value;
    if (oldest === undefined) break;
    pendingDatasetBatches.delete(oldest);
  }
}

function resolvePendingDatasetBatch(
  batchId: string,
  accountId: string,
  ctx: AgentToolContext,
): PendingDatasetBatch | undefined {
  const entry = pendingDatasetBatches.get(batchId);
  return entry?.accountId === accountId && entry.scopeKey === datasetScopeKey(ctx)
    ? entry
    : undefined;
}

interface InsightAggregationPolicy {
  preset: "24h" | "7d";
}

function insightAggregationPolicy(
  ctx: AgentToolContext,
): InsightAggregationPolicy | undefined {
  const sceneAction = ctx.runContext?.sceneAction;
  if (!sceneAction || typeof sceneAction !== "object") return undefined;
  const action = sceneAction as Record<string, unknown>;
  if (action.kind !== "insight-report" ||
    (action.operation !== "aggregate" && action.operation !== "regenerate") ||
    (action.lookbackPreset !== "24h" && action.lookbackPreset !== "7d")) {
    return undefined;
  }
  const preset = action.lookbackPreset === "24h" ? "24h" : "7d";
  return { preset };
}

function insightSceneAction(ctx: AgentToolContext): Record<string, unknown> | undefined {
  const sceneAction = ctx.runContext?.sceneAction;
  return sceneAction && typeof sceneAction === "object"
    ? sceneAction as Record<string, unknown>
    : undefined;
}

function insightRegenerationSourceIds(ctx: AgentToolContext): string[] {
  const action = insightSceneAction(ctx);
  if (action?.kind !== "insight-report" || action.operation !== "regenerate") return [];
  return Array.isArray(action.sourceEmailIds)
    ? [...new Set(action.sourceEmailIds.map(stringValue).filter((value): value is string => Boolean(value)))]
    : [];
}

/**
 * A rolling-window insight action is a multi-email workflow even when the
 * model has not selected any IDs yet. It must go through association first;
 * falling back to the focused email would make a successful-looking report
 * with the wrong scope.
 */
function requiresAssociatedInsightEmails(ctx: AgentToolContext): boolean {
  const action = insightSceneAction(ctx);
  return action?.kind === "insight-report" && (
    action.operation === "aggregate" ||
    (action.operation === "regenerate" && (
      action.lookbackPreset === "24h" ||
      action.lookbackPreset === "7d"
    ))
  );
}

function insightSceneReportId(ctx: AgentToolContext): string | undefined {
  const action = insightSceneAction(ctx);
  return action?.kind === "insight-report" ? stringValue(action.reportId) : undefined;
}

function requiresAggregatedInsightDataset(ctx: AgentToolContext): boolean {
  const action = insightSceneAction(ctx);
  return action?.kind === "insight-report" && (
    action.operation === "aggregate" ||
    (action.operation === "regenerate" && (
      action.lookbackPreset === "24h" ||
      action.lookbackPreset === "7d" ||
      insightRegenerationSourceIds(ctx).length > 1
    ))
  );
}

function hasAggregatedInsightContract(dataset: AutomationDataset): boolean {
  const hasAggregationProcessor = (dataset.provenance ?? []).some((item) =>
    item.sourceType === "processor" && item.operation === "aggregate-email-datasets",
  );
  if (!hasAggregationProcessor || dataset.rawTables) return false;
  try {
    assertAggregatedInsightDataset(dataset);
    return true;
  } catch {
    return false;
  }
}

type DatasetField = AutomationDataset["schema"]["fields"][number];
type DatasetMeasureAggregation = "sum" | "average" | "min" | "max" | "latest" | "ratio";

interface DatasetMeasurePlan {
  field: string;
  agg: DatasetMeasureAggregation;
  numeratorField?: string;
  denominatorField?: string;
}

function defaultMeasureAggregation(field: DatasetField): DatasetMeasureAggregation {
  const identity = `${field.name} ${field.label ?? ""}`;
  return /(^|[_\s-])(cnt|count|total|sum|calls?|volume)([_\s-]|$)|数量|次数|调用量|通话量|呼叫量|接通量|总量/i.test(identity)
    ? "sum"
    : "average";
}

function datasetFieldSummary(dataset: AutomationDataset) {
  return dataset.schema.fields.map((field) => {
    const values = dataset.rows
      .map((row) => row[field.name])
      .filter((value) => value !== undefined && value !== null && value !== "");
    const distinct = [...new Set(values.map((value) => String(value)))];
    const numeric = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
    const percentile = (p: number): number | undefined => {
      if (!numeric.length) return undefined;
      return numeric[Math.max(0, Math.ceil(numeric.length * p) - 1)];
    };
    return {
      name: field.name,
      label: field.label,
      type: field.type,
      semanticRole: field.semanticRole,
      semanticId: field.semanticId,
      distinctCount: distinct.length,
      sampleValues: distinct.slice(0, 6),
      missingCount: Math.max(0, dataset.rows.length - values.length),
      ...(numeric.length === values.length && numeric.length
        ? {
            suggestedAggregation: defaultMeasureAggregation(field),
            min: numeric[0],
            median: percentile(0.5),
            p95: percentile(0.95),
            max: numeric.at(-1),
          }
        : {}),
    };
  });
}

function datasetSchemaSignature(dataset: AutomationDataset): string {
  return JSON.stringify(dataset.schema.fields.map(schemaFieldKey).sort());
}

function schemaFieldKey(field: DatasetField): string {
  return String(field.label || field.name)
    .trim()
    .toLowerCase()
    .replace(/[\s_\-—·:：/\\（）()]+/g, "")
    .replace(/[\[\]{}]/g, "");
}

function alignedFieldNames(dataset: AutomationDataset, targetFields: DatasetField[]): Map<string, string> {
  const sourceByKey = new Map(dataset.schema.fields.map((field) => [schemaFieldKey(field), field.name]));
  return new Map(targetFields.map((field) => [field.name, sourceByKey.get(schemaFieldKey(field)) ?? field.name]));
}

function sourceTimeValue(receivedAt: string, timeGrain: "hour" | "day"): string {
  const parsed = new Date(receivedAt);
  if (!Number.isFinite(parsed.getTime())) return receivedAt;
  if (timeGrain === "day") return parsed.toISOString().slice(0, 10);
  return `${parsed.toISOString().slice(0, 13)}:00:00.000Z`;
}

function inferBatchTimeGrain(parsed: ParsedEmailDataset[]): "hour" | "day" {
  const timestamps = parsed
    .map((entry) => Date.parse(entry.receivedAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (timestamps.length < 2) return "hour";
  return timestamps[timestamps.length - 1] - timestamps[0] <= 36 * 60 * 60 * 1_000
    ? "hour"
    : "day";
}

function aggregateParsedEmailDatasets(input: {
  parsed: ParsedEmailDataset[];
  timeGrain: "hour" | "day";
  groupBy?: string[];
  measures?: DatasetMeasurePlan[];
}): { dataset?: AutomationDataset; skippedEmailIds: string[]; error?: string; hint?: string } {
  const first = input.parsed[0];
  if (!first) return { skippedEmailIds: [], error: "empty-dataset-batch" };
  const signature = datasetSchemaSignature(first.dataset);
  const compatible = input.parsed.filter((entry) => datasetSchemaSignature(entry.dataset) === signature);
  const skippedEmailIds = input.parsed
    .filter((entry) => datasetSchemaSignature(entry.dataset) !== signature)
    .map((entry) => entry.emailId);
  if (skippedEmailIds.length) {
    return {
      skippedEmailIds,
      error: "aggregation-schema-mismatch",
      hint: "Some associated emails have a different primary table schema. Recheck the association or stop and explain the mismatch; do not silently omit those emails.",
    };
  }
  const fields = first.dataset.schema.fields.map((field): DatasetField => {
    const values = compatible.flatMap((entry) => {
      const sourceName = alignedFieldNames(entry.dataset, first.dataset.schema.fields).get(field.name) ?? field.name;
      return entry.dataset.rows.map((row) => row[sourceName]);
    })
      .filter((value) => value !== undefined && value !== null && value !== "");
    const numeric = values.length > 0 && values.every((value) => Number.isFinite(Number(value)));
    return numeric
      ? { ...field, type: "number", semanticRole: "measure", semanticId: `measure:${field.name}` }
      : field;
  });
  const fieldMap = new Map(fields.map((field) => [field.name, field]));
  const defaultMeasures: DatasetMeasurePlan[] = fields
    .filter((field) => field.type === "number")
    .map((field): DatasetMeasurePlan => ({ field: field.name, agg: defaultMeasureAggregation(field) }));
  const measurePlans = input.measures?.length ? input.measures : defaultMeasures;
  const invalidMeasure = measurePlans.find((plan) =>
    fieldMap.get(plan.field)?.type !== "number" ||
    (plan.agg === "ratio" && (
      !plan.numeratorField ||
      !plan.denominatorField ||
      fieldMap.get(plan.numeratorField)?.type !== "number" ||
      fieldMap.get(plan.denominatorField)?.type !== "number"
    )),
  );
  if (invalidMeasure) {
    return {
      skippedEmailIds,
      error: "aggregation-measure-invalid",
      hint: `${invalidMeasure.field} is not a numeric field in the parsed schema.`,
    };
  }
  if (!measurePlans.length) {
    return {
      skippedEmailIds,
      error: "aggregation-measure-required",
      hint: "The parsed schema has no numeric measure to aggregate.",
    };
  }
  const measureNames = new Set(measurePlans.flatMap((plan) => [
    plan.field,
    ...(plan.numeratorField ? [plan.numeratorField] : []),
    ...(plan.denominatorField ? [plan.denominatorField] : []),
  ]));
  const defaultGroupBy = fields
    .filter((field) => !measureNames.has(field.name))
    .map((field) => field.name);
  const groupBy = [...new Set(input.groupBy?.length ? input.groupBy : defaultGroupBy)];
  const invalidGroup = groupBy.find((name) => !fieldMap.has(name) || measureNames.has(name));
  if (invalidGroup) {
    return {
      skippedEmailIds,
      error: "aggregation-group-field-invalid",
      hint: `${invalidGroup} is missing or is already configured as a measure.`,
    };
  }

  interface MeasureState { sum: number; count: number; min: number; max: number; latest: number; latestAt: number; numeratorSum: number; denominatorSum: number }
  interface GroupState { dimensions: Record<string, unknown>; measures: Map<string, MeasureState> }
  const groups = new Map<string, GroupState>();
  for (const entry of compatible) {
    const sourceTime = sourceTimeValue(entry.receivedAt, input.timeGrain);
    const sourceTimestamp = Date.parse(entry.receivedAt);
    const sourceNames = alignedFieldNames(entry.dataset, fields);
    for (const row of entry.dataset.rows) {
      const valueOf = (name: string): unknown => row[sourceNames.get(name) ?? name];
      const dimensions = Object.fromEntries(groupBy.map((name) => [name, valueOf(name)]));
      const key = JSON.stringify([sourceTime, ...groupBy.map((name) => valueOf(name) ?? null)]);
      let group = groups.get(key);
      if (!group) {
        group = { dimensions, measures: new Map() };
        groups.set(key, group);
      }
      for (const plan of measurePlans) {
        if (plan.agg === "ratio") {
          const numeratorRaw = valueOf(plan.numeratorField!);
          const denominatorRaw = valueOf(plan.denominatorField!);
          if (numeratorRaw === undefined || numeratorRaw === null || numeratorRaw === "" || denominatorRaw === undefined || denominatorRaw === null || denominatorRaw === "") continue;
          const numerator = Number(numeratorRaw);
          const denominator = Number(denominatorRaw);
          if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) continue;
          const current = group.measures.get(plan.field) ?? {
            sum: 0,
            count: 0,
            min: 0,
            max: 0,
            latest: 0,
            latestAt: Number.NEGATIVE_INFINITY,
            numeratorSum: 0,
            denominatorSum: 0,
          };
          current.numeratorSum += numerator;
          current.denominatorSum += denominator;
          current.count += 1;
          group.measures.set(plan.field, current);
          continue;
        }
        const rawValue = valueOf(plan.field);
        if (rawValue === undefined || rawValue === null || rawValue === "") continue;
        const value = Number(rawValue);
        if (!Number.isFinite(value)) continue;
        const current = group.measures.get(plan.field) ?? {
          sum: 0,
          count: 0,
          min: value,
          max: value,
          latest: value,
          latestAt: Number.NEGATIVE_INFINITY,
          numeratorSum: 0,
          denominatorSum: 0,
        };
        current.sum += value;
        current.count += 1;
        current.min = Math.min(current.min, value);
        current.max = Math.max(current.max, value);
        if (sourceTimestamp >= current.latestAt) {
          current.latest = value;
          current.latestAt = sourceTimestamp;
        }
        group.measures.set(plan.field, current);
      }
    }
  }
  const timeField: DatasetField = input.timeGrain === "day"
    ? { name: "_source_date", type: "date", label: "统计日期", semanticRole: "time", semanticId: "source_date" }
    : { name: "_source_time", type: "datetime", label: "统计时间", semanticRole: "time", semanticId: "source_time" };
  const rows = [...groups.entries()].map(([key, group]) => {
    const sourceTime = JSON.parse(key)[0] as string;
    const row: Record<string, unknown> = { [timeField.name]: sourceTime, ...group.dimensions };
    for (const plan of measurePlans) {
      const state = group.measures.get(plan.field);
      if (!state?.count) continue;
      row[plan.field] = plan.agg === "sum"
        ? state.sum
        : plan.agg === "ratio"
          ? state.denominatorSum === 0 ? null : state.numeratorSum / state.denominatorSum
        : plan.agg === "min"
          ? state.min
          : plan.agg === "max"
            ? state.max
            : plan.agg === "latest"
              ? state.latest
              : state.sum / state.count;
    }
    return row;
  });
  const sourceEmails = [...new Map(
    compatible
      .flatMap((entry) => entry.dataset.sourceEmails ?? [])
      .map((source) => [source.id, source] as const),
  ).values()];
  const requestedEmailCount = input.parsed.length;
  const timePointCountValue = new Set(rows
    .map((row) => row[timeField.name])
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map(String)).size;
  return {
    skippedEmailIds,
    dataset: {
      type: "dataset",
      schema: {
        fields: [
          timeField,
          ...groupBy.map((name) => fieldMap.get(name)).filter((field): field is DatasetField => Boolean(field)),
          ...measurePlans.map((plan) => fieldMap.get(plan.field)).filter((field): field is DatasetField => Boolean(field)),
        ],
      },
      rows,
      summary: {
        aggregation: {
          stage: "aggregated",
          timeGrain: input.timeGrain,
          timeField: timeField.name,
          groupBy,
          measures: measurePlans,
          requestedEmailCount,
          parsedEmailCount: compatible.length,
          skippedEmailCount: skippedEmailIds.length,
          sourceEmailCount: sourceEmails.length,
          rowCount: rows.length,
          timePointCount: timePointCountValue,
        },
      },
      provenance: [{
        outputPath: "rows",
        sourceType: "processor",
        emailIds: sourceEmails.map((source) => source.id),
        operation: "aggregate-email-datasets",
      }],
      sourceEmails,
      // Intentionally omit rawTables: multi-mail reports retain only the
      // integrated dataset and lightweight source metadata.
    },
  };
}

function skillSnapshotsFromContext(
  deps: WemailAgentToolDeps,
  ctx: AgentToolContext,
): SkillSnapshot[] {
  const resolved = deps.resolveSkillSnapshots?.(ctx.runContext);
  if (resolved && resolved.length > 0) return resolved;
  const read = ctx.runContext?.skillReadSnapshots;
  return Array.isArray(read)
    ? read.filter(isSkillSnapshot)
    : [];
}

function isSkillSnapshot(value: unknown): value is SkillSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<SkillSnapshot>;
  return (
    typeof snapshot.skillId === "string" &&
    typeof snapshot.version === "string" &&
    typeof snapshot.contentHash === "string" &&
    (snapshot.scope === "builtin" || snapshot.scope === "personal")
  );
}

function isBuiltInAutomationCapability(value: string | undefined, catalog: ReturnType<typeof automationCapabilityDiscovery>): boolean {
  if (!value) return false;
  return [
    ...catalog.triggers,
    ...catalog.schedules,
    ...catalog.conditionFields,
    ...catalog.conditionOperators,
    ...catalog.scopes,
    ...catalog.processors,
    ...catalog.actions,
  ].some((capability) => capability.id === value);
}

function normalizeAutomationDiscoveryInput(input: ToolInput, catalog: ReturnType<typeof automationCapabilityDiscovery>) {
  const requestedProvider = stringValue(input.provider);
  const capability = stringValue(input.capability);
  const query = stringValue(input.query);
  const requestsBuiltInCapability =
    (!requestedProvider || ["wemail", "mail", "core"].includes(requestedProvider)) &&
    (isBuiltInAutomationCapability(capability, catalog) || isBuiltInAutomationCapability(query, catalog));
  const builtInCapability = isBuiltInAutomationCapability(capability, catalog)
    ? capability
    : isBuiltInAutomationCapability(query, catalog)
      ? query
      : undefined;
  return {
    requestsBuiltInCapability,
    provider: requestsBuiltInCapability ? undefined : requestedProvider,
    capability: requestsBuiltInCapability ? undefined : capability,
    query: requestsBuiltInCapability ? undefined : query,
    builtInCapability,
  };
}

function accountIdFrom(input: ToolInput, ctx: AgentToolContext, deps: WemailAgentToolDeps) {
  return stringValue(input.accountId) ??
    stringValue(ctx.runContext?.accountId) ??
    deps.getActiveAccountId?.();
}

/**
 * Resolve the focused email's own timestamp (receivedAt, falling back to
 * sentAt) so a rolling-window association can anchor "最近 24 小时 / 最近 7 天"
 * to the email's send time instead of the wall clock. Snapshot failures are
 * non-fatal: the caller falls back to a now-anchored window.
 */
async function focusedEmailReceivedAt(
  deps: WemailAgentToolDeps,
  accountId: string | undefined,
  emailId: string,
): Promise<string | undefined> {
  const candidateIds = accountId && !emailId.startsWith(`${accountId}:`)
    ? [`${accountId}:${emailId}`, emailId]
    : [emailId];
  for (const id of candidateIds) {
    try {
      const snapshot = await deps.mailDatabase.getMailSnapshot(id, 8_000);
      const message = snapshot?.message;
      if (message) return message.receivedAt ?? message.sentAt ?? undefined;
    } catch {
      // Try the next id form; do not let a snapshot failure break association.
    }
  }
  return undefined;
}

function toolNameForAction(actionType: HighRiskActionType): string {
  if (actionType === "configure_smart_tag") return "propose_smart_tag_change";
  if (actionType === "configure_automation_rule") return "propose_automation_rule_change";
  if (actionType === "configure_writing_style") return "propose_writing_style_change";
  if (actionType === "configure_business_preferences") return "propose_business_preference_change";
  if (actionType === "schedule_send") return "propose_schedule_mail";
  if (actionType === "cancel_scheduled_send") return "propose_cancel_scheduled_mail";
  if (["move", "archive", "mark_spam", "permanent_delete", "bulk_mail_operation"].includes(actionType)) {
    return "propose_mail_operation";
  }
  if (actionType === "delete_draft") return "propose_delete_draft";
  return "propose_send_mail";
}

function propose(
  deps: WemailAgentToolDeps,
  ctx: AgentToolContext,
  input: {
    actionType: HighRiskActionType;
    description: string;
    payload: Record<string, unknown>;
    riskReason: string;
    emailId?: string;
  },
): { ok: true; pendingAction: AgentPendingAction; executed: false } {
  const configurationTaskId = stringValue(input.payload.configurationTaskId);
  if (configurationTaskId && ctx.sessionId) {
    const existing = deps.pendingActions.getPending(ctx.sessionId).find((row) => {
      if (row.action_type !== input.actionType) return false;
      try {
        const payload = JSON.parse(row.input_json) as Record<string, unknown>;
        return payload.configurationTaskId === configurationTaskId &&
          payload.configurationTaskRevision === input.payload.configurationTaskRevision;
      } catch {
        return false;
      }
    });
    if (existing) {
      return { ok: true, pendingAction: rowToAction(existing), executed: false };
    }
  }
  const id = `pending-${randomUUID()}`;
  const authorization = createPendingActionAuthorization(id, input.payload);
  const pendingAction: AgentPendingAction = {
    id,
    actionType: input.actionType,
    description: input.description,
    toolName: toolNameForAction(input.actionType),
    inputJson: JSON.stringify(input.payload),
    riskReason: input.riskReason,
    riskLevel: deriveRiskLevel(input.actionType),
    conversationId: ctx.sessionId,
    emailId: input.emailId,
    ...authorization,
  };
  deps.pendingActions.insert({
    id: pendingAction.id,
    conversationId: ctx.sessionId,
    actionType: input.actionType,
    description: input.description,
    inputJson: pendingAction.inputJson,
    riskReason: input.riskReason,
    riskLevel: pendingAction.riskLevel,
    emailId: input.emailId,
    ...authorization,
  });
  return { ok: true, pendingAction, executed: false };
}

function parseAddresses(value: unknown): WemailAddress[] {
  if (!Array.isArray(value)) return [];
  const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return value.flatMap((item) => {
    if (typeof item === "string" && validEmail(item.trim())) return [{ email: item.trim() }];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const email = stringValue(record.email);
    if (!email || !validEmail(email)) return [];
    const name = stringValue(record.name);
    return [{ email, ...(name ? { name } : {}) }];
  });
}

function parseOutboundAttachments(value: unknown): WemailOutboundAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("invalid-mail-attachment");
    }
    const record = item as Record<string, unknown>;
    const id = stringValue(record.id);
    const filename = stringValue(record.filename);
    const mimetype = stringValue(record.mimetype);
    const dataBase64 = stringValue(record.dataBase64);
    const size = typeof record.size === "number" ? record.size : Number.NaN;
    if (
      !id ||
      !filename ||
      !mimetype ||
      !dataBase64 ||
      !Number.isInteger(size) ||
      size < 0 ||
      size > 25 * 1024 * 1024
    ) {
      throw new Error("invalid-mail-attachment");
    }
    return { id, filename, mimetype, size, dataBase64 };
  });
}

const outboundAttachmentSchema = {
  type: "array",
  maxItems: 20,
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      filename: { type: "string" },
      mimetype: { type: "string" },
      size: { type: "number", minimum: 0, maximum: 25 * 1024 * 1024 },
      dataBase64: { type: "string" },
    },
    required: ["id", "filename", "mimetype", "size", "dataBase64"],
    additionalProperties: false,
  },
} as const;

function normalizeRule(input: ToolInput, accountId: string, ruleService?: AutomationRuleService) {
  const name = stringValue(input.name) ?? "";
  const trigger = input.trigger as AutomationTrigger | undefined;
  const conditions = (input.conditions === undefined ? {} : input.conditions) as AutomationConditions;
  const actions = (input.actions === undefined ? [] : input.actions) as AutomationAction[];
  const naturalLanguageCondition = input.naturalLanguageCondition as string | undefined;
  const conditionRules = (input.conditionRules === undefined
    ? []
    : input.conditionRules) as AutomationConditionRule[];
  const rule = {
    accountId,
    name,
    enabled: (input.enabled === undefined ? true : input.enabled) as boolean,
    trigger: trigger as AutomationTrigger,
    naturalLanguageCondition,
    conditions,
    conditionMode: (input.conditionMode === undefined ? "all" : input.conditionMode) as AutomationConditionMode,
    conditionRules,
    processing: input.processing as AutomationProcessing | undefined,
    actions,
  };
  if (ruleService) ruleService.validateDraft(rule);
  else assertValidAutomationRuleDraft(rule, undefined, {});
  return rule;
}

export function describeTemporalExpression(expression: TemporalExpression, fields: readonly AutomationFieldDefinition[] = AUTOMATION_FIELD_DEFINITIONS): string {
  if (expression.type === "field") {
    return fields.find(
      (definition) => definition.path === expression.path,
    )?.label ?? expression.path;
  }
  if (expression.type === "aggregate") {
    const prefix = expression.operator === "max" ? "最晚" : "最早";
    return `${prefix}${describeTemporalExpression(expression.values, fields)}`;
  }
  if (expression.type === "coalesce") {
    const [first, ...fallbacks] = flattenCoalesceValues(expression);
    if (!first) return "";
    return fallbacks.reduce((description, fallback, index) => {
      const fallbackDescription = describeTemporalExpression(fallback, fields);
      return index === 0
        ? `优先使用${description}，取不到时使用${fallbackDescription}`
        : `${description}，仍取不到时使用${fallbackDescription}`;
    }, describeTemporalExpression(first, fields));
  }
  const unit = expression.duration.unit === "minute"
    ? "分钟"
    : expression.duration.unit === "hour"
      ? "小时"
      : "天";
  return `${describeTemporalExpression(expression.base, fields)}后 ${expression.duration.amount} ${unit}`;
}

function flattenCoalesceValues(expression: TemporalExpression): TemporalExpression[] {
  if (expression.type !== "coalesce") return [expression];
  return expression.values.flatMap(flattenCoalesceValues);
}

function describeTrigger(trigger: AutomationTrigger, fields: readonly AutomationFieldDefinition[] = AUTOMATION_FIELD_DEFINITIONS): string {
  if (trigger.type === "manual") return "手动运行";
  if (trigger.type === "scheduled") return trigger.schedule?.type === "daily"
    ? `每天 ${trigger.schedule.localTime}（${trigger.schedule.timezone}）运行`
    : `每 ${trigger.schedule?.type === "interval" ? trigger.schedule.intervalMinutes : trigger.intervalMinutes} 分钟运行`;
  const execution = trigger.execution ?? { type: "immediate" as const };
  if (execution.type === "immediate") return "收到匹配邮件后立即执行";
  if (execution.type === "delay") {
    const unit = execution.unit === "minute" ? "分钟" : execution.unit === "hour" ? "小时" : "天";
    return `收到匹配邮件 ${execution.amount} ${unit}后执行`;
  }
  if (execution.type === "atExpression") {
    return `收到匹配邮件后，于${describeTemporalExpression(execution.expression, fields)}执行`;
  }
  return `收到匹配邮件后的下一自然日 ${execution.localTime}（${execution.timezone}）执行`;
}

function describeActions(actions: AutomationAction[], describeEditionAction?: (action: AutomationAction) => string | undefined): string {
  return actions.map((action) => {
    const editionDescription = describeEditionAction?.(action);
    if (editionDescription) return editionDescription;
    return action.type;
  }).join("、");
}

export function createWemailAgentTools(deps: WemailAgentToolDeps): AgentTool[] {
  // Effective allowance capability for the automation adapter clauses —
  // same contract as MailAgentTools' allowance tools: feature flag AND the
  // per-composition service. No global-registry fallback.
  const allowanceAdapterAvailable = deps.allowanceToolsEnabled === true && deps.allowance != null;
  const configurationFailures = new ConfigurationFailureAdapter();
  const configurationProjector = new ConfigurationOutcomeProjector();
  const searchDirectoryContacts: AgentTool = {
    name: "search_directory_contacts",
    description: "Search the active account's enterprise directory by colleague name, email, pinyin, department, or title. Use this before composing mail when the user names a colleague without an exact email address. Returns at most 20 candidates and never exposes credentials or Coremail session data.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        query: { type: "string" },
        departmentId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const query = stringValue(input.query);
      if (!accountId) return { ok: false, error: "accountId-required" };
      if (!query) return { ok: false, error: "directory-query-required" };
      const limit = typeof input.limit === "number" ? Math.min(20, Math.max(1, Math.floor(input.limit))) : 10;
      const result = await deps.directoryService.searchContacts(accountId, query, {
        departmentId: stringValue(input.departmentId),
        limit,
      });
      const matches = Array.isArray(result) ? result : result.contacts;
      const contacts = matches.map(({ mobile: _mobile, companyPhone: _companyPhone, ...contact }) => contact);
      return { ok: true, contacts };
    },
    observe: (output) => `Found ${((output as { contacts?: unknown[] }).contacts ?? []).length} directory contacts`,
  };

  const getDirectoryContact: AgentTool = {
    name: "get_directory_contact",
    description: "Get one enterprise-directory contact by stable contact id or exact email. Use only when the user needs the person's exact directory details.",
    inputSchema: {
      type: "object",
      properties: { accountId: { type: "string" }, idOrEmail: { type: "string" } },
      required: ["idOrEmail"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const idOrEmail = stringValue(input.idOrEmail);
      if (!accountId) return { ok: false, error: "accountId-required" };
      if (!idOrEmail) return { ok: false, error: "idOrEmail-required" };
      const contact = await deps.directoryService.getContact(accountId, idOrEmail);
      return contact ? { ok: true, contact } : { ok: false, error: "contact-not-found" };
    },
  };

  const listDirectoryDepartments: AgentTool = {
    name: "list_directory_departments",
    description: "List one level of the enterprise organization tree. This does not export all employee records.",
    inputSchema: {
      type: "object",
      properties: { accountId: { type: "string" }, parentId: { type: "string" } },
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      if (!accountId) return { ok: false, error: "accountId-required" };
      return { ok: true, departments: (await deps.directoryService.listDepartments(accountId, stringValue(input.parentId))).slice(0, 100) };
    },
  };

  const resolveDirectoryRecipients: AgentTool = {
    name: "resolve_directory_recipients",
    description: "Resolve colleague names, department-qualified names, or email addresses into canonical recipients. If status is ambiguous, ask the user to choose; never guess between candidates.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        inputs: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
      },
      required: ["inputs"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const inputs = Array.isArray(input.inputs)
        ? input.inputs.map(stringValue).filter((item): item is string => !!item).slice(0, 20)
        : [];
      if (!accountId) return { ok: false, error: "accountId-required" };
      if (inputs.length === 0) return { ok: false, error: "recipient-inputs-required" };
      return { ok: true, resolutions: await deps.directoryService.resolveRecipients(accountId, inputs) };
    },
  };

  const getDirectoryStatus: AgentTool = {
    name: "get_directory_status",
    description: "Read enterprise-directory initialization and refresh status for the active account.",
    inputSchema: { type: "object", properties: { accountId: { type: "string" } }, additionalProperties: false },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      if (!accountId) return { ok: false, error: "accountId-required" };
      return { ok: true, status: await deps.directoryService.getStatus(accountId) };
    },
  };

  const refreshDirectory: AgentTool = {
    name: "refresh_directory",
    description: "Start a manual background refresh of the active enterprise directory. A duplicate request shares the running refresh.",
    inputSchema: { type: "object", properties: { accountId: { type: "string" } }, additionalProperties: false },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      if (!accountId) return { ok: false, error: "accountId-required" };
      void deps.directoryService.refresh(accountId).catch(() => undefined);
      return { ok: true, status: await deps.directoryService.getStatus(accountId) };
    },
  };

  const listSmartTags: AgentTool = {
    name: "list_smart_tags",
    description: "List user-defined smart tags for the active WeMail account.",
    inputSchema: {
      type: "object",
      properties: { accountId: { type: "string" } },
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      if (!accountId) return { ok: false, error: "accountId-required" };
      return { ok: true, tags: deps.userTags.listByAccount(accountId) };
    },
    observe: (output) => `Loaded ${((output as { tags?: unknown[] }).tags ?? []).length} smart tags`,
  };

  const proposeSmartTagChange: AgentTool = {
    name: "propose_smart_tag_change",
    description: "Propose creating, updating, or deleting a smart tag. The user must confirm the configuration change.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["create", "update", "delete"] },
        accountId: { type: "string" },
        tagId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const operation = stringValue(input.operation);
      const tagId = stringValue(input.tagId);
      const name = stringValue(input.name);
      if (!accountId) return { ok: false, error: "accountId-required" };
      if (!operation || !["create", "update", "delete"].includes(operation)) {
        return { ok: false, error: "invalid-smart-tag-operation" };
      }
      if (operation === "create" && !name) return { ok: false, error: "smart-tag-name-required" };
      if (operation !== "create" && !tagId) return { ok: false, error: "tagId-required" };
      return propose(deps, ctx, {
        actionType: "configure_smart_tag",
        description: `${operation === "create" ? "创建" : operation === "update" ? "修改" : "删除"}智能标签${name ? `“${name}”` : ""}`,
        payload: {
          operation,
          accountId,
          tagId,
          name,
          description: typeof input.description === "string" ? input.description : undefined,
          prompt: typeof input.prompt === "string" ? input.prompt : undefined,
        },
        riskReason: "This changes WeMail smart-tag configuration and requires user confirmation.",
      });
    },
  };

  const listAutomationRules: AgentTool = {
    name: "list_automation_rules",
    description: "List automation rules for the active WeMail account, including triggers and actions.",
    inputSchema: {
      type: "object",
      properties: { accountId: { type: "string" } },
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      if (!accountId) return { ok: false, error: "accountId-required" };
      return { ok: true, rules: deps.rules.list(accountId) };
    },
    observe: (output) => `Loaded ${((output as { rules?: unknown[] }).rules ?? []).length} automation rules`,
  };

  const startAutomationConfiguration: AgentTool = {
    name: "start_automation_configuration",
    description: "Start or resume the durable configuration task for an automation-rule change. Call this before capability discovery so prerequisites, blocking issues, preview authorization, commit, and verification share one user-readable lifecycle.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        operation: { type: "string", enum: ["create", "update", "enable", "disable", "delete", "repair"] },
        targetKey: { type: "string" },
        title: { type: "string" },
      },
      required: ["operation", "targetKey", "title"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const operation = stringValue(input.operation);
      const targetKey = stringValue(input.targetKey);
      const title = stringValue(input.title);
      if (!accountId) return { ok: false, error: "accountId-required" };
      if (!deps.configurationWorkflow) return { ok: false, error: "configuration-workflow-unavailable" };
      if (!operation || !["create", "update", "enable", "disable", "delete", "repair"].includes(operation)) {
        return { ok: false, error: "invalid-automation-operation" };
      }
      if (!targetKey || !title) return { ok: false, error: "configuration-target-and-title-required" };
      let task = deps.configurationWorkflow.start({
        accountId,
        sessionId: ctx.sessionId,
        kind: "automation_rule",
        operation: operation as "create" | "update" | "enable" | "disable" | "delete" | "repair",
        targetKey,
        title,
        source: { surface: "agent", sourceId: ctx.sessionId },
      });
      const prerequisite = task.steps.find((step) => step.phase === "check_prerequisites");
      if (prerequisite?.status === "running") {
        task = deps.configurationWorkflow.completePhase({
          taskId: task.id,
          accountId,
          expectedRevision: task.revision,
          phase: "check_prerequisites",
          summary: "账号与配置任务已就绪",
        });
      }
      return {
        ok: true,
        configurationTask: task,
        configurationOutcome: configurationProjector.project(task),
      };
    },
  };

  const discoverAutomationCapabilities: AgentTool = {
    name: "discover_automation_capabilities",
    description: "Discover current automation providers and capabilities before composing a rule. Built-in triggers, schedules, conditions, and collection scopes are core capabilities; omit provider when looking them up. Discover installed providers before using their operations.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        configurationTaskId: { type: "string" },
        provider: { type: "string" },
        capability: { type: "string" },
        query: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const builtInCatalog = deps.ruleService?.capabilities() ?? automationCapabilityDiscovery({});
      if (!deps.providers) return { ok: true, capabilities: builtInCatalog };
      const normalizedDiscovery = normalizeAutomationDiscoveryInput(input, builtInCatalog);
      const discoveryInput = {
        provider: normalizedDiscovery.provider,
        capability: normalizedDiscovery.capability,
        query: normalizedDiscovery.query,
      };
      const taskId = stringValue(input.configurationTaskId);
      const accountId = accountIdFrom(input, ctx, deps);
      const discover = async () => {
        const filtered = await deps.providers!.discoverWithStatus(discoveryInput);
        if (!discoveryInput.provider) return filtered;
        const requested = filtered.providers.find(
          (item) => item.provider === discoveryInput.provider,
        );
        if (!requested || requested.status !== "available" || requested.capabilityCount > 0) {
          return filtered;
        }
        const providerCatalog = await deps.providers!.discoverWithStatus({
          provider: discoveryInput.provider,
        });
        const catalogProvider = providerCatalog.providers.find(
          (item) => item.provider === discoveryInput.provider,
        );
        return catalogProvider?.status === "available" && catalogProvider.capabilityCount > 0
          ? providerCatalog
          : filtered;
      };
      let configurationTask;
      let discovery;
      if (taskId && accountId && deps.configurationWorkflow) {
        const task = deps.configurationWorkflow.get(taskId, accountId);
        if (!task) return { ok: false, error: "configuration-task-not-found" };
        const phase = await deps.configurationWorkflow.runPhase({
          taskId,
          accountId,
          expectedRevision: task.revision,
          phase: "discover_capabilities",
          hooks: {
            run: async () => {
              const value = await discover();
              const requestedProvider = discoveryInput.provider
                ? value.providers.find((item) => item.provider === discoveryInput.provider)
                : undefined;
              if (requestedProvider?.status === "unavailable" && requestedProvider.issue) {
                return {
                  status: "unavailable" as const,
                  effectState: "none" as const,
                  issue: requestedProvider.issue,
                  partialValue: value,
                };
              }
              if (requestedProvider && requestedProvider.capabilityCount === 0) {
                return configurationFailures.unavailable({
                  code: discoveryInput.provider === "bot-message"
                    ? "resource_unavailable"
                    : "capability_unsupported",
                  phase: "discover_capabilities",
                  provider: discoveryInput.provider,
                  capability: discoveryInput.capability ?? discoveryInput.query,
                  message: discoveryInput.provider === "bot-message"
                    ? "没有已连接且可投递的飞书或企业微信 Bot，因此通知步骤尚未执行。"
                    : undefined,
                  partialValue: value,
                  affectedScope: [`provider:${discoveryInput.provider}`],
                  unaffectedScope: value.providers
                    .filter((item) => item.status === "available" && item.capabilityCount > 0)
                    .map((item) => `provider:${item.provider}`),
                });
              }
              return { status: "succeeded" as const, effectState: "none" as const, value };
            },
          },
          successSummary: (value) => `已发现 ${value.capabilities.length} 项可用能力`,
        });
        configurationTask = phase.task;
        discovery = phase.result.status === "succeeded"
          ? phase.result.value
          : phase.result.status === "unavailable"
            ? phase.result.partialValue
            : undefined;
      } else {
        discovery = await discover();
      }
      return {
        ok: true,
        ...(discovery ?? { capabilities: [], providers: [] }),
        ...(normalizedDiscovery.requestsBuiltInCapability
          ? {
              builtInCapability: normalizedDiscovery.builtInCapability,
              builtInCatalog,
            }
          : {}),
        registryFingerprint: await deps.providers.fingerprint(),
        ...(configurationTask ? { configurationTask } : {}),
        ...(configurationTask
          ? { configurationOutcome: configurationProjector.project(configurationTask) }
          : {}),
      };
    },
    observe: (output) => `Discovered ${((output as { capabilities?: unknown[] }).capabilities ?? []).length} automation capabilities`,
  };

  const previewAutomationRule: AgentTool = {
    name: "preview_automation_rule",
    description: `Validate and dry-run an automation rule before proposing it. Supports mail-received immediate, delay, nextDayAt, and catalog-backed atExpression timing${allowanceAdapterAvailable ? deps.editionPreviewSuffix ?? "" : ""}.`,
    inputSchema: ruleSchema(false, deps.ruleService?.fieldDefinitions()),
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      if (!accountId) return { ok: false, error: "accountId-required" };
      try {
        const rule = normalizeRule(input, accountId, deps.ruleService);
        if (deps.ruleService) {
          const preview = deps.ruleService.preview(rule, stringValue(input.sourceRuleId));
          return { ok: true, rule: preview.normalizedRule, preview };
        }
        const dryRun = deps.dryRunner.dryRunDraft(
          { id: `agent-preview-${randomUUID()}`, accountId, conditions: rule.conditions, actions: rule.actions },
          accountId,
        );
        return { ok: true, rule, dryRun };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  const previewPipelineAutomationRule: AgentTool = {
    name: "preview_pipeline_automation_rule",
    description: "Compile and dry-run a V2 provider pipeline after capability discovery. Use this for multi-step processing, design artifacts, and application-message delivery.",
    inputSchema: {
      type: "object",
      properties: {
        schemaVersion: { type: "number", enum: [2] }, accountId: { type: "string" }, configurationTaskId: { type: "string" }, name: { type: "string" }, description: { type: "string" }, enabled: { type: "boolean" },
        trigger: { type: "object" }, naturalLanguageCondition: { type: "string" }, conditions: { type: "object" }, conditionMode: { type: "string", enum: ["all", "any"] }, conditionRules: { type: "array", items: { type: "object" } }, collection: { type: "object" }, pipeline: { type: "array", minItems: 1, items: { type: "object" } },
      },
      required: ["schemaVersion", "name", "enabled", "trigger", "conditions", "pipeline"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      if (!accountId || !deps.pipelineRuleService) return { ok: false, error: accountId ? "pipeline-runtime-unavailable" : "accountId-required" };
      const taskId = stringValue(input.configurationTaskId);
      const { configurationTaskId: _configurationTaskId, ...draftInput } = input;
      try {
        let preview;
        let configurationTask;
        if (taskId && deps.configurationWorkflow) {
          const task = deps.configurationWorkflow.get(taskId, accountId);
          if (!task) return { ok: false, error: "configuration-task-not-found" };
          const phase = await deps.configurationWorkflow.runPhase({
            taskId,
            accountId,
            expectedRevision: task.revision,
            phase: "generate_preview",
            hooks: {
              run: async () => {
                try {
                  const value = await deps.pipelineRuleService!.preview(
                    { ...draftInput, accountId } as unknown as AutomationRuleV2Draft,
                  );
                  return { status: "succeeded" as const, effectState: "none" as const, value };
                } catch (error) {
                  return configurationFailures.failed({
                    error,
                    phase: "generate_preview",
                    provider: "automation-pipeline",
                  });
                }
              },
            },
            successSummary: () => "配置预览已生成并通过校验",
          });
          if (phase.result.status !== "succeeded") {
            return {
              ok: false,
              error: phase.result.issue.code,
              configurationTask: phase.task,
              configurationOutcome: configurationProjector.project(phase.task),
            };
          }
          preview = phase.result.value;
          configurationTask = deps.configurationWorkflow.recordPreview({
            taskId,
            accountId,
            expectedRevision: phase.task.revision,
            previewId: preview.previewId,
            previewHash: preview.ruleHash,
            expiresAt: preview.expiresAt,
            capabilityFingerprints: preview.capabilitySnapshots.map((item) => ({
              provider: item.provider,
              capability: item.capability,
              fingerprint: item.fingerprint,
            })),
            risk: preview.risk,
          });
        } else {
          preview = await deps.pipelineRuleService.preview(
            { ...draftInput, accountId } as unknown as AutomationRuleV2Draft,
          );
        }
        return {
          ok: true,
          preview,
          ...(configurationTask
            ? {
                configurationTask,
                configurationOutcome: configurationProjector.project(configurationTask),
              }
            : {}),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  const proposeAutomationRuleChange: AgentTool = {
    name: "propose_automation_rule_change",
    description: "Propose creating, updating, enabling, disabling, or deleting an automation rule after preview. Confirmation authorizes later automatic executions without asking PI again.",
    inputSchema: ruleSchema(true, deps.ruleService?.fieldDefinitions()),
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const operation = stringValue(input.operation);
      const ruleId = stringValue(input.ruleId);
      const previewId = stringValue(input.previewId);
      const ruleHash = stringValue(input.ruleHash);
      const configurationTaskId = stringValue(input.configurationTaskId);
      const configurationTaskRevision = typeof input.configurationTaskRevision === "number"
        ? Math.floor(input.configurationTaskRevision)
        : undefined;
      if (!accountId) return { ok: false, error: "accountId-required" };
      if (!operation || !["create", "update", "enable", "disable", "delete"].includes(operation)) {
        return { ok: false, error: "invalid-automation-operation" };
      }
      if (operation !== "create" && !ruleId) return { ok: false, error: "ruleId-required" };
      try {
        if (
          input.pipelineVersion === 2 &&
          deps.configurationWorkflow &&
          (!configurationTaskId || configurationTaskRevision === undefined)
        ) {
          return { ok: false, error: "configuration-task-id-and-revision-required" };
        }
        if ((operation === "create" || operation === "update") && deps.ruleService && (!previewId || !ruleHash)) {
          return { ok: false, error: "automation-preview-id-and-hash-required" };
        }
        if (configurationTaskId && deps.configurationWorkflow) {
          const task = deps.configurationWorkflow.get(configurationTaskId, accountId);
          if (!task) return { ok: false, error: "configuration-task-not-found" };
          if (configurationTaskRevision !== task.revision) {
            return { ok: false, error: "configuration-task-revision-mismatch" };
          }
          const authorization = task.authorization;
          if (
            task.status !== "awaiting_confirmation" ||
            authorization?.previewId !== previewId ||
            authorization?.previewHash !== ruleHash
          ) {
            return { ok: false, error: "configuration-preview-authorization-mismatch" };
          }
        }
        const rule = operation === "create" || operation === "update"
          ? (deps.ruleService ? undefined : normalizeRule(input, accountId, deps.ruleService))
          : undefined;
        return propose(deps, ctx, {
          actionType: "configure_automation_rule",
          description: rule
            ? `${operation === "create" ? "创建" : "修改"}自动化规则“${rule.name}”：${describeTrigger(rule.trigger, deps.ruleService?.fieldDefinitions())}；条件：${rule.naturalLanguageCondition ?? "结构化条件"}；动作：${describeActions(rule.actions, (action) => (allowanceAdapterAvailable ? deps.describeEditionAction?.(action) : undefined) ?? deps.describeWecliAction?.(action))}`
            : operation === "create" || operation === "update"
              ? `${operation === "create" ? "创建" : "修改"}自动化规则（按预览快照）`
              : `${operation === "enable" ? "启用" : operation === "disable" ? "停用" : "删除"}自动化规则`,
          payload: {
            operation,
            ruleId,
            accountId,
            rule,
            previewId,
            ruleHash,
            pipelineVersion: input.pipelineVersion === 2 ? 2 : 1,
            configurationTaskId,
            configurationTaskRevision,
          },
          riskReason: "This changes a persistent automation rule. Once confirmed, matching executions run automatically within the authorized scope.",
        });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  const proposeSendMail: AgentTool = {
    name: "propose_send_mail",
    description: "Propose sending a fully specified email. Sending only occurs after explicit user confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        draftId: { type: "string" },
        originalEmailId: { type: "string" },
        threadId: { type: "string" },
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        bodyText: { type: "string" },
        bodyHtml: { type: "string" },
        attachments: outboundAttachmentSchema,
      },
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const draftId = stringValue(input.draftId);
      const savedDraft = draftId && accountId
        ? await deps.mailDatabase.getDraft({ accountId, id: draftId })
        : null;
      if (draftId && (!savedDraft || savedDraft.accountId !== accountId)) {
        return { ok: false, error: "draft-not-found" };
      }
      const to = savedDraft?.to ?? parseAddresses(input.to);
      const subject = savedDraft?.subject ?? stringValue(input.subject);
      const bodyText = savedDraft?.bodyText ?? (typeof input.bodyText === "string" ? input.bodyText : "");
      if (!accountId) return { ok: false, error: "accountId-required" };
      if (to.length === 0) return { ok: false, error: "recipient-required" };
      if (!subject) return { ok: false, error: "subject-required" };
      if (!bodyText.trim()) return { ok: false, error: "body-required" };
      const originalEmailId = savedDraft?.originalEmailId ?? stringValue(input.originalEmailId) ?? stringValue(ctx.runContext?.emailId);
      return propose(deps, ctx, {
        actionType: "send",
        description: `发送邮件“${subject}”给 ${to.map((item) => item.email).join(", ")}`,
        emailId: originalEmailId,
        payload: {
          accountId,
          draftId,
          originalEmailId,
          threadId: stringValue(input.threadId) ?? stringValue(ctx.runContext?.threadId),
          to,
          cc: savedDraft?.cc ?? parseAddresses(input.cc),
          bcc: savedDraft?.bcc ?? parseAddresses(input.bcc),
          subject,
          bodyText,
          bodyHtml: savedDraft?.bodyHtml ?? (typeof input.bodyHtml === "string" ? input.bodyHtml : bodyText),
          attachments: savedDraft?.attachments ?? parseOutboundAttachments(input.attachments),
        },
        riskReason: "Sending email is an external side effect and requires explicit confirmation.",
      });
    },
  };

  const setMailState: AgentTool = {
    name: "set_mail_state",
    description: "Directly mark a mail read/unread or star/unstar. These reversible local mail-state changes do not require confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        emailIds: { type: "array", items: { type: "string" }, maxItems: 100 },
        operation: { type: "string", enum: ["mark_read", "mark_unread", "star", "unstar", "mark_important", "mark_not_important"] },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const emailIds = Array.isArray(input.emailIds)
        ? input.emailIds.map(stringValue).filter((item): item is string => !!item).slice(0, 100)
        : [];
      const focusedId = stringValue(input.emailId);
      if (focusedId && !emailIds.includes(focusedId)) emailIds.unshift(focusedId);
      const operation = stringValue(input.operation);
      if (!accountId || emailIds.length === 0 || !operation) return { ok: false, error: "accountId-emailId-operation-required" };
      if (emailIds.length !== 1) {
        return {
          ok: false,
          executed: false,
          requires_confirmation: true,
          error: "batch-mail-state-change-requires-confirmation",
        };
      }
      const patch = operation === "mark_read"
        ? { seen: true }
        : operation === "mark_unread"
          ? { seen: false }
          : operation === "star" || operation === "mark_important"
            ? { flagged: true }
            : operation === "unstar" || operation === "mark_not_important"
              ? { flagged: false }
              : undefined;
      if (!patch) return { ok: false, error: "invalid-mail-state-operation" };
      const messages = await Promise.all(emailIds.map(async (emailId) => {
        const snapshot = await deps.mailDatabase.getMailSnapshot(emailId);
        if (!snapshot.message || snapshot.message.accountId !== accountId) return { id: emailId, ok: false };
        const result = await deps.mailDatabase.mutateMail(
          { accountId, emailId, mutation: { type: "flags", patch } },
          `agent-state:${ctx.sessionId ?? "standalone"}:${emailId}:${operation}:${randomUUID()}`,
        );
        return { id: emailId, ok: true, flags: result.value.message?.flags };
      }));
      return { ok: messages.every((item) => item.ok), messages };
    },
  };

  const setMailSmartTag: AgentTool = {
    name: "set_mail_smart_tag",
    description: "Apply or remove an existing user-defined smart tag on one email.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        emailId: { type: "string" },
        tagId: { type: "string" },
        operation: { type: "string", enum: ["apply", "remove"] },
      },
      required: ["emailId", "tagId", "operation"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const emailId = stringValue(input.emailId);
      const tagId = stringValue(input.tagId);
      const operation = stringValue(input.operation);
      if (!accountId || !emailId || !tagId) return { ok: false, error: "accountId-emailId-tagId-required" };
      const message = (await deps.mailDatabase.getMailSnapshot(emailId)).message;
      const tag = deps.userTags.getById(tagId);
      if (!message || !tag || tag.accountId !== accountId) return { ok: false, error: "mail-or-tag-not-found" };
      if (operation === "apply") {
        deps.emailSmartTags.upsert({ accountId, emailId, userTagId: tagId, source: "user" });
      } else if (operation === "remove") {
        deps.emailSmartTags.remove(emailId, tagId);
      } else {
        return { ok: false, error: "invalid-tag-operation" };
      }
      return { ok: true, operation, emailId, tagId };
    },
  };

  const saveMailDraft: AgentTool = {
    name: "save_mail_draft",
    description: "Create or update a persistent WeMail draft without sending it. When draftId is provided, create the draft with that exact id if it does not exist, or update the existing draft if it does.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        draftId: {
          type: "string",
          description: "Stable draft id supplied by the caller. The first call creates this id; later calls update the same draft.",
        },
        draftType: { type: "string", enum: ["new", "reply", "forward"] },
        originalEmailId: { type: "string" },
        threadId: { type: "string" },
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        bodyText: { type: "string" },
        bodyHtml: { type: "string" },
        attachments: outboundAttachmentSchema,
      },
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      if (!accountId) return { ok: false, error: "accountId-required" };
      const draftId = stringValue(input.draftId);
      const existing = draftId ? await deps.mailDatabase.getDraft({ accountId, id: draftId }) : null;
      if (existing && existing.accountId !== accountId) {
        return { ok: false, error: "draft-not-found" };
      }
      const originalEmailId = stringValue(input.originalEmailId) ?? existing?.originalEmailId ?? stringValue(ctx.runContext?.emailId);
      const draftInput = {
        accountId,
        originalEmailId,
        to: input.to === undefined ? existing?.to ?? [] : parseAddresses(input.to),
        cc: input.cc === undefined ? existing?.cc ?? [] : parseAddresses(input.cc),
        bcc: input.bcc === undefined ? existing?.bcc ?? [] : parseAddresses(input.bcc),
        subject: typeof input.subject === "string" ? input.subject : existing?.subject ?? "",
        bodyText: typeof input.bodyText === "string" ? input.bodyText : existing?.bodyText ?? "",
        bodyHtml: typeof input.bodyHtml === "string" ? input.bodyHtml : existing?.bodyHtml,
        attachments: [] as never[],
      };
      if (input.attachments !== undefined && parseOutboundAttachments(input.attachments).length > 0) {
        return { ok: false, error: "draft-attachments-must-be-staged" };
      }
      const result = await deps.mailDatabase.saveDraft({
        ...(draftId ? { id: draftId } : {}),
        ...draftInput,
        bodyHtml: draftInput.bodyHtml ?? draftInput.bodyText,
      });
      const draft = result.value;
      return { ok: true, draft: { id: draft.id, subject: draft.subject, updatedAt: draft.updatedAt } };
    },
  };

  const listMailDrafts: AgentTool = {
    name: "list_mail_drafts",
    description: "List persistent drafts for the active account.",
    inputSchema: { type: "object", properties: { accountId: { type: "string" } }, additionalProperties: false },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      if (!accountId) return { ok: false, error: "accountId-required" };
      return {
        ok: true,
        drafts: (await deps.mailDatabase.listDrafts({ accountId, limit: 100 })).map((draft) => ({
          id: draft.id,
          type: draft.type,
          to: draft.to,
          subject: draft.subject,
          updatedAt: draft.updatedAt,
          bodyExcerpt: draft.bodyText.slice(0, 240),
        })),
      };
    },
  };

  const listScheduledMail: AgentTool = {
    name: "list_scheduled_mail",
    description: "List scheduled outgoing mail for the active account.",
    inputSchema: { type: "object", properties: { accountId: { type: "string" } }, additionalProperties: false },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      if (!accountId) return { ok: false, error: "accountId-required" };
      return {
        ok: true,
        scheduled: (await deps.scheduledSend.listScheduled(accountId)).map((item) => ({
          id: item.id,
          to: item.payload.to,
          subject: item.payload.subject,
          sendAt: item.sendAt,
          status: item.status,
          lastError: item.lastError,
        })),
      };
    },
  };

  const getMailDraft: AgentTool = {
    name: "get_mail_draft",
    description: "Read one targeted saved draft so it can be reviewed, edited, scheduled, or proposed for sending.",
    inputSchema: {
      type: "object",
      properties: { accountId: { type: "string" }, draftId: { type: "string" } },
      required: ["draftId"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const draftId = stringValue(input.draftId);
      const draft = draftId && accountId
        ? await deps.mailDatabase.getDraft({ accountId, id: draftId })
        : null;
      if (!accountId || !draft || draft.accountId !== accountId) return { ok: false, error: "draft-not-found" };
      return { ok: true, draft };
    },
    observe: (output) => (output as { ok?: boolean }).ok ? "Loaded one saved draft" : "Draft not found",
  };

  const proposeDeleteDraft: AgentTool = {
    name: "propose_delete_draft",
    description: "Propose permanently deleting a saved draft. Requires confirmation.",
    inputSchema: {
      type: "object",
      properties: { draftId: { type: "string" } },
      required: ["draftId"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const draftId = stringValue(input.draftId);
      const draft = draftId && accountId
        ? await deps.mailDatabase.getDraft({ accountId, id: draftId })
        : null;
      if (!accountId || !draftId || !draft || draft.accountId !== accountId) {
        return { ok: false, error: "draft-not-found" };
      }
      return propose(deps, ctx, {
        actionType: "delete_draft",
        description: `删除草稿“${draft.subject || "无主题"}”`,
        payload: { accountId, draftId },
        riskReason: "Deleting a saved draft is irreversible and requires confirmation.",
      });
    },
  };

  const proposeScheduleMail: AgentTool = {
    name: "propose_schedule_mail",
    description: "Propose scheduling a fully specified email for a future time. Requires confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        draftId: { type: "string" },
        sendAt: { type: "string" },
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        bodyText: { type: "string" },
        bodyHtml: { type: "string" },
        attachments: outboundAttachmentSchema,
      },
      required: ["sendAt"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const draftId = stringValue(input.draftId);
      const savedDraft = draftId && accountId
        ? await deps.mailDatabase.getDraft({ accountId, id: draftId })
        : null;
      if (draftId && (!savedDraft || savedDraft.accountId !== accountId)) {
        return { ok: false, error: "draft-not-found" };
      }
      const sendAt = stringValue(input.sendAt);
      const to = savedDraft?.to ?? parseAddresses(input.to);
      const subject = savedDraft?.subject ?? stringValue(input.subject);
      const bodyText = savedDraft?.bodyText ?? (typeof input.bodyText === "string" ? input.bodyText : "");
      if (!accountId || !sendAt || to.length === 0 || !subject || !bodyText.trim()) {
        return { ok: false, error: "schedule-fields-required" };
      }
      const date = new Date(sendAt);
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) return { ok: false, error: "sendAt-must-be-future" };
      return propose(deps, ctx, {
        actionType: "schedule_send",
        description: `定时发送邮件“${subject}”，时间：${date.toISOString()}`,
        payload: {
          accountId,
          sendAt: date.toISOString(),
          draft: {
            accountId,
            originalEmailId: savedDraft?.originalEmailId,
            to,
            cc: savedDraft?.cc ?? parseAddresses(input.cc),
            bcc: savedDraft?.bcc ?? parseAddresses(input.bcc),
            subject,
            bodyText,
            bodyHtml: savedDraft?.bodyHtml ?? (typeof input.bodyHtml === "string" ? input.bodyHtml : bodyText),
            attachments: savedDraft?.attachments ?? parseOutboundAttachments(input.attachments),
          },
        },
        riskReason: "Scheduling mail creates a future external send and requires confirmation.",
      });
    },
  };

  const proposeMailOperation: AgentTool = {
    name: "propose_mail_operation",
    description: "Propose moving, archiving, trashing, marking spam, restoring, or permanently deleting one email. To DELETE an email (删除/删掉) use operation='permanent_delete' (彻底删除，不可恢复). Use operation='trash' (移到回收站) only when the user explicitly asks for the recycle bin / 垃圾箱. These operations require confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        emailIds: { type: "array", items: { type: "string" }, maxItems: 100 },
        operation: { type: "string", enum: ["move", "archive", "trash", "spam", "restore", "permanent_delete"] },
        targetFolder: { type: "string" },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const emailIds = Array.isArray(input.emailIds)
        ? input.emailIds.map(stringValue).filter((item): item is string => !!item).slice(0, 100)
        : [];
      const emailId = stringValue(input.emailId) ?? stringValue(ctx.runContext?.emailId);
      if (emailId && !emailIds.includes(emailId)) emailIds.unshift(emailId);
      const operation = stringValue(input.operation);
      if (!accountId || emailIds.length === 0 || !operation) return { ok: false, error: "mail-operation-fields-required" };
      const snapshots = await Promise.all(emailIds.map((id) => deps.mailDatabase.getMailSnapshot(id)));
      if (snapshots.some((snapshot) => !snapshot.message || snapshot.message.accountId !== accountId)) {
        return { ok: false, error: "mail-not-found" };
      }
      const actionType: HighRiskActionType = emailIds.length > 1
        ? "bulk_mail_operation"
        : operation === "archive"
        ? "archive"
        : operation === "spam"
          ? "mark_spam"
          : operation === "permanent_delete"
            ? "permanent_delete"
            : "move";
      const targetFolder = operation === "trash"
        ? "Trash"
        : operation === "restore"
          ? "INBOX"
          : stringValue(input.targetFolder);
      if (operation === "move" && !targetFolder) return { ok: false, error: "targetFolder-required" };
      return propose(deps, ctx, {
        actionType,
        emailId: emailIds[0],
        description: `${operation === "permanent_delete" ? "永久删除" : operation === "archive" ? "归档" : operation === "spam" ? "标记垃圾邮件" : "移动"} ${emailIds.length} 封邮件`,
        payload: { accountId, operation, targetFolder, emailIds },
        riskReason: "This mail operation changes mailbox state and requires explicit confirmation.",
      });
    },
  };

  const proposeCancelScheduledMail: AgentTool = {
    name: "propose_cancel_scheduled_mail",
    description: "Propose cancelling a pending scheduled email. Requires confirmation.",
    inputSchema: {
      type: "object",
      properties: { scheduledId: { type: "string" } },
      required: ["scheduledId"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const scheduledId = stringValue(input.scheduledId);
      if (!scheduledId) return { ok: false, error: "scheduledId-required" };
      return propose(deps, ctx, {
        actionType: "cancel_scheduled_send",
        description: "取消定时发送邮件",
        payload: { scheduledId },
        riskReason: "Cancelling a scheduled send changes an approved future mail action and requires confirmation.",
      });
    },
  };

  const listWritingStyles: AgentTool = {
    name: "list_writing_styles",
    description: "List WeMail writing styles available to draft generation.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      return { ok: true, styles: deps.aiProfile.listStyles() };
    },
  };

  const proposeWritingStyleChange: AgentTool = {
    name: "propose_writing_style_change",
    description: "Propose creating, updating, or deleting a writing style. Requires confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["create", "update", "delete"] },
        styleId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        instructions: { type: "string" },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const operation = stringValue(input.operation);
      const styleId = stringValue(input.styleId);
      const name = stringValue(input.name);
      const instructions = stringValue(input.instructions);
      if (!operation || !["create", "update", "delete"].includes(operation)) return { ok: false, error: "invalid-style-operation" };
      if (operation === "create" && (!name || !instructions)) return { ok: false, error: "style-name-instructions-required" };
      if (operation !== "create" && !styleId) return { ok: false, error: "styleId-required" };
      return propose(deps, ctx, {
        actionType: "configure_writing_style",
        description: `${operation === "create" ? "创建" : operation === "update" ? "修改" : "删除"}写作风格${name ? `“${name}”` : ""}`,
        payload: {
          operation,
          styleId,
          name,
          description: typeof input.description === "string" ? input.description : undefined,
          instructions,
        },
        riskReason: "This changes WeMail writing-style configuration and requires confirmation.",
      });
    },
  };

  const getBusinessPreferences: AgentTool = {
    name: "get_business_preferences",
    description: "Read non-sensitive WeMail inbox, compose, notification, and language preferences. Security and credential settings are excluded.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      return { ok: true, preferences: deps.businessPreferences.get() };
    },
  };

  const proposeBusinessPreferenceChange: AgentTool = {
    name: "propose_business_preference_change",
    description: "Propose changing non-sensitive inbox, compose, notification, or language preferences. Requires confirmation. Cannot change security or credential settings.",
    inputSchema: {
      type: "object",
      properties: {
        inboxDensity: { type: "string", enum: ["comfortable", "compact"] },
        threading: { type: "boolean" },
        readingPane: { type: "string", enum: ["side", "off"] },
        sendShortcut: { type: "string", enum: ["cmd-enter", "ctrl-enter", "off"] },
        actionRequiredNotifications: { type: "boolean" },
        newMailNotifications: { type: "boolean" },
        notificationSound: { type: "boolean" },
        dailyDigest: { type: "boolean" },
        interfaceLanguage: { type: "string", enum: ["auto", "zh-CN", "en"] },
      },
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const allowedKeys = [
        "inboxDensity",
        "threading",
        "readingPane",
        "sendShortcut",
        "actionRequiredNotifications",
        "newMailNotifications",
        "notificationSound",
        "dailyDigest",
        "interfaceLanguage",
      ];
      const patch = Object.fromEntries(
        allowedKeys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]),
      );
      if (Object.keys(patch).length === 0) return { ok: false, error: "preference-change-required" };
      return propose(deps, ctx, {
        actionType: "configure_business_preferences",
        description: `修改 WeMail 业务偏好：${Object.keys(patch).join("、")}`,
        payload: { patch },
        riskReason: "This changes non-sensitive WeMail business preferences and requires confirmation.",
      });
    },
  };

  const inspectWorkflowCapabilities: AgentTool = {
    name: "inspect_workflow_capabilities",
    description:
      "Discover capability IDs only when authoring or editing a reusable automation pipeline. Do NOT use this for a one-shot report, chart, dashboard, brief, deck, or HTML request; gather bounded source data and call publish_design_artifact directly. Capability IDs are stable business IDs; never ask the user for an internal provider name.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["trigger", "timing", "data", "analysis", "output", "delivery"],
        },
        query: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler(input) {
      if (!deps.automationAuthoring) {
        return { ok: false, error: "workflow-authoring-unavailable" };
      }
      const category = stringValue(input.category);
      const query = stringValue(input.query)?.toLowerCase();
      const categoryCapabilities = (await deps.automationAuthoring.capabilities())
        .filter((item) => !category || item.category === category);
      const matchedCapabilities = categoryCapabilities.filter(
          (item) =>
            !query ||
            `${item.id} ${item.name} ${item.description}`
              .toLowerCase()
              .includes(query),
        );
      if (query && matchedCapabilities.length === 0) {
        return {
          ok: true,
          capabilities: categoryCapabilities,
          queryMatched: false,
          guidance:
            "No exact phrase match. Use the listed category capabilities; do not repeat capability inspection with another query.",
        };
      }
      return { ok: true, capabilities: matchedCapabilities, queryMatched: true };
    },
    observe: (output) =>
      `Found ${((output as { capabilities?: unknown[] }).capabilities ?? []).length} workflow capabilities`,
  };

  const createExecutionPipeline: AgentTool = {
    name: "create_execution_pipeline",
    description:
      "Create a structured one-shot or automation pipeline from public capability IDs. This starts an inline review conversation and may return a preview link. Do not create a durable rule yet.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        title: { type: "string" },
        targetKey: { type: "string" },
        mode: { type: "string", enum: ["one_shot", "automation"] },
        trigger: { type: "object" },
        dataSelection: { type: "object" },
        analysis: { type: "object" },
        artifact: { type: "object" },
        delivery: { type: "object" },
        steps: { type: "array", minItems: 1, items: { type: "object" } },
        previewRows: {
          type: "array",
          maxItems: 50,
          items: { type: "object" },
          description:
            "Optional bounded, privacy-safe sample rows for a real preview. Never include mail bodies, credentials, tokens, or local paths.",
        },
      },
      required: ["title", "mode", "steps"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      if (!deps.automationAuthoring) {
        return { ok: false, error: "workflow-authoring-unavailable" };
      }
      const accountId = accountIdFrom(input, ctx, deps);
      const title = stringValue(input.title);
      if (!accountId || !title) {
        return { ok: false, error: "accountId-and-title-required" };
      }
      return {
        ok: true,
        ...(await deps.automationAuthoring.create({
          accountId,
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          title,
          targetKey: stringValue(input.targetKey),
          draft: {
            mode: input.mode === "automation" ? "automation" : "one_shot",
            ...(input.trigger ? { trigger: input.trigger as never } : {}),
            ...(input.dataSelection
              ? { dataSelection: input.dataSelection as never }
              : {}),
            ...(input.analysis ? { analysis: input.analysis as never } : {}),
            ...(input.artifact ? { artifact: input.artifact as never } : {}),
            ...(input.delivery ? { delivery: input.delivery as never } : {}),
            steps: Array.isArray(input.steps) ? (input.steps as never) : [],
            skillSnapshots: skillSnapshotsFromContext(deps, ctx),
          },
          previewRows: Array.isArray(input.previewRows)
            ? (input.previewRows as Array<Record<string, unknown>>)
            : [],
        })),
      };
    },
  };

  const createSkillDraftFromPipeline: AgentTool = {
    name: "create_skill_draft_from_pipeline",
    description:
      "Create a reusable Skill draft from a reviewed pipeline. This creates only a sanitized draft; it never installs or executes the Skill.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        pipelineDraftId: { type: "string" },
        skillId: { type: "string" },
        version: { type: "string" },
        displayName: { type: "string" },
        description: { type: "string" },
      },
      required: [
        "pipelineDraftId",
        "skillId",
        "version",
        "displayName",
        "description",
      ],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      if (!deps.automationAuthoring) {
        return { ok: false, error: "workflow-authoring-unavailable" };
      }
      const accountId = accountIdFrom(input, ctx, deps);
      const pipelineDraftId = stringValue(input.pipelineDraftId);
      const skillId = stringValue(input.skillId);
      const version = stringValue(input.version);
      const displayName = stringValue(input.displayName);
      const description = stringValue(input.description);
      if (
        !accountId ||
        !pipelineDraftId ||
        !skillId ||
        !version ||
        !displayName ||
        !description
      ) {
        return { ok: false, error: "skill-draft-input-required" };
      }
      return {
        ok: true,
        draft: deps.automationAuthoring.createSkillDraftFromPipeline({
          accountId,
          pipelineDraftId,
          skillId,
          version,
          displayName,
          description,
        }),
      };
    },
  };

  const validateSkillDraft: AgentTool = {
    name: "validate_skill_draft",
    description:
      "Validate a Skill draft and return its sanitized content hash. Validation does not install the Skill.",
    inputSchema: {
      type: "object",
      properties: { draftId: { type: "string" } },
      required: ["draftId"],
      additionalProperties: false,
    },
    async handler(input) {
      const draftId = stringValue(input.draftId);
      if (!draftId) return { ok: false, error: "draft-id-required" };
      if (!deps.skillDrafts) {
        return { ok: false, error: "skill-draft-service-unavailable" };
      }
      return { ok: true, draft: deps.skillDrafts.validate(draftId) };
    },
  };

  const installSkillDraft: AgentTool = {
    name: "install_skill_draft",
    description:
      "Install a validated Skill draft only when the user has explicitly confirmed its exact content hash.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string" },
        contentHash: { type: "string" },
      },
      required: ["draftId", "contentHash"],
      additionalProperties: false,
    },
    async handler(input) {
      const draftId = stringValue(input.draftId);
      const contentHash = stringValue(input.contentHash);
      if (!draftId || !contentHash) {
        return { ok: false, error: "draft-confirmation-required" };
      }
      if (!deps.skillDrafts) {
        return { ok: false, error: "skill-draft-service-unavailable" };
      }
      return {
        ok: true,
        skill: deps.skillDrafts.install({ draftId, contentHash }),
      };
    },
  };

  const reviewPipelinePreview: AgentTool = {
    name: "review_pipeline_preview",
    description:
      "Apply the user's natural-language answer to exactly one current preview checkpoint. Accepting a preview never authorizes creation of a durable rule.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        taskId: { type: "string" },
        draftId: { type: "string" },
        checkpointId: { type: "string" },
        message: { type: "string" },
      },
      required: ["taskId", "draftId", "checkpointId", "message"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      if (!deps.automationAuthoring) {
        return { ok: false, error: "workflow-authoring-unavailable" };
      }
      const accountId = accountIdFrom(input, ctx, deps);
      const taskId = stringValue(input.taskId);
      const draftId = stringValue(input.draftId);
      const checkpointId = stringValue(input.checkpointId);
      const message = stringValue(input.message);
      if (!accountId || !taskId || !draftId || !checkpointId || !message) {
        return { ok: false, error: "review-reference-and-message-required" };
      }
      return {
        ok: true,
        ...(await deps.automationAuthoring.respond({
          accountId,
          taskId,
          draftId,
          checkpointId,
          message,
        })),
      };
    },
  };

  const resumeAutomationRuleDraft: AgentTool = {
    name: "resume_automation_rule_draft",
    description:
      "Open the one canonical editing draft for an existing automation rule. Use this when the user asks the Agent to modify a rule; never create a parallel draft.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        ruleId: { type: "string" },
      },
      required: ["ruleId"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      if (!deps.automationAuthoring) {
        return { ok: false, error: "workflow-authoring-unavailable" };
      }
      const accountId = accountIdFrom(input, ctx, deps);
      const ruleId = stringValue(input.ruleId);
      if (!accountId || !ruleId) {
        return { ok: false, error: "accountId-and-ruleId-required" };
      }
      return {
        ok: true,
        ...(await deps.automationAuthoring.resumeRule({
          accountId,
          ruleId,
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        })),
      };
    },
  };

  const patchExecutionPipelineDraft: AgentTool = {
    name: "patch_execution_pipeline_draft",
    description:
      "Apply a typed natural-language-derived patch to the same canonical pipeline draft using its exact revision. Changed previews are invalidated and must be reviewed again.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        draftId: { type: "string" },
        expectedRevision: { type: "number" },
        owner: { type: "object" },
        accountScope: { type: "object" },
        name: { type: "string" },
        description: { type: "string" },
        trigger: { type: "object" },
        dataSelection: { type: "object" },
        analysis: { type: "object" },
        artifact: { type: "object" },
        delivery: { type: "object" },
        templateConfiguration: { type: "object" },
        advancedPolicy: { type: "object" },
        steps: { type: "array", items: { type: "object" } },
        previewRows: { type: "array", maxItems: 50, items: { type: "object" } },
      },
      required: ["draftId", "expectedRevision"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      if (!deps.automationAuthoring) {
        return { ok: false, error: "workflow-authoring-unavailable" };
      }
      const accountId = accountIdFrom(input, ctx, deps);
      const draftId = stringValue(input.draftId);
      if (
        !accountId ||
        !draftId ||
        !Number.isInteger(input.expectedRevision)
      ) {
        return { ok: false, error: "draft-reference-and-revision-required" };
      }
      return {
        ok: true,
        ...(await deps.automationAuthoring.patchDraft({
          accountId,
          draftId,
          patch: {
            expectedRevision: input.expectedRevision as number,
            ...(input.owner ? { owner: input.owner as never } : {}),
            ...(input.accountScope
              ? { accountScope: input.accountScope as never }
              : {}),
            ...(typeof input.name === "string" ? { name: input.name } : {}),
            ...(typeof input.description === "string"
              ? { description: input.description }
              : {}),
            ...(input.trigger ? { trigger: input.trigger as never } : {}),
            ...(input.dataSelection
              ? { dataSelection: input.dataSelection as never }
              : {}),
            ...(input.analysis ? { analysis: input.analysis as never } : {}),
            ...(input.artifact ? { artifact: input.artifact as never } : {}),
            ...(input.delivery ? { delivery: input.delivery as never } : {}),
            ...(input.templateConfiguration
              ? {
                  templateConfiguration:
                    input.templateConfiguration as Record<string, unknown>,
                }
              : {}),
            ...(input.advancedPolicy
              ? {
                  advancedPolicy:
                    input.advancedPolicy as Record<string, unknown>,
                }
              : {}),
            ...(Array.isArray(input.steps)
              ? { steps: input.steps as never }
              : {}),
          },
          previewRows: Array.isArray(input.previewRows)
            ? (input.previewRows as Array<Record<string, unknown>>)
            : [],
        })),
      };
    },
  };

  const revisePipelinePreview: AgentTool = {
    name: "revise_pipeline_preview",
    description:
      "Create a new version of one data, analysis, artifact, or delivery recipe from the user's feedback and return a new side-effect-free preview.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        taskId: { type: "string" },
        draftId: { type: "string" },
        target: {
          type: "string",
          enum: ["data", "analysis", "artifact", "delivery"],
        },
        value: { type: "object" },
        previewRows: { type: "array", maxItems: 50, items: { type: "object" } },
      },
      required: ["taskId", "draftId", "target", "value"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      if (!deps.automationAuthoring) {
        return { ok: false, error: "workflow-authoring-unavailable" };
      }
      const accountId = accountIdFrom(input, ctx, deps);
      const taskId = stringValue(input.taskId);
      const draftId = stringValue(input.draftId);
      const target = stringValue(input.target);
      if (
        !accountId ||
        !taskId ||
        !draftId ||
        !["data", "analysis", "artifact", "delivery"].includes(target ?? "")
      ) {
        return { ok: false, error: "revision-reference-required" };
      }
      return {
        ok: true,
        ...(await deps.automationAuthoring.revise({
          accountId,
          taskId,
          draftId,
          target: target as "data" | "analysis" | "artifact" | "delivery",
          value: input.value,
          previewRows: Array.isArray(input.previewRows)
            ? (input.previewRows as Array<Record<string, unknown>>)
            : [],
        })),
      };
    },
  };

  const executeOneShotPipeline: AgentTool = {
    name: "execute_one_shot_pipeline",
    description:
      "Execute a fully reviewed one-shot pipeline now. It never creates an automation rule.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        draftId: { type: "string" },
      },
      required: ["draftId"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      if (!deps.automationAuthoring) {
        return { ok: false, error: "workflow-authoring-unavailable" };
      }
      const accountId = accountIdFrom(input, ctx, deps);
      const draftId = stringValue(input.draftId);
      if (!accountId || !draftId) {
        return { ok: false, error: "accountId-and-draftId-required" };
      }
      return deps.automationAuthoring.executeOneShot({ accountId, draftId });
    },
  };

  const listRecentEmails: AgentTool = {
    name: "list_recent_emails",
    description:
      "Preferred lookup for associating sibling emails in rolling 24-hour or 7-day insight reports. Matches by sender and/or subject and applies the report's selected window. When the run is bound to a focused email, the window ENDS at that email's own send time (“最近 24 小时 / 最近 7 天” relative to the email, not the wall clock); otherwise it ends now. Returns envelope metadata only (no bodies). Use another mail lookup when its declared filters better fit the request. The agent decides which associated messages are relevant; there is no aggregation-specific mail-count cap.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        from: { type: "string", description: "Sender substring (email or name), case-insensitive." },
        subject: { type: "string", description: "Subject substring, case-insensitive." },
        days: { type: "number", description: "Look back this many days. Default 7, max 90; insight aggregation uses its selected preset. When the run is bound to a focused email, the window is anchored to that email's send time; otherwise it is anchored to now." },
        limit: { type: "number", description: "Maximum envelope matches to return. Default 30, max 100." },
      },
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      if (!accountId) {
        return { ok: false, error: "accountId-required" };
      }
      const aggregationPolicy = insightAggregationPolicy(ctx);
      const requestedDays = Math.max(1, Math.min(90, Number(input.days) > 0 ? Number(input.days) : 7));
      const days = aggregationPolicy
        ? aggregationPolicy.preset === "24h" ? 1 : 7
        : requestedDays;
      const requestedLimit = Math.max(1, Math.min(100, Number(input.limit) > 0 ? Number(input.limit) : 30));
      const limit = aggregationPolicy ? 100 : requestedLimit;
      // Anchor the rolling window to the focused email's own timestamp when the
      // run is email-bound: "最近 24 小时 / 最近 7 天" means the window ENDING at
      // the focused email's send time, not the wall clock. Associating an older
      // email against a now-anchored window would always report zero matches and
      // block the aggregate report. Without a focused email, fall back to a
      // now-anchored window (previous behavior).
      const boundEmailId = stringValue(ctx.runContext?.emailId);
      const focusedReceivedAt = boundEmailId
        ? await focusedEmailReceivedAt(deps, accountId, boundEmailId)
        : undefined;
      const anchorMs = focusedReceivedAt !== undefined
        ? Date.parse(focusedReceivedAt)
        : NaN;
      const anchored = Number.isFinite(anchorMs);
      const windowEndMs = anchored ? anchorMs : Date.now();
      const windowStartMs = windowEndMs - days * 86_400_000;
      const dateFrom = new Date(windowStartMs).toISOString();
      const dateTo = anchored ? new Date(windowEndMs).toISOString() : undefined;
      const from = stringValue(input.from);
      const subject = stringValue(input.subject);
      if (!from && !subject) {
        return { ok: false, error: "from-or-subject-required", hint: "Narrow by a sender or subject substring to avoid matching unrelated mail." };
      }
      const searched = await deps.mailDatabase.search({
        accountId,
        from,
        subject,
        receivedFromMs: windowStartMs,
        receivedToMs: windowEndMs,
        limit,
      });
      const filteredMatches = searched.messages.filter((message) => {
        const receivedAtMs = Date.parse(message.receivedAt);
        if (Number.isFinite(receivedAtMs)) {
          if (receivedAtMs < windowStartMs) return false;
          if (anchored && receivedAtMs > windowEndMs) return false;
        }
        const sender = `${message.from.name ?? ""} ${message.from.email}`.toLowerCase();
        if (from && !sender.includes(from.toLowerCase())) return false;
        if (subject && !message.subject.toLowerCase().includes(subject.toLowerCase())) return false;
        return true;
      });
      const matches = filteredMatches.slice(0, limit);
      const hasMore = searched.hasMore || matches.length < filteredMatches.length;
      return {
        ok: true,
        windowDays: days,
        ...(aggregationPolicy ? { windowPreset: aggregationPolicy.preset } : {}),
        ...(anchored
          ? { windowStart: dateFrom, windowEnd: dateTo, windowAnchor: "focused-email" }
          : {}),
        total: matches.length,
        ...(hasMore ? { hasMore } : {}),
        emails: matches.map((m) => ({
          id: m.id,
          subject: m.subject,
          from: m.from?.name ?? m.from?.email,
          receivedAt: m.receivedAt,
        })),
        hint: matches.length
          ? aggregationPolicy
            ? `Select the relevant associated IDs and pass them together to extract_email_tables. The selected ${aggregationPolicy.preset === "24h" ? "24-hour" : "7-day"} window is the report scope. If hasMore is true, use envelope metadata to narrow deliberately or explain why the association is incomplete; do not loop broad searches.`
            : "Pass the relevant associated IDs to extract_email_tables for per-email parsing."
          : "No matches. Widen the window (days) or relax the from/subject substring.",
      };
    },
  };

  const extractEmailTables: AgentTool = {
    name: "extract_email_tables",
    description:
      "Parse HTML tables separately for each selected email. A single email returns a publishable datasetId. Multiple emails return a temporary batchId plus compact per-email schema summaries; call aggregate_email_datasets next. Raw rows and tables stay in the run-scoped host registry and are never copied through model context.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "A single email ID to extract tables from." },
        emailIds: {
          type: "array",
          items: { type: "string" },
          description: "Relevant associated email IDs to parse independently into a temporary aggregation batch.",
        },
        accountId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const aggregationPolicy = insightAggregationPolicy(ctx);
      const explicitIds = (Array.isArray(input.emailIds) ? input.emailIds : input.emailId ? [input.emailId] : [])
        .map((v) => stringValue(v))
        .filter((v): v is string => Boolean(v));
      const uniqueExplicitIds = [...new Set(explicitIds)];
      const boundEmailId = stringValue(ctx.runContext?.emailId);
      const regenerationIds = insightRegenerationSourceIds(ctx);
      const hasAssociatedIds = uniqueExplicitIds.length > 0 || regenerationIds.length > 0;
      if (requiresAssociatedInsightEmails(ctx) && !hasAssociatedIds) {
        const preset = aggregationPolicy?.preset ??
          (insightSceneAction(ctx)?.lookbackPreset === "24h" ? "24h" : "7d");
        return {
          ok: false,
          code: "associated-email-ids-required",
          error: "associated-email-ids-required",
          windowPreset: preset,
          nextTool: "list_recent_emails",
          hint: `This ${preset === "24h" ? "24-hour" : "7-day"} insight action requires an explicit associated email set. Call list_recent_emails once, then pass the selected emailIds to extract_email_tables. The focused email is not a valid fallback for a rolling-window report.`,
        };
      }
      // Only the single-email branch may rely on the focused email from the
      // runtime context. Multi-email actions must name their associated set.
      const requestedIds = uniqueExplicitIds.length > 0
        ? uniqueExplicitIds
        : regenerationIds.length > 0
          ? regenerationIds
          : boundEmailId ? [boundEmailId] : [];
      const ids = requestedIds;
      if (!accountId) {
        return { ok: false, error: "accountId-required" };
      }
      if (!ids.length) {
        return { ok: false, error: "emailId-or-emailIds-required", hint: "Pass emailId (one) or emailIds (many), or invoke from an email-bound conversation." };
      }
      const parsed: ParsedEmailDataset[] = [];
      const parseFailures: Array<{ emailId: string; error: string }> = [];
      for (const id of ids) {
        // getMailSnapshot defaults to a 1s producer timeout, which can fire
        // under DB contention and throw — surfacing as a looping
        // tool_execution_failed. Use a generous timeout and catch so a real
        // failure becomes a clear result instead of an unhandled throw.
        let email;
        try {
          email = (await deps.mailDatabase.getMailSnapshot(id, 8_000)).message;
          if (!email && accountId && !id.startsWith(`${accountId}:`)) {
            email = (await deps.mailDatabase.getMailSnapshot(`${accountId}:${id}`, 8_000)).message;
          }
        } catch (err) {
          parseFailures.push({
            emailId: id,
            error: `mail-snapshot-unavailable: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
        if (!email) {
          parseFailures.push({ emailId: id, error: "mail-not-found" });
          continue;
        }
        const message = {
          id: email.id,
          subject: email.subject,
          receivedAt: email.receivedAt,
          body_html: email.bodyHtml,
          bodyText: email.bodyText,
          from: email.from,
        };
        const dataset = htmlTableDataset([message]);
        if (!dataset.rows.length) {
          parseFailures.push({ emailId: email.id, error: "no-tables-found" });
          continue;
        }
        parsed.push({ emailId: email.id, receivedAt: email.receivedAt, dataset });
      }
      if (!parsed.length) {
        return {
          ok: false,
          error: "no-tables-found",
          emailsChecked: ids.length,
          hint: "No <table> elements found in the email HTML. The data may be in an image, an attachment, or plain text — this tool only extracts HTML tables. If it is a daily/periodic report, check whether sibling emails (same sender/subject) carry the data in tables.",
        };
      }
      const multiEmail = ids.length > 1 || Boolean(aggregationPolicy) || requiresAssociatedInsightEmails(ctx);
      if (multiEmail) {
        const batchId = `dsb-${randomUUID().slice(0, 8)}`;
        rememberDatasetBatch(batchId, parsed, accountId, ctx, ids, parseFailures);
        const schemaGroups = new Map<string, { emailIds: string[]; fields: ReturnType<typeof datasetFieldSummary> }>();
        for (const entry of parsed) {
          const signature = datasetSchemaSignature(entry.dataset);
          const group = schemaGroups.get(signature) ?? {
            emailIds: [],
            fields: datasetFieldSummary(entry.dataset),
          };
          group.emailIds.push(entry.emailId);
          schemaGroups.set(signature, group);
        }
        return {
          ok: true,
          batchId,
          sourceEmailCount: ids.length,
          parsedEmailCount: parsed.length,
          ...(parseFailures.length ? { parseFailures } : {}),
          ...(aggregationPolicy ? { windowPreset: aggregationPolicy.preset } : {}),
          emails: parsed.map((entry) => ({
            emailId: entry.emailId,
            receivedAt: entry.receivedAt,
            totalRows: entry.dataset.rows.length,
            tablesFound: entry.dataset.rawTables?.length ?? 0,
          })),
          schemas: [...schemaGroups.values()].map((group, index) => ({
            schemaId: `schema-${index + 1}`,
            emailCount: group.emailIds.length,
            emailIds: group.emailIds,
            fields: group.fields,
          })),
          nextTool: "aggregate_email_datasets",
          nextToolInput: { batchId },
          hint: "Choose the time grain, grouping dimensions, and numeric aggregation from the parsed schemas, then call aggregate_email_datasets. Do not publish this temporary batch.",
        };
      }
      const dataset = parsed[0].dataset;
      const analysisTimezone = stringValue(ctx.runContext?.timezone);
      dataset.summary = {
        ...(dataset.summary ?? {}),
        ...(analysisTimezone ? { analysisTimezone } : {}),
      };
      const datasetId = `ds-${randomUUID().slice(0, 8)}`;
      rememberDataset(datasetId, dataset, accountId, ctx);
      return {
        ok: true,
        datasetId,
        tablesFound: dataset.rawTables?.length ?? 0,
        totalRows: dataset.rows.length,
        sourceEmailCount: 1,
        fields: dataset.schema.fields.map((field) => ({
          name: field.name,
          label: field.label,
          type: field.type,
          semanticRole: field.semanticRole,
          semanticId: field.semanticId,
        })),
        multiDay: false,
        nextTool: "publish_design_artifact",
        nextToolInput: { datasetId },
        hint: "Pass datasetId to publish_design_artifact. If the user named required dimensions or values, bind them in analysisPlan; use autoPivot:true only for an unconstrained overview.",
      };
    },
  };

  const aggregateEmailDatasets: AgentTool = {
    name: "aggregate_email_datasets",
    description:
      "Integrate a temporary per-email parse batch into the final report dataset. Choose a time grain, preserve meaningful dimensions in groupBy, and state how each numeric measure is combined. On success, raw per-email tables are released and the returned datasetId contains only aggregated rows plus lightweight source metadata.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        batchId: { type: "string" },
        timeGrain: {
          type: "string",
          enum: ["auto", "hour", "day"],
          description: "Use hour for a 24-hour report and day for a 7-day report unless the parsed report cadence requires otherwise.",
        },
        groupBy: {
          type: "array",
          items: { type: "string" },
          description: "Parsed dimension fields to retain. Omit to retain every non-measure field.",
        },
        measures: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              agg: { type: "string", enum: ["sum", "average", "min", "max", "latest", "ratio"] },
              numeratorField: { type: "string", description: "For ratio only: numeric numerator field summed across rows." },
              denominatorField: { type: "string", description: "For ratio only: numeric denominator field summed across rows." },
            },
            required: ["field", "agg"],
            additionalProperties: false,
          },
          description: "Numeric fields and their cross-email aggregation. For rates, use ratio with explicit numeratorField and denominatorField instead of averaging percentages. Omit only when host defaults are semantically correct.",
        },
      },
      required: ["batchId"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const accountId = accountIdFrom(input, ctx, deps);
      const batchId = stringValue(input.batchId);
      if (!accountId || !batchId) {
        return { ok: false, error: "accountId-and-batchId-required" };
      }
      const batch = resolvePendingDatasetBatch(batchId, accountId, ctx);
      if (!batch) {
        return { ok: false, error: "dataset-batch-not-found", batchId };
      }
      if (batch.parseFailures.length > 0 || batch.datasets.length !== batch.requestedEmailIds.length) {
        return {
          ok: false,
          code: "aggregation-source-incomplete",
          error: "aggregation-source-incomplete",
          requestedEmailCount: batch.requestedEmailIds.length,
          parsedEmailCount: batch.datasets.length,
          parseFailures: batch.parseFailures,
          hint: "One or more associated emails could not be parsed. Do not publish a partial report; repair the missing email data or explicitly narrow the association and start a new run.",
        };
      }
      const aggregationPolicy = insightAggregationPolicy(ctx);
      const timeGrain = input.timeGrain === "hour" || input.timeGrain === "day"
        ? input.timeGrain
        : aggregationPolicy?.preset === "24h"
          ? "hour"
          : aggregationPolicy?.preset === "7d"
            ? "day"
            : inferBatchTimeGrain(batch.datasets);
      const groupBy = Array.isArray(input.groupBy)
        ? input.groupBy.map((value) => stringValue(value)).filter((value): value is string => Boolean(value))
        : undefined;
      const measures = Array.isArray(input.measures)
        ? input.measures.flatMap((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return [];
            const plan = value as Record<string, unknown>;
            const field = stringValue(plan.field);
            const agg = plan.agg;
            const numeratorField = stringValue(plan.numeratorField);
            const denominatorField = stringValue(plan.denominatorField);
            return field && (agg === "sum" || agg === "average" || agg === "min" || agg === "max" || agg === "latest" || agg === "ratio")
              ? [{ field, agg: agg as DatasetMeasureAggregation, numeratorField, denominatorField }]
              : [];
          })
        : undefined;
      const aggregated = aggregateParsedEmailDatasets({
        parsed: batch.datasets,
        timeGrain,
        groupBy,
        measures,
      });
      if (!aggregated.dataset) {
        return { ok: false, error: aggregated.error, hint: aggregated.hint };
      }
      const aggregationSummary = aggregated.dataset.summary?.aggregation;
      const analysisTimezone = stringValue(ctx.runContext?.timezone);
      const finalDataset: AutomationDataset = {
        ...aggregated.dataset,
        summary: {
          ...aggregated.dataset.summary,
          ...(analysisTimezone ? { analysisTimezone } : {}),
          aggregation: {
            ...(aggregationSummary && typeof aggregationSummary === "object" && !Array.isArray(aggregationSummary)
              ? aggregationSummary
              : {}),
            scopePreset: aggregationPolicy?.preset,
            sourceEmailCount: aggregated.dataset.sourceEmails?.length ?? 0,
          },
        },
      };
      if (finalDataset.rows.length > 500) {
        return {
          ok: false,
          error: "aggregation-plan-too-granular",
          totalRows: finalDataset.rows.length,
          fields: datasetFieldSummary(finalDataset),
          hint: "The integrated result is still too granular for an insight report. Retry this same batch with a coarser timeGrain or fewer intentional groupBy dimensions; do not drop emails or truncate rows.",
        };
      }
      const datasetId = `ds-${randomUUID().slice(0, 8)}`;
      rememberDataset(datasetId, finalDataset, accountId, ctx, "aggregated");
      pendingDatasetBatches.delete(batchId);
      return {
        ok: true,
        datasetId,
        totalRows: finalDataset.rows.length,
        sourceEmailCount: finalDataset.sourceEmails?.length ?? 0,
        skippedEmailIds: aggregated.skippedEmailIds,
        fields: datasetFieldSummary(finalDataset),
        aggregation: finalDataset.summary?.aggregation,
        rawSourceDataRetained: false,
        nextTool: "publish_design_artifact",
        nextToolInput: { datasetId },
        hint: "Publish this final integrated dataset. The temporary per-email parses and raw tables have been released.",
      };
    },
  };

  const publishDesignArtifact: AgentTool = {
    name: "publish_design_artifact",
    description:
      "Required final step for a one-shot user-facing report, chart, dashboard, brief, or deck. Publish structured data through WeMail's trusted renderer, persist the result, deliver it to Application Messages, and return an in-chat artifact card. If datasetId and title are omitted, the host safely reuses this run's latest extracted dataset and derives a title. Never output complete HTML or JavaScript instead of calling this tool.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        title: { type: "string" },
        datasetId: { type: "string", description: "If extract_email_tables was called first, pass its datasetId here instead of repeating the full dataset. Saves tokens." },
        mode: {
          type: "string",
          enum: ["auto", "brief", "report", "dashboard", "deck"],
        },
        objective: { type: "string" },
        audience: { type: "string" },
        instructions: { type: "string" },
        templateId: {
          type: "string",
          enum: [
            "email-visual-summary",
            "quick-chart",
            "timeline-view",
            "executive-insight",
            "trend-analysis",
            "comparison-breakdown",
            "operational-health",
          ],
          description:
            "Optional report template. Omit to automatically choose from the dataset and objective.",
        },
        purpose: {
          type: "string",
          enum: ["auto", "visualize", "analyze"],
          description:
            "Use visualize for faithful email/data-to-chart conversion without invented conclusions; use analyze for an insight report. Omit or use auto to infer.",
        },
        charts: {
          type: "array",
          description:
            "Optional thin chart specs — DATA LOGIC ONLY (never ECharts option objects, HTML, CSS, or script). Each binds a family to dataset fields; the trusted renderer owns all visuals and refuses charts that contradict the data (no line without a temporal axis, no cross-unit sum). Omit to let the renderer infer charts from the dataset shape.",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              family: { type: "string", enum: ["bar", "line", "area", "waffle", "donut", "scatter", "heatmap", "dumbbell", "stacked-bar", "treemap", "diverging-bar", "counter", "histogram", "boxplot", "table"] },
              x: { type: "string", description: "dimension field name (category or temporal axis)" },
              y: { type: "string", description: "measure field name (numeric value)" },
              y2: { type: "string", description: "optional second measure for a before/after dumbbell" },
              splitBy: { type: "string", description: "optional series-grouping field" },
              agg: { type: "string", enum: ["sum", "count", "average", "min", "max"] },
              where: { type: "object", description: "optional equality filter on rows, e.g. {unit:'次'}" },
              top: { type: "number", description: "optional limit to top-N categories by magnitude" },
              title: { type: "string", description: "optional conclusion-style title" },
              span: { type: "string", enum: ["full", "half"] },
              switchGroup: { type: "string" },
              switchLabel: { type: "string", description: "visible dimension label inside a switch group, e.g. 类型 or 模型" },
            },
            required: ["family", "x", "y"],
            additionalProperties: false,
          },
        },
        analysisPlan: {
          type: "object",
          description:
            "Executable requirements for user-directed grouping. Include every named dimension (up to 6), not only the first. Use exactly dimensions:[{field,requiredValues?,overlapping?}], measures:[{field,agg?}]. Valid example: {\"dimensions\":[{\"field\":\"type\",\"requiredValues\":[\"实时\",\"离线\"]}],\"measures\":[{\"field\":\"count\",\"agg\":\"sum\"}]}. Copy a field summary's name into field; never copy name, label, type, semanticRole, semanticId, distinctCount, or sampleValues as properties. Undeclared properties make the call fail. Each dimension becomes a switchable chart+table view; publishing fails instead of silently dropping a missing binding.",
          properties: {
            dimensions: {
              type: "array",
              minItems: 1,
              maxItems: 6,
              items: {
                type: "object",
                properties: {
                  field: { type: "string", description: "real normalized dataset field name; use the summary's name as this value, not as another property" },
                  requiredValues: {
                    type: "array",
                    items: { type: "string" },
                    description: "values explicitly required by the user, for example 实时/离线 or 最近一小时/当天",
                  },
                  overlapping: {
                    type: "boolean",
                    description: "true for overlapping windows such as 最近一小时 and 当天; prevents stacked sums",
                  },
                },
                required: ["field"],
                additionalProperties: false,
              },
            },
            measures: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  field: { type: "string", description: "real numeric dataset field" },
                  agg: { type: "string", enum: ["sum", "count", "average", "min", "max"] },
                },
                required: ["field"],
                additionalProperties: false,
              },
            },
          },
          required: ["dimensions", "measures"],
          additionalProperties: false,
        },
        dataset: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["dataset"] },
            schema: {
              type: "object",
              properties: {
                fields: {
                  type: "array",
                  minItems: 1,
                  maxItems: 64,
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      type: {
                        type: "string",
                        enum: [
                          "string",
                          "number",
                          "boolean",
                          "date",
                          "datetime",
                          "reference",
                        ],
                      },
                      label: { type: "string" },
                      semanticRole: {
                        type: "string",
                        enum: ["dimension", "measure", "time", "time_window", "status", "unit"],
                      },
                      semanticId: { type: "string" },
                    },
                    required: ["name", "type"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["fields"],
              additionalProperties: false,
            },
            rows: {
              type: "array",
              maxItems: 500,
              items: { type: "object" },
            },
            summary: { type: "object" },
            provenance: { type: "array", items: { type: "object" } },
            sourceEmails: { type: "array", items: { type: "object" } },
            rawTables: { type: "array", items: { type: "object" } },
          },
          required: ["type", "schema", "rows"],
          additionalProperties: false,
        },
        autoPivot: { type: "boolean", description: "Unconstrained fallback only: infer preset pivots when charts and analysisPlan are absent." },
        reportId: { type: "string", description: "Existing insight report id to create the next immutable version instead of a new report." },
      },
      additionalProperties: false,
    },
    async handler(input, ctx) {
      if (!deps.artifactDelivery) {
        return { ok: false, error: "artifact-delivery-unavailable" };
      }
      const accountId = accountIdFrom(input, ctx, deps);
      if (!accountId) {
        return { ok: false, code: "account-required", error: "account-required" };
      }
      // Resolve dataset: either from datasetId (extract_email_tables result) or inline.
      let dataset = input.dataset;
      let storedDataset: PendingDataset | undefined;
      const datasetId = stringValue(input.datasetId);
      if (!dataset) {
        storedDataset = resolvePendingDataset(datasetId, accountId, ctx);
        if (datasetId && !storedDataset) {
          return {
            ok: false,
            code: "dataset-not-found",
            error: "dataset-not-found",
            datasetId,
          };
        }
        dataset = storedDataset?.dataset;
      }
      if (!dataset) {
        return {
          ok: false,
          code: "dataset-required",
          error: "dataset-required",
          hint: "Call extract_email_tables in this run before publishing, or pass dataset inline.",
        };
      }
      if (requiresAggregatedInsightDataset(ctx) && (
        storedDataset?.stage !== "aggregated" ||
        !hasAggregatedInsightContract(dataset as AutomationDataset)
      )) {
        return {
          ok: false,
          code: "email-aggregation-required",
          error: "email-aggregation-required",
          hint: "This rolling-window report has not produced a verified aggregated dataset. Associate the matching emails, parse them separately, aggregate them, and publish that final datasetId; the focused email cannot satisfy this scope.",
        };
      }
      const title = stringValue(input.title) ?? deriveReportTitle(dataset as AutomationDataset).title;
      const sceneAction = insightSceneAction(ctx);
      const defaultInsightGeneration = sceneAction?.kind === "insight-report" &&
        (sceneAction.operation === "generate" || sceneAction.operation === "aggregate" || sceneAction.operation === "regenerate");
      try {
        const published = deps.artifactDelivery.publish({
          accountId,
          title,
          mode:
            input.mode === "brief" ||
            input.mode === "report" ||
            input.mode === "dashboard" ||
            input.mode === "deck"
              ? input.mode
              : "auto",
          objective: stringValue(input.objective),
          audience: stringValue(input.audience),
          instructions: stringValue(input.instructions),
          templateId:
            input.templateId === "email-visual-summary" ||
            input.templateId === "quick-chart" ||
            input.templateId === "timeline-view" ||
            input.templateId === "executive-insight" ||
            input.templateId === "trend-analysis" ||
            input.templateId === "comparison-breakdown" ||
            input.templateId === "operational-health"
              ? input.templateId
              : undefined,
          purpose:
            input.purpose === "visualize" || input.purpose === "analyze"
              ? input.purpose
              : "auto",
          charts: Array.isArray(input.charts) ? (input.charts as never) : undefined,
          analysisPlan:
            input.analysisPlan && typeof input.analysisPlan === "object"
              ? input.analysisPlan as DesignAnalysisPlan
              : undefined,
          reportId: stringValue(input.reportId) ?? insightSceneReportId(ctx),
          autoPivot: input.autoPivot === true || (
            defaultInsightGeneration &&
            !input.analysisPlan &&
            !Array.isArray(input.charts)
          ),
          dataset: dataset as AutomationDataset,
        });
        if (
          !published ||
          typeof published !== "object" ||
          !published.artifact ||
          typeof published.artifact.applicationMessageId !== "string" ||
          !published.applicationMessage ||
          typeof published.applicationMessage.id !== "string"
        ) {
          return {
            ok: false,
            code: "artifact-delivery-incomplete",
            error: "artifact-delivery-incomplete",
            hint: "The report renderer returned without a persisted artifact and application message. Do not claim success; inspect the delivery boundary and retry only after it is repaired.",
          };
        }
        if (datasetId) pendingDatasets.delete(datasetId);
        return {
          ok: true,
          ...published,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.startsWith("analysis-plan-")) {
          return {
            ok: false,
            code: "analysis-plan-validation-failed",
            error: detail,
            hint: "The requested grouping could not be proven from the extracted dataset. Correct the field/value binding; do not publish a generic substitute.",
          };
        }
        if (detail.startsWith("design-dataset-")) {
          return {
            ok: false,
            code: "design-dataset-validation-failed",
            error: detail,
            hint: "Repair the aggregation plan or dataset shape before publishing; do not retry the same publish call.",
          };
        }
        if (detail.startsWith("insight-data-contract-") || detail === "artifact-delivery-pointer-mismatch") {
          return {
            ok: false,
            code: detail,
            error: detail,
            hint: "本次报告没有生成新的可验证产物，保留上一版报告；请修复数据链路后重新执行。",
          };
        }
        return {
          ok: false,
          code: "artifact-publish-failed",
          error: detail,
          hint: "Expand this tool step to inspect the exact renderer or report compilation error before retrying.",
        };
      }
    },
    observe: (output) => {
      if (
        output &&
        typeof output === "object" &&
        (output as { ok?: unknown }).ok === false
      ) {
        const code = (output as { code?: unknown }).code;
        return typeof code === "string"
          ? `生成洞察报告失败：${code}`
          : "生成洞察报告失败";
      }
      const artifact = (output as { artifact?: { title?: string } }).artifact;
      return artifact?.title
        ? `已生成洞察报告：${artifact.title}`
        : "已生成洞察报告";
    },
  };

  const completeAutomationConfiguration: AgentTool = {
    name: "complete_automation_configuration",
    description:
      "Prepare the exact final automation snapshot or, only after the user explicitly says confirm/create, authorize, commit, reload and verify that exact rule. Preview approval alone is ambiguous and must not call this as confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        taskId: { type: "string" },
        message: { type: "string" },
        snapshotId: { type: "string" },
        ruleHash: { type: "string" },
      },
      required: ["taskId", "message"],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      if (!deps.automationAuthoring) {
        return { ok: false, error: "workflow-authoring-unavailable" };
      }
      const accountId = accountIdFrom(input, ctx, deps);
      const taskId = stringValue(input.taskId);
      const message = stringValue(input.message);
      if (!accountId || !taskId || !message) {
        return { ok: false, error: "confirmation-reference-required" };
      }
      return {
        ok: true,
        ...(await deps.automationAuthoring.authorizeAndCommit({
          accountId,
          taskId,
          message,
          snapshotId: stringValue(input.snapshotId),
          ruleHash: stringValue(input.ruleHash),
        })),
      };
    },
  };

  return [
    // Six enterprise-directory tools: mechanism stays open, registration is
    // edition-gated (see WemailAgentToolDeps.directoryToolsEnabled).
    ...(deps.directoryToolsEnabled
      ? [
          searchDirectoryContacts,
          getDirectoryContact,
          listDirectoryDepartments,
          resolveDirectoryRecipients,
          getDirectoryStatus,
          refreshDirectory,
        ]
      : []),
    listSmartTags,
    proposeSmartTagChange,
    listAutomationRules,
    ...(deps.artifactDelivery ? [extractEmailTables, aggregateEmailDatasets, publishDesignArtifact] : []),
    ...(deps.automationAuthoring
      ? [
          inspectWorkflowCapabilities,
          createExecutionPipeline,
          ...(deps.skillDrafts
            ? [
                createSkillDraftFromPipeline,
                validateSkillDraft,
                installSkillDraft,
              ]
            : []),
          resumeAutomationRuleDraft,
          patchExecutionPipelineDraft,
          reviewPipelinePreview,
          revisePipelinePreview,
          executeOneShotPipeline,
          completeAutomationConfiguration,
        ]
      : [
          startAutomationConfiguration,
          discoverAutomationCapabilities,
          previewAutomationRule,
          previewPipelineAutomationRule,
          proposeAutomationRuleChange,
        ]),
    proposeSendMail,
    setMailState,
    setMailSmartTag,
    saveMailDraft,
    listRecentEmails,
    listMailDrafts,
    getMailDraft,
    proposeDeleteDraft,
    listScheduledMail,
    proposeScheduleMail,
    proposeCancelScheduledMail,
    proposeMailOperation,
    listWritingStyles,
    proposeWritingStyleChange,
    getBusinessPreferences,
    proposeBusinessPreferenceChange,
  ];
}

function ruleSchema(includeOperation: boolean, fields: readonly AutomationFieldDefinition[] = AUTOMATION_FIELD_DEFINITIONS) {
  const temporalExpressionRef = { $ref: "#/$defs/temporalExpression" };
  const fieldDescription = fields.map(
    (definition) =>
      `${definition.path}: ${definition.label} — ${definition.description}`,
  ).join("; ");
  const executionSchema = {
    oneOf: [
      {
        type: "object",
        properties: {
          type: { type: "string", enum: ["immediate"] },
        },
        required: ["type"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { type: "string", enum: ["delay"] },
          amount: { type: "number", exclusiveMinimum: 0, maximum: 365 },
          unit: { type: "string", enum: ["minute", "hour", "day"] },
        },
        required: ["type", "amount", "unit"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { type: "string", enum: ["nextDayAt"] },
          localTime: {
            type: "string",
            pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
            description: "Local wall-clock time in HH:mm format.",
          },
          timezone: {
            type: "string",
            description: "IANA timezone, for example Asia/Shanghai.",
          },
        },
        required: ["type", "localTime", "timezone"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { type: "string", enum: ["atExpression"] },
          expression: temporalExpressionRef,
          timezone: {
            type: "string",
            description: "IANA timezone used to interpret date-only field values.",
          },
        },
        required: ["type", "expression", "timezone"],
        additionalProperties: false,
      },
    ],
  };
  const triggerSchema = {
    oneOf: [
      {
        type: "object",
        properties: {
          type: { type: "string", enum: ["manual"] },
        },
        required: ["type"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { type: "string", enum: ["mailReceived"] },
          execution: executionSchema,
        },
        required: ["type"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { type: "string", enum: ["scheduled"] },
          intervalMinutes: { type: "number", exclusiveMinimum: 0 },
          schedule: {
            oneOf: [
              { type: "object", properties: { type: { type: "string", enum: ["interval"] }, intervalMinutes: { type: "number", exclusiveMinimum: 0 } }, required: ["type", "intervalMinutes"], additionalProperties: false },
              { type: "object", properties: { type: { type: "string", enum: ["daily"] }, localTime: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }, timezone: { type: "string" } }, required: ["type", "localTime", "timezone"], additionalProperties: false },
            ],
          },
          timezone: { type: "string" },
          nextRunAt: { type: "string" },
        },
        required: ["type"],
        additionalProperties: false,
      },
    ],
  };
  const properties = {
    ...(includeOperation
      ? {
          operation: { type: "string", enum: ["create", "update", "enable", "disable", "delete"] },
          ruleId: { type: "string" },
          previewId: { type: "string" },
          ruleHash: { type: "string" },
          configurationTaskId: { type: "string" },
          configurationTaskRevision: { type: "integer", minimum: 1 },
          pipelineVersion: { type: "number", enum: [1, 2] },
        }
      : {}),
    accountId: { type: "string" },
    sourceRuleId: { type: "string" },
    name: { type: "string" },
    enabled: { type: "boolean" },
    trigger: triggerSchema,
    naturalLanguageCondition: { type: "string" },
    conditions: { type: "object" },
    conditionMode: { type: "string", enum: ["all", "any"] },
    conditionRules: { type: "array", items: { type: "object" } },
    processing: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["perMessage", "collection"] },
        scope: { type: "object" },
        processors: { type: "array", items: { type: "object" } },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    actions: { type: "array", items: { type: "object" } },
  };
  return {
    type: "object" as const,
    properties,
    ...(includeOperation
      ? {
          oneOf: [
            {
              properties: { operation: { type: "string", enum: ["create"] } },
              required: ["operation"],
              oneOf: [
                { required: ["name", "trigger", "actions"] },
                { required: ["previewId", "ruleHash"] },
              ],
            },
            {
              properties: { operation: { type: "string", enum: ["update"] } },
              required: ["operation", "ruleId"],
              oneOf: [
                { required: ["name", "trigger", "actions"] },
                { required: ["previewId", "ruleHash"] },
              ],
            },
            {
              properties: {
                operation: { type: "string", enum: ["enable", "disable", "delete"] },
              },
              required: ["operation", "ruleId"],
              not: { anyOf: [{ required: ["name"] }, { required: ["trigger"] }, { required: ["actions"] }, { required: ["previewId"] }] },
            },
          ],
        }
      : { required: ["name", "trigger", "actions"] }),
    additionalProperties: false,
    $defs: {
      temporalExpression: {
        oneOf: [
          {
            type: "object",
            properties: {
              type: { type: "string", enum: ["field"] },
              path: {
                type: "string",
                enum: fields.map((definition) => definition.path),
                description: fieldDescription,
              },
              scope: {
                type: "string",
                enum: ["mail", "matchingAttachments"],
                description: "Use mail for mail fields and matchingAttachments for attachment collection fields.",
              },
            },
            required: ["type", "path"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              type: { type: "string", enum: ["aggregate"] },
              operator: { type: "string", enum: ["max", "min"] },
              values: temporalExpressionRef,
            },
            required: ["type", "operator", "values"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              type: { type: "string", enum: ["coalesce"] },
              values: {
                type: "array",
                items: temporalExpressionRef,
                minItems: 2,
                maxItems: 8,
                description: "Explicit priority order: later values are fallbacks only when requested.",
              },
            },
            required: ["type", "values"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              type: { type: "string", enum: ["addDuration"] },
              base: temporalExpressionRef,
              duration: {
                type: "object",
                properties: {
                  amount: { type: "integer", exclusiveMinimum: 0 },
                  unit: { type: "string", enum: ["minute", "hour", "day"] },
                },
                required: ["amount", "unit"],
                additionalProperties: false,
              },
            },
            required: ["type", "base", "duration"],
            additionalProperties: false,
          },
        ],
      },
    },
  };
}

export function getAgentAutomationCapabilityGuidance(ruleService?: AutomationRuleService) {
  return ruleService?.capabilities() ?? automationCapabilityDiscovery({});
}
