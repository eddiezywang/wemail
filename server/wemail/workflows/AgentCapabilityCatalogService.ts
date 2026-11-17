import { createHash } from "node:crypto";
import type {
  AgentCapabilityDescriptor,
  CapabilityAvailability,
  CapabilityCategory,
  WorkflowValueKind,
} from "../../../shared/wemail/skillCenter.js";
import type { AutomationCapabilityDescriptor } from "../automation/providers/AutomationProvider.js";
import type { AutomationProviderRegistry } from "../automation/providers/AutomationProviderRegistry.js";

const TRIGGERS: AgentCapabilityDescriptor[] = [
  trigger("trigger.manual", "手动触发", "由用户明确运行一次"),
  trigger("trigger.immediate", "立即执行", "立即运行一次，不创建规则"),
  trigger("trigger.schedule.daily", "每天定时", "按账户时区每天固定时间运行"),
  trigger("trigger.schedule.interval", "固定间隔", "按固定分钟或小时运行"),
  trigger("trigger.mail.received", "收到邮件", "收到符合条件的邮件后运行"),
  trigger("timing.delay", "延时执行", "在事件发生一段时间后运行", "timing"),
  trigger("timing.nextDay", "次日执行", "在事件后的下一个日历日运行", "timing"),
];

export class AgentCapabilityCatalogService {
  constructor(
    private readonly providers: AutomationProviderRegistry,
    private readonly expectedOptionalProviders: string[] = [],
  ) {}

  async list(): Promise<AgentCapabilityDescriptor[]> {
    const result = await this.providers.discoverWithStatus();
    const capabilities = result.capabilities.map(mapProviderCapability);
    const installed = new Set(this.providers.listProviderIds());
    if (
      installed.has("bot-message") &&
      !capabilities.some(
        (capability) => capability.id === "delivery.bot.sendConnected",
      )
    ) {
      capabilities.push(
        unavailableKnownCapability({
          id: "delivery.bot.sendConnected",
          name: "发送到已连接 Bot",
          description: "发送到飞书或企业微信 Bot",
          executorKey: "bot-message/publish-connected",
          availability: {
            state: "not_connected",
            reason: "当前没有已连接且可投递的飞书或企业微信 Bot。",
            recoveryActions: [
              {
                id: "connect-bot",
                type: "connect",
                label: "连接 Bot",
                target: "settings/connections",
              },
              {
                id: "message-center-only",
                type: "adjust_pipeline",
                label: "仅发布到消息中心",
              },
              { id: "cancel-bot-step", type: "cancel", label: "取消 Bot 投递" },
            ],
          },
        }),
      );
    }
    for (const status of result.providers.filter(
      (provider) => provider.status === "unavailable",
    )) {
      capabilities.push(
        unavailableKnownCapability({
          id: `unavailable.${camel(status.provider)}`,
          name: `${status.provider} 能力`,
          description: "当前执行适配器不可用",
          executorKey: `${status.provider}/unknown`,
          availability: availabilityFromIssue(status.issue),
        }),
      );
    }
    for (const provider of this.expectedOptionalProviders) {
      if (!installed.has(provider)) {
        capabilities.push(optionalMissing(provider));
      }
    }
    return [...TRIGGERS, ...capabilities].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  async get(id: string): Promise<AgentCapabilityDescriptor | undefined> {
    return (await this.list()).find((capability) => capability.id === id);
  }
}

function availabilityFromIssue(
  issue: import("../../../shared/wemail/configuration.js").ConfigurationIssue | undefined,
): CapabilityAvailability {
  const state =
    issue?.category === "authentication_required"
      ? "authentication_required"
      : issue?.category === "permission_denied"
        ? "permission_required"
        : issue?.category === "transient_service_failure"
          ? "temporarily_unavailable"
          : "unknown";
  return {
    state,
    reason: issue?.userMessage ?? "暂时无法确认该能力是否可用。",
    recoveryActions: [
      {
        id: `recover-${issue?.code ?? "unknown"}`,
        type:
          state === "authentication_required"
            ? "authenticate"
            : state === "permission_required"
              ? "open_settings"
              : "retry",
        label:
          state === "authentication_required"
            ? "重新登录"
            : state === "permission_required"
              ? "检查权限"
              : "重试",
      },
    ],
  };
}

function unavailableKnownCapability(input: {
  id: string;
  name: string;
  description: string;
  executorKey: string;
  availability: CapabilityAvailability;
}): AgentCapabilityDescriptor {
  return {
    ...input,
    category: "delivery",
    inputSchema: {},
    outputSchema: {},
    inputKinds: ["artifact-reference", "analysis-result"],
    outputKinds: ["delivery-receipt"],
    risk: "external_side_effect",
    previewSupport: "plan_only",
    idempotency: "keyed",
    version: "0",
    fingerprint: createHash("sha256")
      .update(`${input.id}:${input.availability.state}`)
      .digest("hex"),
  };
}

function mapProviderCapability(
  descriptor: AutomationCapabilityDescriptor,
): AgentCapabilityDescriptor {
  const category = categoryFor(descriptor);
  const id = publicCapabilityId(descriptor);
  return {
    id,
    category,
    name: descriptor.label,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    outputSchema: descriptor.outputSchema,
    inputKinds: inferInputKinds(descriptor),
    outputKinds: inferOutputKinds(descriptor),
    availability: { state: "ready" },
    risk:
      descriptor.risk === "read"
        ? "read"
        : descriptor.risk === "local-write"
          ? "local_write"
          : descriptor.risk === "destructive"
            ? "destructive"
            : "external_side_effect",
    previewSupport:
      descriptor.previewSupport === "plan-only"
        ? "plan_only"
        : descriptor.previewSupport,
    idempotency: descriptor.idempotency,
    version: descriptor.version,
    fingerprint: descriptor.fingerprint,
    executorKey: `${descriptor.provider}/${descriptor.id}`,
    ...(descriptor.metadata ? { metadata: descriptor.metadata } : {}),
  };
}

function publicCapabilityId(descriptor: AutomationCapabilityDescriptor): string {
  const exact: Record<string, string> = {
    "processor/mail-digest": "analysis.mailDigest",
    "processor/subscription-insight": "analysis.subscriptionInsight",
    "processor/monitoring-report": "analysis.monitoringReport",
    "processor/invoice-extract": "analysis.invoiceExtract",
    "processor/invoice-readiness": "analysis.invoiceReadiness",
    "processor/dataset-normalize": "analysis.normalize",
    "processor/aggregate": "analysis.aggregate",
    "analysis-recipe/execute": "analysis.recipeExecute",
    "design/render": "output.render",
    "bot-message/publish-connected": "delivery.bot.sendConnected",
    "application-message/publish": "delivery.messageCenter.publish",
  };
  const key = `${descriptor.provider}/${descriptor.id}`;
  return (
    exact[key] ??
    `${categoryFor(descriptor)}.${camel(descriptor.provider)}.${camel(descriptor.id)}`
  );
}

function categoryFor(
  descriptor: AutomationCapabilityDescriptor,
): CapabilityCategory {
  if (descriptor.kind === "source") return "data";
  if (descriptor.kind === "processor") return "analysis";
  if (descriptor.kind === "design") return "output";
  return "delivery";
}

function inferInputKinds(
  descriptor: AutomationCapabilityDescriptor,
): WorkflowValueKind[] {
  if (descriptor.kind === "processor") return ["mail-collection", "dataset"];
  if (descriptor.kind === "design") return ["dataset", "analysis-result"];
  if (descriptor.kind === "sink") {
    return ["artifact-reference", "analysis-result"];
  }
  return [];
}

function inferOutputKinds(
  descriptor: AutomationCapabilityDescriptor,
): WorkflowValueKind[] {
  const value = descriptor.outputSchema.automationValue;
  if (value === "dataset") return ["dataset"];
  if (value === "artifact-reference") return ["artifact-reference"];
  if (descriptor.kind === "sink") return ["delivery-receipt"];
  return [];
}

function trigger(
  id: string,
  name: string,
  description: string,
  category: CapabilityCategory = "trigger",
): AgentCapabilityDescriptor {
  const seed = { id, name, description, category };
  return {
    ...seed,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    inputKinds: [],
    outputKinds: [],
    availability: { state: "ready" },
    risk: "read",
    previewSupport: "full",
    idempotency: "native",
    version: "1",
    fingerprint: createHash("sha256").update(JSON.stringify(seed)).digest("hex"),
  };
}

function optionalMissing(provider: string): AgentCapabilityDescriptor {
  const availability: CapabilityAvailability = {
    state: "not_installed",
    reason: `${provider} 是可选能力，当前未安装。只有依赖它的步骤会被阻塞。`,
    recoveryActions: [
      {
        id: `install-${provider}`,
        type: "install",
        label: `安装 ${provider}`,
        requiresConfirmation: true,
      },
      {
        id: `adjust-without-${provider}`,
        type: "adjust_pipeline",
        label: "改用现有能力",
      },
      { id: `cancel-${provider}`, type: "cancel", label: "取消该步骤" },
    ],
  };
  return {
    id: `optional.${camel(provider)}`,
    category: "delivery",
    name: `${provider}（可选）`,
    description: "可选的企业系统能力",
    inputSchema: {},
    outputSchema: {},
    inputKinds: [],
    outputKinds: [],
    availability,
    risk: "external_side_effect",
    previewSupport: "plan_only",
    idempotency: "none",
    version: "0",
    fingerprint: createHash("sha256").update(`missing:${provider}`).digest("hex"),
  };
}

function camel(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
