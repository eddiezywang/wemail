import { createHash } from "node:crypto";
import type { UserTag } from "../../intelligence/UserTagRepository.js";

export interface SmartTagDefinition {
  id: string;
  name: string;
  prompt: string;
  source: "builtin" | "user";
  version: string;
  enabled: boolean;
}

export const BUILTIN_SMART_TAG_DEFINITION_VERSION = "2026-07-03.1";

export const BUILTIN_SMART_TAG_DEFINITIONS = Object.freeze([
  {
    id: "builtin-notification",
    name: "通知",
    source: "builtin",
    version: BUILTIN_SMART_TAG_DEFINITION_VERSION,
    enabled: true,
    prompt:
      "用于系统、平台、组织或流程自动发送的告知类邮件。包括系统通知、流程状态变更、账号提醒、服务提醒、内部公告通知。不包括需要明确审批、确认、反馈或补充材料的邮件。",
  },
  {
    id: "builtin-awaiting-reply",
    name: "待回复",
    source: "builtin",
    version: BUILTIN_SMART_TAG_DEFINITION_VERSION,
    enabled: true,
    prompt:
      "用于明确要求收件人回复、确认、反馈、给出意见、补充信息或在截止时间前响应的邮件。不包括仅供知悉、无需回复的通知或公告。",
  },
  {
    id: "builtin-release",
    name: "发布",
    source: "builtin",
    version: BUILTIN_SMART_TAG_DEFINITION_VERSION,
    enabled: true,
    prompt:
      "用于产品、系统、版本、制度、公告、文档等正式发布或上线信息。包括版本发布、生产变更发布、功能上线、制度发布、公告发布。不包括普通通知、会议纪要或日报周报。",
  },
  {
    id: "builtin-alert",
    name: "告警",
    source: "builtin",
    version: BUILTIN_SMART_TAG_DEFINITION_VERSION,
    enabled: true,
    prompt:
      "用于监控、系统、业务指标、安全或流程异常告警。包括失败、异常、超时、风险、阈值触发、故障恢复等需要关注的告警信息。不包括普通状态通知。",
  },
  {
    id: "builtin-daily-report",
    name: "日报",
    source: "builtin",
    version: BUILTIN_SMART_TAG_DEFINITION_VERSION,
    enabled: true,
    prompt:
      "用于每日、每周或定期工作进展、运营数据、监控结果、统计报表类邮件。包括项目日报、运营日报、监控日报、数据日报和周期性汇总。不包括单次会议纪要或普通通知。",
  },
  {
    id: "builtin-requirement",
    name: "需求",
    source: "builtin",
    version: BUILTIN_SMART_TAG_DEFINITION_VERSION,
    enabled: true,
    prompt:
      "用于提出、澄清、评审或跟进业务需求、产品需求、技术需求的邮件。包括需求收集、需求变更、方案评审、排期讨论。不包括纯发布通知或普通会议邀请。",
  },
  {
    id: "builtin-meeting",
    name: "会议",
    source: "builtin",
    version: BUILTIN_SMART_TAG_DEFINITION_VERSION,
    enabled: true,
    prompt:
      "用于会议邀请、会议调整、会议取消、会议议程、会议纪要或会后行动项相关邮件。不包括普通日报、发布公告或无需参会的信息通知。",
  },
  {
    id: "builtin-approval",
    name: "审批",
    source: "builtin",
    version: BUILTIN_SMART_TAG_DEFINITION_VERSION,
    enabled: true,
    prompt:
      "用于需要审批、授权、确认同意、流程流转或审批结果通知的邮件。包括费用、权限、合同、流程单、变更审批。不包括普通待回复问题。",
  },
] satisfies readonly SmartTagDefinition[]);

export const BUILTIN_SMART_TAG_NAMES = Object.freeze(
  BUILTIN_SMART_TAG_DEFINITIONS.map((definition) => definition.name),
) as readonly string[];

/** Legacy names retained only as content-topic normalization seeds. */
export const LEGACY_CONTENT_TOPIC_SEEDS = BUILTIN_SMART_TAG_NAMES;

export function definitionsForUserTags(
  userTags: readonly UserTag[],
): SmartTagDefinition[] {
  return userTags.map((tag) => ({
    id: tag.id,
    name: tag.name.trim(),
    prompt: tag.effectivePrompt.trim(),
    source: "user" as const,
    version: tag.optimizedPromptVersion ?? tag.updatedAt,
    enabled: true,
  })).filter((definition) => definition.name.length > 0);
}

export function buildSmartTagDefinitions(
  userTags: readonly UserTag[] = [],
): SmartTagDefinition[] {
  const seen = new Set<string>();
  const out: SmartTagDefinition[] = [];
  for (const definition of definitionsForUserTags(userTags)) {
    if (!definition.enabled || seen.has(definition.name)) continue;
    seen.add(definition.name);
    out.push(definition);
  }
  return out;
}

export function smartTagDefinitionFingerprint(
  definitions: readonly SmartTagDefinition[] = BUILTIN_SMART_TAG_DEFINITIONS,
): string {
  const payload = definitions.map((definition) => ({
    id: definition.id,
    name: definition.name,
    prompt: definition.prompt,
    source: definition.source,
    version: definition.version,
  }));
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

export const BUILTIN_SMART_TAG_FINGERPRINT =
  smartTagDefinitionFingerprint(BUILTIN_SMART_TAG_DEFINITIONS);

