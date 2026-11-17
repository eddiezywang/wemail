import type { AutomationArtifactReference } from "../../../../shared/wemail/automation.js";
import type { SubscriptionInsightResult } from "../../../../shared/wemail/automationCenter.js";
import type { ChannelBotProfile, ChannelDestination } from "../../../../shared/wemail/channels.js";
import type { ChannelConnectionRepository } from "../../channels/ChannelConnectionRepository.js";
import type { ChannelBindingRepository } from "../../channels/ChannelBindingRepository.js";
import type { ChannelDestinationRepository } from "../../channels/ChannelDestinationRepository.js";
import type { ChannelDeliveryRepository } from "../../channels/ChannelLedgerRepository.js";
import type { ApplicationMessageRepository } from "../../applicationMessages/ApplicationMessageRepository.js";
import type { MessageArtifactRepository } from "../../design/MessageArtifactRepository.js";
import { BaseAutomationProvider } from "./BaseAutomationProvider.js";
import {
  completedAudit,
  type AutomationCapabilityDescriptor,
  type AutomationProviderContext,
  type AutomationStepPreview,
  type AutomationStepResult,
  type CapabilityCompatibility,
  type CompiledAutomationStep,
} from "./AutomationProvider.js";
import { descriptorFingerprint } from "./AutomationProviderRegistry.js";

// The first Bot contract changed display copy before generic legacy-hash
// compatibility existed. Both historical contracts remain execution-compatible.
const LEGACY_BOT_MESSAGE_CAPABILITY_FINGERPRINTS = new Set([
  "1e34bee8d566658cfc66f1091aa54984788c24277f3ecefdc71c5445e4f3551a",
  "29e492b91a86981e724408c01c9ecf61f1cef743b867c836548ce61d7d6d277d",
]);

interface BotTarget {
  profile: ChannelBotProfile;
  destination?: ChannelDestination;
  targetType: "person" | "group";
  targetId: string;
  ownerBindingVersion?: number;
}

export class BotMessageAutomationProvider extends BaseAutomationProvider {
  readonly id = "bot-message";
  readonly version = "1";

  constructor(
    private readonly connections: ChannelConnectionRepository,
    private readonly bindings: ChannelBindingRepository,
    private readonly destinations: ChannelDestinationRepository,
    private readonly deliveries: ChannelDeliveryRepository,
    private readonly artifacts: MessageArtifactRepository,
    private readonly applicationMessages?: ApplicationMessageRepository,
  ) {
    super();
  }

  override checkCompatibility(
    previousFingerprint: string,
    current: AutomationCapabilityDescriptor,
  ): CapabilityCompatibility {
    if (
      current.id === "publish-connected" &&
      LEGACY_BOT_MESSAGE_CAPABILITY_FINGERPRINTS.has(previousFingerprint)
    ) {
      return "compatible";
    }
    return super.checkCompatibility(previousFingerprint, current);
  }

  protected capabilities(): AutomationCapabilityDescriptor[] {
    if (this.targets().length === 0) return [];
    const base = {
      provider: this.id,
      id: "publish-connected",
      version: this.version,
      kind: "sink" as const,
      label: "推送到已连接 Bot",
      description: "按已评审的优先级或全量策略选择已连接 Bot，并通过可靠队列执行失败回退与幂等投递",
      inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, artifact: { type: "object" } } },
      outputSchema: { type: "object", automationValue: "scalar" },
      risk: "external-mutation" as const,
      sideEffects: ["publish-message"] as const,
      previewSupport: "full" as const,
      idempotency: "keyed" as const,
      discoveryConfidence: "declared" as const,
    };
    return [{
      ...base,
      sideEffects: [...base.sideEffects],
      fingerprint: descriptorFingerprint({ ...base, sideEffects: [...base.sideEffects] }),
      metadata: {
        connectedTargets: this.targets().map((target) => ({
          platform: target.profile.platform,
          profileId: target.profile.id,
          displayName: target.profile.displayName,
        })),
      },
    }];
  }

  override async validate(
    _step: CompiledAutomationStep,
    input: Record<string, unknown>,
    context: AutomationProviderContext,
  ): Promise<string[]> {
    const targets = this.targets();
    if (targets.length === 0) return ["没有已连接且可投递的飞书或企业微信 Bot"];
    if (targets.length > 1 && !hasExplicitPolicy(input)) {
      return ["飞书和企业微信都已连接；请确认发送到两者，或给出明确优先级"];
    }
    if (input.artifact !== undefined && !isArtifact(input.artifact)) return ["artifact must be an artifact-reference"];
    return [];
  }

  async preview(
    _step: CompiledAutomationStep,
    input: Record<string, unknown>,
  ): Promise<AutomationStepPreview> {
    const targets = this.selectTargets(input);
    const target = targets[0];
    const firstAvailable = isFirstAvailablePolicy(input);
    return {
      plannedOperation: target
        ? firstAvailable && targets.length > 1
          ? `优先推送到${platformLabel(target.profile.platform)} Bot“${target.profile.displayName}”，失败后按顺序回退`
          : `推送到${platformLabel(target.profile.platform)} Bot“${target.profile.displayName}”`
        : "等待连接飞书或企业微信 Bot 后推送",
      resolvedInputSummary: {
        title: asText(input.title) ?? "自动化报告",
        targets: targets.map((item) => ({
          platform: item.profile.platform,
          profileId: item.profile.id,
        })),
        hasArtifact: isArtifact(input.artifact),
      },
      output: { type: "scalar", value: { preview: true, platform: target?.profile.platform } },
      warnings: target ? [] : ["当前没有可用 Bot；该依赖会阻塞配置提交"],
      sideEffects: ["publish-message"],
    };
  }

  async execute(
    step: CompiledAutomationStep,
    input: Record<string, unknown>,
    context: AutomationProviderContext,
  ): Promise<AutomationStepResult> {
    const startedAt = new Date().toISOString();
    try {
      const notification = subscriptionInsightNotificationDecision(
        input.value,
        input.notificationPolicy,
      );
      if (notification.suppress) {
        const completedAt = new Date().toISOString();
        return {
          status: "succeeded",
          output: {
            type: "scalar",
            value: { deliveries: [], suppressed: notification.reason },
          },
          warnings: ["邮箱速览没有风险或可处理建议，未发送 Bot 通知"],
          sideEffects: [],
          audit: completedAudit(step.descriptor, startedAt, completedAt),
        };
      }
      const targets = this.selectTargets(input);
      if (targets.length === 0) throw new Error("connected-bot-unavailable");
      if (this.targets().length > 1 && !hasExplicitPolicy(input)) {
        throw new Error("connected-bot-policy-required");
      }
      const artifact = isArtifact(input.artifact) ? input.artifact : undefined;
      const manifest = artifact
        ? this.artifacts.getManifest(artifact.artifactId, artifact.version, context.run.accountId)
        : undefined;
      if (artifact && !manifest) throw new Error("artifact-not-found");
      const title =
        asText(input.title) ??
        asText(context.trigger.notificationTitle) ??
        notification.title ??
        manifest?.title ??
        "自动化报告";
      const body =
        asText(input.body) ??
        asText(context.trigger.notificationBody) ??
        notification.body ??
        manifest?.preview ??
        "自动化任务已完成";
      const applicationMessage = artifact && manifest && this.applicationMessages
        ? this.applicationMessages.create({
            accountId: context.run.accountId,
            owner: context.owner,
            sourceType: "automation",
            sourceRuleId: context.run.ruleId,
            sourceRunId: context.run.id,
            type: "analysis",
            severity: "success",
            title: manifest.title,
            preview: manifest.preview,
            content: [
              { type: "paragraph", text: body },
              { type: "callout", tone: "info", title: "分析结论", text: manifest.preview },
            ],
            references: [
              { type: "automationRule", id: context.run.ruleId },
              { type: "automationRun", id: context.run.id },
            ],
            interactions: [{
              type: "openArtifact",
              artifactId: artifact.artifactId,
              version: artifact.version,
              label: "查看完整图表",
            }],
            artifact: {
              id: artifact.artifactId,
              version: artifact.version,
              kind: manifest.kind,
              contentHash: manifest.contentHash,
            },
            delayed: context.run.delayed,
          })
        : undefined;
      const artifactLine = artifact
        ? "\n\n完整图表已保存到 WeMail「应用消息」，可在应用内打开。"
        : "";
      const firstAvailable = isFirstAvailablePolicy(input);
      const activeTargets = firstAvailable ? targets.slice(0, 1) : targets;
      const fallbackTargets = firstAvailable
        ? targets.slice(1).map(targetToFallback)
        : [];
      const queued = activeTargets.map((target, index) =>
        this.deliveries.enqueue({
          connectionId: target.profile.connectionId,
          profileId: target.profile.id,
          botUuid: target.profile.botUuid,
          platform: target.profile.platform,
          targetType: target.targetType,
          targetId: target.targetId,
          purpose: "automation",
          text: `【${title}】\n${body}${artifactLine}`,
          sequence: index,
          maxAttempts: 3,
          correlationKey: firstAvailable
            ? `${context.run.occurrenceKey}:${step.id}:first_available`
            : `${context.run.occurrenceKey}:${step.id}:${target.profile.platform}`,
          automationRuleId: context.run.ruleId,
          automationRunId: context.run.id,
          automationActionIndex: index,
          ownerBindingVersion: target.ownerBindingVersion,
          ...(index === 0 && fallbackTargets.length > 0
            ? { fallbackTargets }
            : {}),
        }),
      );
      const completedAt = new Date().toISOString();
      return {
        status: "succeeded",
        output: {
          type: "scalar",
          value: {
            deliveries: queued.map((delivery) => ({
              deliveryId: delivery.id,
              platform: delivery.platform,
            })),
            artifact,
            applicationMessageId: applicationMessage?.id,
          },
        },
        warnings: [],
        sideEffects: queued.map((delivery) => ({
          type: "publish-message" as const,
          summary: `已加入${delivery.platform === "feishu" ? "飞书" : "企业微信"}投递队列`,
        })),
        audit: completedAudit(
          step.descriptor,
          startedAt,
          completedAt,
          queued.map((delivery) => delivery.id).join(","),
        ),
      };
    } catch (error) {
      const completedAt = new Date().toISOString();
      return {
        status: "failed",
        error: {
          code: error instanceof Error && error.message === "connected-bot-unavailable"
            ? "resource-unavailable"
            : "execution-failed",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
          retrySafe: true,
        },
        warnings: [],
        sideEffects: [],
        audit: completedAudit(step.descriptor, startedAt, completedAt),
      };
    }
  }

  private targets(): BotTarget[] {
    return this.connections
      .listProfiles()
      .filter((profile) =>
        profile.enabled &&
        profile.onboardingState === "ready" &&
        (profile.platform === "feishu" || profile.platform === "wecom"),
      )
      .sort((a, b) => {
        const platform = Number(a.platform !== "feishu") - Number(b.platform !== "feishu");
        return platform || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      })
      .flatMap((profile): BotTarget[] => {
        if (profile.owner) {
          const ownerTargetId = profile.platform === "wecom"
            ? this.bindings.findActiveOwner(profile.id, profile.owner.userId)?.chatId ??
              profile.owner.userId
            : profile.owner.userId;
          return [{
            profile,
            targetType: "person",
            targetId: ownerTargetId,
            ownerBindingVersion: profile.owner.bindingVersion,
          }];
        }
        const destination = this.destinations.list(profile.id).find((item) => item.verified);
        return destination
          ? [{ profile, destination, targetType: destination.type, targetId: destination.externalId }]
          : [];
      });
  }

  private selectTargets(input: Record<string, unknown>): BotTarget[] {
    const targets = this.targets();
    if (targets.length <= 1) return targets;
    if (input.notificationPolicy === "risk_or_actionable") return targets;
    const policy = asText(input.policy);
    if (policy === "all_available") return targets;
    const priority = Array.isArray(input.priority)
      ? input.priority.filter(
          (item): item is "feishu" | "wecom" =>
            item === "feishu" || item === "wecom",
        )
      : [];
    if (priority.length > 0) {
      return [...targets].sort(
        (left, right) => priorityRank(priority, left.profile.platform) -
          priorityRank(priority, right.profile.platform),
      );
    }
    return [];
  }
}

function targetToFallback(target: BotTarget) {
  return {
    connectionId: target.profile.connectionId,
    profileId: target.profile.id,
    botUuid: target.profile.botUuid,
    platform: target.profile.platform,
    targetType: target.targetType,
    targetId: target.targetId,
    ...(target.ownerBindingVersion !== undefined
      ? { ownerBindingVersion: target.ownerBindingVersion }
      : {}),
  };
}

function priorityRank(
  priority: Array<"feishu" | "wecom">,
  platform: "feishu" | "wecom",
): number {
  const index = priority.indexOf(platform);
  return index < 0 ? priority.length + 1 : index;
}

function platformLabel(platform: "feishu" | "wecom"): string {
  return platform === "feishu" ? "飞书" : "企业微信";
}

function hasExplicitPolicy(input: Record<string, unknown>): boolean {
  return (
    input.policy === "all_available" ||
    input.policy === "first_available" ||
    (Array.isArray(input.priority) &&
      input.priority.some((item) => item === "feishu" || item === "wecom"))
  );
}

function isFirstAvailablePolicy(input: Record<string, unknown>): boolean {
  return input.policy === "first_available" ||
    (input.policy !== "all_available" && Array.isArray(input.priority));
}

function isArtifact(value: unknown): value is AutomationArtifactReference {
  return !!value && typeof value === "object" && (value as AutomationArtifactReference).type === "artifact-reference";
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function subscriptionInsightNotificationDecision(
  value: unknown,
  policy: unknown,
): {
  suppress: boolean;
  reason?: "not-actionable";
  urgent: boolean;
  title?: string;
  body?: string;
} {
  if (policy !== "risk_or_actionable") {
    return { suppress: false, urgent: false };
  }
  const candidate =
    value &&
    typeof value === "object" &&
    (value as { type?: string }).type === "scalar"
      ? (value as { value?: unknown }).value
      : value;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    (candidate as { type?: string }).type !== "subscriptionDailyInsight"
  ) {
    return { suppress: false, urgent: false };
  }
  const result = candidate as SubscriptionInsightResult;
  const urgent =
    result.topHighlights.some((item) => item.kind === "risk") ||
    result.curatedCategories.some(
      (category) =>
        category.kind === "security" && category.items.length > 0,
    );
  const actionable = result.recommendedActions.length > 0;
  if (!urgent && !actionable) {
    return { suppress: true, reason: "not-actionable", urgent: false };
  }
  return {
    suppress: false,
    urgent,
    title: urgent ? "邮箱速览 · 安全提醒" : "邮箱速览 · 有待处理建议",
    body: urgent
      ? `发现需要及时查看的安全信息；另有 ${result.recommendedActions.length} 项可处理建议。`
      : `今天有 ${result.recommendedActions.length} 项可处理建议，详情已保存到消息中心。`,
  };
}
