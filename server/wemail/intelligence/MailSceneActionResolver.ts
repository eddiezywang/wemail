import type {
  MailSceneAction,
  SummaryResult,
} from "../../../shared/wemail/intelligence.js";
import type { InvoiceMailStatusSummary } from "../../../shared/wemail/invoice.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import {
  resolveIsInvoiceAttachmentCandidate,
  type IsInvoiceAttachmentCandidate,
} from "../agent/allowancePort.js";
import { EDITION_MODULES } from "../bootstrap/editionModules.js";

export interface MailSceneActionInput {
  message?: MailMessage | null;
  summary?: SummaryResult;
  invoiceIntent: boolean;
  invoiceStatus?: InvoiceMailStatusSummary | null;
  /**
   * P2.6 test/edition override for the invoice-attachment heuristic.
   * Omitting it resolves the build-time registration (open default: no
   * candidates). The edition overlay's own suites pass the real check
   * because their process cannot resolve `#edition-modules` bindings.
   */
  invoiceCandidateCheck?: IsInvoiceAttachmentCandidate;
  /**
   * Contributors bound to this resolution. Service instances pass their own
   * captured set; an explicit empty array means "off" and never falls back to
   * the build registration. Omitting it uses the build-time registration
   * (used by processes with no per-call override, e.g. the DB reader lane).
   */
  contributors?: readonly SceneActionContributor[];
}

/**
 * Edition-contributed scene actions. Receives the same input as
 * {@link resolveMailSceneActions} and returns extra actions appended after
 * the built-in summary/report/invoice actions. Contributors never replace
 * built-ins; returning an empty array is the expected no-op.
 */
export interface SceneActionContributor {
  (input: MailSceneActionInput): MailSceneAction[];
}

/**
 * Build-time edition registration. Stateless and per-call: the independent DB
 * reader lane (which never runs `composeApp`) captures this once when it
 * constructs its query repository. It intentionally has no mutable global
 * setter — two compositions in one process can no longer change each other's
 * contributor set, and an explicit empty array means "off" rather than
 * silently restoring the internal default.
 */
export function defaultSceneActionContributors(): readonly SceneActionContributor[] {
  return EDITION_MODULES.sceneActionContributors ?? [];
}

function summaryActionCandidates(summary?: SummaryResult): MailSceneAction[] {
  if (!summary) return [];
  const obligation = summary.actionObligation ??
    (summary.displayMode === "actionable" ? "required" : "none");
  if (obligation !== "required") return [];
  const values = [...(summary.actions ?? []), ...summary.actionItems];
  return [...new Set(values)]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0)
    .slice(0, 3)
    .map((value, index) => ({
      id: `summary.action.${index + 1}` as const,
      scene: "summary_action" as const,
      label: value.slice(0, 42),
      icon: "action" as const,
      status: "available" as const,
      composerText: `【处理邮件行动】${value}`,
      agentPrompt:
        `基于当前邮件帮助我完成"${value}"。` +
        "先说明依据；" +
        "涉及发送、提交、审批或其他外部变更时，等待我确认后再执行。",
      risk: "none" as const,
    }));
}

const GENERATE_CHART_ACTION: MailSceneAction = {
  id: "monitoring.generate_chart",
  scene: "monitoring_report",
  label: "生成数据洞察报告",
  icon: "chart",
  status: "available",
  agentPrompt:
    "任务类型：ship（生成图表）。这是从邮件摘要中的可执行按钮发起的一次性最终产物任务。必须先使用 read 工具读取并严格遵循内置 Skill `wemail-data-analysis` 和 `wemail-insight-report`（使用可用技能列表中提供的实际文件路径），并按这两个 Skill 的要求处理当前邮件中的可验证数据；不要推测无证据的原因。必须调用 `extract_email_tables` 提取并规范化当前邮件表格，再调用 `publish_design_artifact` 生成最终 HTML 洞察报告。若用户明确指定分类、时间窗口、状态或必需值，必须通过 `analysisPlan` 逐项绑定并校验，禁止用 `autoPivot` 覆盖；仅在用户没有明确分组要求时使用 `autoPivot:true`，由宿主侧确定性分析器覆盖适用视角并控制 token。必须确认产物已成功投递到 WeMail 消息中心。不要输出分析过程、指标清单、异常解读、趋势正文或 HTML 源码，用户只需要最终 HTML 报告。最终回复只给出简短执行结果：成功时说明“HTML 报告已生成并投递到消息中心”；失败时只说明未完成、缺失的字段或值及可执行的下一步。在 `publish_design_artifact` 明确成功前不得声称任务完成。",
  risk: "none",
};

const UPLOAD_INVOICE_ACTION: MailSceneAction = {
  id: "invoice.upload",
  scene: "invoice",
  label: "上传至发票平台",
  icon: "upload",
  status: "available",
  agentPrompt: "上传当前邮件中符合条件的发票附件至发票平台。",
  risk: "confirmation_required",
};

const UPLOADED_INVOICE_ACTION: MailSceneAction = {
  id: "invoice.upload",
  scene: "invoice",
  label: "已上传发票平台",
  icon: "upload",
  status: "completed",
  risk: "none",
};

export function resolveMailSceneActions(
  input: MailSceneActionInput,
): MailSceneAction[] {
  const actions: MailSceneAction[] = summaryActionCandidates(input.summary);
  if (
    input.summary?.dataInsight?.kind === "monitoring_report" &&
    input.summary.dataInsight.chartRecommended
  ) {
    actions.push(GENERATE_CHART_ACTION);
  }

  const uploaded =
    input.invoiceStatus?.state === "uploaded" ||
    input.invoiceStatus?.state === "associated_self";
  // P2.6: the invoice-attachment heuristic is an edition module. The open
  // default is constant false, so the built-in invoice.upload scene action
  // never fires without it.
  const isInvoiceAttachmentCandidate =
    input.invoiceCandidateCheck ?? resolveIsInvoiceAttachmentCandidate();
  const hasCandidate = input.message?.attachments.some((attachment) =>
    isInvoiceAttachmentCandidate(attachment, input.message!),
  ) ?? false;
  if (input.invoiceIntent && hasCandidate) {
    actions.push(uploaded ? UPLOADED_INVOICE_ACTION : UPLOAD_INVOICE_ACTION);
  }
  const contributors = input.contributors ?? defaultSceneActionContributors();
  for (const contribute of contributors) {
    actions.push(...contribute(input));
  }
  return actions;
}
