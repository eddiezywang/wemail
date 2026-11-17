// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type {
	EmailIntelligenceState,
	IntelligenceJobType,
	IntelligenceStatus as IntelligenceStatusValue,
} from "~/types/wemail";

export interface IntelligenceStatusProps {
	payload: EmailIntelligenceState | null | undefined;
	loading?: boolean;
	error?: unknown;
}

const LABEL: Record<IntelligenceJobType, string> = {
	summary: "摘要",
	tags: "标签",
	replyDecision: "决策",
	replyDraft: "草稿",
	todoExtraction: "待办",
	linkExtraction: "链接",
	translation: "翻译",
	composeMail: "撰写",
};

const STATUS_COLOR: Record<IntelligenceStatusValue, string> = {
	pending: "bg-paper-3 text-ink-3",
	running: "bg-amber-bg text-amber",
	succeeded: "bg-green-bg text-green",
	failed: "bg-red-bg text-red",
	skipped: "bg-paper-3 text-ink-3",
};

const STATUS_LABEL: Record<IntelligenceStatusValue, string> = {
	pending: "等待中",
	running: "处理中",
	succeeded: "完成",
	failed: "失败",
	skipped: "已跳过",
};

function deriveStatus(
	payload: EmailIntelligenceState | null | undefined,
	loading: boolean,
	error: unknown,
	kind: IntelligenceJobType,
): IntelligenceStatusValue {
	if (error) return "failed";
	if (!payload) return loading ? "pending" : "skipped";

	const capability =
		kind === "summary"
			? payload.summary
			: kind === "tags"
				? payload.tags
				: kind === "replyDecision"
					? payload.replyDecision
					: payload.replyDraft;

	// replyDraft can be "not-needed" which is not a valid IntelligenceStatus,
	// but for display purposes we map it to succeeded since the decision was made.
	if (kind === "replyDraft" && capability.status === "not-needed") {
		return "succeeded";
	}

	return capability.status as IntelligenceStatusValue;
}

/**
 * Compact status bar for the detail footer. One pill per processor
 * kind, derived from the same `useIntelligence` payload the cards
 * consume — no extra request.
 */
export default function IntelligenceStatus({
	payload,
	loading,
	error,
}: IntelligenceStatusProps) {
	const kinds: IntelligenceJobType[] = [
		"summary",
		"tags",
		"replyDecision",
		"replyDraft",
	];
	return (
		<div
			className="flex flex-wrap items-center gap-1.5 text-xs"
			data-testid="wemail-intelligence-status"
			aria-label="智能任务状态"
		>
			{kinds.map((k) => {
				const status = deriveStatus(payload, !!loading, error, k);
				return (
					<span
						key={k}
						data-testid={`wemail-status-${k}`}
						data-status={status}
						className={`rounded-full px-2 py-0.5 ${STATUS_COLOR[status]}`}
					>
						{LABEL[k]}: {STATUS_LABEL[status]}
					</span>
				);
			})}
		</div>
	);
}
