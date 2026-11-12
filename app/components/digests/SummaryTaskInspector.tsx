// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { EnvelopeOpenIcon } from "@phosphor-icons/react/EnvelopeOpen";
import type {
	IntelligenceAttributeKind,
	IntelligenceAttributeStatus,
	SummaryHealthItem,
	SummaryWorkState,
} from "shared/wemail/intelligence";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/cn";
import { formatTokenCount } from "~/lib/utils";
import { useEmailUsage } from "~/queries/usageStats";
import {
	ATTRIBUTE_LABELS,
	getAttributeBadge,
} from "./AttributeStatusBadges";
import {
	formatSummaryErrorDetail,
	getSummaryStateReason,
} from "./summaryErrors";
import {
	isSummaryItemRetryable,
	SummaryStateBadge,
} from "./SummaryTaskTable";

export interface SummaryTaskInspectorProps {
	item: SummaryHealthItem | null;
	isRetrying: boolean;
	onRetry: (emailId: string) => void;
	onRetryAttribute: (emailId: string, kind: IntelligenceAttributeKind) => void;
	onOpenEmail: (emailId: string) => void;
}

const stateLabels: Record<SummaryWorkState, string> = {
	succeeded: "已完成",
	failed: "失败",
	missing: "未生成",
	invalid: "无效",
	pending: "排队中",
	running: "生成中",
	skipped: "已跳过",
};

const jobStatusLabels: Record<string, string> = {
	pending: "排队中",
	leased: "生成中",
	running: "生成中",
	succeeded: "已完成",
	failed: "失败",
	terminal: "已结束",
	cancelled: "已取消",
	skipped: "已跳过",
};

const USAGE_LABELS: Record<string, string> = {
	summary: "摘要",
	agent_chat: "聊天",
	compose: "撰写",
	todo: "待办",
	translation: "翻译",
	automation: "自动化",
	other: "其他",
};

function formatJobStatus(status?: string) {
	if (!status) return "-";
	return jobStatusLabels[status] ?? status;
}

function formatDateTime(value?: string) {
	if (!value) return "-";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date);
}

function isAttributeRetryable(attribute: IntelligenceAttributeStatus) {
	return ["failed", "missing", "invalid", "pending", "running"].includes(
		attribute.state,
	);
}

function AttributeRow({
	attribute,
	isRetrying,
	onRetry,
}: {
	attribute: IntelligenceAttributeStatus;
	isRetrying: boolean;
	onRetry: () => void;
}) {
	const badge = getAttributeBadge(attribute.state);
	const Icon = badge.Icon;
	const retryable = isAttributeRetryable(attribute);
	return (
		<div className="flex items-center gap-3 py-3">
			<div className="min-w-0 flex-1">
				<div className="text-sm font-medium text-ink">
					{ATTRIBUTE_LABELS[attribute.kind]}
				</div>
				{attribute.error ? (
					<div className="truncate text-xs text-ink-3" title={attribute.error}>
						{attribute.error}
					</div>
				) : attribute.job ? (
					<div className="text-xs text-ink-3">
						{attribute.job.attempts}/{attribute.job.maxAttempts} 次尝试
					</div>
				) : null}
			</div>
			<span
				className={cn(
					"inline-flex h-6 shrink-0 items-center gap-1 text-xs font-semibold leading-none",
					badge.className,
				)}
			>
				<Icon
					size={11}
					weight={attribute.state === "running" ? "bold" : "fill"}
					className={cn(
						"shrink-0",
						attribute.state === "running" &&
							"animate-spin motion-reduce:animate-none",
					)}
					aria-hidden="true"
				/>
				<span>{badge.label}</span>
			</span>
			{retryable ? (
				<button
					type="button"
					aria-label={`重试${ATTRIBUTE_LABELS[attribute.kind]}`}
					onClick={onRetry}
					disabled={isRetrying}
					className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-edge bg-paper-2 px-2 text-xs font-medium text-ink-2 transition-colors hover:border-edge-2 hover:bg-paper-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
				>
					<ArrowsClockwiseIcon size={12} weight="bold" />
					重试
				</button>
			) : null}
		</div>
	);
}

function DetailRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-2 text-sm">
			<div className="text-ink-3">{label}</div>
			<div className="min-w-0 break-words text-ink">{value}</div>
		</div>
	);
}

export default function SummaryTaskInspector({
	item,
	isRetrying,
	onRetry,
	onRetryAttribute,
	onOpenEmail,
}: SummaryTaskInspectorProps) {
	const usageRows = useEmailUsage(item?.emailId).data ?? [];

	if (!item) {
		return (
			<aside className="grid min-h-[220px] w-full shrink-0 place-items-center overflow-y-auto rounded-xl border border-edge bg-paper-2 lg:h-full lg:min-h-[420px]">
				<div className="max-w-[240px] px-6 py-10 text-center">
					<div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-paper-3 text-ink-3">
						<EnvelopeOpenIcon size={22} weight="duotone" aria-hidden="true" />
					</div>
					<h2 className="mt-4 text-sm font-semibold text-ink">选择一项任务</h2>
					<p className="mt-2 text-sm leading-6 text-ink-3">查看处理状态、错误原因和各项智能能力的执行结果。</p>
				</div>
			</aside>
		);
	}

	const errorDetail = formatSummaryErrorDetail(item);
	const retryable = isSummaryItemRetryable(item);
	const usageTotal = usageRows.reduce(
		(sum, row) => sum + row.inputTokens + row.outputTokens,
		0,
	);

	return (
		<aside
			data-testid="summary-task-inspector"
			className="max-h-[440px] min-h-[280px] w-full shrink-0 overflow-y-auto rounded-xl border border-edge bg-paper-2 lg:h-full lg:max-h-none lg:min-h-[420px]"
		>
			<div className="p-5">
				<header>
					<div className="mb-2">
						<SummaryStateBadge state={item.state} />
					</div>
					<h3 className="break-words text-base font-semibold leading-6 text-ink">
						{item.subject}
					</h3>
					<p className="mt-1 break-words text-xs text-ink-3">{item.sender}</p>
				</header>

				<div className={cn("mt-5 grid gap-2", retryable ? "grid-cols-2" : "grid-cols-1")}>
					{retryable ? (
						<Button
							type="button"
							size="sm"
							onClick={() => onRetry(item.emailId)}
							disabled={isRetrying}
							className="w-full rounded-lg"
						>
							<ArrowsClockwiseIcon size={14} weight="bold" />
							重试此封
						</Button>
					) : null}
					<Button
						type="button"
						size="sm"
						variant="secondary"
						className="w-full rounded-lg"
						onClick={() => onOpenEmail(item.emailId)}
					>
						<EnvelopeOpenIcon size={14} weight="bold" />
						打开邮件
					</Button>
				</div>

				<section className="mt-5 border-t border-edge pt-4">
					<h3 className="text-xs font-semibold text-ink-3">各属性状态</h3>
					<div className="mt-2 divide-y divide-edge">
						{item.attributes && item.attributes.length > 0 ? (
							item.attributes.map((attribute) => (
								<AttributeRow
									key={attribute.kind}
									attribute={attribute}
									isRetrying={isRetrying}
									onRetry={() =>
										onRetryAttribute(item.emailId, attribute.kind)
									}
								/>
							))
						) : (
							<p className="py-2 text-sm text-ink-3">暂无属性数据</p>
						)}
					</div>
				</section>

				<section className="mt-5 border-t border-edge pt-4">
					<h3 className="text-xs font-semibold text-ink-3">处理状态</h3>
					<div className="mt-2 divide-y divide-edge">
						<DetailRow label="状态" value={stateLabels[item.state]} />
						<DetailRow label="说明" value={getSummaryStateReason(item.state)} />
						{errorDetail ? (
							<DetailRow label="原因" value={errorDetail} />
						) : null}
						{item.diagnostic?.errorCode && !errorDetail ? (
							<DetailRow label="错误码" value={item.diagnostic.errorCode} />
						) : null}
					</div>
				</section>

				{item.job ? (
					<section className="mt-5 border-t border-edge pt-4">
						<h3 className="text-xs font-semibold text-ink-3">任务</h3>
						<div className="mt-2 divide-y divide-edge">
							<DetailRow label="任务状态" value={formatJobStatus(item.job.status)} />
							<DetailRow
								label="尝试次数"
								value={`${item.job.attempts}/${item.job.maxAttempts}`}
							/>
							<DetailRow
								label="更新时间"
								value={formatDateTime(item.job.updatedAt)}
							/>
						</div>
					</section>
				) : null}

				{usageRows.length > 0 ? (
					<section className="mt-5 border-t border-edge pt-4">
						<h3 className="flex items-center justify-between text-xs font-semibold text-ink-3">
							<span>AI 用量</span>
							<span className="font-mono-meta font-normal tabular-nums">
								{usageRows.length} 次请求 · {formatTokenCount(usageTotal)} tokens
							</span>
						</h3>
						<div className="mt-2 divide-y divide-edge">
							{usageRows.map((row) => (
								<div
									key={row.id}
									className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 py-2 text-sm"
								>
									<div className="text-ink-3">{USAGE_LABELS[row.category] ?? row.processor}</div>
									<div
										className="min-w-0 truncate text-xs text-ink-4"
										title={row.model ?? undefined}
									>
										{row.model ?? "unknown"}
									</div>
									<div className="shrink-0 text-right text-xs tabular-nums text-ink-3">
										入 {formatTokenCount(row.inputTokens)} · 出 {formatTokenCount(row.outputTokens)}
									</div>
								</div>
							))}
						</div>
					</section>
				) : null}
			</div>
		</aside>
	);
}
