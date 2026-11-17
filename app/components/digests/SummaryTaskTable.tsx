// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { memo } from "react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { MinusCircleIcon } from "@phosphor-icons/react/MinusCircle";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import type { Icon } from "@phosphor-icons/react";
import type {
	SummaryHealthItem,
	SummaryWorkState,
} from "shared/wemail/intelligence";
import { cn } from "~/lib/cn";
import { Checkbox } from "~/components/ui/checkbox";
import { AttributeDots } from "./AttributeStatusBadges";
import { formatSummaryTaskError } from "./summaryErrors";

export interface SummaryTaskTableProps {
	items: SummaryHealthItem[];
	selectedIds: Set<string>;
	isRetrying: boolean;
	hasMore: boolean;
	isLoadingMore: boolean;
	onLoadMore: () => void;
	onToggleSelected: (emailId: string, selected: boolean) => void;
	onSelectItem: (item: SummaryHealthItem) => void;
	onRetryOne: (emailId: string) => void;
}

function getSummaryStateLabel(state: SummaryWorkState) {
	switch (state) {
		case "succeeded":
			return "已完成";
		case "failed":
			return "失败";
		case "missing":
			return "未生成";
		case "invalid":
			return "无效";
		case "pending":
			return "排队中";
		case "running":
			return "生成中";
		case "skipped":
			return "已跳过";
		default:
			return "未知";
	}
}

function getSummaryStateBadge(state: SummaryWorkState): {
	label: string;
	Icon: Icon;
	className: string;
} {
	const label = getSummaryStateLabel(state);
	switch (state) {
		case "succeeded":
			return {
				label,
				Icon: CheckCircleIcon,
				className: "text-green",
			};
		case "failed":
		case "invalid":
			return {
				label,
				Icon: WarningCircleIcon,
				className: "text-coral",
			};
		case "missing":
			return {
				label,
				Icon: MinusCircleIcon,
				className: "text-amber",
			};
		case "pending":
			return {
				label,
				Icon: ClockIcon,
				className: "text-blue",
			};
		case "running":
			return {
				label,
				Icon: CircleNotchIcon,
				className: "text-blue",
			};
		case "skipped":
			return {
				label,
				Icon: MinusCircleIcon,
				className: "text-ink-3",
			};
		default:
			return {
				label,
				Icon: WarningCircleIcon,
				className: "text-ink-3",
			};
	}
}

export function SummaryStateBadge({ state }: { state: SummaryWorkState }) {
	const badge = getSummaryStateBadge(state);
	const Icon = badge.Icon;
	return (
		<span
			aria-label={`任务状态：${badge.label}`}
			className={cn(
				"inline-flex h-6 items-center gap-1.5 whitespace-nowrap text-xs font-semibold leading-none",
				badge.className,
			)}
		>
			<Icon
				size={13}
				weight={state === "running" ? "bold" : "fill"}
				className={cn("shrink-0", state === "running" && "animate-spin motion-reduce:animate-none")}
				aria-hidden="true"
			/>
			<span>{badge.label}</span>
		</span>
	);
}

function TaskCheckbox({
	checked,
	disabled,
	label,
	onChange,
}: {
	checked: boolean;
	disabled: boolean;
	label: string;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label className="inline-flex min-h-9 min-w-9 cursor-pointer items-center justify-center rounded-md focus-within:ring-2 focus-within:ring-ring">
			<Checkbox
				checked={checked}
				disabled={disabled}
				onChange={onChange}
				label={label}
				size={18}
				boxClassName="rounded-[5px] border-edge-2 bg-paper-2 hover:border-ink-4"
			/>
		</label>
	);
}

export function isSummaryItemRetryable(item: SummaryHealthItem) {
	return (
		item.state === "failed" ||
		item.state === "missing" ||
		item.state === "invalid"
	);
}

function formatSummaryTaskTime(value?: string) {
	if (!value) return "-";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "-";
	return summaryTaskTimeFormatter.format(date);
}

const summaryTaskTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});

function getAttemptsLabel(item: SummaryHealthItem) {
	if (!item.job) return "-";
	return `${item.job.attempts}/${item.job.maxAttempts}`;
}

function SummaryTaskTable({
	items,
	selectedIds,
	isRetrying,
	hasMore,
	isLoadingMore,
	onLoadMore,
	onToggleSelected,
	onSelectItem,
	onRetryOne,
}: SummaryTaskTableProps) {
	return (
		<div
			data-testid="summary-task-table-scroll"
			className="h-full min-h-[320px] overflow-auto pb-20"
			onScroll={(event) => {
				const target = event.currentTarget;
				if (
					hasMore &&
					!isLoadingMore &&
					target.scrollHeight - target.scrollTop - target.clientHeight < 160
				) {
					onLoadMore();
				}
			}}
		>
			{items.length === 0 ? (
				<div className="grid min-h-[320px] place-items-center px-4 text-center">
					<div>
						<div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-paper-3 text-ink-3">
							<MagnifyingGlassIcon size={20} weight="duotone" aria-hidden="true" />
						</div>
						<p className="mt-3 text-sm font-medium text-ink">没有匹配的智能任务</p>
						<p className="mt-1 text-xs text-ink-3">调整搜索条件或任务范围后再试。</p>
					</div>
				</div>
			) : (
				<>
				<div className="space-y-2 p-3 md:hidden">
					{items.map((item) => {
						const retryable = isSummaryItemRetryable(item);
						const selected = selectedIds.has(item.emailId);
						return (
							<article key={item.emailId} className="rounded-xl border border-edge bg-paper-2 p-3">
								<div className="flex items-start gap-3">
									<TaskCheckbox checked={selected} disabled={!retryable} label={`选择 ${item.subject}`} onChange={(checked) => onToggleSelected(item.emailId, checked)} />
									<button type="button" onClick={() => onSelectItem(item)} className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
										<span className="block truncate text-sm font-semibold text-ink">{item.subject}</span>
										<span className="mt-1 block truncate text-xs text-ink-3">{item.sender}</span>
									</button>
									<SummaryStateBadge state={item.state} />
								</div>
								<div className="mt-3 flex items-center justify-between gap-3 border-t border-edge pt-3 text-xs text-ink-3">
									<span>{formatSummaryTaskError(item)}</span>
									{retryable ? <button type="button" disabled={isRetrying} onClick={() => onRetryOne(item.emailId)} className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md border border-edge px-3 font-medium text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"><ArrowsClockwiseIcon size={13} />重试</button> : null}
								</div>
							</article>
						);
					})}
				</div>
				<table className="hidden w-full table-fixed border-separate border-spacing-0 text-left text-sm md:table">
					<thead className="sticky top-0 z-10 bg-paper-3 text-xs font-medium text-ink-3">
						<tr>
							<th className="w-10 border-b border-edge px-2 py-3"><span className="sr-only">选择</span></th>
							<th className="w-[34%] min-w-0 border-b border-edge px-3 py-3">邮件</th>
							<th className="w-[26%] min-w-0 border-b border-edge px-3 py-3">状态与反馈</th>
							<th className="hidden w-[180px] border-b border-edge px-3 py-3 xl:table-cell">处理项</th>
							<th className="w-20 border-b border-edge px-3 py-3">最近更新</th>
							<th className="w-10 border-b border-edge px-1 py-3"><span className="sr-only">操作</span></th>
						</tr>
					</thead>
					<tbody>
						{items.map((item) => {
							const retryable = isSummaryItemRetryable(item);
							const isSelected = selectedIds.has(item.emailId);
							return (
								<tr
									key={item.emailId}
									data-testid="summary-task-row"
									data-state={item.state}
									onClick={() => onSelectItem(item)}
									className="cursor-pointer text-ink transition-colors hover:bg-paper-3/70"
								>
									<td className="border-b border-edge px-2 py-3 align-middle">
										<TaskCheckbox checked={isSelected} disabled={!retryable} label={`选择 ${item.subject}`} onChange={(checked) => onToggleSelected(item.emailId, checked)} />
									</td>
									<td className="min-w-0 border-b border-edge px-3 py-3 align-middle">
										<button
											type="button"
											onClick={() => onSelectItem(item)}
											className="block min-h-9 max-w-full rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										>
											<span className="block truncate font-medium text-ink">{item.subject}</span>
											<span className="mt-1 block truncate text-xs text-ink-3">{item.sender}</span>
										</button>
									</td>
									<td className="min-w-0 border-b border-edge px-3 py-3 align-middle">
										<div className="flex items-center gap-2">
											<SummaryStateBadge state={item.state} />
											<span className="text-xs tabular-nums text-ink-3">{getAttemptsLabel(item)}</span>
										</div>
										<div className="mt-1.5 truncate text-xs text-ink-3" title={formatSummaryTaskError(item)}>{formatSummaryTaskError(item)}</div>
									</td>
									<td className="hidden border-b border-edge px-3 py-3 align-middle xl:table-cell">
										<AttributeDots attributes={item.attributes} />
									</td>
									<td className="border-b border-edge px-3 py-3 align-middle text-xs leading-5 text-ink-3">
										{formatSummaryTaskTime(
											item.job?.updatedAt ?? item.receivedAt,
										)}
									</td>
									<td className="border-b border-edge px-2 py-3 align-middle">
										{retryable ? (
											<button
												type="button"
												aria-label={`重试此任务：${item.subject}`}
												disabled={isRetrying}
												onClick={(event) => {
													event.stopPropagation();
													onRetryOne(item.emailId);
												}}
												className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-paper-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
											>
												<ArrowsClockwiseIcon size={15} weight="bold" />
											</button>
										) : (
											<span className="text-ink-3">-</span>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
				{isLoadingMore ? (
					<div className="flex items-center justify-center gap-2 px-4 py-4 text-xs text-ink-3">
						<CircleNotchIcon size={14} weight="bold" className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
						正在加载更多任务
					</div>
				) : hasMore ? (
					<div className="px-4 py-3 text-center text-xs text-ink-3">继续向下滚动加载更多</div>
				) : null}
				</>
			)}
		</div>
	);
}

export default memo(SummaryTaskTable);
