// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMemo, useState } from "react";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { XIcon } from "@phosphor-icons/react/X";
import type { IntelligenceStatus, TagResult } from "~/types/wemail";
import { CreateSmartTagDialog } from "./CreateSmartTagDialog";
import type { ContentTopicTag } from "shared/wemail/intelligence";

const SYSTEM_TAGS = [
	{ id: "important", label: "重要", key: "important" },
	{ id: "action_required", label: "待处理", key: "actionRequired" },
	{ id: "invoice", label: "发票", key: "invoice" },
] as const;

export interface EmailSmartTagsProps {
	status: IntelligenceStatus;
	tags?: TagResult | null;
	onConfirm?: (tag: string) => void;
	onReject?: (tag: string) => void;
	onSystemReject?: (classificationId: "important" | "action_required" | "invoice") => void;
	emailId?: string;
	accountId?: string;
}

/**
 * Inline tag strip for an email. Each tag chip carries a deterministic
 * color dot (HSL hashed from the tag name) so identical tags read the
 * same across the app without an explicit palette assignment.
 *
 * Tier semantics:
 * - `tier === "auto"`: solid chip, already applied. No buttons.
 * - `tier === "suggested"`: dashed chip with confirm + dismiss icon
 *   buttons. Buttons collapse on confirm/reject so the chip settles.
 *
 * Non-success states render nothing — tags appear only when analysis finishes.
 */
export default function EmailSmartTags({
	status,
	tags,
	onConfirm,
	onReject,
	onSystemReject,
	emailId,
	accountId,
}: EmailSmartTagsProps) {
	const [rejected, setRejected] = useState<Set<string>>(new Set());
	const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
	const [rejectedSystem, setRejectedSystem] = useState<Set<string>>(new Set());
	const [promotionCandidate, setPromotionCandidate] = useState<ContentTopicTag | null>(null);
	const [promoted, setPromoted] = useState<Map<string, string>>(new Map());

	if (status !== "succeeded") return null;

	if (!tags || (tags.tags.length === 0 && !(tags.contentTags?.length) && !SYSTEM_TAGS.some((item) => tags.system?.[item.key]?.matched))) {
		return (
			<div
				className="text-xs text-ink-3"
				data-testid="wemail-tags-empty"
			>
				暂无标签 / No tags
			</div>
		);
	}

	return (
		<>
		<div
			className="flex flex-wrap gap-1.5"
			data-testid="wemail-tags"
			aria-label="智能标签"
		>
			{SYSTEM_TAGS.map((item, index) => {
				const signal = tags.system?.[item.key];
				if (!signal?.matched || rejectedSystem.has(item.id)) return null;
				return (
					<button
						type="button"
						key={item.id}
						data-testid={`wemail-system-tag-${item.id}`}
						className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-coral/10 px-2.5 text-xs font-semibold text-coral"
						title={`系统分类 · ${signal.reason}${onSystemReject ? " · 点击移除" : ""}`}
						onClick={() => {
							if (!onSystemReject) return;
							setRejectedSystem((previous) => new Set(previous).add(item.id));
							onSystemReject(item.id);
						}}
						style={{ animation: `slide-in-up 280ms cubic-bezier(.2,.8,.2,1) ${index * 40}ms backwards` }}
					>
						<span aria-hidden className="h-1.5 w-1.5 rounded-full bg-coral" />
						{item.label}
						{onSystemReject ? <XIcon size={9} weight="bold" className="ml-0.5 opacity-60" /> : null}
					</button>
				);
			})}
			{tags.tags.map((t, idx) => (
				<TagChip
					key={t.name}
					tag={t}
					index={idx}
					isRejected={rejected.has(t.name)}
					isConfirmed={confirmed.has(t.name)}
					onConfirm={onConfirm ? () => {
						setConfirmed((prev) => new Set(prev).add(t.name));
						onConfirm(t.name);
					} : undefined}
					onReject={onReject ? () => {
						setRejected((prev) => new Set(prev).add(t.name));
						onReject(t.name);
					} : undefined}
				/>
			))}
			{(tags.contentTags ?? []).map((tag, index) => {
				const promotedName = promoted.get(candidateKey(tag));
				return promotedName ? (
					<span
						key={`content-${candidateKey(tag)}`}
						data-testid={`wemail-content-tag-${tag.name}`}
						className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-blue/20 bg-blue-bg px-2.5 text-xs font-medium text-blue"
						title={`已创建智能标签“${promotedName}”`}
					>
						<span aria-hidden className="h-1.5 w-1.5 rounded-full bg-blue" />
						{promotedName}
						<CheckIcon size={10} weight="bold" className="text-green" />
					</span>
				) : (
				<button
					key={`content-${tag.topicId ?? tag.name}`}
					data-testid={`wemail-content-tag-${tag.name}`}
					type="button"
					className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-paper-2/75 px-2.5 text-xs font-medium text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
					title={`AI 候选主题 · 置信度 ${formatConfidence(tag.confidence)} · 点击创建智能标签`}
					aria-label={`使用候选标签“${tag.name}”创建智能标签`}
					onClick={() => setPromotionCandidate(tag)}
					disabled={!emailId || !accountId}
					style={{ animation: `slide-in-up 280ms cubic-bezier(.2,.8,.2,1) ${(SYSTEM_TAGS.length + tags.tags.length + index) * 40}ms backwards` }}
				>
					<span aria-hidden className="h-1.5 w-1.5 rounded-sm border border-ink-3/60" />
					{tag.name}
					<PlusIcon aria-hidden size={10} weight="bold" className="opacity-70" />
				</button>
				);
			})}
		</div>
		{emailId && promotionCandidate ? (
			<CreateSmartTagDialog
				open={promotionCandidate !== null}
				onOpenChange={(open) => !open && setPromotionCandidate(null)}
				accountId={accountId}
				candidateSource={{ emailId, candidate: promotionCandidate }}
				onCreated={(tag) => {
					setPromoted((previous) => new Map(previous).set(candidateKey(promotionCandidate), tag.name));
				}}
			/>
		) : null}
		</>
	);
}

function candidateKey(tag: Pick<ContentTopicTag, "topicId" | "name">): string {
	return tag.topicId ?? tag.name.trim().toLocaleLowerCase();
}

function TagChip({
	tag,
	index,
	isRejected,
	isConfirmed,
	onConfirm,
	onReject,
}: {
	tag: { name: string; tier?: "auto" | "suggested"; confidence?: number };
	index: number;
	isRejected: boolean;
	isConfirmed: boolean;
	onConfirm?: () => void;
	onReject?: () => void;
}) {
	const dotColor = useMemo(() => tagDotColor(tag.name), [tag.name]);

	if (isRejected) {
		return (
			<span
				data-testid={`wemail-tag-${tag.name}`}
				className="inline-flex items-center gap-1.5 rounded-full border border-edge px-2 py-0.5 text-xs text-ink-3 opacity-40"
				style={{ animationDelay: `${index * 30}ms` }}
			>
				<TagDot color={dotColor} muted />
				<span>{tag.name}</span>
			</span>
		);
	}

	const isAuto = tag.tier === "auto";
	const baseClass =
		"group/chip relative inline-flex h-[26px] items-center gap-1.5 rounded-full px-2.5 text-xs font-medium leading-none transition-colors";

	const animationStyle = {
		animation: `slide-in-up 280ms cubic-bezier(.2,.8,.2,1) ${index * 40}ms backwards`,
	} as const;

	if (isAuto) {
		return (
			<span
				data-testid={`wemail-tag-${tag.name}`}
				className={`${baseClass} border border-blue/20 bg-blue-bg text-blue hover:border-blue/40`}
				style={animationStyle}
				title={`已应用 — 置信度 ${formatConfidence(tag.confidence)}`}
			>
				<TagDot color={dotColor} />
				<span>{tag.name}</span>
			</span>
		);
	}

	if (isConfirmed) {
		return (
			<span
				data-testid={`wemail-tag-${tag.name}`}
				className={`${baseClass} border border-blue/20 bg-blue-bg text-blue`}
				style={animationStyle}
				title="已确认"
			>
				<TagDot color={dotColor} />
				<span>{tag.name}</span>
				<CheckIcon
					size={10}
					weight="bold"
					className="text-green ml-0.5"
				/>
			</span>
		);
	}

	// Suggested-tier with hover-revealed actions.
	return (
		<span
			data-testid={`wemail-tag-${tag.name}`}
			className={`${baseClass} bg-paper-2/75 text-ink-2 hover:bg-paper-2`}
			style={animationStyle}
			title={`AI 建议 — 置信度 ${formatConfidence(tag.confidence)}`}
		>
			<TagDot color={dotColor} muted />
			<span>{tag.name}</span>
			{onConfirm || onReject ? (
				<span className="-mr-1 ml-0.5 inline-flex items-center opacity-60 transition-opacity group-hover/chip:opacity-100">
					{onConfirm ? (
						<button
							type="button"
							aria-label={`Confirm tag ${tag.name}`}
							data-testid={`wemail-tag-confirm-${tag.name}`}
							onClick={onConfirm}
							className="-m-2 inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-green/15 hover:text-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<CheckIcon size={9} weight="bold" />
						</button>
					) : null}
					{onReject ? (
						<button
							type="button"
							aria-label={`Reject tag ${tag.name}`}
							data-testid={`wemail-tag-reject-${tag.name}`}
							onClick={onReject}
							className="-m-2 inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-coral/15 hover:text-coral focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<XIcon size={9} weight="bold" />
						</button>
					) : null}
				</span>
			) : null}
		</span>
	);
}

function TagDot({ color, muted }: { color: string; muted?: boolean }) {
	return (
		<span
			aria-hidden
			className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
			style={{
				backgroundColor: color,
				opacity: muted ? 0.55 : 1,
			}}
		/>
	);
}

/**
 * Deterministic color for a tag name. Maps the tag string into a
 * Stone-friendly HSL space — slightly desaturated, mid-lightness so
 * the dot reads against both paper-2 and paper-3 backgrounds without
 * fighting the page palette.
 */
function tagDotColor(name: string): string {
	const norm = name.trim().toLowerCase();
	let hash = 0;
	for (let i = 0; i < norm.length; i += 1) {
		hash = (hash * 31 + norm.charCodeAt(i)) | 0;
	}
	const hue = Math.abs(hash) % 360;
	return `hsl(${hue} 58% 52%)`;
}

function formatConfidence(c: number | undefined): string {
	if (typeof c !== "number") return "—";
	return `${Math.round(c * 100)}%`;
}
