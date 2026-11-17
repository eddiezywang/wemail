// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useState } from "react";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { toast } from "sonner";
import {
	TASK_AGENT_STATUSES,
	type TaskAgentStatus,
	type TodoExtractionResult,
} from "shared/wemail/intelligence";
import type { IntelligenceStatus } from "~/types/wemail";
import { useCompleteTodo } from "~/hooks/useTodos";
import api from "~/services/api";
import { getUserFacingError } from "~/lib/user-facing-error";

export interface EmailTodosCardProps {
	emailId: string;
	status: IntelligenceStatus | undefined;
	result: TodoExtractionResult | undefined;
}

/** Color tokens per status; tailwind utility classes mapped to design tokens. */
const STATUS_STYLES: Record<TaskAgentStatus, { bg: string; text: string; label: string }> = {
	"to-respond":      { bg: "bg-rose-100",    text: "text-rose-700",    label: "待回复" },
	"awaiting-reply":  { bg: "bg-sky-100",     text: "text-sky-700",     label: "等待对方" },
	"review-needed":   { bg: "bg-amber-100",   text: "text-amber-700",   label: "待审阅" },
	"approval-needed": { bg: "bg-violet-100",  text: "text-violet-700",  label: "待审批" },
	"meeting-update":  { bg: "bg-emerald-100", text: "text-emerald-700", label: "会议变更" },
	"suggested-done":  { bg: "bg-stone-200",   text: "text-stone-700",   label: "建议完成" },
};

/** Cycle order: progresses through every status, then back to none. */
function nextStatus(current: TaskAgentStatus | null | undefined): TaskAgentStatus | null {
	if (!current) return TASK_AGENT_STATUSES[0]!;
	const idx = TASK_AGENT_STATUSES.indexOf(current);
	if (idx < 0) return TASK_AGENT_STATUSES[0]!;
	const next = TASK_AGENT_STATUSES[idx + 1];
	return next ?? null;
}

/**
 * upstream-style todos card. Shows extracted action items with a complete
 * checkbox per item. Hidden when there are no todos and the extractor
 * already terminated successfully.
 */
export function EmailTodosCard({ emailId, status, result }: EmailTodosCardProps) {
	const completeTodo = useCompleteTodo(emailId);
	const todos = result?.todos ?? [];
	// Local optimistic overrides for the agent-status badge so the
	// cycle-on-click feels instantaneous; the canonical state still
	// lives on the server (next refetch will reconcile).
	const [overrides, setOverrides] = useState<
		Record<string, { status: TaskAgentStatus | null; locked: boolean }>
	>({});

	const cycleStatus = async (
		todoId: string,
		currentStatus: TaskAgentStatus | null | undefined,
	) => {
		const next = nextStatus(currentStatus);
		setOverrides((prev) => ({
			...prev,
			[todoId]: { status: next, locked: true },
		}));
		try {
			await api.setTodoAgentStatus(todoId, next, true);
		} catch (err) {
			toast.error(getUserFacingError(err, "待办状态更新失败，请稍后重试。"));
			setOverrides((prev) => {
				const { [todoId]: _ignored, ...rest } = prev;
				return rest;
			});
		}
	};

	if (status === "succeeded" && todos.length === 0) return null;
	if (!status || status === "skipped") return null;

	return (
		<section
			data-testid="email-todos-card"
			className="rounded-md border border-edge bg-paper-2 p-3 text-sm"
		>
			<header className="flex items-center gap-2 pb-2">
				<ListChecksIcon size={14} weight="bold" className="text-coral" />
				<span className="text-xs font-semibold uppercase tracking-wide text-ink-3">
					待办
				</span>
				{status === "pending" || status === "running" ? (
					<span className="text-xs text-ink-3">提取中…</span>
				) : null}
			</header>
			{status === "failed" ? (
				<p className="text-ink-2 text-xs">提取失败，请稍后重试。</p>
			) : null}
			{todos.length > 0 ? (
				<ul className="space-y-1.5 select-text">
					{todos.map((todo, idx) => {
						const id = todo.id ?? `${emailId}-todo-${idx}`;
						const done = todo.status === "confirmed";
						const override = todo.id ? overrides[todo.id] : undefined;
						const agentStatus =
							override?.status !== undefined
								? override.status
								: todo.agentStatus ?? null;
						const locked =
							override?.locked !== undefined
								? override.locked
								: todo.agentStatusLocked ?? false;
						const styles = agentStatus ? STATUS_STYLES[agentStatus] : null;
						return (
							<li key={id} className="flex items-start gap-2">
								<button
									type="button"
									onClick={() => todo.id && completeTodo.mutate(todo.id)}
									disabled={done || !todo.id || completeTodo.isPending}
									aria-label={done ? "已完成" : `完成：${todo.title}`}
									className="mt-0.5 text-ink-3 hover:text-coral disabled:cursor-default"
								>
									{done ? (
										<CheckCircleIcon
											size={16}
											weight="fill"
											className="text-coral"
										/>
									) : (
										<CircleIcon size={16} weight="regular" />
									)}
								</button>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-1.5 flex-wrap">
										<span
											className={`text-xs ${done ? "text-ink-3 line-through" : "text-ink"}`}
										>
											{todo.title}
										</span>
										{todo.id ? (
											<button
												type="button"
												onClick={() => cycleStatus(todo.id!, agentStatus)}
												className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium leading-none transition-colors ${
													styles
														? `${styles.bg} ${styles.text}`
														: "bg-paper-3 text-ink-3"
												}`}
												title={
													locked
														? "用户锁定 — 点击切换到下一个状态"
														: "Task Agent 自动状态 — 点击锁定并切换"
												}
												aria-label="切换 Task Agent 状态"
											>
												<span>{styles ? styles.label : "未分类"}</span>
												{locked ? <span aria-hidden>🔒</span> : null}
											</button>
										) : null}
									</div>
									{todo.description ? (
										<div className="text-xs text-ink-3 mt-0.5">
											{todo.description}
										</div>
									) : null}
									{todo.dueDate ? (
										<div className="text-xs text-ink-3 mt-0.5 font-mono">
											截止 {todo.dueDate}
										</div>
									) : null}
								</div>
							</li>
						);
					})}
				</ul>
			) : status === "pending" || status === "running" ? (
				<div
					aria-label="正在加载"
					className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent text-ink-3 motion-reduce:animate-none"
				/>
			) : null}
		</section>
	);
}

export default EmailTodosCard;
