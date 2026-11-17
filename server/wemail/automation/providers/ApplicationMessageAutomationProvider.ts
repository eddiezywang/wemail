import type { AutomationArtifactReference } from "../../../../shared/wemail/automation.js";
import type {
  ApplicationMessageContentBlock,
  ApplicationMessageInteraction,
  ApplicationMessageReference,
} from "../../../../shared/wemail/applicationMessages.js";
import type { SubscriptionInsightResult } from "../../../../shared/wemail/automationCenter.js";
import type { ApplicationMessageRepository } from "../../applicationMessages/ApplicationMessageRepository.js";
import type { MessageArtifactRepository } from "../../design/MessageArtifactRepository.js";
import { BaseAutomationProvider } from "./BaseAutomationProvider.js";
import type { AutomationCapabilityDescriptor, AutomationProviderContext, AutomationStepPreview, AutomationStepResult, CompiledAutomationStep } from "./AutomationProvider.js";
import { completedAudit } from "./AutomationProvider.js";
import { descriptorFingerprint } from "./AutomationProviderRegistry.js";

export class ApplicationMessageAutomationProvider extends BaseAutomationProvider {
  readonly id = "application-message";
  readonly version = "1";
  constructor(
    private readonly messages: ApplicationMessageRepository,
    private readonly artifacts: MessageArtifactRepository,
    private readonly onAttention?: (event: {
      accountId: string;
      messageId: string;
      title: string;
      detail: string;
      urgent: boolean;
    }) => void,
  ) { super(); }
  protected capabilities(): AutomationCapabilityDescriptor[] {
    const base = { provider: this.id, id: "publish", version: this.version, kind: "sink" as const, label: "推送应用消息", description: "把摘要和可选 Design Artifact 发布到消息中心", inputSchema: { type: "object" }, outputSchema: { type: "object", automationValue: "scalar" }, risk: "local-write" as const, sideEffects: ["publish-message"] as const, previewSupport: "full" as const, idempotency: "keyed" as const, discoveryConfidence: "declared" as const };
    return [{ ...base, sideEffects: [...base.sideEffects], fingerprint: descriptorFingerprint({ ...base, sideEffects: [...base.sideEffects] }) }];
  }
  override async validate(_step: CompiledAutomationStep, input: Record<string, unknown>): Promise<string[]> {
    const artifact = input.artifact;
    return artifact === undefined || isArtifact(artifact) ? [] : ["artifact must be an artifact-reference"];
  }
  async preview(_step: CompiledAutomationStep, input: Record<string, unknown>): Promise<AutomationStepPreview> { return { plannedOperation: `发布应用消息：${asString(input.title) ?? "自动化结果"}`, resolvedInputSummary: { title: asString(input.title), hasArtifact: isArtifact(input.artifact) }, output: { type: "scalar", value: { preview: true } }, warnings: [], sideEffects: ["publish-message"] }; }
  async execute(step: CompiledAutomationStep, input: Record<string, unknown>, context: AutomationProviderContext): Promise<AutomationStepResult> {
    const startedAt = new Date().toISOString();
    try {
      const artifact = isArtifact(input.artifact) ? input.artifact : undefined;
      const manifest = artifact ? this.artifacts.getManifest(artifact.artifactId, artifact.version, context.run.accountId) : null;
      if (artifact && !manifest) throw new Error("artifact-not-found");
      const title = asString(input.title) ?? manifest?.title ?? "自动化结果";
      const insight = subscriptionInsightFrom(input.value);
      if (insight?.emptyReason) {
        const completedAt = new Date().toISOString();
        return {
          status: "succeeded",
          output: {
            type: "scalar",
            value: { messageId: undefined, suppressed: "empty-insight" },
          },
          warnings: ["empty insight was retained in run history without publication"],
          sideEffects: [],
          audit: completedAudit(
            step.descriptor,
            startedAt,
            completedAt,
          ),
        };
      }
      const specialized = insight ? subscriptionApplicationMessage(insight) : undefined;
      const preview = specialized?.preview ?? asString(input.preview) ?? manifest?.preview ?? "自动化任务已完成";
      const message = this.messages.create({
        accountId: context.run.accountId,
        owner: context.owner,
        sourceType: "automation",
        sourceRuleId: context.run.ruleId,
        sourceRunId: context.run.id,
        type: "analysis",
        severity: specialized?.severity ?? "success",
        title: specialized?.title ?? title,
        preview,
        content: specialized?.content ?? [{ type: "paragraph", text: preview }],
        references: specialized?.references ?? [{ type: "automationRule", id: context.run.ruleId }],
        interactions: specialized?.interactions ?? (artifact ? [{ type: "openArtifact", artifactId: artifact.artifactId, version: artifact.version, label: "查看完整内容" }] : []),
        artifact: artifact ? { id: artifact.artifactId, version: artifact.version, kind: artifact.kind, contentHash: artifact.contentHash } : undefined,
        keyMetrics: specialized?.keyMetrics ?? normalizeMetrics(input.keyMetrics),
        delayed: context.run.delayed,
      });
      if (
        insight &&
        (specialized?.severity === "warning" ||
          insight.recommendedActions.length > 0)
      ) {
        this.onAttention?.({
          accountId: context.run.accountId,
          messageId: message.id,
          title:
            specialized?.severity === "warning"
              ? "邮箱速览 · 安全提醒"
              : "邮箱速览 · 有待处理建议",
          detail: message.preview,
          urgent: specialized?.severity === "warning",
        });
      }
      const completedAt = new Date().toISOString();
      return { status: "succeeded", output: { type: "scalar", value: { messageId: message.id } }, warnings: [], sideEffects: [{ type: "publish-message", summary: title }], audit: completedAudit(step.descriptor, startedAt, completedAt) };
    } catch (error) {
      const completedAt = new Date().toISOString();
      return { status: "failed", error: { code: "execution-failed", message: error instanceof Error ? error.message : String(error), retryable: false, retrySafe: false }, warnings: [], sideEffects: [], audit: completedAudit(step.descriptor, startedAt, completedAt) };
    }
  }
}
function isArtifact(value: unknown): value is AutomationArtifactReference { return !!value && typeof value === "object" && (value as AutomationArtifactReference).type === "artifact-reference"; }
function asString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function normalizeMetrics(value: unknown) { return Array.isArray(value) ? value.slice(0, 6).filter((item): item is { label: string; value: string } => !!item && typeof item === "object" && typeof (item as any).label === "string" && typeof (item as any).value === "string") : undefined; }

function subscriptionInsightFrom(value: unknown): SubscriptionInsightResult | undefined {
  const candidate =
    value &&
    typeof value === "object" &&
    (value as { type?: string }).type === "scalar"
      ? (value as { value?: unknown }).value
      : value;
  if (!candidate || typeof candidate !== "object") return undefined;
  const result = candidate as Partial<SubscriptionInsightResult>;
  return result.type === "subscriptionDailyInsight" &&
    result.schemaVersion === 1 &&
    Array.isArray(result.topHighlights) &&
    Array.isArray(result.curatedCategories) &&
    Array.isArray(result.recommendedActions) &&
    !!result.stats
    ? (candidate as SubscriptionInsightResult)
    : undefined;
}

function subscriptionApplicationMessage(result: SubscriptionInsightResult): {
  title: string;
  preview: string;
  severity: "info" | "warning";
  content: ApplicationMessageContentBlock[];
  references: ApplicationMessageReference[];
  interactions: ApplicationMessageInteraction[];
  keyMetrics: Array<{ label: string; value: string; tone?: "info" | "warning" }>;
} {
  const urgent = result.topHighlights.some((item) => item.kind === "risk");
  const title = "邮箱速览";
  const preview = result.emptyReason
    ? `已扫描 ${result.stats.scanned} 封邮件，今天没有需要整理的订阅更新。`
    : `整理出 ${result.stats.groups} 个内容组、${result.recommendedActions.length} 项建议。`;
  const content: ApplicationMessageContentBlock[] = result.emptyReason
    ? [{ type: "paragraph", text: preview }]
    : [
        { type: "heading", level: 2, text: "今日重点" },
        {
          type: "list",
          ordered: false,
          items: result.topHighlights.slice(0, 4).map((item) => item.text),
        },
        ...result.curatedCategories.slice(0, 6).flatMap(
          (category): ApplicationMessageContentBlock[] => [
            {
              type: "heading",
              level: 3,
              text: category.label ?? category.kind,
            },
            {
              type: "list",
              ordered: false,
              items: category.items.slice(0, 5).map((item) => item.takeaway),
            },
          ],
        ),
        ...(result.stats.truncated
          ? [{
              type: "callout" as const,
              tone: "warning" as const,
              title: "结果已做有界截断",
              text: `扫描 ${result.stats.scanned} 封，选中 ${result.stats.selected} 封，排除 ${result.stats.excluded} 封。`,
            }]
          : []),
      ];
  const sources = [
    ...result.topHighlights.flatMap((item) => item.sourceEmails),
    ...result.curatedCategories.flatMap((category) =>
      category.items.flatMap((item) => item.sourceEmails),
    ),
  ];
  const uniqueSources = [...new Map(
    sources.map((source) => [`${source.accountId}:${source.emailId}`, source]),
  ).values()].slice(0, 100);
  const references: ApplicationMessageReference[] = uniqueSources.map((source) => ({
    type: "email",
    id: source.emailId,
    accountId: source.accountId,
    label: source.label ?? source.subject,
  }));
  const interactions: ApplicationMessageInteraction[] = uniqueSources.length
    ? [{
        type: "openEmails",
        emailIds: uniqueSources.slice(0, 4).map((source) => source.emailId),
        references: uniqueSources.slice(0, 4).map((source) => ({
          accountId: source.accountId,
          emailId: source.emailId,
        })),
        label: "查看重点来源",
      }]
    : [];
  return {
    title,
    preview,
    severity: urgent ? "warning" : "info",
    content,
    references,
    interactions,
    keyMetrics: [
      { label: "扫描", value: String(result.stats.scanned) },
      { label: "入选", value: String(result.stats.selected) },
      { label: "内容组", value: String(result.stats.groups) },
      {
        label: "建议",
        value: String(result.recommendedActions.length),
        tone: result.recommendedActions.length ? "warning" : "info",
      },
    ],
  };
}
