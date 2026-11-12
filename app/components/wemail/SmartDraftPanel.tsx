// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowsOutCardinalIcon } from "@phosphor-icons/react/ArrowsOutCardinal";
import { DotsSixVerticalIcon } from "@phosphor-icons/react/DotsSixVertical";
import { PushPinIcon } from "@phosphor-icons/react/PushPin";
import { useEffect, useRef, useState } from "react";
import type {
	IntelligenceStatus,
	ReplyDecisionResult,
	ReplyDraftResult,
	WemailAddress,
} from "~/types/wemail";
import type { WemailDraftInput } from "../../../shared/wemail/mail";
import { AICard } from "./AICard";

export interface SmartDraftPanelProps {
	emailId: string;
	status: IntelligenceStatus | "not-needed";
	replyDraft?: ReplyDraftResult | null;
	replyDecision?: ReplyDecisionResult | null;
	/** Build the send payload when the user clicks Edit & Send. */
	buildDraft?: (bodyMarkdown: string) => WemailDraftInput | null;
	onAccept?: (bodyMarkdown: string) => void;
	onDelete?: () => void;
	onEditAndSend?: (bodyMarkdown: string) => void;
	/**
	 * Re-trigger the reply-draft pipeline. The parent's mutation should
	 * invalidate the intelligence query so this panel rerenders into its
	 * `pending` skeleton until the new draft lands.
	 */
	onRegenerate?: () => void;
	isRegenerating?: boolean;
	/** Called once when a draft first becomes available (for "generated" telemetry). */
	onGeneratedOnce?: (bodyMarkdown: string) => void;
	/**
	 * Floating mode controls. When provided, a drag handle and dock toggle
	 * appear in the panel header. The parent owns the floating-vs-docked
	 * rendering decision (this component just emits drag events).
	 */
	mode?: "docked" | "floating";
	position?: { x: number; y: number };
	onMove?: (x: number, y: number) => void;
	onUndock?: (initialX: number, initialY: number) => void;
	onDock?: () => void;
}

/**
 * Map SmartDraftPanel status to AICardState. The `skipped` state maps to
 * `empty`; `not-needed` is handled as a silent state before rendering.
 */
function toAICardState(
	status: IntelligenceStatus | "not-needed",
): "empty" | "pending" | "success" | "failed" {
	switch (status) {
		case "pending":
		case "running":
			return "pending";
		case "succeeded":
		case "not-needed":
			return "success";
		case "failed":
			return "failed";
		case "skipped":
			return "empty";
	}
}

/**
 * Reply draft panel below the message body. Reply decisions remain available
 * to the application, but a negative decision is intentionally not surfaced.
 *
 * - `pending|running`: skeleton
 * - `not-needed`: silent (render nothing)
 * - `succeeded`: editable textarea with Accept, Edit & Send, Delete
 * - `failed|skipped`: silent (render nothing)
 *
 * The panel NEVER auto-sends — sending is routed through the existing send
 * service by the parent callback.
 */
export default function SmartDraftPanel({
	status,
	replyDraft,
	replyDecision,
	buildDraft: _buildDraft,
	onAccept,
	onDelete,
	onEditAndSend,
	onRegenerate,
	isRegenerating,
	onGeneratedOnce,
	mode,
	position,
	onMove,
	onUndock,
	onDock,
}: SmartDraftPanelProps) {
	const initial = replyDraft?.draftMarkdown ?? "";
	const [body, setBody] = useState(initial);
	const [dirty, setDirty] = useState(false);

	useEffect(() => {
		if (!dirty) setBody(initial);
	}, [initial, dirty]);

	useEffect(() => {
		if (status === "succeeded" && replyDraft?.draftMarkdown) {
			onGeneratedOnce?.(replyDraft.draftMarkdown);
		}
		// We intentionally only fire on draft identity change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [replyDraft?.draftMarkdown, status]);

	/* Pointer-driven drag. Active only when mode==="floating".
	 * Records the offset between pointer and panel origin on pointerdown,
	 * then emits onMove(clientX - offset, clientY - offset) until release.
	 * Coordinates are clamped inside the viewport so the panel never
	 * disappears off-screen. */
	const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
	const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
		if (mode !== "floating" || !position) return;
		dragOffsetRef.current = {
			x: e.clientX - position.x,
			y: e.clientY - position.y,
		};
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
		const offset = dragOffsetRef.current;
		if (!offset || !onMove) return;
		const PANEL_W = 380;
		const PANEL_H = 200;
		const maxX =
			typeof window === "undefined" ? Infinity : window.innerWidth - PANEL_W;
		const maxY =
			typeof window === "undefined" ? Infinity : window.innerHeight - PANEL_H;
		const nextX = Math.max(0, Math.min(maxX, e.clientX - offset.x));
		const nextY = Math.max(0, Math.min(maxY, e.clientY - offset.y));
		onMove(nextX, nextY);
	};
	const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
		dragOffsetRef.current = null;
		if (e.currentTarget.hasPointerCapture(e.pointerId)) {
			e.currentTarget.releasePointerCapture(e.pointerId);
		}
	};

	const showDragControls = mode !== undefined;
	const dragControls = showDragControls ? (
		<div className="flex items-center gap-1 ml-auto shrink-0">
			{mode === "floating" ? (
				<button
					type="button"
					data-drag-handle
					data-testid="wemail-draft-drag"
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
					onPointerCancel={handlePointerUp}
					aria-label="拖动草稿面板"
					className="cursor-grab active:cursor-grabbing rounded p-0.5 text-ink-3 hover:text-ink touch-none"
				>
					<DotsSixVerticalIcon size={14} weight="bold" />
				</button>
			) : null}
			<button
				type="button"
				data-testid="wemail-draft-toggle-mode"
				onClick={() => {
					if (mode === "floating") {
						onDock?.();
					} else {
						const startX =
							typeof window === "undefined"
								? 0
								: Math.max(16, window.innerWidth - 420);
						const startY =
							typeof window === "undefined"
								? 0
								: Math.max(16, window.innerHeight - 320);
						onUndock?.(startX, startY);
					}
				}}
				aria-label={mode === "floating" ? "Dock to bottom" : "Float panel"}
				className="rounded p-0.5 text-ink-3 hover:text-ink"
			>
				{mode === "floating" ? (
					<PushPinIcon size={14} weight="regular" />
				) : (
					<ArrowsOutCardinalIcon size={14} weight="regular" />
				)}
			</button>
		</div>
	) : null;

	if (status === "pending" || status === "running") {
		return (
			<AICard
				variant="draft"
				state="pending"
				data-testid="wemail-draft-pending"
				header={dragControls}
			>
				<div className="animate-pulse space-y-2 motion-reduce:animate-none">
					<div className="h-3 w-1/3 rounded bg-paper-3" />
					<div className="h-20 w-full rounded bg-paper-3" />
				</div>
			</AICard>
		);
	}

	if (status === "not-needed") {
		return null;
	}

	// Silent failure for failed/skipped — show nothing
	if (status === "failed" || status === "skipped") {
		return null;
	}

	if (!replyDraft || !replyDraft.draftMarkdown) {
		return (
			<AICard
				variant="draft"
				state="empty"
				data-testid="wemail-draft-empty"
				header={dragControls}
			>
				<p className="text-xs text-ink-3">暂无回复草稿 / No draft yet</p>
			</AICard>
		);
	}

	return (
		<AICard
			variant="draft"
			state={toAICardState(status)}
			data-testid="wemail-draft-ready"
			header={
				<div className="flex items-center gap-2 w-full">
					<span className="text-xs font-semibold uppercase tracking-wide text-ink-3 shrink-0">
						回复草稿 / Smart draft
					</span>
					{replyDecision?.reason ? (
						<span className="text-xs text-ink-3 truncate">
							{replyDecision.reason}
						</span>
					) : null}
					{dragControls}
				</div>
			}
			actions={
				<>
					<button
						type="button"
						data-testid="wemail-draft-accept"
						onClick={() => onAccept?.(body)}
						disabled={isRegenerating}
						className="rounded border border-edge bg-paper-2 px-2 py-1 text-xs hover:bg-paper-3 disabled:opacity-50"
					>
						接受 / Accept
					</button>
					<button
						type="button"
						data-testid="wemail-draft-edit-send"
						onClick={() => onEditAndSend?.(body)}
						disabled={isRegenerating}
						className="min-h-9 rounded border border-green bg-green px-3 py-1 text-xs text-paper hover:opacity-90 disabled:opacity-50"
					>
						编辑并发送 / Edit &amp; Send
					</button>
					{onRegenerate ? (
						<button
							type="button"
							data-testid="wemail-draft-regenerate"
							onClick={() => {
								setDirty(false);
								onRegenerate();
							}}
							disabled={isRegenerating}
							className="inline-flex items-center gap-1 rounded border border-edge px-2 py-1 text-xs text-ink-2 hover:bg-paper-3 disabled:opacity-50"
							aria-label="重新生成草稿"
						>
							<ArrowClockwiseIcon
								size={12}
								className={isRegenerating ? "animate-spin motion-reduce:animate-none" : ""}
							/>
							{isRegenerating ? "生成中…" : "重新生成"}
						</button>
					) : null}
					<button
						type="button"
						data-testid="wemail-draft-delete"
						onClick={() => onDelete?.()}
						disabled={isRegenerating}
						className="min-h-9 rounded border border-red px-3 py-1 text-xs text-red hover:bg-red-bg disabled:opacity-50"
					>
						删除 / Delete
					</button>
				</>
			}
		>
			<textarea
				data-testid="wemail-draft-textarea"
				className="min-h-[8rem] w-full resize-y rounded border border-edge bg-paper-2 p-2 font-mono text-sm"
				value={body}
				onChange={(e) => {
					setBody(e.target.value);
					setDirty(true);
				}}
				aria-label="回复草稿"
			/>
		</AICard>
	);
}

export function buildReplyDraftInput(args: {
	accountId: string;
	originalEmailId?: string;
	threadId?: string;
	to: WemailAddress[];
	subject: string;
	bodyMarkdown: string;
}): WemailDraftInput {
	return {
		accountId: args.accountId,
		originalEmailId: args.originalEmailId,
		threadId: args.threadId,
		to: args.to,
		subject: args.subject,
		bodyText: args.bodyMarkdown,
		bodyHtml: `<pre>${escapeHtml(args.bodyMarkdown)}</pre>`,
	};
}

function escapeHtml(s: string) {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
