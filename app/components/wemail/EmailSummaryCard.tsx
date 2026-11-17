// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useState } from "react";
import type { IntelligenceStatus, SummaryResult } from "~/types/wemail";
import { AICard } from "./AICard";
import { Chip } from "./Chip";

export interface EmailSummaryCardProps {
	status: IntelligenceStatus;
	summary?: SummaryResult | null;
	errorMessage?: string;
	canRetry?: boolean;
	onRetry?: () => void;
}

const URGENCY_VARIANT: Record<SummaryResult["urgency"], "ink" | "amber" | "coral"> = {
	low: "ink",
	medium: "amber",
	high: "coral",
};

const URGENCY_LABEL: Record<SummaryResult["urgency"], string> = {
	low: "低",
	medium: "中",
	high: "高",
};

/**
 * Map IntelligenceStatus to AICardState. The `skipped` state maps to
 * `empty` so AICard renders the compact copy; `succeeded` maps to
 * `success`; `pending`/`running` both map to `pending`.
 */
function toAICardState(status: IntelligenceStatus): "empty" | "pending" | "success" | "failed" {
	switch (status) {
		case "pending":
		case "running":
			return "pending";
		case "succeeded":
			return "success";
		case "failed":
			return "failed";
		case "skipped":
			return "empty";
	}
}

/**
 * Compact summary card slotted below the message body. Renders one of
 * five states: pending/running (skeleton), succeeded (bullets +
 * action items + urgency chip), failed (error + retry affordance),
 * or skipped (compact message). Collapsible by default for skipped state.
 */
export default function EmailSummaryCard({
	status,
	summary,
	errorMessage,
	canRetry,
	onRetry,
}: EmailSummaryCardProps) {
	const [isExpanded, setIsExpanded] = useState(
		status === "succeeded" || status === "failed",
	);

	const toggleExpanded = () => setIsExpanded((prev) => !prev);

	const header =
		status === "succeeded" && summary ? (
			<div className="flex items-center justify-between w-full">
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={toggleExpanded}
						data-testid="wemail-summary-toggle"
						aria-label={isExpanded ? "Collapse summary / 收起摘要" : "Expand summary / 展开摘要"}
						className="rounded p-0.5 text-ink-3 hover:text-ink"
					>
						{isExpanded ? "▼" : "▶"}
					</button>
				</div>
				<Chip
					variant={URGENCY_VARIANT[summary.urgency]}
					label={URGENCY_LABEL[summary.urgency]}
					data-testid="wemail-urgency-pill"
				/>
			</div>
		) : (
			<button
				type="button"
				onClick={toggleExpanded}
				data-testid="wemail-summary-toggle"
				aria-label={isExpanded ? "Collapse summary / 收起摘要" : "Expand summary / 展开摘要"}
				className="rounded p-0.5 text-ink-3 hover:text-ink"
			>
				{isExpanded ? "▼" : "▶"}
			</button>
		);

	const actions =
		status === "failed" && canRetry && onRetry ? (
			<button
				type="button"
				onClick={onRetry}
				data-testid="wemail-summary-retry"
				className="rounded border border-edge px-2 py-1 text-xs hover:bg-paper-3"
			>
				重试 / Retry
			</button>
		) : undefined;

	return (
		<AICard
			variant="summary"
			state={toAICardState(status)}
			header={header}
			actions={actions}
			aria-label="智能摘要"
			data-testid="wemail-summary-card"
		>
			{isExpanded ? (
				<div data-testid="wemail-summary-content" className="select-text">
					{status === "pending" || status === "running" ? (
						<div
							className="space-y-1.5"
							data-testid="wemail-summary-pending"
						>
							<div className="shimmer-line h-2.5 w-5/6" />
							<div className="shimmer-line h-2.5 w-4/6" />
							<div className="shimmer-line h-2.5 w-3/6" />
						</div>
					) : null}

					{status === "failed" ? (
						<div className="space-y-2" data-testid="wemail-summary-failed">
							<p className="text-ink-2">
								摘要生成失败 / Summary failed
								{errorMessage ? ` — ${errorMessage}` : ""}
							</p>
						</div>
					) : null}

					{status === "skipped" ? (
						<p
							className="text-ink-3 text-xs"
							data-testid="wemail-summary-skipped"
						>
							摘要已跳过
							{errorMessage ? ` — ${errorMessage}` : ""}
						</p>
					) : null}

					{status === "succeeded" && summary ? (
						<div className="space-y-2" data-testid="wemail-summary-success">
							{summary.bullets.length > 0 ? (
								<ul className="list-disc space-y-1 pl-4">
									{summary.bullets.map((b, i) => (
										<li key={i} className="text-ink">
											{b}
										</li>
									))}
								</ul>
							) : null}
							{summary.actionItems.length > 0 ? (
								<div>
									<div className="text-xs font-semibold uppercase tracking-wide text-ink-3">
										待办
									</div>
									<ul className="mt-1 list-disc space-y-1 pl-4">
										{summary.actionItems.map((a, i) => (
											<li key={i} className="text-ink">
												{a}
											</li>
										))}
									</ul>
								</div>
							) : null}
						</div>
					) : null}
				</div>
			) : null}
		</AICard>
	);
}
