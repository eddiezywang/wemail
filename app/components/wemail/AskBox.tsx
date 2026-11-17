// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArrowUpIcon } from "@phosphor-icons/react/ArrowUp";
import { type KeyboardEvent, useCallback, useState } from "react";
import { Textarea } from "~/components/ui/textarea";
import { useImeComposition } from "~/hooks/useImeComposition";
import { cn } from "~/lib/cn";

export interface AskBoxProps {
	onSubmit: (text: string) => void | Promise<void>;
	placeholder?: string;
	loading?: boolean;
	className?: string;
}

/**
 * AskBox — IME-safe single-line-feeling agent input.
 *
 * Behavior contract:
 * - Enter submits ONLY when not composing and not loading. We read
 *   `imeComposingRef.current` (the synchronous ref returned as
 *   `isComposingRef`) inside the keydown handler, mirroring the pattern in
 *   `useComposeForm.ts`. State-based `isComposing` is unsafe inside the same
 *   event tick on Chromium macOS Pinyin and several Android IMEs.
 * - Shift+Enter is left alone — the browser inserts a newline.
 * - Submit payload is the textarea value verbatim (no trim).
 *   We only short-circuit when the *trimmed* value is empty.
 *
 * Visual: pill container (`bg-paper-2 border border-edge rounded-full`)
 * with a circular send button on the right.
 */
export function AskBox({
	onSubmit,
	placeholder,
	loading,
	className,
}: AskBoxProps) {
	const [value, setValue] = useState("");
	const ime = useImeComposition();
	const imeComposingRef = ime.isComposingRef;

	const submit = useCallback(() => {
		if (loading) return;
		if (!value.trim()) return;
		const payload = value;
		setValue("");
		void Promise.resolve(onSubmit(payload));
	}, [loading, onSubmit, value]);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key !== "Enter") return;
			if (event.shiftKey) return;
			if (imeComposingRef.current) return;
			if (loading) return;
			event.preventDefault();
			submit();
		},
		[imeComposingRef, loading, submit],
	);

	const canSubmit = !loading && value.trim().length > 0;

	return (
		<div
			data-testid="ask-box"
			className={cn(
				"flex items-end gap-1.5 rounded-2xl border border-edge bg-paper-2 px-3 py-2 focus-within:border-coral focus-within:ring-2 focus-within:ring-coral-bg",
				className,
			)}
		>
			<Textarea
				data-testid="ask-box-input"
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={handleKeyDown}
				onCompositionStart={ime.onCompositionStart}
				onCompositionEnd={ime.onCompositionEnd}
				placeholder={placeholder}
				rows={1}
				aria-label="向 Agent 提问"
				disabled={loading}
				className="min-h-9 max-h-32 resize-none border-0 bg-transparent px-1 py-2 text-xs shadow-none focus-visible:ring-0"
			/>
			<button
				type="button"
				data-testid="ask-box-submit"
				onClick={submit}
				disabled={!canSubmit}
				aria-label="发送"
				className={cn(
					"shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors",
					canSubmit
						? "bg-coral text-paper-2 hover:bg-coral-2"
						: "bg-paper-3 text-ink-4 cursor-not-allowed",
				)}
			>
				<ArrowUpIcon size={14} weight="bold" />
			</button>
		</div>
	);
}

export default AskBox;
