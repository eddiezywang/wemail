// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMemo } from "react";
import { ArrowDownIcon } from "@phosphor-icons/react/ArrowDown";
import { ArrowUpIcon } from "@phosphor-icons/react/ArrowUp";
import { MinusIcon } from "@phosphor-icons/react/Minus";
import type { SummaryHealthStatus } from "shared/wemail/intelligence";
import type { SummaryStateFilter } from "~/queries/digests";
import { useUsageTimeseries } from "~/queries/usageStats";

/** Hourly buckets × 7 days — the widest window the timeseries API allows. */
const HOUR_WINDOW = 168;
const DAILY_BUCKETS = HOUR_WINDOW / 24;

function formatCompact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/** Percent change of the second half vs the first half. NaN-safe. */
function halfWindowDelta(values: number[]): number | null {
	const half = Math.floor(values.length / 2);
	if (half === 0) return null;
	const prev = values.slice(0, half).reduce((a, b) => a + b, 0);
	const next = values.slice(half).reduce((a, b) => a + b, 0);
	if (prev === 0) return next > 0 ? null : 0;
	return (next - prev) / prev;
}

function DeltaChip({ delta }: { delta: number | null }) {
	if (delta === null) {
		return <span className="text-caption text-ink-4">新增活动</span>;
	}
	if (Math.abs(delta) < 0.005) {
		return (
			<span className="inline-flex items-center gap-0.5 text-caption text-ink-3">
				<MinusIcon size={10} weight="bold" aria-hidden /> 持平
			</span>
		);
	}
	const up = delta > 0;
	return (
		<span
			className={`inline-flex items-center gap-0.5 text-caption font-medium tabular-nums ${up ? "text-green" : "text-coral-2"}`}
		>
			{up ? <ArrowUpIcon size={10} weight="bold" aria-hidden /> : <ArrowDownIcon size={10} weight="bold" aria-hidden />}
			{`${up ? "+" : ""}${Math.round(delta * 100)}%`}
			<span className="font-normal text-ink-4">后半 vs 前半</span>
		</span>
	);
}

function Sparkline({ values }: { values: number[] }) {
	const max = Math.max(1, ...values);
	return (
		<div className="flex h-9 items-end gap-[3px]" aria-hidden>
			{values.map((value, index) => (
				<i
					key={index}
					className="flex-1 rounded-[2px] bg-coral"
					style={{
						height: `${Math.max(8, (value / max) * 100)}%`,
						opacity: 0.3 + 0.7 * (value / max),
					}}
				/>
			))}
		</div>
	);
}

interface InsightCardProps {
	label: string;
	value: string;
	delta?: React.ReactNode;
	sparkline?: React.ReactNode;
	footer?: React.ReactNode;
	testId: string;
	/** Stagger index — drives the 90ms rise-in delay (.stagger-rise in index.css). */
	staggerIndex?: number;
}

function InsightCard({ label, value, delta, sparkline, footer, testId, staggerIndex }: InsightCardProps) {
	return (
		<div
			className="flex min-w-0 flex-col gap-2 rounded-xl border border-edge bg-paper-2 p-3.5 stagger-rise"
			style={staggerIndex === undefined ? undefined : { animationDelay: `${staggerIndex * 90}ms` }}
			data-testid={testId}
		>
			<div className="text-xs font-medium text-ink-4">{label}</div>
			<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
				<span className="text-lg font-semibold leading-none tabular-nums text-ink">{value}</span>
				{delta}
			</div>
			{sparkline}
			{footer ? <div className="text-caption text-ink-3">{footer}</div> : null}
		</div>
	);
}

export interface SummaryInsightCardsProps {
	accountId: string | undefined;
	health?: SummaryHealthStatus;
	/** Applies a table state filter (e.g. "failed") when a card action fires. */
	onFilter: (filter: SummaryStateFilter) => void;
}

/**
 * Turns the throughput table into scannable insight cards (Beautiful UI §12):
 * trend + delta + one concrete next action per card.
 */
export function SummaryInsightCards({ accountId, health, onFilter }: SummaryInsightCardsProps) {
	const timeseries = useUsageTimeseries(accountId, "hour", HOUR_WINDOW);

	const daily = useMemo(() => {
		const calls = new Array<number>(DAILY_BUCKETS).fill(0);
		const tokens = new Array<number>(DAILY_BUCKETS).fill(0);
		for (const entry of timeseries.data?.series ?? []) {
			entry.calls.forEach((value, index) => {
				calls[Math.floor(index / 24)] += value;
			});
			entry.tokens.forEach((value, index) => {
				tokens[Math.floor(index / 24)] += value;
			});
		}
		return { calls, tokens };
	}, [timeseries.data]);

	const hasData = !!timeseries.data && !timeseries.isError;
	const totalCalls = daily.calls.reduce((a, b) => a + b, 0);
	const totalTokens = daily.tokens.reduce((a, b) => a + b, 0);
	const callsDelta = halfWindowDelta(daily.calls);
	const tokensDelta = halfWindowDelta(daily.tokens);
	const trendWord = (delta: number | null) =>
		delta === null ? "出现新活动" : delta > 0.05 ? "趋势上升" : delta < -0.05 ? "趋势回落" : "基本持平";

	const failed = health?.failed ?? 0;
	const retryable = health?.retryable ?? 0;
	const running = health?.running ?? 0;
	const pending = health?.pending ?? 0;

	return (
		<section
			aria-label="智能洞察"
			className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
			data-testid="summary-insight-cards"
		>
			<InsightCard
				testId="insight-card-calls"
				staggerIndex={0}
				label="AI 调用 · 近7天"
				value={hasData ? formatCompact(totalCalls) : "—"}
				delta={hasData ? <DeltaChip delta={callsDelta} /> : null}
				sparkline={hasData ? <Sparkline values={daily.calls} /> : <div className="shimmer-line h-9 w-full" />}
				footer={hasData ? trendWord(callsDelta) : "加载中…"}
			/>
			<InsightCard
				testId="insight-card-tokens"
				staggerIndex={1}
				label="Token 消耗 · 近7天"
				value={hasData ? formatCompact(totalTokens) : "—"}
				delta={hasData ? <DeltaChip delta={tokensDelta} /> : null}
				sparkline={hasData ? <Sparkline values={daily.tokens} /> : <div className="shimmer-line h-9 w-full" />}
				footer={hasData ? trendWord(tokensDelta) : "加载中…"}
			/>
			<InsightCard
				testId="insight-card-failures"
				staggerIndex={2}
				label="失败任务"
				value={String(failed)}
				delta={failed > 0 ? <span className="text-caption text-coral-2">需关注</span> : <span className="text-caption text-green">健康</span>}
				footer={
					retryable > 0 ? (
						<button
							type="button"
							onClick={() => onFilter("failed")}
							className="font-medium text-coral-2 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							筛选失败任务（{retryable} 可重试）
						</button>
					) : (
						"没有可重试的任务"
					)
				}
			/>
			<InsightCard
				testId="insight-card-queue"
				staggerIndex={3}
				label="队列状态"
				value={`${running} 生成中`}
				delta={<span className="text-caption text-ink-4 tabular-nums">{pending} 排队</span>}
				footer={
					running + pending > 0 ? (
						<button
							type="button"
							onClick={() => onFilter("running")}
							className="font-medium text-coral-2 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							查看处理中的任务
						</button>
					) : (
						"队列为空，全部处理完成"
					)
				}
			/>
		</section>
	);
}

export default SummaryInsightCards;
