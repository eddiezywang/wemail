import type { AutomationDataset, AutomationValue } from "../../../../shared/wemail/automation.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import type { CanonicalMailRepository } from "../../mail/CanonicalMailRepository.js";
import { BaseAutomationProvider } from "./BaseAutomationProvider.js";
import type { AutomationCapabilityDescriptor, AutomationProviderContext, AutomationStepPreview, AutomationStepResult, CompiledAutomationStep } from "./AutomationProvider.js";
import { completedAudit } from "./AutomationProvider.js";
import { descriptorFingerprint } from "./AutomationProviderRegistry.js";
import {
  SubscriptionInsightService,
  type SubscriptionSemanticClassifier,
} from "../SubscriptionInsightService.js";
import type { OfficeScenePort } from "../../intelligence/officeScenePort.js";

export class ProcessorAutomationProvider extends BaseAutomationProvider {
  readonly id = "processor";
  readonly version = "1";
  private readonly subscriptionInsight: SubscriptionInsightService;

  constructor(
    private readonly mail: CanonicalMailRepository,
    semanticClassifier?: SubscriptionSemanticClassifier,
    officeScenes?: OfficeScenePort,
  ) {
    super();
    this.subscriptionInsight = new SubscriptionInsightService(
      semanticClassifier,
      officeScenes,
    );
  }

  protected capabilities(): AutomationCapabilityDescriptor[] {
    return ["mail-digest", "subscription-insight", "monitoring-report", "invoice-extract", "invoice-readiness", "dataset-normalize", "aggregate"].map((id) => {
      const monitoring = id === "monitoring-report";
      const subscriptionInsight = id === "subscription-insight";
      const base = {
        provider: this.id,
        id,
        version: this.version,
        kind: "processor" as const,
        label: monitoring ? "监控告警与执行邮件结构化" : subscriptionInsight ? "邮箱速览分析" : id,
        description: monitoring
          ? "从带 WEMAIL_MONITORING_REPORT 标记的系统监控邮件提取小时调用量、失败量、平均耗时、告警数、成功率和告警摘要，供趋势图与日报使用"
          : subscriptionInsight
            ? "对冻结的订阅候选邮件进行有界筛选、去重、分组、风险识别并生成带来源的邮箱速览结果"
          : `结构化处理：${id}`,
        inputSchema: monitoring
          ? { type: "object", required: ["messages"], properties: { messages: { automationValue: "mail-collection" } } }
          : { type: "object" },
        outputSchema: subscriptionInsight
          ? {
              type: "object",
              automationValue: "scalar",
              resultType: "subscriptionDailyInsight",
              schemaVersion: 1,
            }
          : {
          type: "object",
          automationValue: "dataset",
          ...(monitoring
            ? { fields: ["hour", "requestCount", "errorCount", "latencyMs", "avgLatencyMs", "alertCount", "successRate", "model", "alertSummary"] }
            : {}),
          },
        risk: "read" as const,
        sideEffects: ["read-mail"] as const,
        previewSupport: "full" as const,
        idempotency: "native" as const,
        discoveryConfidence: "declared" as const,
      };
      return { ...base, sideEffects: [...base.sideEffects], fingerprint: descriptorFingerprint({ ...base, sideEffects: [...base.sideEffects] }) };
    });
  }

  async preview(step: CompiledAutomationStep, input: Record<string, unknown>, context: AutomationProviderContext): Promise<AutomationStepPreview> {
    const output = await this.buildOutput(step.capability, input, context);
    const dataset = output.type === "dataset" ? output : undefined;
    return {
      plannedOperation: dataset
        ? `${step.capability} 处理 ${dataset.rows.length} 行`
        : `${step.capability} 生成结构化速览`,
      resolvedInputSummary: dataset
        ? { rows: dataset.rows.length, fields: dataset.schema.fields.map((field) => field.name) }
        : { resultType: "subscriptionDailyInsight" },
      output,
      warnings: [],
      sideEffects: ["read-mail"],
    };
  }

  async execute(step: CompiledAutomationStep, input: Record<string, unknown>, context: AutomationProviderContext): Promise<AutomationStepResult> {
    const startedAt = new Date().toISOString();
    try {
      const output = await this.buildOutput(step.capability, input, context);
      const completedAt = new Date().toISOString();
      const count =
        output.type === "dataset"
          ? output.rows.length
          : output.type === "scalar" &&
              typeof output.value === "object" &&
              output.value &&
              "stats" in output.value
            ? Number((output.value as { stats?: { selected?: number } }).stats?.selected ?? 0)
            : 0;
      return { status: "succeeded", output, warnings: [], sideEffects: [{ type: "read-mail", summary: `${count} selected` }], audit: completedAudit(step.descriptor, startedAt, completedAt) };
    } catch (error) {
      const completedAt = new Date().toISOString();
      return { status: "failed", error: { code: "execution-failed", message: error instanceof Error ? error.message : String(error), retryable: false, retrySafe: false }, warnings: [], sideEffects: [], audit: completedAudit(step.descriptor, startedAt, completedAt) };
    }
  }

  private async buildOutput(capability: string, input: Record<string, unknown>, context: AutomationProviderContext): Promise<AutomationValue> {
    if (capability === "dataset-normalize" || capability === "aggregate") {
      const value = input.dataset;
      if (value && typeof value === "object" && (value as any).type === "dataset") return value as AutomationDataset;
      throw new Error("dataset-required");
    }
    const refs = normalizeMessageRefs(input.messages ?? context.collection?.messages ?? context.trigger.mail);
    const messages = refs.map((ref) => this.mail.getMessageById(ref.emailId, ref.accountId ?? context.run.accountId)).filter((item: MailMessage | null): item is MailMessage => !!item);
    if (capability === "subscription-insight") {
      const accountIds = [...new Set(messages.map((message) => message.accountId))];
      const collectionWindow =
        context.collection?.window &&
        typeof context.collection.window === "object"
          ? (context.collection.window as Record<string, unknown>)
          : {};
      const end =
        typeof context.trigger.windowEnd === "string"
          ? context.trigger.windowEnd
          : typeof collectionWindow.to === "string"
            ? collectionWindow.to
          : context.run.scheduledAt ?? context.run.actualStartedAt;
      const start =
        typeof context.trigger.windowStart === "string"
          ? context.trigger.windowStart
          : typeof collectionWindow.from === "string"
            ? collectionWindow.from
          : new Date(Date.parse(end) - 24 * 60 * 60 * 1_000).toISOString();
      return {
        type: "scalar",
        value: await this.subscriptionInsight.analyzeWithSemanticClassification(messages, {
          window: {
            start,
            end,
            timezone:
              typeof context.trigger.timezone === "string"
                ? context.trigger.timezone
                : typeof collectionWindow.timezone === "string"
                  ? collectionWindow.timezone
                : "Asia/Shanghai",
          },
          accountIds: accountIds.length ? accountIds : [context.run.accountId],
          maxMessages:
            typeof input.maxMessages === "number" ? input.maxMessages : 400,
          perAccountLimit:
            typeof input.perAccountLimit === "number"
              ? input.perAccountLimit
              : 150,
          maxSemanticCandidates:
            typeof input.maxSemanticCandidates === "number"
              ? input.maxSemanticCandidates
              : 20,
          includePromotions:
            typeof input.includePromotions === "boolean"
              ? input.includePromotions
              : true,
        }),
      };
    }
    if (capability === "invoice-extract" || capability === "invoice-readiness") return invoiceDataset(messages);
    if (capability === "monitoring-report") return monitoringDataset(messages);
    return digestDataset(messages);
  }
}

interface MonitoringReportRow {
  hour: string;
  requestCount: number;
  errorCount: number;
  latencyMs?: number;
  avgLatencyMs: number;
  alertCount: number;
  successRate: number;
  model: string;
  status: string;
  sourceEmailId: string;
  alertSummary: string;
}

function monitoringDataset(messages: MailMessage[]): AutomationDataset {
  const rows = messages.flatMap((message) =>
    extractMonitoringRows(message.bodyText || message.snippet || "").map(
      (row): MonitoringReportRow => {
        const latencyMs = asOptionalNumber(row.latencyMs ?? row.latency_ms);
        return {
          hour: asText(row.hour) ?? message.receivedAt.slice(11, 13) + ":00",
          requestCount: asNumber(row.requestCount ?? row.cnt),
          errorCount: asNumber(row.errorCount ?? row.failed),
          ...(latencyMs !== undefined ? { latencyMs } : {}),
          avgLatencyMs: asNumber(row.avgLatencyMs ?? row.avg_latency),
          alertCount: asNumber(row.alertCount ?? row.alerts),
          successRate: asNumber(row.successRate ?? row.success_rate, 100),
          model: asText(row.model ?? row.model_name) ?? "unknown",
          status: asText(row.status ?? row.deal_status) ?? "S",
          sourceEmailId: message.id,
          alertSummary: asText(row.alertSummary ?? row.alert) ?? "",
        };
      },
    ),
  ).sort((a, b) => a.hour.localeCompare(b.hour));
  const totalRequests = rows.reduce((sum, row) => sum + row.requestCount, 0);
  const totalErrors = rows.reduce((sum, row) => sum + row.errorCount, 0);
  const sourceEmails: Array<{ id: string; subject?: string; from?: string; date?: string }> = [];
  const seenIds = new Set<string>();
  for (const message of messages) {
    if (seenIds.has(message.id)) continue;
    seenIds.add(message.id);
    sourceEmails.push({
      id: message.id,
      subject: message.subject,
      from: message.from?.name ?? message.from?.email,
      date: message.receivedAt,
    });
  }
  return {
    type: "dataset",
    schema: { fields: [
      { name: "hour", type: "string", label: "时段" },
      { name: "requestCount", type: "number", label: "接口调用量" },
      { name: "errorCount", type: "number", label: "失败量" },
      { name: "latencyMs", type: "number", label: "请求耗时(ms)" },
      { name: "avgLatencyMs", type: "number", label: "平均耗时(ms)" },
      { name: "alertCount", type: "number", label: "告警数" },
      { name: "successRate", type: "number", label: "成功率(%)" },
      { name: "model", type: "string", label: "模型" },
      { name: "status", type: "string", label: "状态" },
      { name: "alertSummary", type: "string", label: "告警摘要" },
      { name: "sourceEmailId", type: "reference", label: "来源邮件" },
    ] },
    rows: rows.map((row) => ({ ...row })),
    summary: {
      totalMessages: messages.length,
      totalRequests,
      totalErrors,
      totalAlerts: rows.reduce((sum, row) => sum + row.alertCount, 0),
      avgLatencyMs: rows.length
        ? Math.round(rows.reduce((sum, row) => sum + row.avgLatencyMs, 0) / rows.length)
        : 0,
      successRate: totalRequests > 0
        ? Number((((totalRequests - totalErrors) / totalRequests) * 100).toFixed(2))
        : 100,
    },
    provenance: rows.map((row, index) => ({
      outputPath: `rows.${index}`,
      sourceType: "mail",
      emailIds: [row.sourceEmailId],
      operation: "monitoring-report",
    })),
    sourceEmails,
  };
}

function extractMonitoringRows(value: string): Array<Record<string, unknown>> {
  const marker = "WEMAIL_MONITORING_REPORT:";
  return value.split(/\r?\n/).flatMap((line) => {
    const index = line.indexOf(marker);
    if (index < 0) return [];
    try {
      const parsed = JSON.parse(line.slice(index + marker.length).trim()) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
      }
      return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

function asNumber(value: unknown, fallback = 0): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(numeric)
    ? numeric
    : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeMessageRefs(value: unknown): Array<{ emailId: string; accountId?: string }> {
  const rows: unknown[] = Array.isArray(value) ? value : value && typeof value === "object" && (value as any).type === "mail-collection" ? (value as any).messages : value ? [value] : [];
  return rows.filter((item: unknown): item is { emailId: string; accountId?: string } => !!item && typeof item === "object" && typeof (item as any).emailId === "string");
}

function digestDataset(messages: MailMessage[]): AutomationDataset {
  const bySender = new Map<string, number>();
  for (const message of messages) bySender.set(message.from.email, (bySender.get(message.from.email) ?? 0) + 1);
  return {
    type: "dataset",
    schema: { fields: [
      { name: "emailId", type: "reference", label: "邮件" },
      { name: "receivedAt", type: "datetime", label: "时间" },
      { name: "sender", type: "string", label: "发件人" },
      { name: "subject", type: "string", label: "主题" },
      { name: "hasAttachments", type: "boolean", label: "附件" },
    ] },
    rows: messages.map((message) => ({ emailId: message.id, receivedAt: message.receivedAt, sender: message.from.email, subject: message.subject, hasAttachments: message.hasAttachments })),
    summary: { totalMessages: messages.length, uniqueSenders: bySender.size, withAttachments: messages.filter((item) => item.hasAttachments).length },
    provenance: messages.map((message, index) => ({ outputPath: `rows.${index}`, sourceType: "mail", emailIds: [message.id] })),
  };
}

function invoiceDataset(messages: MailMessage[]): AutomationDataset {
  const rows = messages.flatMap((message) => message.attachments.filter((attachment) => /pdf|invoice|发票/i.test(`${attachment.mimetype ?? ""} ${attachment.filename}`)).map((attachment) => ({ emailId: message.id, attachmentId: attachment.id, invoiceNumber: extract(message.subject, /(?:发票|invoice)[^A-Za-z0-9]*([A-Za-z0-9-]{5,})/i), seller: message.from.name || message.from.email, amount: extractAmount(`${message.subject} ${message.snippet}`), invoiceDate: message.receivedAt.slice(0, 10), status: "待处理", filename: attachment.filename })));
  return {
    type: "dataset",
    schema: { fields: [
      { name: "emailId", type: "reference" }, { name: "attachmentId", type: "reference" },
      { name: "invoiceNumber", type: "string", label: "发票号码" }, { name: "seller", type: "string", label: "销售方" },
      { name: "amount", type: "number", label: "金额" }, { name: "invoiceDate", type: "date", label: "日期" },
      { name: "status", type: "string", label: "状态" }, { name: "filename", type: "string", label: "附件" },
    ] },
    rows,
    summary: { totalInvoices: rows.length, totalAmount: rows.reduce((sum, row) => sum + (typeof row.amount === "number" ? row.amount : 0), 0), missingAmountCount: rows.filter((row) => row.amount === undefined).length },
    provenance: rows.map((row, index) => ({ outputPath: `rows.${index}`, sourceType: "attachment", emailIds: [row.emailId], attachmentIds: [row.attachmentId] })),
  };
}

function extract(value: string, pattern: RegExp): string | undefined { return pattern.exec(value)?.[1]; }
function extractAmount(value: string): number | undefined { const match = /(?:¥|￥|CNY|RMB)?\s*([0-9]+(?:\.[0-9]{1,2})?)/i.exec(value); return match ? Number(match[1]) : undefined; }
