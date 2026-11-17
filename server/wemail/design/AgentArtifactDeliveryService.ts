import { randomUUID } from "node:crypto";
import type { AutomationDataset } from "../../../shared/wemail/automation.js";
import type {
  DesignAnalysisPlan,
  DesignArtifactKind,
  DesignRequest,
  DesignTemplateId,
  ThinChartSpec,
  InsightReportFormatPreferences,
} from "../../../shared/wemail/designArtifacts.js";
import type { ApplicationMessageRepository } from "../applicationMessages/ApplicationMessageRepository.js";
import { DesignRecipeCompiler } from "./DesignRecipeCompiler.js";
import { DesignRenderer } from "./DesignRenderer.js";
import type { MessageArtifactRepository } from "./MessageArtifactRepository.js";
import { InsightReportRepository } from "./InsightReportRepository.js";
import {
  aggregationSummary,
  assertAggregatedInsightDataset,
  sourceEmailIds,
  timePointCount,
} from "./InsightDatasetContract.js";

const MAX_DATASET_BYTES = 1_000_000;
const MAX_DATASET_ROWS = 500;
const MAX_DATASET_FIELDS = 64;

export interface PublishAgentArtifactInput {
  accountId: string;
  title: string;
  mode?: "auto" | DesignArtifactKind;
  objective?: string;
  audience?: string;
  instructions?: string;
  templateId?: DesignTemplateId;
  purpose?: DesignRequest["purpose"];
  autoPivot?: boolean;
  /** Optional color system for the whole delivery: "auto" (default), a preset id, or "custom:<hex>,<hex>…". */
  designSystem?: string;
  dataset: AutomationDataset;
  analysisPlan?: DesignAnalysisPlan;
  /** Optional model-authored thin chart specs (data logic only); validated against the dataset. */
  charts?: ThinChartSpec[];
  reportId?: string;
  formatPreferences?: InsightReportFormatPreferences;
}

/**
 * Direct one-shot delivery boundary for Agent-generated reports and charts.
 * The Agent supplies structured data only; trusted application code owns the
 * recipe, HTML, charts, persistence, and application-message delivery.
 */
export class AgentArtifactDeliveryService {
  constructor(
    private readonly messages: ApplicationMessageRepository,
    private readonly artifacts: MessageArtifactRepository,
    private readonly reports: InsightReportRepository,
    private readonly compiler = new DesignRecipeCompiler(),
    private readonly renderer = new DesignRenderer(),
  ) {}

  publish(input: PublishAgentArtifactInput) {
    validateDataset(input.dataset);
    const sourceIds = sourceEmailIds(input.dataset);
    if (sourceIds.length > 1) assertAggregatedInsightDataset(input.dataset);
    validateCharts(input.charts, input.dataset);
    const request: DesignRequest = {
      dataset: input.dataset,
      mode: input.mode ?? "report",
      title: input.title,
      objective: input.objective,
      audience: input.audience,
      instructions: input.instructions,
      templateId: input.templateId,
      purpose: input.purpose,
      charts: input.charts,
      analysisPlan: input.analysisPlan,
      autoPivot: input.autoPivot,
      designSystem: input.designSystem,
    };
    const recipe = this.compiler.compile(request);
    const rendered = this.renderer.render(recipe, input.dataset);
    const runId = `agent-artifact-${randomUUID()}`;
    const existing = input.reportId ? this.reports.get(input.accountId, input.reportId) : null;
    if (input.reportId && !existing) throw new Error("insight-report-not-found");
    const reportId = existing?.id ?? `insight-report-${randomUUID()}`;
    const reportVersion = (existing?.currentVersion ?? 0) + 1;
    recipe.version = reportVersion;
    const artifact = this.artifacts.create({
      accountId: input.accountId,
      artifactId: reportId,
      version: reportVersion,
      recipe,
      html: rendered.html,
      preview: rendered.preview,
      sourceRuleId: "agent-one-shot-artifact",
      sourceRunId: runId,
    });
    const aggregation = aggregationSummary(input.dataset);
    const dataSummary = {
      sourceEmailCount: sourceIds.length,
      rowCount: input.dataset.rows.length,
      timePointCount: aggregation?.timePointCount ?? timePointCount(input.dataset),
      ...(aggregation?.timeGrain ? { timeGrain: aggregation.timeGrain } : {}),
    };
    const keyMetrics = [
      ...(rendered.keyMetrics ?? []),
      { label: "来源邮件", value: String(sourceIds.length) },
      { label: "时间点", value: String(dataSummary.timePointCount) },
    ].slice(0, 6);
    const message = this.messages.create({
      accountId: input.accountId,
      sourceType: "agent",
      sourceRuleId: `agent-one-shot-artifact:${artifact.artifactId}`,
      sourceRunId: runId,
      type: "analysis",
      severity: "success",
      title: artifact.title,
      preview: artifact.preview,
      content: [
        {
          type: "paragraph",
          text: artifact.preview || "Agent 已生成可反复查看的完整产物。",
        },
        {
          type: "status",
          label: "数据范围",
          value: `${sourceIds.length} 封来源邮件 · ${input.dataset.rows.length} 行聚合数据 · ${dataSummary.timePointCount} 个时间点`,
          tone: "info",
        },
      ],
      references: [
        { type: "automationRun", id: runId, label: "本次 Agent 执行" },
        ...sourceIds.map((id) => ({ type: "email" as const, id, label: "来源邮件" })),
      ],
      interactions: [
        {
          type: "openArtifact",
          artifactId: artifact.artifactId,
          version: artifact.version,
          label: "查看完整内容",
        },
      ],
      artifact: {
        id: artifact.artifactId,
        version: artifact.version,
        kind: artifact.kind,
        contentHash: artifact.contentHash,
      },
      keyMetrics,
      delayed: false,
    });
    const report = this.reports.recordVersion({
      reportId,
      version: reportVersion,
      accountId: input.accountId,
      scope: sourceIds.length > 1 ? "multi" : "single",
      title: artifact.title,
      applicationMessageId: message.id,
      sourceEmailIds: sourceIds,
      recipe,
      dataset: input.dataset,
      preferences: input.formatPreferences,
    });
    if (report.currentVersion !== reportVersion || report.applicationMessageId !== message.id) {
      throw new Error("artifact-delivery-pointer-mismatch");
    }
    return {
      artifact: {
        ...artifact,
        applicationMessageId: message.id,
        dataSummary,
      },
      applicationMessage: {
        id: message.id,
        title: message.title,
        preview: message.preview,
      },
    };
  }
}

function validateDataset(dataset: AutomationDataset): void {
  if (
    !dataset ||
    dataset.type !== "dataset" ||
    !Array.isArray(dataset.schema?.fields) ||
    !Array.isArray(dataset.rows)
  ) {
    throw new Error("invalid-design-dataset");
  }
  if (dataset.schema.fields.length > MAX_DATASET_FIELDS) {
    throw new Error("design-dataset-too-many-fields");
  }
  if (dataset.rows.length > MAX_DATASET_ROWS) {
    throw new Error("design-dataset-too-many-rows");
  }
  if (Buffer.byteLength(JSON.stringify(dataset)) > MAX_DATASET_BYTES) {
    throw new Error("design-dataset-too-large");
  }
  const names = new Set<string>();
  for (const field of dataset.schema.fields) {
    if (!field.name?.trim() || names.has(field.name)) {
      throw new Error("invalid-design-dataset-field");
    }
    names.add(field.name);
  }
  if (dataset.rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("invalid-design-dataset-row");
  }
}

function validateCharts(charts: ThinChartSpec[] | undefined, dataset: AutomationDataset): void {
  if (!charts || charts.length === 0) return;
  if (charts.length > 6) throw new Error("too-many-charts");
  const fields = new Set(dataset.schema.fields.map((f) => f.name));
  for (const spec of charts) {
    for (const name of [spec.x, spec.y, spec.y2, spec.splitBy, ...Object.keys(spec.where ?? {})]) {
      if (name && !fields.has(name)) throw new Error(`unknown-chart-field:${name}`);
    }
  }
}
