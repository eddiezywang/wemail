// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { SummaryHealthStatus } from "shared/wemail/intelligence";
import type { UsageCategory, UsageTimeseriesGranularity } from "shared/wemail/usage";
import { useUsageTimeseries } from "~/queries/usageStats";

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

const CATEGORY_COLORS: Record<UsageCategory, string> = {
	summary: "#3b82f6",
	agent_chat: "#8b5cf6",
	compose: "#ec4899",
	todo: "#f59e0b",
	translation: "#10b981",
	automation: "#ef4444",
	other: "#64748b",
};

const WINDOW_OPTIONS: Record<
	UsageTimeseriesGranularity,
	Array<{ value: number; label: string }>
> = {
	minute: [
		{ value: 60, label: "近1小时" },
		{ value: 120, label: "近2小时" },
		{ value: 360, label: "近6小时" },
	],
	hour: [
		{ value: 24, label: "近1天" },
		{ value: 48, label: "近2天" },
		{ value: 168, label: "近7天" },
	],
};

type Tone = "default" | "success" | "danger" | "warning";

const toneClass: Record<Tone, string> = {
	default: "text-ink",
	success: "text-green",
	danger: "text-coral",
	warning: "text-amber",
};

function formatCompact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

const visuallyHidden: CSSProperties = {
	position: "absolute",
	width: 1,
	height: 1,
	padding: 0,
	margin: -1,
	overflow: "hidden",
	clip: "rect(0 0 0 0)",
	whiteSpace: "nowrap",
	border: 0,
};

/** Read a live design token so the canvas tracks the active theme (light/dark). */
function readToken(name: string, fallback: string): string {
	if (typeof window === "undefined") return fallback;
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim();
	return value || fallback;
}

function KpiStat({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
	return (
		<div className="min-w-0">
			<div className="truncate text-xs font-medium text-ink-4">{label}</div>
			<div className={`mt-1 text-lg font-semibold leading-none tabular-nums ${toneClass[tone ?? "default"]}`}>
				{value}
			</div>
		</div>
	);
}

function KpiGroup({
	label,
	children,
	className,
}: {
	label: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={`flex flex-col gap-2 px-4 py-3 ${className ?? ""}`}>
			<div className="text-xs font-medium text-ink-4">{label}</div>
			<div className="flex flex-wrap gap-x-5 gap-y-2">{children}</div>
		</div>
	);
}

function Segmented<T extends string>({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: Array<{ value: T; label: string }>;
	value: T;
	onChange: (value: T) => void;
}) {
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className="inline-flex rounded-lg border border-edge bg-paper-3 p-0.5"
		>
			{options.map((opt) => {
				const active = value === opt.value;
				return (
					<button
						key={opt.value}
						type="button"
						role="radio"
						aria-checked={active}
						onClick={() => onChange(opt.value)}
						className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
							active ? "bg-paper text-ink shadow-sm" : "text-ink-3 hover:text-ink"
						}`}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}

export interface SummaryThroughputPanelProps {
	accountId: string | undefined;
	health?: SummaryHealthStatus;
}

export function SummaryThroughputPanel({
	accountId,
	health,
}: SummaryThroughputPanelProps) {
	const [granularity, setGranularity] = useState<UsageTimeseriesGranularity>(
		"minute",
	);
	const [range, setRange] = useState<number>(120);
	const [metric, setMetric] = useState<"tokens" | "calls">("tokens");

	const timeseries = useUsageTimeseries(accountId, granularity, range);
	const data = timeseries.data;

	function changeGranularity(next: UsageTimeseriesGranularity) {
		setGranularity(next);
		setRange(next === "minute" ? 120 : 24);
	}

	const chartRef = useRef<HTMLDivElement>(null);
	const chartInstance = useRef<echarts.ECharts | null>(null);

	useEffect(() => {
		if (!chartRef.current) return;
		const inst = echarts.init(chartRef.current);
		chartInstance.current = inst;
		const ro = new ResizeObserver(() => inst.resize());
		ro.observe(chartRef.current);
		return () => {
			ro.disconnect();
			inst.dispose();
			chartInstance.current = null;
		};
	}, []);

	// Re-theme the canvas when the active theme (class/data-theme on <html>) flips.
	const [themeTick, bumpTheme] = useState(0);
	useEffect(() => {
		const el = document.documentElement;
		const obs = new MutationObserver(() => bumpTheme((n) => n + 1));
		obs.observe(el, { attributes: true, attributeFilter: ["class", "data-theme"] });
		return () => obs.disconnect();
	}, []);

	const axisColor = readToken("--color-ink-3", "#705c49");
	const gridlineColor = readToken("--color-edge", "#e2d9c6");

	const option = useMemo(() => {
		const series = data?.series ?? [];
		const buckets = data?.buckets ?? [];
		return {
			tooltip: {
				trigger: "axis",
				axisPointer: { type: "line" },
				confine: true,
				backgroundColor: readToken("--color-paper-2", "#fbf8f1"),
				borderColor: readToken("--color-edge", "#e2d9c6"),
				borderWidth: 1,
				padding: [6, 8],
				textStyle: {
					color: readToken("--color-ink", "#2a1f14"),
					fontSize: 11,
				},
				formatter: (params: unknown) => {
					const arr = (Array.isArray(params) ? params : [params]) as Array<{
						value: number;
						seriesName: string;
						marker: string;
						axisValueLabel: string;
					}>;
					const rows = arr.filter((p) => Number(p.value) > 0);
					if (rows.length === 0) return "";
					const header = rows[0].axisValueLabel;
					const lines = rows.map(
						(p) => `${p.marker}${p.seriesName}  ${formatCompact(Number(p.value))}`,
					);
					return [header, ...lines].join("<br/>");
				},
			} as const,
			grid: { left: 44, right: 16, top: 12, bottom: 24 },
			xAxis: {
				type: "category",
				boundaryGap: false,
				data: buckets,
				axisLabel: { hideOverlap: true, fontSize: 10, color: axisColor },
				axisLine: { lineStyle: { color: gridlineColor } },
			} as const,
			yAxis: {
				type: "value",
				axisLabel: {
					fontSize: 10,
					color: axisColor,
					formatter: (v: number) => formatCompact(v),
				},
				splitLine: { lineStyle: { color: gridlineColor } },
			} as const,
			series: series.map((s) => ({
				name: s.label,
				type: "line",
				stack: metric,
				smooth: true,
				showSymbol: false,
				areaStyle: { opacity: 0.18 },
				lineStyle: { width: 1.5 },
				itemStyle: { color: CATEGORY_COLORS[s.category] ?? "#64748b" },
				data: metric === "tokens" ? s.tokens : s.calls,
			})),
		};
	}, [data, metric, axisColor, gridlineColor, themeTick]);

	useEffect(() => {
		chartInstance.current?.setOption(option, true);
	}, [option]);

	const taskBreakdown = useMemo(() => {
		const series = data?.series ?? [];
		return series
			.map((s) => ({
				label: s.label,
				category: s.category,
				calls: s.calls.reduce((a, b) => a + b, 0),
				tokens: s.tokens.reduce((a, b) => a + b, 0),
			}))
			.sort((a, b) => b.calls - a.calls);
	}, [data]);
	const maxCalls = Math.max(1, ...taskBreakdown.map((t) => t.calls));

	const bucketCount = data?.buckets.length ?? 1;
	const avgPerBucket = data
		? metric === "tokens"
			? data.totals.tokens / Math.max(1, bucketCount)
			: data.totals.calls / Math.max(1, bucketCount)
		: 0;
	const bucketUnit = granularity === "minute" ? "min" : "h";
	const isError = timeseries.isError;

	// Screen-reader summary: the canvas carries no AT-readable data, so mirror it here.
	const srSummary = [
		`总邮件 ${health?.total ?? "未知"}，已完成 ${health?.succeeded ?? "未知"}`,
		`队列：排队中 ${health?.pending ?? 0}，生成中 ${health?.running ?? 0}`,
		`异常：失败 ${health?.failed ?? 0}，可重试 ${health?.retryable ?? 0}`,
		data
			? `窗口${metric === "tokens" ? " Token" : "调用"} ${formatCompact(
					metric === "tokens" ? data.totals.tokens : data.totals.calls,
				)}，平均每${bucketUnit} ${formatCompact(Math.round(avgPerBucket))}`
			: "",
	].join("。");

	return (
		<section
			aria-label="智能处理吞吐监控"
			className="flex flex-col gap-3 overflow-hidden rounded-xl border border-edge bg-paper-2"
		>
			<p style={visuallyHidden}>{srSummary}</p>

			<div className="grid grid-cols-3 border-b border-edge">
				<KpiGroup label="规模">
					<KpiStat
						label="总邮件"
						value={health?.total == null ? "-" : formatCompact(health.total)}
					/>
					<KpiStat
						label="已完成"
						value={health?.succeeded == null ? "-" : formatCompact(health.succeeded)}
						tone="success"
					/>
				</KpiGroup>
				<KpiGroup label="队列" className="border-x border-edge">
					<KpiStat
						label="排队中"
						value={health?.pending == null ? "-" : formatCompact(health.pending)}
					/>
					<KpiStat
						label="生成中"
						value={health?.running == null ? "-" : formatCompact(health.running)}
					/>
				</KpiGroup>
				<KpiGroup label="异常">
					<KpiStat
						label="失败"
						value={health?.failed == null ? "-" : formatCompact(health.failed)}
						tone="danger"
					/>
					<KpiStat
						label="可重试"
						value={health?.retryable == null ? "-" : formatCompact(health.retryable)}
						tone="warning"
					/>
				</KpiGroup>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-1">
				<div className="flex flex-wrap items-center gap-2">
					<Segmented
						label="时间粒度"
						options={[
							{ value: "minute", label: "按分钟" },
							{ value: "hour", label: "按小时" },
						]}
						value={granularity}
						onChange={changeGranularity}
					/>
					<select
						aria-label="监控窗口"
						value={range}
						onChange={(e) => setRange(Number(e.target.value))}
						className="h-8 rounded-lg border border-edge bg-paper-3 px-2 text-xs font-medium text-ink outline-none hover:bg-paper-4 focus:border-coral"
					>
						{WINDOW_OPTIONS[granularity].map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
				</div>
				<Segmented
					label="吞吐指标"
					options={[
						{ value: "tokens", label: "Token" },
						{ value: "calls", label: "调用数" },
					]}
					value={metric}
					onChange={setMetric}
				/>
			</div>

			<div className="flex items-center justify-between px-4 text-xs text-ink-3">
				<span className="font-medium">吞吐趋势</span>
				{data && !isError && (
					<span className="tabular-nums">
						窗口 {formatCompact(metric === "tokens" ? data.totals.tokens : data.totals.calls)}
						{" · "}平均 {formatCompact(Math.round(avgPerBucket))}/{bucketUnit}
					</span>
				)}
			</div>

			<div className="relative px-4">
				<div ref={chartRef} className="h-[240px] w-full" aria-hidden="true" />
				{isError && (
					<div className="absolute inset-x-4 inset-y-0 flex flex-col items-center justify-center gap-2 rounded-lg bg-paper-2/95 text-xs text-ink-3">
						<span>吞吐数据加载失败</span>
						<button
							type="button"
							onClick={() => timeseries.refetch()}
							className="rounded-md border border-edge bg-paper px-3 py-1 text-xs font-medium text-ink hover:bg-paper-3"
						>
							重试
						</button>
					</div>
				)}
			</div>

			<div className="border-t border-edge px-4 py-3">
				<div className="mb-2 text-xs font-medium text-ink-3">
					任务类型分布（窗口内调用数）
				</div>
				{isError ? (
					<div className="py-2 text-center text-xs text-ink-3">分布数据加载失败</div>
				) : taskBreakdown.length === 0 ? (
					<div className="py-4 text-center text-xs text-ink-3">
						{timeseries.isLoading ? "加载中…" : "暂无 AI 调用记录"}
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						{taskBreakdown.map((t) => (
							<div key={t.category} className="flex items-center gap-3">
								<span className="w-16 shrink-0 truncate text-xs text-ink-2">
									{t.label}
								</span>
								<div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-paper-4">
									<div
										className="h-full rounded-full"
										style={{
											width: `${(t.calls / maxCalls) * 100}%`,
											backgroundColor: CATEGORY_COLORS[t.category] ?? "#64748b",
										}}
									/>
								</div>
								<span className="w-10 shrink-0 text-right text-xs tabular-nums text-ink-3">
									{t.calls}
								</span>
							</div>
						))}
					</div>
				)}
			</div>
		</section>
	);
}

export default SummaryThroughputPanel;
