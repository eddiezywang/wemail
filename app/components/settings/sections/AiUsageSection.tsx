// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { type CSSProperties, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { formatTokenCount as formatCompact } from "~/lib/utils";
import { useUsageStats } from "~/queries/usageStats";
import { useLlmSettings } from "~/queries/llmSettings";
import { mergeModelRows } from "./aiUsageModelRows";
import type { UsageBucketStats } from "../../../../shared/wemail/intelligence";
import type { UsagePeriod } from "../../../../shared/wemail/usage";

const PERIODS: ReadonlyArray<{ value: UsagePeriod; label: string }> = [
	{ value: "365d", label: "近一年" },
	{ value: "180d", label: "近半年" },
	{ value: "90d", label: "近三月" },
	{ value: "30d", label: "近一月" },
];

const BUCKETS: Record<string, { label: string; color: string }> = {
	summary: { label: "摘要", color: "var(--color-blue)" },
	todo: { label: "待办", color: "var(--color-edge-2)" },
	agent_chat: { label: "AI 聊天", color: "var(--color-green)" },
	translation: { label: "AI 翻译", color: "var(--color-amber)" },
	compose: { label: "撰写", color: "var(--color-coral)" },
	automation: { label: "自动化", color: "var(--color-ink-3)" },
	other: { label: "标签 / 其他", color: "var(--color-ink-4)" },
};

const BUCKET_ORDER = [
	"summary",
	"todo",
	"agent_chat",
	"translation",
	"compose",
	"automation",
	"other",
] as const;

const PROVIDER_LABELS: Record<string, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
};

function donutBackground(stats: UsageBucketStats[], totalTokens: number): string {
	if (totalTokens <= 0) return "var(--color-edge)";
	let cursor = 0;
	const stops: string[] = [];
	for (const bucket of stats.filter((item) => item.tokens > 0)) {
		const next = cursor + (bucket.tokens / totalTokens) * 100;
		const color = BUCKETS[bucket.category]?.color ?? "var(--color-ink-4)";
		stops.push(`${color} ${cursor}% ${next}%`);
		cursor = next;
	}
	return `conic-gradient(from -90deg, ${stops.join(", ")})`;
}

export function AiUsageSection({ accountId }: { accountId?: string }) {
	const [period, setPeriod] = useState<UsagePeriod>("365d");
	const { data: stats = [], isLoading, isFetching, isError, refetch } =
		useUsageStats(accountId, period);
	const { data: llmSettings } = useLlmSettings();

	const orderedStats = useMemo(() => {
		const byCategory = new Map(stats.map((bucket) => [bucket.category, bucket]));
		const stableBuckets = BUCKET_ORDER.map((category) =>
			byCategory.get(category) ?? {
				category,
				label: BUCKETS[category].label,
				tokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				calls: 0,
				details: [],
				models: [],
			},
		);
		const extraBuckets = stats.filter(
			(bucket) => !BUCKET_ORDER.includes(bucket.category as (typeof BUCKET_ORDER)[number]),
		);
		return [...stableBuckets, ...extraBuckets];
	}, [stats]);

	// Model dimension: one row per model name. The backend groups by
	// (category, provider, model), so the same model reached via different
	// provider protocols arrives as separate rows; mergeModelRows collapses
	// them so the list never shows the same model twice.
	const modelRows = useMemo(
		() => mergeModelRows(stats.flatMap((bucket) => bucket.models)),
		[stats],
	);
	const totalTokens = orderedStats.reduce((sum, bucket) => sum + bucket.tokens, 0);
	const totalInputTokens = orderedStats.reduce((sum, bucket) => sum + bucket.inputTokens, 0);
	const totalOutputTokens = orderedStats.reduce((sum, bucket) => sum + bucket.outputTokens, 0);
	const totalCalls = orderedStats.reduce((sum, bucket) => sum + bucket.calls, 0);
	const chartStyle = {
		background: donutBackground(orderedStats, totalTokens),
	} satisfies CSSProperties;
	const inputRatio =
		totalTokens > 0 ? Math.round((totalInputTokens / totalTokens) * 100) : 0;

	return (
		<section aria-labelledby="ai-usage-title" data-testid="account-ai-usage">
			<div className="mb-2 flex items-end justify-between gap-4">
				<div>
					<h3 id="ai-usage-title" className="text-sm font-semibold text-ink">
						AI 用量
					</h3>
					<p className="mt-1 text-xs text-ink-3">
						按当前账户统计，仅保存在本机
					</p>
				</div>
				<span className="inline-flex items-center gap-1 text-xs text-ink-4">
					<ClockCounterClockwiseIcon size={12} />
					随 AI 调用更新
				</span>
			</div>

			<div className="overflow-hidden rounded-xl border border-edge bg-paper-2">
				<div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge-3 px-4 py-3">
					<div className="flex items-center gap-1" aria-label="用量时间范围">
						{PERIODS.map((item) => (
							<button
								key={item.value}
								type="button"
								onClick={() => setPeriod(item.value)}
								aria-pressed={period === item.value}
								className={`rounded-full px-2.5 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
									period === item.value
										? "bg-paper-4 font-semibold text-ink"
										: "text-ink-3 hover:bg-paper-3 hover:text-ink"
								}`}
							>
								{item.label}
							</button>
						))}
					</div>
					<Button
						variant="secondary"
						size="sm"
						className="rounded-full"
						onClick={() => void refetch()}
						loading={isFetching}
						aria-label="刷新 AI 用量"
					>
						<ArrowClockwiseIcon size={14} />
						刷新
					</Button>
				</div>

				<div className="relative grid gap-5 px-4 py-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center">
					<div className="mx-auto flex w-full max-w-[180px] flex-col items-center">
						<div
							role="img"
							aria-label={`AI 用量合计 ${totalTokens.toLocaleString("zh-CN")} tokens`}
							className="relative h-[132px] w-[132px] rounded-full shadow-[inset_0_0_0_1px_var(--color-edge-3)]"
							style={chartStyle}
						>
							<div className="absolute inset-[11px] flex flex-col items-center justify-center rounded-full bg-paper-2">
								<strong className="font-mono-meta text-xl font-semibold tracking-tight text-ink tabular-nums">
									{formatCompact(totalTokens)}
								</strong>
								<span className="mt-0.5 text-xs tracking-wide text-ink-3">
									tokens
								</span>
							</div>
						</div>
						<span className="mt-2 text-xs text-ink-4 tabular-nums">
							{totalCalls.toLocaleString("zh-CN")} 次调用
						</span>
						<div className="mt-3 w-full">
							<div className="flex items-center justify-between text-xs text-ink-4 tabular-nums">
								<span className="inline-flex items-center gap-1">
									<span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-blue)" }} />
									输入 {formatCompact(totalInputTokens)}
								</span>
								<span className="inline-flex items-center gap-1">
									输出 {formatCompact(totalOutputTokens)}
									<span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-amber)" }} />
								</span>
							</div>
							<div
								className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full"
								role="img"
								aria-label={`输入占比 ${inputRatio}%`}
							>
								<div style={{ width: `${inputRatio}%`, background: "var(--color-blue)" }} />
								<div style={{ width: `${100 - inputRatio}%`, background: "var(--color-amber)" }} />
							</div>
						</div>
					</div>

					<div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
						{orderedStats.map((bucket) => {
							const meta = BUCKETS[bucket.category] ?? {
								label: bucket.label,
								color: "var(--color-ink-4)",
							};
							return (
								<div key={bucket.category} className="border-b border-edge-3 last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0">
									<div className="flex w-full items-center gap-2 py-2 text-left">
										<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: meta.color }} />
										<span className="min-w-0 flex-1">
										<span className="block truncate text-xs text-ink-2">{meta.label}</span>
										<span className="block text-xs text-ink-4 tabular-nums">
											输入 {formatCompact(bucket.inputTokens)} · 输出 {formatCompact(bucket.outputTokens)}
										</span>
									</span>
										<span className="font-mono-meta text-xs text-ink tabular-nums">{formatCompact(bucket.tokens)}</span>
									</div>
								</div>
							);
						})}
					</div>

					{isLoading ? (
						<div className="absolute inset-0 flex items-center justify-center bg-paper-2/75 text-xs text-ink-3" role="status" aria-live="polite">
							<SpinnerGapIcon size={16} className="mr-2 animate-spin motion-reduce:animate-none" />
							正在读取用量…
						</div>
					) : null}
				</div>

				<div className="flex flex-wrap items-center justify-between gap-2 border-t border-edge-3 px-4 py-3">
					{isError ? (
						<span className="text-xs text-red">当前范围读取失败，请刷新重试</span>
					) : totalTokens === 0 ? (
						<span className="text-xs text-ink-3">此时间范围内还没有 AI 用量</span>
					) : (
						<span className="text-xs text-ink-3">输入与输出 token 分开统计</span>
					)}
					<strong className="ml-auto text-sm font-semibold text-ink tabular-nums">
						总计：{totalTokens.toLocaleString("zh-CN")}
					</strong>
				</div>

				{modelRows.length > 0 ? (
					<div className="border-t border-edge-3 px-4 py-3">
						<h4 className="text-xs font-semibold text-ink">按模型</h4>
						<div className="mt-2 space-y-1.5">
							{modelRows.map((row) => {
								// 免费资源由 WeMail 提供，不展示底层兼容协议 provider。
								const isFreeModel =
									llmSettings?.freeTrial === true &&
									row.model === llmSettings.defaultModel;
								const providerLabel =
									!isFreeModel && row.provider !== "unknown"
										? (PROVIDER_LABELS[row.provider] ?? row.provider)
										: null;
								return (
									<div key={row.model} className="flex items-center gap-2 text-xs">
										<span className="min-w-0 flex-1 truncate text-ink-2">
											{providerLabel ? (
													<>
														<span className="text-ink-4">{providerLabel} · </span>
														{isFreeModel ? (
															<span className="mr-1 inline-flex items-center rounded bg-green/15 px-1 py-px align-middle font-mono-meta text-xs font-semibold uppercase tracking-wider text-green">
																free
															</span>
														) : null}
														{row.model}
													</>
												) : (
													<>
														{isFreeModel ? (
															<span className="mr-1 inline-flex items-center rounded bg-green/15 px-1 py-px align-middle font-mono-meta text-xs font-semibold uppercase tracking-wider text-green">
																free
															</span>
														) : null}
														{row.model}
													</>
												)}
										</span>
										<span className="flex flex-col items-end">
											<span className="font-mono-meta text-ink tabular-nums">{formatCompact(row.tokens)}</span>
											<span className="text-xs text-ink-4 tabular-nums">
												输 {formatCompact(row.inputTokens)} / 出 {formatCompact(row.outputTokens)}
											</span>
										</span>
										<span className="w-12 text-right text-ink-4 tabular-nums">{row.calls} 次</span>
									</div>
								);
							})}
						</div>
					</div>
				) : null}
			</div>
		</section>
	);
}
