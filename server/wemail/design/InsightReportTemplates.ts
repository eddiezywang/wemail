import type { DesignTemplateId } from "../../../shared/wemail/designArtifacts.js";

export interface InsightReportTemplate {
  id: DesignTemplateId;
  name: string;
  description: string;
  bestFor: string;
}

export const INSIGHT_REPORT_TEMPLATES: readonly InsightReportTemplate[] = [
  {
    id: "executive-insight",
    name: "综合洞察",
    description: "结论先行，组合关键指标、核心发现与完整明细。",
    bestFor: "通用数据分析与管理层阅读",
  },
  {
    id: "trend-analysis",
    name: "趋势分析",
    description: "突出时间变化、峰值、低谷与首尾变化。",
    bestFor: "包含日期和连续数值的数据",
  },
  {
    id: "comparison-breakdown",
    name: "对比拆解",
    description: "比较类别贡献与排序，快速识别头部和长尾。",
    bestFor: "类别、渠道、团队或产品对比",
  },
  {
    id: "operational-health",
    name: "运营健康",
    description: "突出成功、失败、告警、风险与建议动作。",
    bestFor: "调用量、失败率、告警和服务质量",
  },
] as const;

export const VISUALIZATION_TEMPLATES: readonly InsightReportTemplate[] = [
  {
    id: "email-visual-summary",
    name: "邮件数据卡",
    description: "把单封邮件中的关键数值和清单忠实转换为可读图表。",
    bestFor: "单封邮件、一行多指标或简短结构化清单",
  },
  {
    id: "quick-chart",
    name: "快速图表",
    description: "直接展示趋势或类别对比，同时保留精确明细。",
    bestFor: "用户只要求将已有数据画成图",
  },
  {
    id: "timeline-view",
    name: "时间线",
    description: "按时间顺序整理事件、里程碑、排期与状态变化。",
    bestFor: "邮件中的计划、进度、会议和节点信息",
  },
] as const;

export const DESIGN_ARTIFACT_TEMPLATES: readonly InsightReportTemplate[] = [
  ...VISUALIZATION_TEMPLATES,
  ...INSIGHT_REPORT_TEMPLATES,
];

export function templateName(id: DesignTemplateId): string {
  return DESIGN_ARTIFACT_TEMPLATES.find((template) => template.id === id)?.name ?? "综合洞察";
}
