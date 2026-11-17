// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Action Center — Open todos section (Route C / WP 3H).
 *
 * v1 surfaces title, due-date and Task Agent status badge. Each row
 * has a "complete" button that calls the existing
 * account-scoped todo command via `api.completeTodo`
 * and then invalidates the action-center query so the row disappears.
 *
 * Out of scope here: editing, snoozing, reordering, status overrides.
 * The dedicated /todos route already covers those affordances.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { accountTodoKeys } from "~/queries/todos";
import api from "~/services/api";
import type { TodoItem } from "../../../shared/wemail/intelligence";

const AGENT_STATUS_LABEL: Record<string, string> = {
	"to-respond": "待回复",
	"awaiting-reply": "等待回复",
	"review-needed": "待审阅",
	"approval-needed": "待审批",
	"meeting-update": "会议有更新",
	"suggested-done": "建议完成",
};

function formatDueDate(due: string | undefined): string | null {
	if (!due) return null;
	const d = new Date(due);
	if (Number.isNaN(d.getTime())) return null;
	// Show date only — the Action Center is a triage view, exact times
	// belong on the dedicated todo detail.
	return d.toISOString().slice(0, 10);
}

export function TodosSection({ todos }: { todos: TodoItem[] }) {
	const qc = useQueryClient();
	const complete = useMutation({
		mutationFn: (id: string) => api.completeTodo(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["action-center"] });
			// The /todos route reads through `listAccountTodos`; keep that
			// surface in sync too. `accountTodoKeys.all = ["todos", "account"]`
			// is the prefix shared by every per-account list query, so
			// invalidating it clears the right caches without reaching into
			// other top-level "todos"-prefixed keys.
			qc.invalidateQueries({ queryKey: accountTodoKeys.all });
		},
	});

	if (todos.length === 0) {
		return (
			<section
				data-testid="action-center-todos"
				className="rounded-lg border border-edge-3 bg-paper-2 p-4 text-sm text-ink-3"
			>
				<h2 className="text-sm font-semibold text-ink mb-1">
					待办
				</h2>
				<p data-testid="action-center-todos-empty">
					当前没有待办。WeMail 从邮件中识别出新的待办后，会显示在这里。
				</p>
			</section>
		);
	}

	return (
		<section
			data-testid="action-center-todos"
			aria-labelledby="action-center-todos-heading"
			className="space-y-2"
		>
			<h2
				id="action-center-todos-heading"
				className="text-sm font-semibold text-ink"
			>
				待办
				<span className="ml-2 text-xs font-normal text-ink-3">
					({todos.length})
				</span>
			</h2>
			<ul className="space-y-1.5">
				{todos.map((todo) => {
					const due = formatDueDate(todo.dueDate);
					const status = todo.agentStatus
						? (AGENT_STATUS_LABEL[todo.agentStatus] ?? todo.agentStatus)
						: null;
					return (
						<li
							key={todo.id}
							data-testid="action-center-todo-row"
							data-todo-id={todo.id}
							className="flex items-center gap-3 rounded-lg border border-edge-3 bg-paper-2 px-3 py-2 text-sm"
						>
							<div className="flex-1 min-w-0">
								<div
									className="font-medium text-ink truncate"
									data-testid="action-center-todo-title"
								>
									{todo.title}
								</div>
								<div className="flex flex-wrap items-center gap-2 text-xs text-ink-3 mt-0.5">
									{due ? (
										<span data-testid="action-center-todo-due">
											截止 {due}
										</span>
									) : null}
									{status ? (
										<span
											data-testid="action-center-todo-status"
											className="inline-flex items-center rounded-full bg-paper-3 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-ink-2"
										>
											{status}
										</span>
									) : null}
								</div>
							</div>
							<button
								type="button"
								disabled={complete.isPending}
								onClick={() => complete.mutate(todo.id)}
								data-testid="action-center-todo-complete"
								className="rounded border border-edge px-3 py-1 text-xs hover:bg-paper-3 disabled:opacity-50"
							>
								完成
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

export default TodosSection;
