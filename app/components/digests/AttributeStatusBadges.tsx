// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { MinusCircleIcon } from "@phosphor-icons/react/MinusCircle";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import type { Icon } from "@phosphor-icons/react";
import type {
	IntelligenceAttributeKind,
	IntelligenceAttributeStatus,
	SummaryWorkState,
} from "shared/wemail/intelligence";
import { cn } from "~/lib/cn";

export const ATTRIBUTE_LABELS: Record<IntelligenceAttributeKind, string> = {
	summary: "摘要",
	tags: "标签",
	replyDecision: "回复判断",
	todoExtraction: "待办",
};

const ATTRIBUTE_ORDER: IntelligenceAttributeKind[] = [
	"summary",
	"tags",
	"replyDecision",
	"todoExtraction",
];

export function getAttributeBadge(state: SummaryWorkState): {
	label: string;
	Icon: Icon;
	className: string;
} {
	switch (state) {
		case "succeeded":
			return {
				label: "已完成",
				Icon: CheckCircleIcon,
				className: "text-green",
			};
		case "failed":
		case "invalid":
			return {
				label: state === "failed" ? "失败" : "无效",
				Icon: WarningCircleIcon,
				className: "text-coral",
			};
		case "pending":
			return {
				label: "排队中",
				Icon: ClockIcon,
				className: "text-blue",
			};
		case "running":
			return {
				label: "生成中",
				Icon: CircleNotchIcon,
				className: "text-blue",
			};
		case "skipped":
			return {
				label: "已跳过",
				Icon: MinusCircleIcon,
				className: "text-ink-3",
			};
		default:
			return {
				label: "未生成",
				Icon: MinusCircleIcon,
				className: "text-amber",
			};
	}
}

/** Compact per-attribute status summary for task rows. */
export function AttributeDots({
	attributes,
}: {
	attributes?: IntelligenceAttributeStatus[];
}) {
	if (!attributes || attributes.length === 0) return null;
	return (
		<div className="grid grid-cols-2 gap-1" aria-label="各属性生成状态">
			{ATTRIBUTE_ORDER.map((kind) => {
				const attribute = attributes.find((item) => item.kind === kind);
				if (!attribute) return null;
				const badge = getAttributeBadge(attribute.state);
				const Icon = badge.Icon;
				return (
					<span
						key={kind}
						title={`${ATTRIBUTE_LABELS[kind]}：${badge.label}`}
						aria-label={`${ATTRIBUTE_LABELS[kind]}：${badge.label}`}
						className={cn(
							"inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-edge bg-paper-2 px-2 text-xs font-medium leading-none",
							badge.className,
						)}
					>
						<Icon
							size={10}
							weight={attribute.state === "running" ? "bold" : "fill"}
							className={cn(
								"shrink-0",
								attribute.state === "running" && "animate-spin motion-reduce:animate-none",
							)}
							aria-hidden="true"
						/>
						<span className="truncate text-ink-2">{ATTRIBUTE_LABELS[kind]}</span>
					</span>
				);
			})}
		</div>
	);
}
