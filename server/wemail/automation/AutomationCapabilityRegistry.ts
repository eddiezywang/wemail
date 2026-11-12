import { createHash } from "node:crypto";

export type AutomationCapabilityRisk = "low" | "medium" | "high";

export interface AutomationCapability {
  id: string;
  label: string;
  description: string;
  risk: AutomationCapabilityRisk;
  configurable: boolean;
}

export interface AutomationCapabilityCatalog {
  version: number;
  triggers: AutomationCapability[];
  schedules: AutomationCapability[];
  conditionFields: AutomationCapability[];
  conditionOperators: AutomationCapability[];
  scopes: AutomationCapability[];
  processors: AutomationCapability[];
  actions: AutomationCapability[];
}

const capability = (
  id: string,
  label: string,
  description: string,
  risk: AutomationCapabilityRisk = "low",
): AutomationCapability => ({ id, label, description, risk, configurable: true });

export const AUTOMATION_CAPABILITIES: AutomationCapabilityCatalog = Object.freeze({
  version: 1,
  triggers: [
    capability("manual", "手动运行", "由用户或 Agent 明确触发"),
    capability("mailReceived", "收到邮件", "新邮件到达后运行"),
    capability("scheduled", "定时运行", "按间隔或每天固定时间运行"),
  ],
  schedules: [
    capability("interval", "固定间隔", "按固定分钟数循环"),
    capability("daily", "每天固定时间", "按 IANA 时区的本地时间每天运行"),
  ],
  conditionFields: [
    capability("sender", "发件人", "匹配发件人名称或地址"),
    capability("recipient", "收件人", "匹配收件人名称或地址"),
    capability("cc", "抄送", "匹配抄送人"),
    capability("subject", "主题", "匹配邮件主题"),
    capability("body", "正文", "匹配邮件正文"),
    capability("hasAttachment", "包含附件", "匹配附件存在状态"),
    capability("aiTag", "智能标签", "匹配 AI 或用户标签"),
  ],
  conditionOperators: [
    capability("contains", "包含", "文本包含指定值"),
    capability("notContains", "不包含", "文本不包含指定值"),
    capability("equals", "等于", "值完全相等"),
    capability("notEquals", "不等于", "值不相等"),
    capability("exists", "存在", "字段存在"),
    capability("notExists", "不存在", "字段不存在"),
  ],
  scopes: [
    capability("rollingWindow", "滚动时间窗口", "收集运行时向前的一段时间"),
    capability("previousScheduleWindow", "上次调度窗口", "收集上次计划时间到本次计划时间"),
  ],
  processors: [
    capability("mailDigest", "邮件摘要", "把匹配邮件归集为阶段性摘要"),
    capability("invoiceReadinessAnalysis", "发票就绪分析", "整理发票并分析可上传状态"),
  ],
  actions: [
    capability("applyLabel", "添加标签", "为单封邮件添加标签"),
    capability("star", "加星", "为单封邮件加星"),
    capability("archive", "归档", "归档单封邮件", "medium"),
    capability("trash", "删除", "移入垃圾箱", "high"),
    capability("spam", "标为垃圾邮件", "标记为垃圾邮件", "high"),
    capability("notSpam", "取消垃圾邮件", "移出垃圾邮件"),
    capability("markImportant", "标为重要", "标记为重要"),
    capability("markNotImportant", "取消重要", "取消重要标记"),
    capability("markRead", "标为已读", "标记为已读"),
    capability("markUnread", "标为未读", "标记为未读"),
    capability("suppressTodoCreation", "不创建待办", "阻止自动生成待办"),
    capability("publishApplicationMessage", "发布应用消息", "将处理结果保存到消息中心并可选桌面提醒"),
    capability("publishBotMessage", "发送 Bot 消息", "通过已验证的飞书或企业微信机器人通知主人", "medium"),
    capability("external", "后台任务", "执行经审计的 wecli 后台任务", "high"),
  ],
});

export function automationCapabilityFingerprint(): string {
  return createHash("sha256")
    .update(JSON.stringify(AUTOMATION_CAPABILITIES))
    .digest("hex");
}

export function automationCapabilityDiscovery() {
  return {
    ...AUTOMATION_CAPABILITIES,
    fingerprint: automationCapabilityFingerprint(),
  };
}
