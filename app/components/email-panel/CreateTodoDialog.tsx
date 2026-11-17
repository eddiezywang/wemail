// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * CreateTodoDialog — upstream-aligned "新建待办" sheet (Feature 5).
 *
 * Mirrors the screenshot fields:
 *   - Title (required, defaults to email subject)
 *   - Date & time block: 全天 toggle, 开始 + 结束 date/time, 时区
 *   - 优先级 (高 / 中 / 低)
 *   - Description (optional)
 *
 * Storage matches the schema columns added in migration 30
 * (`end_time`, `timezone`, `priority`); priority defaults to "中" / medium.
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { toast } from "sonner";
import { useCreateTodo } from "~/queries/todos";
import { getUserFacingError } from "~/lib/user-facing-error";

type Priority = "high" | "medium" | "low";

interface CreateTodoDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accountId: string | undefined;
	emailId: string;
	defaultTitle: string;
}

const PRIORITY_LABEL: Record<Priority, string> = {
	high: "高",
	medium: "中",
	low: "低",
};

const TIMEZONE_OPTIONS = [
	"Asia/Shanghai",
	"Asia/Tokyo",
	"Asia/Singapore",
	"Asia/Kolkata",
	"Europe/London",
	"Europe/Paris",
	"America/New_York",
	"America/Los_Angeles",
	"UTC",
] as const;

function detectInitialTimezone(): string {
	try {
		const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (z && TIMEZONE_OPTIONS.includes(z as (typeof TIMEZONE_OPTIONS)[number])) {
			return z;
		}
		return z || "Asia/Shanghai";
	} catch {
		return "Asia/Shanghai";
	}
}

function todayIsoDate(): string {
	const d = new Date();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

function combineDateTime(date: string, time: string): string | undefined {
	if (!date) return undefined;
	if (!time) return new Date(`${date}T00:00:00`).toISOString();
	return new Date(`${date}T${time}`).toISOString();
}

export function CreateTodoDialog({
	open,
	onOpenChange,
	accountId,
	emailId,
	defaultTitle,
}: CreateTodoDialogProps) {
	const initialTz = useMemo(detectInitialTimezone, []);
	const initialDate = useMemo(todayIsoDate, []);

	const [title, setTitle] = useState(defaultTitle);
	const [description, setDescription] = useState("");
	const [allDay, setAllDay] = useState(true);
	const [startDate, setStartDate] = useState(initialDate);
	const [startTime, setStartTime] = useState("12:00");
	const [showEnd, setShowEnd] = useState(false);
	const [endDate, setEndDate] = useState(initialDate);
	const [endTime, setEndTime] = useState("13:00");
	const [timezone, setTimezone] = useState(initialTz);
	const [priority, setPriority] = useState<Priority>("medium");
	const [rangeError, setRangeError] = useState<string | null>(null);
	const createMut = useCreateTodo();

	useEffect(() => {
		if (open) {
			setTitle(defaultTitle);
			setDescription("");
			setAllDay(true);
			setStartDate(initialDate);
			setStartTime("12:00");
			setShowEnd(false);
			setEndDate(initialDate);
			setEndTime("13:00");
			setTimezone(initialTz);
			setPriority("medium");
			setRangeError(null);
		}
	}, [open, defaultTitle, initialDate, initialTz]);

	const handleCreate = async () => {
		if (!accountId) {
			toast.error("没有可用账号");
			return;
		}
		if (!title.trim()) {
			toast.error("标题不能为空");
			return;
		}
		const startIso = allDay
			? new Date(`${startDate}T00:00:00`).toISOString()
			: combineDateTime(startDate, startTime);
		const endIso =
			showEnd && !allDay
				? combineDateTime(endDate, endTime)
				: showEnd && allDay
					? new Date(`${endDate}T23:59:59`).toISOString()
					: undefined;
		if (startIso && endIso && new Date(endIso).getTime() < new Date(startIso).getTime()) {
			setRangeError("结束时间不能早于开始时间。");
			return;
		}
		setRangeError(null);
		try {
			await createMut.mutateAsync({
				accountId,
				emailId,
				title: title.trim(),
				description: description.trim() || undefined,
				dueDate: startDate || undefined,
				startTime: startIso,
				endTime: endIso,
				timezone,
				priority,
			});
			toast.success("已添加待办");
			onOpenChange(false);
		} catch (err) {
			toast.error(getUserFacingError(err, "创建失败，请稍后重试。"));
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[520px] w-[92vw] p-0 overflow-hidden">
				<div className="px-5 py-4 border-b border-edge flex items-start justify-between gap-4">
					<div>
						<DialogTitle className="text-base font-semibold text-ink">
							新建待办
						</DialogTitle>
						<DialogDescription className="text-xs text-ink-3 mt-1">
							基于这封邮件添加一条手动待办。
						</DialogDescription>
					</div>
					<button
						type="button"
						onClick={() => onOpenChange(false)}
						className="text-coral text-sm font-medium hover:opacity-80"
					>
						取消
					</button>
				</div>

				<div className="px-5 py-4 space-y-4">
					<div>
						<Input
							aria-label="待办标题"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							autoFocus
							placeholder="待办标题"
							className="text-base font-medium"
							data-testid="todo-title-input"
						/>
					</div>

					<div className="text-xs uppercase tracking-wider text-ink-3 font-medium">
						日期 &amp; 时间
					</div>

					<div className="rounded-lg border border-edge bg-paper-3/30 divide-y divide-edge">
						<Row>
							<RowLabel>全天</RowLabel>
							<label className="inline-flex items-center cursor-pointer">
								<input
									type="checkbox"
									checked={allDay}
									onChange={(e) => setAllDay(e.target.checked)}
									className="h-4 w-4 accent-coral"
									data-testid="todo-allday-toggle"
									aria-label="全天待办"
								/>
							</label>
						</Row>

						<Row>
							<RowLabel tone="active">
								<span className="inline-block h-1.5 w-1.5 rounded-full bg-coral mr-1.5 align-middle" />
								开始
							</RowLabel>
							<div className="flex items-center gap-1.5">
								<Input
									aria-label="开始日期"
									type="date"
									value={startDate}
									onChange={(e) => setStartDate(e.target.value)}
									className="h-8 w-[124px] text-xs"
								/>
								{!allDay ? (
									<Input
										aria-label="开始时间"
										type="time"
										value={startTime}
										onChange={(e) => setStartTime(e.target.value)}
										className="h-8 w-[88px] text-xs"
									/>
								) : null}
							</div>
						</Row>

						{showEnd ? (
							<Row>
								<RowLabel>结束</RowLabel>
								<div className="flex items-center gap-1.5">
									<Input
										aria-label="结束日期"
										aria-invalid={Boolean(rangeError)}
										aria-describedby={rangeError ? "todo-time-range-error" : undefined}
										type="date"
										value={endDate}
										onChange={(e) => setEndDate(e.target.value)}
										className="h-8 w-[124px] text-xs"
									/>
									{!allDay ? (
										<Input
											aria-label="结束时间"
											aria-invalid={Boolean(rangeError)}
											aria-describedby={rangeError ? "todo-time-range-error" : undefined}
											type="time"
											value={endTime}
											onChange={(e) => setEndTime(e.target.value)}
											className="h-8 w-[88px] text-xs"
										/>
									) : null}
									<button
										type="button"
										onClick={() => setShowEnd(false)}
										className="min-h-9 text-xs text-ink-3 hover:text-ink"
										aria-label="移除结束时间"
									>
										移除
									</button>
								</div>
							</Row>
						) : (
							<Row>
								<button
									type="button"
									onClick={() => setShowEnd(true)}
									className="inline-flex min-h-9 items-center gap-1.5 text-xs text-coral hover:opacity-80"
								>
									<span aria-hidden>＋</span> 结束
								</button>
							</Row>
						)}

						<Row>
							<RowLabel>时区</RowLabel>
							<select
								aria-label="时区"
								value={timezone}
								onChange={(e) => setTimezone(e.target.value)}
								className="h-8 rounded-md border border-edge bg-paper px-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-coral/30"
							>
								{TIMEZONE_OPTIONS.map((tz) => (
									<option key={tz} value={tz}>
										{tz}
									</option>
								))}
								{!TIMEZONE_OPTIONS.includes(
									timezone as (typeof TIMEZONE_OPTIONS)[number],
								) ? (
									<option value={timezone}>{timezone}</option>
								) : null}
							</select>
						</Row>

						<Row>
							<RowLabel>优先级</RowLabel>
							<select
								aria-label="优先级"
								value={priority}
								onChange={(e) => setPriority(e.target.value as Priority)}
								className="h-8 rounded-md border border-edge bg-paper px-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-coral/30"
								data-testid="todo-priority"
							>
								{(["high", "medium", "low"] as const).map((p) => (
									<option key={p} value={p}>
										{PRIORITY_LABEL[p]}
									</option>
								))}
							</select>
						</Row>
					</div>
					{rangeError ? (
						<p id="todo-time-range-error" role="alert" className="text-xs text-red">
							{rangeError}
						</p>
					) : null}

					<div>
						<label htmlFor="todo-description" className="mb-1 block text-xs font-medium uppercase tracking-wider text-ink-3">
							备注（可选）
						</label>
						<Textarea
							id="todo-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={3}
							className="resize-y min-h-20 text-sm"
						/>
					</div>
				</div>

				<div className="px-5 py-3 border-t border-edge flex items-center justify-end gap-2">
					<Button
						size="sm"
						onClick={handleCreate}
						loading={createMut.isPending}
						data-testid="todo-create-submit"
					>
						创建
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function Row({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between px-3 py-2 min-h-10">
			{children}
		</div>
	);
}

function RowLabel({
	children,
	tone,
}: {
	children: React.ReactNode;
	tone?: "active";
}) {
	return (
		<span
			className={`text-xs ${
				tone === "active" ? "text-ink font-medium" : "text-ink-2"
			}`}
		>
			{children}
		</span>
	);
}
