// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Inline confirmation card for an `AgentPendingAction` (Route C / WP 3I).
 *
 * Rendered above the agent chat when one or more high-risk actions are
 * waiting for the user's decision. NOT a modal — `AgentActionConfirmDialog`
 * is the modal surface for ad-hoc / WeCLI confirmation. Cards stack
 * inline so the user can see context (what the agent has just said)
 * alongside the action.
 *
 * Color coding is driven by `action.riskLevel` (already populated by
 * the API; legacy rows fall back to a derivation from `actionType`).
 */

import { useEffect, useState } from "react";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import type {
	AgentActionRiskLevel,
	AgentPendingAction,
} from "~/services/api";
import type { ActionExecutionSnapshot } from "../../../shared/wemail/actionExecution";
import { useEditionFeatures } from "~/hooks/useEditionFeatures";

const PARAMETER_LABELS: Record<string, string> = {
	command: "命令",
	args: "参数",
	emailId: "邮件",
	emailIds: "邮件",
	attachmentId: "附件",
	attachmentIds: "附件",
	recipients: "收件人",
	to: "收件人",
	cc: "抄送",
	bcc: "密送",
	subject: "主题",
	folder: "目标文件夹",
	targetFolder: "目标文件夹",
	scheduledAt: "执行时间",
};

function parameterValue(key: string, value: unknown): string {
	if (/password|secret|token|api.?key|authorization|cookie/i.test(key)) {
		return "已保护，不在界面中显示";
	}
	if (value === null || value === undefined || value === "") return "未设置";
	if (typeof value === "boolean") return value ? "是" : "否";
	if (typeof value === "string" || typeof value === "number") return String(value);
	try {
		const serialized = JSON.stringify(value);
		return serialized.length > 180 ? `${serialized.slice(0, 177)}...` : serialized;
	} catch {
		return "复杂参数";
	}
}

const RISK_STYLES: Record<
	AgentActionRiskLevel,
	{ border: string; badge: string; label: string }
> = {
	low: {
		border: "border-edge",
		badge: "bg-paper-3 text-ink-2",
		label: "低风险",
	},
	medium: {
		border: "border-amber",
		badge: "bg-amber/20 text-amber",
		label: "需要确认",
	},
	high: {
		border: "border-red",
		badge: "bg-red/20 text-red",
		label: "高风险",
	},
};

const ACTION_HINTS: Partial<Record<AgentPendingAction["actionType"], string>> = {
	run_wecli_command:
		"确认后只会执行本卡片列出的企业命令与参数。",
	install_wecli:
		"确认后会通过企业内网 npm 源全局安装 WeCLI；取消不影响 WeMail 其他功能。",
	send: "确认后会发送邮件。",
	delete: "确认后会删除邮件。",
	move: "确认后会移动邮件。",
	archive: "确认后会归档邮件。",
	mark_spam: "确认后会标记为垃圾邮件。",
	unsubscribe: "确认后会执行退订操作。",
	run_automation: "确认后会运行自动化操作。",
	configure_smart_tag: "确认后会修改智能标签配置。",
	configure_automation_rule:
		"确认后会保存自动化规则；后续匹配邮件将由规则引擎自动执行，不再逐次确认。",
	configure_writing_style: "确认后会修改写作风格配置。",
	schedule_send: "确认后会创建定时发送任务。",
	cancel_scheduled_send: "确认后会取消该定时发送任务。",
	permanent_delete: "确认后会永久删除邮件，且无法恢复。",
	delete_draft: "确认后会永久删除草稿，且无法恢复。",
	bulk_mail_operation: "确认后会批量修改邮件状态；永久删除的邮件无法恢复。",
	configure_business_preferences: "确认后会修改 WeMail 的非敏感业务偏好。",
};

/**
 * Allowance upload-flow hints (P2.6 round 8: the upload process display is
 * edition semantics). Only applied behind the `allowanceInvoice` feature —
 * the open edition renders the generic hint for legacy rows.
 */
const ALLOWANCE_ACTION_HINTS: Partial<Record<AgentPendingAction["actionType"], string>> = {
	upload_allowance_invoices:
		"确认后 WeMail 会先将本卡片列出的 PDF 下载到内部临时目录，再用本地临时路径上传；下载不需要单独权限，后续上传需重新确认。",
	delete_allowance_invoices:
		"确认后会从月度发票平台删除选中的发票关联。",
};

function executingText(action: AgentPendingAction, allowanceInvoice: boolean): string {
	if (allowanceInvoice && action.actionType === "upload_allowance_invoices") {
		return action.description.startsWith("上传")
			? `正在${action.description}`
			: `正在执行：${action.description}`;
	}
	if (action.actionType === "install_wecli") {
		return "正在安装 WeCLI";
	}
	return `正在执行：${action.description}`;
}

function executionFailureText(action: AgentPendingAction, allowanceInvoice: boolean): string {
	const execution = action.executionResult;
	const summary = typeof execution?.summary === "string"
		? execution.summary
		: "已确认，但执行失败。";
	const failedItem = Array.isArray(execution?.items)
		? execution.items.find((item) => item && typeof item === "object" && item.ok === false)
		: undefined;
	const detail = failedItem && typeof failedItem === "object"
		? [failedItem.error, failedItem.stderr]
				.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
				.join(" ")
				.replace(/\s+/g, " ")
				.trim()
		: "";
	// The platform login-recovery hint is allowance display semantics
	// (P2.6 round 8); the open edition keeps the generic failure text.
	if (allowanceInvoice && /AUTH_REQUIRED|not logged in|login|登录|认证/i.test(detail)) {
		return `${summary} 请先登录发票平台，再重新发起失败项。`;
	}
	return detail
		? `${summary} 失败原因：${detail.slice(0, 220)}`
		: `${summary} 请修正问题后重新发起失败项。`;
}

export interface PendingActionCardProps {
	action: AgentPendingAction;
	onConfirm: (id: string) => void;
	onReject: (id: string) => void;
	isResolving?: boolean;
	error?: string;
	onRefresh?: () => void;
}

export function PendingActionCard({
	action,
	onConfirm,
	onReject,
	isResolving,
	error,
	onRefresh,
}: PendingActionCardProps) {
	// P2.6 round 8: the execution snapshot (progress phases, per-item upload
	// results, the platform login/expense hints) is produced by the allowance
	// upload pipeline, so the whole card branch is edition semantics. The
	// open edition never produces these actions; without the feature a
	// legacy row renders as a generic card and the snapshot is not
	// interpreted at all.
	const { allowanceInvoice } = useEditionFeatures();
	const task = allowanceInvoice
		? (action.executionResult?.task as ActionExecutionSnapshot | undefined)
		: undefined;
	const needsLogin = task?.items.some((item) => item.phase === "failed" && /发票平台未登录/.test(item.error ?? ""));
	const unknown = action.executionState === "outcome_unknown";
	const style = RISK_STYLES[action.riskLevel];
	const failed = action.executionState === "failed";
	const executing = action.executionState === "executing";
	const busy = !!isResolving || executing || task?.state === "queued" || task?.state === "running";
	const [clock, setClock] = useState(() => ({ started: Date.now(), now: Date.now() }));
	useEffect(() => {
		setClock({ started: Date.now(), now: Date.now() });
		if (!busy) return;
		const timer = window.setInterval(() => setClock((value) => ({ ...value, now: Date.now() })), 1000);
		return () => window.clearInterval(timer);
	}, [action.id, busy]);
	const elapsedSeconds = Math.max(0, Math.floor(((task?.completedAt ?? clock.now) - (task?.acceptedAt ?? clock.started)) / 1000));
	const elapsedText = elapsedSeconds >= 60 ? `${Math.floor(elapsedSeconds / 60)} 分 ${elapsedSeconds % 60} 秒` : `${elapsedSeconds} 秒`;
	const currentItem = task?.items.find((item) => ["preparing", "submitting", "verifying"].includes(item.phase));
	const expired = !failed && (action.status === "expired" ||
		(action.status === "pending" && !!action.expiresAt && Date.parse(action.expiresAt) <= Date.now()));
	const resolved = action.status !== undefined && action.status !== "pending";
	const hint = action.origin === "mcp"
		? "确认只会授权这组精确参数，不会立即执行；外部客户端仍需使用幂等键提交。"
		: allowanceInvoice && action.actionType === "upload_allowance_invoices" && action.parameters?.retryUnverified === true
			? "历史上传没有明确回执，尚不能确认是否入库。确认将再次提交，存在重复风险；已成功或正在处理的附件不会重传。"
		: (allowanceInvoice ? ALLOWANCE_ACTION_HINTS[action.actionType] : undefined)
			?? ACTION_HINTS[action.actionType] ?? "确认后会执行该操作。";
	const resolvedText = unknown ? "上次提交结果待核实，请先核对平台中的实际结果，避免重复上传。" : expired
		? "该确认已过期，参数不再可执行。请在对话中重新提出操作以生成新的确认。"
		: action.status === "rejected"
			? "已拒绝，未执行任何操作。"
			: failed
				? executionFailureText(action, allowanceInvoice)
				: action.status === "confirmed"
					? "已确认并处理。此记录保留用于回溯。"
					: hint;
	const taskLabels: Record<ActionExecutionSnapshot["state"], string> = {
		queued: "已确认，等待执行", running: "正在处理", succeeded: "已处理完成",
		partially_succeeded: "部分成功", failed: needsLogin ? "需要登录发票平台" : "执行失败", outcome_unknown: "结果待核实",
	};
	const phaseLabels = { queued: "等待执行", preparing: "下载并准备附件", submitting: "提交平台并等待核验", verifying: "核对平台入库回执",
		succeeded: "已上传并通过核验", failed: "未完成", outcome_unknown: "结果待核实，未自动重传" };
	const statusText = task ? (task.state === "outcome_unknown" ? "请先核对平台中的实际结果，避免重复上传。" : taskLabels[task.state])
		: isResolving ? "正在提交确认，请稍候。" : executing ? executingText(action, allowanceInvoice) : resolvedText;
	const badgeText = task ? taskLabels[task.state] : unknown ? "结果待核实" : isResolving ? "提交确认中" : executing
		? "正在执行"
		: expired
			? "已过期"
			: failed
				? "执行失败"
			: action.status === "rejected"
				? "已拒绝"
				: action.status === "confirmed"
					? (action.executionState === "failed" ? "执行失败" : "已处理")
					: style.label;
	const parameters = Object.entries(action.parameters ?? {});
	return (
		<div
			className={`rounded-lg border ${style.border} bg-paper-2 p-3 text-sm flex flex-col gap-2`}
			role="group"
			aria-label={`待确认操作：${action.description}`}
			data-testid="pending-action-card"
			data-risk-level={action.riskLevel}
			data-action-type={action.actionType}
			data-action-id={action.id}
			aria-busy={busy}
		>
			<div className="flex items-center gap-2">
				{action.origin === "mcp" ? <span className="inline-flex items-center rounded-full bg-coral/10 px-2 py-0.5 text-xs font-semibold text-coral" data-testid="pending-action-mcp-badge">MCP 请求</span> : null}
				<span
					className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${style.badge}`}
					data-testid="pending-action-risk-badge"
				>
					{badgeText}
				</span>
			</div>
			<div className="text-ink" data-testid="pending-action-description">
				{action.description}
			</div>
			{busy ? <div role="status" data-testid="pending-action-risk-reason" className="flex items-center gap-3 rounded-lg border border-edge bg-paper px-3 py-3">
				<CircleNotchIcon size={22} className="shrink-0 animate-spin text-coral motion-reduce:animate-none" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<div className="text-sm font-medium text-ink">{currentItem ? phaseLabels[currentItem.phase] : statusText}</div>
					{currentItem?.filename ? <div className="truncate text-xs text-ink-3">{currentItem.filename}</div> : null}
					{task ? <div className="text-xs text-ink-3">已处理 {task.items.filter((item) => ["succeeded", "failed", "outcome_unknown"].includes(item.phase)).length} / {task.items.length} 个附件</div> : null}
				</div>
				<span className="shrink-0 text-xs tabular-nums text-ink-3" aria-live="off">已用时 {elapsedText}</span>
			</div> : <div
				className="text-xs text-ink-2"
				data-testid="pending-action-risk-reason"
			>
				{statusText}
				{task?.acceptedAt && task.completedAt ? <span className="ml-2 text-ink-3">耗时 {elapsedText}</span> : null}
			</div>}
			{error ? <div role="alert" className="text-xs text-red">{error}</div> : null}
			{needsLogin ? <div className="text-xs text-coral">请先在浏览器登录补贴平台，再重试失败项。</div> : null}
			{error && onRefresh ? <button type="button" onClick={onRefresh} className="min-h-10 rounded-md border border-edge px-3 text-meta">刷新任务状态</button> : null}
			{task ? <ul className="flex flex-col gap-2 text-xs" aria-live="polite">
				{task.items.map((item) => <li key={item.index} className="rounded-md bg-paper-3 px-3 py-2">
					<div className="break-words text-ink">{item.filename || `附件 ${item.index + 1}`}</div>
					<div className="text-ink-2">{item.alreadyProcessed === "associated" ? "已关联账单，本次无需上传"
						: item.alreadyProcessed === "uploaded" ? "此前已上传，本次无需上传" : phaseLabels[item.phase]}</div>
					{item.error ? <div className="text-ink-2">{item.error}</div> : null}
				</li>)}
			</ul> : null}
			{parameters.length > 0 ? (
				<details className="rounded-md bg-paper-3 text-meta" data-testid="pending-action-parameters">
					<summary className="cursor-pointer px-3 py-2 text-ink-3">查看执行参数（{parameters.length}）</summary>
					<dl className="grid gap-1.5 px-3 pb-2">
						{parameters.map(([key, value]) => (
							<div key={key} className="grid grid-cols-[minmax(72px,0.35fr)_minmax(0,1fr)] gap-3">
								<dt className="text-ink-3">{PARAMETER_LABELS[key] ?? key}</dt>
								<dd className="min-w-0 break-words text-ink-2">{parameterValue(key, value)}</dd>
							</div>
						))}
					</dl>
				</details>
			) : null}
			{!task && !resolved && !expired && !failed && action.executionState !== "executing" ? <div className="flex justify-end gap-2 pt-1">
				<button
					type="button"
					disabled={isResolving}
					onClick={() => onReject(action.id)}
					data-testid="pending-action-reject"
					className="min-h-10 rounded-md border border-edge px-3 text-meta hover:bg-paper-3 disabled:opacity-50"
				>
					拒绝
				</button>
				<button
					type="button"
					disabled={isResolving}
					onClick={() => onConfirm(action.id)}
					data-testid="pending-action-confirm"
					className="min-h-10 rounded-md bg-coral-2 px-3 text-meta font-medium text-paper-2 hover:bg-coral-strong disabled:opacity-50"
				>
						{isResolving ? "提交确认中" : (action.origin === "mcp" ? "授权" : "确认")}
				</button>
			</div> : null}
		</div>
	);
}

export default PendingActionCard;
