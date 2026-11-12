// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Floating inline AI prompt + accept/discard pill.
 *
 * Anchored to the rewrite range relative to the editor root. Two
 * sub-views switch off the streaming state:
 *
 *   - idle / streaming / error → instruction input + submit
 *   - done → "Accept · Try again · Discard" pill
 *
 * Esc cancels at any time. The component never owns its own state —
 * it is purely a view of the `useInlineAi` hook.
 */

import { useEffect, useRef } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { XIcon } from "@phosphor-icons/react/X";
import type { InlineAiState } from "./useInlineAi";

interface InlineAiPromptProps {
	state: InlineAiState;
	onChangeInstruction: (value: string) => void;
	onSubmit: () => void;
	onCancel: () => void;
	onAccept: () => void;
	onDiscard: () => void;
	onTryAgain: () => void;
}

export function InlineAiPrompt({
	state,
	onChangeInstruction,
	onSubmit,
	onCancel,
	onAccept,
	onDiscard,
	onTryAgain,
}: InlineAiPromptProps) {
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (state.isOpen && state.status !== "done") {
			// Defer focus until the popover is in the DOM.
			const id = requestAnimationFrame(() => inputRef.current?.focus());
			return () => cancelAnimationFrame(id);
		}
	}, [state.isOpen, state.status]);

	if (!state.isOpen || !state.anchor) return null;

	const baseStyle: React.CSSProperties = {
		position: "absolute",
		top: state.anchor.top,
		left: `clamp(8px, ${state.anchor.left}px, calc(100% - 288px))`,
		width: `min(max(${state.anchor.width}px, 280px), calc(100% - 16px))`,
		maxWidth: "calc(100% - 16px)",
		maxHeight: "calc(100% - 16px)",
		overflow: "auto",
	};

	if (state.status === "done") {
		return (
			<div
				role="dialog"
				aria-label="AI 改写操作"
				data-testid="inline-ai-pill"
				style={baseStyle}
				className="z-40 flex items-center gap-1 rounded-full border border-edge bg-paper-2 px-1.5 py-1 shadow-[var(--shadow-2)] text-xs"
			>
				<button
					type="button"
					onClick={onAccept}
					className="inline-flex items-center gap-1 rounded-full bg-coral px-2.5 py-1 text-paper hover:opacity-90"
					data-testid="inline-ai-accept"
				>
					<CheckIcon size={12} weight="bold" />
					接受
				</button>
				<button
					type="button"
					onClick={onTryAgain}
					className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-ink-2 hover:bg-paper-3"
					data-testid="inline-ai-try-again"
				>
					<ArrowClockwiseIcon size={12} />
					重试
				</button>
				<button
					type="button"
					onClick={onDiscard}
					className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-ink-2 hover:bg-paper-3"
					data-testid="inline-ai-discard"
				>
					<XIcon size={12} />
					恢复原文
				</button>
			</div>
		);
	}

	const isStreaming = state.status === "streaming";

	return (
		<div
			role="dialog"
			aria-label="AI 改写提示"
			data-testid="inline-ai-prompt"
			style={baseStyle}
			className="z-40 flex flex-col gap-1 rounded-lg border border-edge bg-paper-2 p-2 shadow-[var(--shadow-2)] motion-safe:animate-[overlay-enter_120ms_ease-out]"
		>
			<div className="flex items-center gap-2">
				<SparkleIcon size={14} weight="fill" className="text-coral" />
				<input
					ref={inputRef}
					type="text"
					value={state.instruction}
					onChange={(e) => onChangeInstruction(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							e.preventDefault();
							onCancel();
						} else if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							if (!isStreaming && state.instruction.trim()) onSubmit();
						}
					}}
					placeholder="告诉 AI 如何改写所选内容…"
					disabled={isStreaming}
					data-testid="inline-ai-input"
					className="flex-1 bg-transparent text-xs text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-60"
				/>
				<button
					type="button"
					onClick={onCancel}
					className="text-ink-3 hover:text-ink"
					aria-label="取消并恢复原文"
					title="Esc"
				>
					<XIcon size={12} />
				</button>
			</div>
			{isStreaming ? (
				<div className="flex items-center gap-1.5 text-xs text-ink-3">
					<span className="inline-block h-2 w-2 animate-pulse rounded-full bg-coral motion-reduce:animate-none" />
					正在改写…
				</div>
			) : null}
			{state.error ? (
				<div className="text-xs text-red" role="alert">
					{state.error}
				</div>
			) : null}
		</div>
	);
}
