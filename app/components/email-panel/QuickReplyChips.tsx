// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ChatCircleIcon } from "@phosphor-icons/react/ChatCircle";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { useState } from "react";
import type { ReplyDraftVariant } from "~/types/wemail";

/**
 * Quick Reply recommendation card (approved design section 04).
 *
 * Renders the reply suggestion as a card instead of truncated pill chips:
 * a confidence meter (from the reply decision), a readable prose preview of
 * the selected variant, radio-style variant switching, and a single primary
 * "编辑并发送" action routed through the parent's `onSelect` (which opens
 * the composer prefilled — the panel never sends by itself).
 */
export interface QuickReplyChipsProps {
	variants?: ReplyDraftVariant[] | null;
	/** Reply-decision confidence in [0, 1], when available. */
	confidence?: number | null;
	onSelect: (variant: ReplyDraftVariant) => void;
}

function variantLabel(tone: string, length: string): string {
	const toneLabel =
		tone === "concise"
			? "简短"
			: tone === "friendly"
				? "友好"
				: tone === "neutral"
					? "中性"
					: tone;
	const lengthLabel = length === "short" ? "短" : length === "medium" ? "中" : length;
	return `${toneLabel} · ${lengthLabel}`;
}

function confidenceWord(confidence: number): string {
	if (confidence >= 0.75) return "较高";
	if (confidence >= 0.5) return "中";
	return "较低";
}

function prosePreview(markdown: string): string {
	return markdown.replace(/\s+/g, " ").trim();
}

export default function QuickReplyChips({
	variants,
	confidence,
	onSelect,
}: QuickReplyChipsProps) {
	const [selectedIdx, setSelectedIdx] = useState(0);
	const [dismissed, setDismissed] = useState(false);
	if (!variants || variants.length === 0 || dismissed) return null;
	const display = variants.slice(0, 3);
	const index = Math.min(selectedIdx, display.length - 1);
	const selected = display[index];
	const hasConfidence =
		typeof confidence === "number" && Number.isFinite(confidence);

	return (
		<div data-testid="wemail-quick-reply-chips" className="px-5 py-3">
			<section
				className="overflow-hidden rounded-xl border border-edge bg-paper-2 shadow-sm"
				aria-label="回复建议"
			>
				<header className="flex flex-wrap items-center gap-2.5 border-b border-edge bg-summary-surface px-3.5 py-2.5">
					<span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink">
						<SparkleIcon size={13} weight="fill" className="text-coral" />
						回复建议
					</span>
					{hasConfidence ? (
						<span
							className="inline-flex min-h-6 items-center gap-1.5 text-caption text-ink-3"
							aria-label={`置信度 ${Math.round(confidence * 100)}%，${confidenceWord(confidence)}`}
						>
							<span className="font-medium">置信度</span>
							<span className="h-1.5 w-16 overflow-hidden rounded-full bg-paper-3">
								<span
									className="block h-full rounded-full bg-coral"
									style={{ width: `${Math.max(4, Math.min(100, confidence * 100))}%` }}
								/>
							</span>
							<span className="tabular-nums font-semibold text-ink-2">
								{Math.round(confidence * 100)}%
							</span>
							<span className="text-coral-2 font-medium">{confidenceWord(confidence)}</span>
						</span>
					) : null}
					<ChatCircleIcon size={13} className="ml-auto text-ink-4" aria-hidden="true" />
				</header>

				<div className="px-3.5 py-3">
					<p
						className="line-clamp-3 text-sm leading-relaxed text-ink select-text"
						title={selected.draftMarkdown}
					>
						{prosePreview(selected.draftMarkdown)}
					</p>

					{display.length > 1 ? (
						<div className="mt-3 border-t border-dashed border-edge pt-2.5">
							<div className="mb-1.5 text-caption font-semibold tracking-wide text-ink-4">
								其他方案
							</div>
							<div
								className="flex flex-wrap gap-1.5"
								role="radiogroup"
								aria-label="回复方案"
							>
								{display.map((variant, idx) => {
									const active = idx === index;
									return (
										<button
											key={`${variant.tone}-${variant.length}-${idx}`}
											type="button"
											role="radio"
											aria-checked={active}
											onClick={() => setSelectedIdx(idx)}
											data-testid={`wemail-quick-reply-chip-${idx}`}
											aria-label={`回复方案：${variantLabel(variant.tone, variant.length)}`}
											className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/30 ${
												active
													? "border-coral/40 bg-coral-bg text-ink font-medium"
													: "border-edge bg-paper-2 text-ink-2 hover:bg-paper-3"
											}`}
										>
											<span
												className={`h-1.5 w-1.5 rounded-full ${active ? "bg-coral" : "bg-ink-4/50"}`}
												aria-hidden="true"
											/>
											{variantLabel(variant.tone, variant.length)}
											{active ? (
												<CheckIcon size={11} weight="bold" className="text-coral" />
											) : null}
										</button>
									);
								})}
							</div>
						</div>
					) : null}
				</div>

				<footer className="flex items-center justify-end gap-2 border-t border-edge bg-summary-surface px-3.5 py-2">
					<button
						type="button"
						onClick={() => setDismissed(true)}
						className="inline-flex min-h-9 items-center rounded-md px-3 text-xs text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						不用了
					</button>
					<button
						type="button"
						onClick={() => onSelect(selected)}
						data-testid="wemail-quick-reply-accept"
						className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-coral-2 px-3.5 text-xs font-medium text-paper-2 transition-colors hover:bg-coral-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						编辑并发送
					</button>
				</footer>
			</section>
		</div>
	);
}
