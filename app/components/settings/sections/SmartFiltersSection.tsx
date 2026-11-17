// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → 自动化规则.
 *
 * Lists existing automation rules with toggle / dry-run / run / edit /
 * delete affordances and a "+ 添加规则" CTA that opens
 * `AutomationRuleForm`. The form handles create / update via React Query
 * and toasts on success — this section just orchestrates the list.
 */

import { useMemo, useState } from "react";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlayIcon } from "@phosphor-icons/react/Play";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TestTubeIcon } from "@phosphor-icons/react/TestTube";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { Button } from "~/components/ui/button";
import { ConfirmActionDialog } from "~/components/ui/confirm-action-dialog";
import { getUserFacingError } from "~/lib/user-facing-error";
import { Switch } from "~/components/ui/switch";
import { toast } from "sonner";
import { AutomationRuleForm } from "~/components/automation/AutomationRuleForm";
import { useCurrentAccount } from "~/queries/currentAccount";
import {
	useAutomationRules,
	useDeleteAutomationRule,
	useDryRunAutomationRule,
	useRunAutomationRule,
	useUpdateAutomationRule,
} from "~/queries/automationRules";
import type { AutomationRule } from "../../../../shared/wemail/automation";

function summarizeConditions(rule: AutomationRule): string {
	const parts: string[] = [];
	const c = rule.conditions;
	if (c.sender) parts.push(`发件人: ${c.sender}`);
	if (c.recipient) parts.push(`收件人: ${c.recipient}`);
	if (c.cc) parts.push(`抄送: ${c.cc}`);
	if (c.subjectKeyword) parts.push(`主题: ${c.subjectKeyword}`);
	if (c.bodyKeyword) parts.push(`正文: ${c.bodyKeyword}`);
	if (c.aiTag) parts.push(`标签: ${c.aiTag}`);
	if (c.hasAttachment) parts.push("带附件");
	return parts.length ? parts.join(" · ") : "无条件 (匹配全部)";
}

function summarizeActions(rule: AutomationRule): string {
	if (rule.actions.length === 0) return "无动作";
	return rule.actions
		.map((a) =>
			a.type === "applyLabel" ? `添加标签 "${a.label}"` : actionLabel(a.type),
		)
		.join(" · ");
}

function actionLabel(type: string): string {
	switch (type) {
		case "star":
			return "加星";
		case "markImportant":
			return "标记重要";
		case "markNotImportant":
			return "取消重要";
		case "markRead":
			return "标记已读";
		case "markUnread":
			return "标记未读";
		case "archive":
			return "归档";
		case "trash":
			return "回收站";
		case "spam":
			return "垃圾邮件";
		case "notSpam":
			return "取消垃圾";
		case "suppressTodoCreation":
			return "不生成待办";
		default:
			return type;
	}
}

function hasDangerousAction(rule: AutomationRule): boolean {
	return rule.actions.some((action) =>
		["archive", "trash", "spam"].includes(action.type),
	);
}

export function SmartFiltersSection() {
	const { data: currentAccount } = useCurrentAccount();
	const accountId = currentAccount?.account?.id;
	const { data: rules = [], isLoading } = useAutomationRules(accountId);
	const updateMut = useUpdateAutomationRule(accountId);
	const deleteMut = useDeleteAutomationRule(accountId);
	const dryRunMut = useDryRunAutomationRule();
	const runMut = useRunAutomationRule(accountId);

	const [formOpen, setFormOpen] = useState(false);
	const [editing, setEditing] = useState<AutomationRule | null>(null);
	const [confirmCandidate, setConfirmCandidate] = useState<{ kind: "run" | "delete"; rule: AutomationRule } | null>(null);
	const [dryRunResult, setDryRunResult] = useState<
		{ ruleName: string; matched: { id: string; subject: string }[] } | null
	>(null);

	const sortedRules = useMemo(
		() =>
			[...rules].sort(
				(a, b) =>
					new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
			),
		[rules],
	);

	const handleToggleEnabled = (rule: AutomationRule, enabled: boolean) => {
		updateMut.mutate(
			{ id: rule.id, update: { enabled } },
			{
				onError: (err) =>
					toast.error(getUserFacingError(err, "规则保存失败，请稍后重试。")),
			},
		);
	};

	const handleDryRun = async (rule: AutomationRule) => {
		try {
			const res = await dryRunMut.mutateAsync(rule.id);
			setDryRunResult({ ruleName: rule.name, matched: res.matched });
		} catch (err) {
			toast.error(getUserFacingError(err, "试运行失败，请稍后重试。"));
		}
	};

	const handleRun = async (rule: AutomationRule) => {
		if (!rule.enabled) {
			toast.error("规则未启用，启用后再运行");
			return;
		}
		try {
			const res = await runMut.mutateAsync({
				id: rule.id,
				confirmDangerous: hasDangerousAction(rule),
			});
			toast.success(`匹配 ${res.matchedCount}，应用 ${res.appliedCount}`);
			setConfirmCandidate(null);
		} catch (err) {
			toast.error(getUserFacingError(err, "规则运行失败，请稍后重试。"));
		}
	};

	const handleDelete = (rule: AutomationRule) => {
		deleteMut.mutate(rule.id, {
			onSuccess: () => {
				setConfirmCandidate(null);
				toast.success("已删除");
			},
			onError: (err) =>
				toast.error(getUserFacingError(err, "规则删除失败，请稍后重试。")),
		});
	};

	return (
		<div className="space-y-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="text-base font-semibold text-ink mb-1">自动化规则</h2>
					<p className="text-xs text-ink-3">
						规则会按条件匹配邮件并执行动作。试运行只统计命中条数，不会修改任何邮件。
					</p>
				</div>
				<Button
					size="sm"
					onClick={() => {
						setEditing(null);
						setFormOpen(true);
					}}
				>
					<PlusIcon size={14} weight="bold" />
					添加规则
				</Button>
			</div>

			{isLoading ? (
				<div className="rounded-md border border-edge bg-paper-2 px-4 py-8 text-center text-xs text-ink-3">
					加载中…
				</div>
			) : sortedRules.length === 0 ? (
				<div className="rounded-md border border-dashed border-edge bg-paper-2 px-4 py-8 text-center text-xs text-ink-3">
					还没有规则。点击右上角"添加规则"创建第一条。
				</div>
			) : (
				<div className="rounded-md border border-edge bg-paper-2 overflow-hidden divide-y divide-edge-3">
					{sortedRules.map((rule) => (
						<div key={rule.id} className="px-4 py-3 flex items-start gap-3">
							<Switch
								checked={rule.enabled}
								onCheckedChange={(checked) =>
									handleToggleEnabled(rule, checked)
								}
								className="mt-1"
							/>
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2">
									<span className="text-sm font-semibold text-ink truncate">
										{rule.name}
									</span>
									{!rule.enabled ? (
										<span className="text-xs uppercase tracking-wider text-ink-3 px-1.5 py-0.5 rounded border border-edge">
											已停用
										</span>
									) : null}
								</div>
								<p className="text-xs text-ink-3 mt-0.5 truncate">
									{summarizeConditions(rule)}
								</p>
								<p className="text-xs text-ink-2 mt-0.5 truncate">
									→ {summarizeActions(rule)}
								</p>
							</div>
							<div className="flex items-center gap-1 shrink-0">
								<IconBtn
									title="试运行"
									onClick={() => handleDryRun(rule)}
									disabled={dryRunMut.isPending}
								>
									<TestTubeIcon size={14} weight="regular" />
								</IconBtn>
								<IconBtn
									title="立即运行"
									onClick={() => setConfirmCandidate({ kind: "run", rule })}
									disabled={runMut.isPending}
								>
									<PlayIcon size={14} weight="regular" />
								</IconBtn>
								<IconBtn
									title="编辑"
									onClick={() => {
										setEditing(rule);
										setFormOpen(true);
									}}
								>
									<PencilSimpleIcon size={14} weight="regular" />
								</IconBtn>
								<IconBtn
									title="删除"
									onClick={() => setConfirmCandidate({ kind: "delete", rule })}
									destructive
								>
									<TrashIcon size={14} weight="regular" />
								</IconBtn>
							</div>
						</div>
					))}
				</div>
			)}

			<AutomationRuleForm
				open={formOpen}
				onOpenChange={(open) => {
					setFormOpen(open);
					if (!open) setEditing(null);
				}}
				accountId={accountId}
				editing={editing}
			/>

			<DryRunResultPanel
				result={dryRunResult}
				onClose={() => setDryRunResult(null)}
			/>
			<ConfirmActionDialog
				open={confirmCandidate !== null}
				onOpenChange={(nextOpen) => { if (!nextOpen) setConfirmCandidate(null); }}
				title={confirmCandidate?.kind === "delete" ? "删除自动化规则？" : "立即运行自动化规则？"}
				description={confirmCandidate?.kind === "delete"
					? `将永久删除「${confirmCandidate.rule.name}」。`
					: `将对所有匹配「${confirmCandidate?.rule.name ?? "该规则"}」的邮件执行动作。`}
				confirmLabel={confirmCandidate?.kind === "delete" ? "删除规则" : "确认运行"}
				destructive={confirmCandidate?.kind === "delete" || (confirmCandidate ? hasDangerousAction(confirmCandidate.rule) : false)}
				pending={runMut.isPending || deleteMut.isPending}
				onConfirm={() => {
					if (!confirmCandidate) return;
					if (confirmCandidate.kind === "delete") handleDelete(confirmCandidate.rule);
					else void handleRun(confirmCandidate.rule);
				}}
			/>
		</div>
	);
}

function IconBtn({
	children,
	title,
	onClick,
	disabled,
	destructive,
}: {
	children: React.ReactNode;
	title: string;
	onClick: () => void;
	disabled?: boolean;
	destructive?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			aria-label={title}
			className={`inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
				destructive
					? "text-ink-3 hover:bg-red/10 hover:text-red"
					: "text-ink-3 hover:bg-paper-3 hover:text-ink"
			}`}
		>
			{children}
		</button>
	);
}

function DryRunResultPanel({
	result,
	onClose,
}: {
	result: { ruleName: string; matched: { id: string; subject: string }[] } | null;
	onClose: () => void;
}) {
	if (!result) return null;
	return (
		<div className="rounded-md border border-edge bg-paper-3 px-4 py-3">
			<div className="flex items-center justify-between mb-2">
				<span className="text-xs font-semibold text-ink">
					试运行结果 · {result.ruleName} · 命中 {result.matched.length}
				</span>
				<button
					type="button"
					onClick={onClose}
					className="text-xs text-ink-3 hover:text-ink"
				>
					关闭
				</button>
			</div>
			{result.matched.length === 0 ? (
				<p className="text-xs text-ink-3">没有匹配的邮件。</p>
			) : (
				<ul className="space-y-1 max-h-40 overflow-y-auto">
					{result.matched.slice(0, 50).map((m) => (
						<li key={m.id} className="text-xs text-ink-2 truncate">
							· {m.subject || "(无主题)"}
						</li>
					))}
					{result.matched.length > 50 ? (
						<li className="text-xs text-ink-3">
							… 以及 {result.matched.length - 50} 条
						</li>
					) : null}
				</ul>
			)}
		</div>
	);
}
