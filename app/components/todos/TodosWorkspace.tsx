// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/ArrowCounterClockwise";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { ThumbsDownIcon } from "@phosphor-icons/react/ThumbsDown";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { toast } from "sonner";
import EmptyState from "~/components/wemail/EmptyState";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "~/components/ui/popover";
import {
	useAccountTodos,
	useCompleteAccountTodo,
	useDeleteAccountTodo,
	useRejectAccountTodo,
	useRestoreAccountTodo,
	useUpdateAccountTodo,
} from "~/queries/todos";
import type { TodoItem } from "../../../shared/wemail/intelligence";

type ViewMode = "active" | "done";
type TodoGroup = "overdue" | "pending" | "suggestedDone";
type TodoPatch = {
	title?: string;
	description?: string | null;
	dueDate?: string | null;
	startTime?: string | null;
	endTime?: string | null;
	timezone?: string | null;
	priority?: "high" | "medium" | "low";
};

interface TodosWorkspaceProps {
	accountId: string | undefined;
	view: ViewMode;
	onViewChange: (view: ViewMode) => void;
}

const GROUPS: Array<{ key: TodoGroup; label: string }> = [
	{ key: "overdue", label: "已逾期" },
	{ key: "pending", label: "待安排" },
	{ key: "suggestedDone", label: "建议完成" },
];

function isOverdue(todo: TodoItem, now: number): boolean {
	if (!todo.dueDate) return false;
	const due = Date.parse(todo.dueDate);
	return Number.isFinite(due) && due < now;
}

function groupTodos(todos: TodoItem[], now: number): Record<TodoGroup, TodoItem[]> {
	const grouped: Record<TodoGroup, TodoItem[]> = {
		overdue: [],
		pending: [],
		suggestedDone: [],
	};
	for (const todo of todos) {
		if (todo.agentStatus === "suggested-done") grouped.suggestedDone.push(todo);
		else if (isOverdue(todo, now)) grouped.overdue.push(todo);
		else grouped.pending.push(todo);
	}
	return grouped;
}

function formatDue(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	return new Intl.DateTimeFormat("zh-CN", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date);
}

function toLocalInput(value: string | undefined): string {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const offset = date.getTimezoneOffset() * 60_000;
	return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function toIso(value: string): string | null {
	if (!value) return null;
	const date = new Date(value.length === 10 ? `${value}T00:00` : value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isAllDay(todo: TodoItem): boolean {
	const values = [todo.startTime, todo.dueDate].filter((value): value is string => !!value);
	return values.length > 0 && values.every((value) => toLocalInput(value).endsWith("T00:00"));
}

export function TodosWorkspace({
	accountId,
	view,
	onViewChange,
}: TodosWorkspaceProps) {
	const status = view === "active" ? "open" : "completed";
	const todosQuery = useAccountTodos(accountId, status);
	const todos = todosQuery.data?.todos ?? [];
	const { isLoading } = todosQuery;
	const listRef = useRef<HTMLElement | null>(null);
	const loadMore = useCallback((event: React.UIEvent<HTMLElement>) => {
		if (!todosQuery.hasNextPage || todosQuery.isFetchingNextPage) return;
		const element = event.currentTarget;
		if (element.scrollHeight - element.scrollTop - element.clientHeight <= 240) {
			void todosQuery.fetchNextPage();
		}
	}, [todosQuery]);
	const complete = useCompleteAccountTodo();
	const restore = useRestoreAccountTodo();
	const reject = useRejectAccountTodo();
	const remove = useDeleteAccountTodo();
	const update = useUpdateAccountTodo();
	const navigate = useNavigate();
	const groups = useMemo(() => groupTodos(todos, Date.now()), [todos]);
	const openEmail = (emailId: string) => {
		const accountQuery = accountId
			? `?accountId=${encodeURIComponent(accountId)}`
			: "";
		navigate(`/message/${encodeURIComponent(emailId)}${accountQuery}`);
	};

	const deleteTodo = (todo: TodoItem) => {
		remove.mutate(todo.id, {
			onSuccess: () => toast.success("待办已删除", { duration: 1200 }),
		});
	};

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-edge bg-paper-2 shadow-[var(--shadow-2)]">
			<header className="shrink-0 border-b border-edge-3 px-6 py-4 md:px-8">
				<div className="inline-flex rounded-lg bg-paper-3 p-1 text-sm">
					<Tab active={view === "active"} onClick={() => onViewChange("active")}>进行中</Tab>
					<Tab active={view === "done"} onClick={() => onViewChange("done")}>已完成</Tab>
				</div>
			</header>

			<main ref={listRef} onScroll={loadMore} className="min-h-0 flex-1 overflow-y-auto px-6 pb-12 pt-5 md:px-8">
				{isLoading ? (
					<TodosSkeleton />
				) : todos.length === 0 ? (
					<EmptyState
						icon={view === "active" ? <ClockIcon /> : <CheckIcon />}
						title={view === "active" ? "没有进行中的待办" : "还没有已完成的待办"}
						description={view === "active" ? "AI 从邮件中识别出的行动项会出现在这里。" : "完成的待办会保留在这里。"}
					/>
				) : view === "active" ? (
					<div className="mx-auto max-w-6xl space-y-8">
						{GROUPS.map(({ key, label }) => {
							const items = groups[key];
							if (items.length === 0) return null;
							return (
								<TodoSection key={key} label={label}>
									{items.map((todo) => (
										<TodoRow
											key={todo.id}
											todo={todo}
											overdue={key === "overdue"}
											onComplete={() => complete.mutate(todo.id)}
											onOpenEmail={() => openEmail(todo.emailId)}
											onReject={() => reject.mutate(todo.id, {
												onSuccess: () => toast.success("已移除并记录反馈", { duration: 1200 }),
											})}
											onDelete={() => deleteTodo(todo)}
											onUpdate={(patch) => update.mutate({ todoId: todo.id, patch }, {
												onSuccess: () => toast.success("待办已更新", { duration: 1200 }),
											})}
										/>
									))}
								</TodoSection>
							);
						})}
					</div>
				) : (
					<div className="mx-auto max-w-6xl">
						<TodoSection label="已完成">
							{todos.map((todo) => (
								<CompletedRow
									key={todo.id}
									todo={todo}
									onRestore={() => restore.mutate(todo.id)}
									onOpenEmail={() => openEmail(todo.emailId)}
									onDelete={() => deleteTodo(todo)}
								/>
							))}
						</TodoSection>
					</div>
				)}
				{todosQuery.isFetchingNextPage ? <div className="py-4 text-center text-xs text-ink-3">正在加载更多待办…</div> : null}
				{todosQuery.isFetchNextPageError ? (
					<button type="button" className="block w-full py-4 text-center text-xs text-red hover:underline" onClick={() => void todosQuery.fetchNextPage()}>加载失败，点击重试</button>
				) : todosQuery.hasNextPage && todos.length > 0 ? (
					<div className="py-4 text-center text-xs text-ink-3">继续下滑加载更多</div>
				) : null}
			</main>
		</div>
	);
}

function Tab({ active, onClick, children }: {
	active: boolean;
	onClick: () => void;
	children: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={`rounded-md px-4 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
				active ? "bg-paper text-ink shadow-sm" : "text-ink-3 hover:text-ink"
			}`}
		>
			{children}
		</button>
	);
}

function TodoSection({ label, children }: { label: string; children: ReactNode }) {
	return (
		<section aria-labelledby={`todo-${label}`}>
			<h2 id={`todo-${label}`} className="mb-1 text-xl font-semibold tracking-[-0.02em] text-ink">
				{label}
			</h2>
			<ul className="divide-y divide-edge-3 border-y border-edge-3">{children}</ul>
		</section>
	);
}

function TodoRow({
	todo,
	overdue,
	onComplete,
	onOpenEmail,
	onReject,
	onDelete,
	onUpdate,
}: {
	todo: TodoItem;
	overdue: boolean;
	onComplete: () => void;
	onOpenEmail: () => void;
	onReject: () => void;
	onDelete: () => void;
	onUpdate: (patch: TodoPatch) => void;
}) {
	const [armedDelete, setArmedDelete] = useState(false);
	const due = formatDue(todo.dueDate);
	return (
		<li className="group flex min-h-16 items-center gap-3 px-1 transition-colors hover:bg-paper-3/70">
			<button type="button" onClick={onComplete} aria-label={`完成：${todo.title}`} className="grid h-10 w-10 shrink-0 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
				<span className="h-5 w-5 rounded-md border border-edge-2 bg-paper transition-colors group-hover:border-blue" />
			</button>
			<button type="button" onClick={onOpenEmail} className="min-w-0 flex-1 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
				<div className="flex items-center gap-2 text-sm text-ink">
					{todo.priority === "high" ? <span aria-label="高优先级" className="font-semibold text-coral">!!</span> : null}
					<span className="truncate">{todo.title}</span>
				</div>
				{due ? <div className={`mt-1 flex items-center gap-1 text-xs tabular-nums ${overdue ? "text-coral" : "text-ink-3"}`}><ClockIcon size={13} />{due}</div> : null}
			</button>
			<div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
				<TodoDetails todo={todo} onSave={onUpdate} onOpenEmail={onOpenEmail} />
				{todo.source === "ai" ? <IconButton label="移除待办并反馈识别不准确" onClick={onReject}><ThumbsDownIcon size={17} /></IconButton> : null}
				<IconButton
					label={armedDelete ? "再次点击确认删除" : "删除待办"}
					onClick={() => {
						if (!armedDelete) { setArmedDelete(true); return; }
						onDelete();
					}}
				><TrashIcon size={17} /></IconButton>
			</div>
		</li>
	);
}

function CompletedRow({ todo, onRestore, onOpenEmail, onDelete }: {
	todo: TodoItem;
	onRestore: () => void;
	onOpenEmail: () => void;
	onDelete: () => void;
}) {
	const [armedDelete, setArmedDelete] = useState(false);
	return (
		<li className="group flex min-h-16 items-center gap-3 px-1 hover:bg-paper-3/70">
			<button type="button" onClick={onRestore} aria-label={`恢复：${todo.title}`} className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><CheckIcon size={20} weight="bold" /></button>
			<button type="button" onClick={onOpenEmail} className="min-w-0 flex-1 py-3 text-left text-sm text-ink-3 line-through focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{todo.title}</button>
			<IconButton label="恢复待办" onClick={onRestore}><ArrowCounterClockwiseIcon size={17} /></IconButton>
			<IconButton
				label={armedDelete ? "再次点击确认删除" : "删除待办"}
				onClick={() => {
					if (!armedDelete) { setArmedDelete(true); return; }
					onDelete();
				}}
			><TrashIcon size={17} /></IconButton>
		</li>
	);
}

function IconButton({ label, onClick, children }: {
	label: string;
	onClick: () => void;
	children: ReactNode;
}) {
	return <button type="button" aria-label={label} title={label} onClick={onClick} className="grid h-10 w-10 place-items-center rounded-md text-ink-3 transition-colors hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{children}</button>;
}

function TodoDetails({ todo, onSave, onOpenEmail }: {
	todo: TodoItem;
	onSave: (patch: TodoPatch) => void;
	onOpenEmail: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState(todo.title);
	const [allDay, setAllDay] = useState(isAllDay(todo));
	const [startTime, setStartTime] = useState(toLocalInput(todo.startTime));
	const [dueDate, setDueDate] = useState(toLocalInput(todo.dueDate));
	const [timezone, setTimezone] = useState(todo.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
	const [priority, setPriority] = useState(todo.priority ?? "medium");

	useEffect(() => {
		setTitle(todo.title);
		setAllDay(isAllDay(todo));
		setStartTime(toLocalInput(todo.startTime));
		setDueDate(toLocalInput(todo.dueDate));
		setTimezone(todo.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
		setPriority(todo.priority ?? "medium");
	}, [todo]);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button type="button" aria-label="查看待办详情" title="查看待办详情" className="grid h-10 w-10 place-items-center rounded-md text-ink-3 transition-colors hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><InfoIcon size={18} /></button>
			</PopoverTrigger>
			<PopoverContent align="end" side="left" sideOffset={12} className="w-[370px] rounded-2xl border-edge bg-paper p-3 shadow-[var(--shadow-3)]">
				<div className="space-y-3">
					<textarea value={title} onChange={(event) => setTitle(event.target.value)} rows={2} aria-label="待办标题" className="w-full resize-none rounded-xl border-0 bg-paper-3 px-3 py-2.5 text-sm font-semibold leading-snug text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring" />
					<fieldset className="rounded-xl bg-paper-3 p-3">
						<legend className="px-1 text-xs text-ink-3">日期与时间</legend>
						<label className="flex min-h-11 items-center justify-between border-b border-edge-3 text-sm text-ink"><span>全天</span><input type="checkbox" checked={allDay} onChange={(event) => setAllDay(event.target.checked)} className="h-4 w-4 accent-blue" /></label>
						<DateField label="开始" value={startTime} allDay={allDay} onChange={setStartTime} />
						<DateField label="结束" value={dueDate} allDay={allDay} onChange={setDueDate} />
						<label className="mt-2 flex items-center justify-between gap-4 text-sm text-ink"><span>时区</span><input value={timezone} onChange={(event) => setTimezone(event.target.value)} className="min-w-0 flex-1 bg-transparent text-right text-sm text-ink-2 outline-none" /></label>
					</fieldset>
					<label className="flex items-center justify-between rounded-xl bg-paper-3 px-3 py-2.5 text-sm text-ink"><span>优先级</span><select value={priority} onChange={(event) => setPriority(event.target.value as typeof priority)} className="bg-transparent text-sm text-ink-2 outline-none"><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
					<button type="button" onClick={onOpenEmail} className="w-full rounded-xl bg-paper-3 px-3 py-2.5 text-left text-xs text-ink-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="block text-sm font-medium text-ink">关联邮件</span><span className="block truncate">{todo.emailId || "邮件已移除"}</span></button>
					<div className="flex justify-end gap-2 px-1 pb-1">
						<button type="button" onClick={() => setOpen(false)} className="rounded-md px-3 py-2 text-xs text-ink-3 hover:bg-paper-3">取消</button>
						<button type="button" disabled={!title.trim()} onClick={() => {
							onSave({ title: title.trim(), startTime: toIso(startTime), dueDate: toIso(dueDate), endTime: toIso(dueDate), timezone: timezone.trim() || null, priority });
							setOpen(false);
						}} className="rounded-md bg-ink px-3 py-2 text-xs font-medium text-paper disabled:opacity-40">保存</button>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}

function DateField({ label, value, allDay, onChange }: { label: string; value: string; allDay: boolean; onChange: (value: string) => void }) {
	const inputValue = allDay ? value.slice(0, 10) : value.length === 10 ? `${value}T09:00` : value;
	return <label className="flex min-h-11 items-center justify-between gap-4 border-b border-edge-3 text-sm text-ink last:border-b-0"><span>{label}</span><input type={allDay ? "date" : "datetime-local"} value={inputValue} onChange={(event) => onChange(event.target.value)} className="bg-transparent text-right text-sm text-ink-2 outline-none" /></label>;
}

function TodosSkeleton() {
	return <div role="status" aria-label="正在加载待办" className="mx-auto max-w-6xl space-y-8"><div className="h-7 w-24 animate-pulse rounded bg-paper-3" />{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-16 animate-pulse border-b border-edge-3 bg-paper-3/40" />)}</div>;
}
