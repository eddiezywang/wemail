// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Inline AI rewrite hook for the TipTap editor.
 *
 * Drives a Cmd/Ctrl-K mini prompt that takes the user's selected text
 * plus a free-form instruction, streams a rewrite from the agent endpoint
 * (`api.streamAgentChat`), and live-replaces the selection in place.
 *
 * The agent runtime can return tool calls / thinking events; we ignore
 * those and only consume `assistant_text` deltas. We bake a "rewrite
 * only the selected text" preamble into the userText so the agent does
 * not try to look up emails or call tools.
 *
 * Replacement strategy: we capture the ProseMirror range when the prompt
 * opens. Each streamed delta replaces `[from, to]` with the latest
 * accumulated text and updates `to` to point at the end of the new text.
 * This way undo (`Ctrl+Z`) collapses the rewrite back to the original
 * selection in a single step instead of N partial steps — we wrap each
 * incremental replace in `meta('addToHistory', false)` for all but the
 * first one.
 */

import type { Editor } from "@tiptap/react";
import type { Slice } from "@tiptap/pm/model";
import { useCallback, useEffect, useRef, useState } from "react";
import api, { type AgentEvent } from "~/services/api";
import { getUserFacingError } from "~/lib/user-facing-error";

export type InlineAiStatus = "idle" | "streaming" | "done" | "error";

export interface InlineAiState {
	isOpen: boolean;
	status: InlineAiStatus;
	instruction: string;
	error: string | null;
	/** Pixel-accurate anchor for the prompt / Accept-Discard pill. */
	anchor: { top: number; left: number; width: number } | null;
	/** ProseMirror range currently owned by the rewrite (post-stream). */
	range: { from: number; to: number } | null;
}

const SYSTEM_PREAMBLE =
	"You are an inline writing assistant. Rewrite ONLY the user-provided " +
	"text following the user's instruction. Reply with the rewritten text " +
	"only, no preamble, no quotes, no markdown fences.";

function getSelectionAnchor(
	editor: Editor,
): { top: number; left: number; width: number } | null {
	const { from, to } = editor.state.selection;
	if (from === to) return null;
	try {
		const start = editor.view.coordsAtPos(from);
		const end = editor.view.coordsAtPos(to);
		const rootEl = editor.view.dom.closest(
			"[data-editor-root]",
		) as HTMLElement | null;
		const rootRect = rootEl?.getBoundingClientRect();
		const top =
			(rootRect ? end.bottom - rootRect.top : end.bottom) + 6;
		const left = rootRect
			? Math.min(start.left, end.left) - rootRect.left
			: Math.min(start.left, end.left);
		const width = Math.max(120, Math.abs(end.right - start.left));
		return { top, left, width };
	} catch {
		return null;
	}
}

function selectionTouchesSignature(editor: Editor, from: number, to: number) {
	let touchesSignature = false;
	const { doc } = editor.state;
	doc.nodesBetween(from, to, (node) => {
		if (node.type.name === "signatureBlock" || node.type.name === "signatureBrand") {
			touchesSignature = true;
		}
	});

	for (const position of [from, to]) {
		const resolved = doc.resolve(position);
		for (let depth = resolved.depth; depth >= 0; depth -= 1) {
			const node = resolved.node(depth);
			if (node.type.name === "signatureBlock" || node.type.name === "signatureBrand") {
				return true;
			}
		}
	}

	return touchesSignature;
}

export function useInlineAi(editor: Editor | null) {
	const [state, setState] = useState<InlineAiState>({
		isOpen: false,
		status: "idle",
		instruction: "",
		error: null,
		anchor: null,
		range: null,
	});

	const abortRef = useRef<AbortController | null>(null);
	// Selected text snapshot captured when the prompt opens. We need this
	// for "try again" because by then the selection has been overwritten.
	const originalSelectionRef = useRef<{
		text: string;
		from: number;
		to: number;
		slice: Slice;
	} | null>(null);
	const activeRangeRef = useRef<{ from: number; to: number } | null>(null);
	const hasPreviewMutationRef = useRef(false);
	const lastInstructionRef = useRef<string>("");

	const restoreOriginalSelection = useCallback(() => {
		if (!editor) return;
		const original = originalSelectionRef.current;
		const range = activeRangeRef.current;
		if (!original || !range || !hasPreviewMutationRef.current) return;
		const tr = editor.state.tr.replaceRange(range.from, range.to, original.slice);
		tr.setMeta("addToHistory", false);
		editor.view.dispatch(tr);
		activeRangeRef.current = {
			from: original.from,
			to: original.to,
		};
		hasPreviewMutationRef.current = false;
		editor.commands.setTextSelection(activeRangeRef.current);
	}, [editor]);

	const closeAndReset = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		activeRangeRef.current = null;
		hasPreviewMutationRef.current = false;
		setState({
			isOpen: false,
			status: "idle",
			instruction: "",
			error: null,
			anchor: null,
			range: null,
		});
	}, []);

	const open = useCallback(() => {
		if (!editor) return;
		const { from, to } = editor.state.selection;
		if (from === to) return;
		if (selectionTouchesSignature(editor, from, to)) return;
		const text = editor.state.doc.textBetween(from, to, "\n");
		if (!text.trim()) return;
		originalSelectionRef.current = {
			text,
			from,
			to,
			slice: editor.state.doc.slice(from, to),
		};
		activeRangeRef.current = { from, to };
		hasPreviewMutationRef.current = false;
		setState({
			isOpen: true,
			status: "idle",
			instruction: "",
			error: null,
			anchor: getSelectionAnchor(editor),
			range: { from, to },
		});
	}, [editor]);

	/**
	 * Slash-command entry point. Captures an explicit range + text (the
	 * surrounding paragraph or current selection chosen by the caller),
	 * sets the editor selection to it, then immediately fires the
	 * rewrite without showing the instruction-input pill — the
	 * instruction is preset by the slash command. The Accept / Try-again
	 * / Discard pill at the end of streaming is unchanged.
	 */
	const runOnRange = useCallback(
		(text: string, from: number, to: number, instruction: string) => {
			if (!editor) return;
			if (!text.trim() || !instruction.trim()) return;
			if (selectionTouchesSignature(editor, from, to)) return;
			editor.commands.setTextSelection({ from, to });
			originalSelectionRef.current = {
				text,
				from,
				to,
				slice: editor.state.doc.slice(from, to),
			};
			activeRangeRef.current = { from, to };
			hasPreviewMutationRef.current = false;
			lastInstructionRef.current = instruction;
			setState({
				isOpen: true,
				status: "streaming",
				instruction,
				error: null,
				anchor: getSelectionAnchor(editor),
				range: { from, to },
			});
			// Defer to next tick so React renders the prompt shell before
			// streaming events start arriving (otherwise the first delta
			// races the open transition).
			queueMicrotask(() => {
				void runRewriteRef.current?.(instruction);
			});
		},
		[editor],
	);
	// Late-bound ref so `runOnRange` can call `runRewrite` without a
	// circular dependency.
	const runRewriteRef = useRef<((instruction: string) => Promise<void>) | null>(
		null,
	);

	const setInstruction = useCallback((value: string) => {
		setState((prev) => ({ ...prev, instruction: value }));
	}, []);

	const runRewrite = useCallback(
		async (instruction: string) => {
			if (!editor) return;
			const original = originalSelectionRef.current;
			if (!original) return;
			const trimmed = instruction.trim();
			if (!trimmed) return;
			lastInstructionRef.current = trimmed;

			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			// On retry, restore the original selection before streaming a
			// fresh preview over the same range.
			restoreOriginalSelection();
			let currentFrom = original.from;
			let currentTo = original.to;
			activeRangeRef.current = { from: currentFrom, to: currentTo };
			editor.commands.setTextSelection({ from: currentFrom, to: currentTo });

			setState((prev) => ({
				...prev,
				status: "streaming",
				error: null,
				range: { from: currentFrom, to: currentTo },
			}));

			let accumulated = "";
			let firstChunk = true;
			let failed = false;

			const onEvent = (event: AgentEvent) => {
				if (controller.signal.aborted) return;
				if (event.type === "text_delta" || event.type === "text_completed") {
					accumulated = event.type === "text_delta"
						? accumulated + event.delta
						: event.text;
					const tr = editor.state.tr;
					tr.insertText(accumulated, currentFrom, currentTo);
					if (!firstChunk) tr.setMeta("addToHistory", false);
					firstChunk = false;
					hasPreviewMutationRef.current = true;
					editor.view.dispatch(tr);
					currentTo = currentFrom + accumulated.length;
					activeRangeRef.current = { from: currentFrom, to: currentTo };
					setState((prev) => ({
						...prev,
						range: { from: currentFrom, to: currentTo },
					}));
				} else if (event.type === "run_failed") {
					failed = true;
					restoreOriginalSelection();
					setState((prev) => ({
						...prev,
						status: "error",
						error: getUserFacingError(event.message, "AI 改写失败，原文已恢复。"),
					}));
				}
			};

			try {
				await api.streamAgentChat(
					{
						userText: `${SYSTEM_PREAMBLE}\n\nInstruction: ${trimmed}\n\nText to rewrite:\n"""\n${original.text}\n"""`,
						persist: false,
					},
					{ onEvent },
					{ signal: controller.signal },
				);
				if (controller.signal.aborted) return;
				if (failed) return;
				// Re-select the new text so the user can immediately accept
				// (do nothing), discard, or try again.
				editor.commands.setTextSelection({
					from: currentFrom,
					to: currentTo,
				});
				setState((prev) => ({
					...prev,
					status: "done",
					range: { from: currentFrom, to: currentTo },
					anchor: getSelectionAnchor(editor),
				}));
			} catch (err) {
				if ((err as Error).name === "AbortError") return;
				restoreOriginalSelection();
				setState((prev) => ({
					...prev,
					status: "error",
					error: getUserFacingError(err, "AI 改写失败，原文已恢复。"),
				}));
			} finally {
				abortRef.current = null;
			}
		},
		[editor, restoreOriginalSelection],
	);

	// Keep the ref pointing at the latest closure so `runOnRange` can
	// invoke `runRewrite` without listing it as a dependency (which
	// would force `runOnRange`'s identity to churn).
	runRewriteRef.current = runRewrite;

	const submit = useCallback(() => {
		return runRewrite(state.instruction);
	}, [runRewrite, state.instruction]);

	const tryAgain = useCallback(() => {
		return runRewrite(lastInstructionRef.current || state.instruction);
	}, [runRewrite, state.instruction]);

	const discard = useCallback(() => {
		if (!editor) return;
		restoreOriginalSelection();
		closeAndReset();
		queueMicrotask(() => editor.commands.focus());
	}, [editor, closeAndReset, restoreOriginalSelection]);

	const cancel = useCallback(() => {
		restoreOriginalSelection();
		closeAndReset();
		queueMicrotask(() => editor?.commands.focus());
	}, [closeAndReset, editor, restoreOriginalSelection]);

	const accept = useCallback(() => {
		closeAndReset();
		queueMicrotask(() => editor?.commands.focus());
	}, [closeAndReset, editor]);

	// Keep the anchor in sync if the user scrolls inside the editor.
	useEffect(() => {
		if (!editor || !state.isOpen) return;
		const root = editor.view.dom.closest(
			"[data-editor-root]",
		) as HTMLElement | null;
		const onScroll = () => {
			setState((prev) =>
				prev.isOpen
					? { ...prev, anchor: getSelectionAnchor(editor) }
					: prev,
			);
		};
		root?.addEventListener("scroll", onScroll, true);
		return () => {
			root?.removeEventListener("scroll", onScroll, true);
		};
	}, [editor, state.isOpen]);

	return {
		state,
		open,
		runOnRange,
		close: cancel,
		setInstruction,
		submit,
		tryAgain,
		discard,
		accept,
	};
}
