// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useState } from "react";
import type {
	SummaryHealthStatus,
	SummaryRetryMode,
} from "shared/wemail/intelligence";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";

const DEFAULT_COUNT = 500;
const MAX_COUNT = 2000;

function formatCompact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function clampCount(n: number): number {
	if (!Number.isFinite(n) || n <= 0) return 1;
	return Math.min(Math.floor(n), MAX_COUNT);
}

interface ScopeOption {
	mode: SummaryRetryMode;
	title: string;
	desc: string;
	count: number;
}

export interface SummaryRetryDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	health?: SummaryHealthStatus;
	isRetrying: boolean;
	onConfirm: (mode: SummaryRetryMode, limit: number) => void;
}

/**
 * Retry-scope dialog. Replaces the blind "一键入队 500" action with an
 * explicit, transparent choice: scope, manually-controlled count (default 500),
 * and a live preview of how many will actually enqueue. Defaults to never-tried
 * (missing) mail — newest first — so repeatedly-failed items no longer auto-
 * enter the pool.
 */
export function SummaryRetryDialog({
	open,
	onOpenChange,
	health,
	isRetrying,
	onConfirm,
}: SummaryRetryDialogProps) {
	const [mode, setMode] = useState<SummaryRetryMode>("missing");
	const [count, setCount] = useState(DEFAULT_COUNT);

	const missing = health?.missing ?? 0;
	const failed = health?.failed ?? 0;
	const invalid = health?.invalid ?? 0;
	const options: ScopeOption[] = [
		{
			mode: "missing",
			title: "从没跑过（最新优先）",
			desc: "从未生成过智能摘要的邮件",
			count: missing,
		},
		{
			mode: "failed",
			title: "失败的任务",
			desc: "已尝试但失败的邮件",
			count: failed,
		},
		{
			mode: "all",
			title: "全部",
			desc: "失败 + 未生成 + 空/无效",
			count: failed + missing + invalid,
		},
	];

	const selected = options.find((o) => o.mode === mode) ?? options[0];
	const willEnqueue = Math.min(selected.count, count);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>重新入队智能处理</DialogTitle>
					<DialogDescription>
						选择范围与数量，按收信时间最新优先选取。
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-2">
					{options.map((opt) => {
						const active = opt.mode === mode;
						const enqueue = Math.min(opt.count, count);
						return (
							<label
								key={opt.mode}
								className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
									active
										? "border-coral bg-coral-bg/20"
										: "border-edge hover:bg-paper-3"
								}`}
							>
								<input
									type="radio"
									name="retry-mode"
									className="mt-0.5 h-4 w-4 accent-[var(--color-coral)]"
									checked={active}
									onChange={() => setMode(opt.mode)}
								/>
								<div className="min-w-0 flex-1">
									<div className="text-sm font-medium text-ink">{opt.title}</div>
									<div className="text-xs text-ink-3">{opt.desc}</div>
								</div>
								<div className="shrink-0 text-right text-xs tabular-nums text-ink-3">
									<div>{formatCompact(opt.count)} 封</div>
									<div className="text-ink-4">→ 入队 {enqueue}</div>
								</div>
							</label>
						);
					})}
				</div>

				<label className="flex items-center justify-between gap-3 rounded-lg border border-edge p-3">
					<span className="min-w-0">
						<span className="block text-sm font-medium text-ink">入队数量</span>
						<span className="block text-xs text-ink-3">
							每次最多入队的邮件数（1–{MAX_COUNT}）
						</span>
					</span>
					<input
						type="number"
						min={1}
						max={MAX_COUNT}
						value={count}
						onChange={(e) => setCount(clampCount(Number.parseInt(e.target.value, 10)))}
						className="h-9 w-24 shrink-0 rounded-lg border border-edge bg-paper-3 px-3 text-right text-sm tabular-nums text-ink outline-none focus:border-coral"
					/>
				</label>

				<DialogFooter>
					<Button
						variant="secondary"
						onClick={() => onOpenChange(false)}
						disabled={isRetrying}
					>
						取消
					</Button>
					<Button
						onClick={() => onConfirm(mode, count)}
						disabled={isRetrying || willEnqueue === 0}
					>
						{isRetrying ? "正在入队…" : willEnqueue === 0 ? "无可入队" : `入队 ${willEnqueue}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export default SummaryRetryDialog;
