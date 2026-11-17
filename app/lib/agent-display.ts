import type { AgentActionExecutionResult } from "~/services/api";
import { sanitizeAgentDisplayText } from "../../shared/wemail/agentPresentation";
import { projectAgentToolPresentation } from "../../shared/wemail/agentPresentation";

export { sanitizeAgentDisplayText };

const TOOL_LABELS: Record<string, string> = {
	list_emails: "正在查找邮件",
	get_email: "正在读取邮件",
	get_thread: "正在加载邮件会话",
	search_emails: "正在搜索邮件",
	summarize_mail: "整理邮件",
	draft_email: "正在起草邮件",
	get_reply_draft: "正在起草回复",
	find_invoice_attachments: "正在查找发票附件",
	propose_allowance_invoice_upload: "正在准备确认操作",
	propose_allowance_invoice_delete: "正在准备删除关联",
	discard_draft: "正在放弃草稿",
	mark_email_read: "正在更新邮件状态",
	move_email: "正在移动邮件",
};

export function friendlyToolLabel(toolName: string): { label: string } {
	return {
		label: TOOL_LABELS[toolName] ?? projectAgentToolPresentation({
			toolName,
			state: "running",
		}).label,
	};
}

export function formatAgentExecutionMessage(
	execution: AgentActionExecutionResult,
): string {
	const items = execution.items ?? [];
	const completed = items.filter((item) => item.ok).length;
	const failed = items.length - completed;
	if (execution.ok && items.length === 0) return "操作已完成";
	if (execution.ok) return `操作已完成，共处理 ${completed} 项。`;
	return failed > 0
		? `操作未能全部完成，${failed} 项需要重试。`
		: "操作未能完成，请稍后重试。";
}
