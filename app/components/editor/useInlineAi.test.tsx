// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Unit-level coverage for the inline-AI hook open/close lifecycle.
 *
 * We deliberately don't render a real TipTap instance — under jsdom the
 * editor view's `coordsAtPos` cannot resolve without layout. Instead we
 * pass a hand-rolled editor stub with the minimal surface the hook
 * touches: `state.selection`, `state.doc.textBetween`, `state.tr`,
 * `view.dom` / `view.coordsAtPos`, and `commands.focus` (invoked from a
 * deferred microtask when the prompt is dismissed).
 */

import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useInlineAi } from "./useInlineAi";
import type { Editor } from "@tiptap/react";
import api from "~/services/api";

function buildStubEditor(): Editor {
	const dom = document.createElement("div");
	const root = document.createElement("div");
	root.setAttribute("data-editor-root", "");
	root.appendChild(dom);
	document.body.appendChild(root);

	const state = {
		selection: { from: 1, to: 6 },
		doc: {
			textBetween: vi.fn().mockReturnValue("Hello"),
			// selectionTouchesSignature walks the range; visiting no nodes
			// means the selection never touches the signature block.
			nodesBetween: vi.fn(),
			slice: vi.fn().mockReturnValue({ content: [], openStart: 0, openEnd: 0 }),
			resolve: vi.fn().mockReturnValue({
				depth: 0,
				node: () => ({ type: { name: "doc" } }),
			}),
		},
		tr: {
			insertText: vi.fn().mockReturnThis(),
			setMeta: vi.fn().mockReturnThis(),
		},
	};
	return {
		state,
		view: {
			dom,
			coordsAtPos: () => ({ top: 0, bottom: 12, left: 0, right: 12 }),
			dispatch: vi.fn(),
		},
		commands: {
			setTextSelection: vi.fn(),
			undo: vi.fn(),
			// close()/discard()/accept() refocus the editor from a queued
			// microtask after the prompt is dismissed; without this stub the
			// callback throws as an unhandled error after the test finishes.
			focus: vi.fn(),
		},
		chain: () => ({
			setTextSelection: () => ({
				insertContent: () => ({ run: () => true }),
			}),
		}),
	} as unknown as Editor;
}

describe("useInlineAi", () => {
	it("opens and exposes the captured selection range", () => {
		const editor = buildStubEditor();
		const { result } = renderHook(() => useInlineAi(editor));

		expect(result.current.state.isOpen).toBe(false);

		act(() => result.current.open());

		expect(result.current.state.isOpen).toBe(true);
		expect(result.current.state.range).toEqual({ from: 1, to: 6 });
		expect(result.current.state.status).toBe("idle");
	});

	it("close() resets state", () => {
		const editor = buildStubEditor();
		const { result } = renderHook(() => useInlineAi(editor));

		act(() => result.current.open());
		expect(result.current.state.isOpen).toBe(true);
		act(() => result.current.close());
		expect(result.current.state.isOpen).toBe(false);
		expect(result.current.state.range).toBeNull();
	});

	it("ignores open() when selection is empty", () => {
		const editor = buildStubEditor();
		// Force collapsed selection.
		(editor.state as { selection: { from: number; to: number } }).selection = {
			from: 4,
			to: 4,
		};
		const { result } = renderHook(() => useInlineAi(editor));

		act(() => result.current.open());
		expect(result.current.state.isOpen).toBe(false);
	});

	it("setInstruction updates the bound text", () => {
		const editor = buildStubEditor();
		const { result } = renderHook(() => useInlineAi(editor));

		act(() => result.current.open());
		act(() => result.current.setInstruction("make it shorter"));
		expect(result.current.state.instruction).toBe("make it shorter");
	});

	it("marks inline rewrite chat requests as non-persistent", async () => {
		const streamAgentChat = vi
			.spyOn(api, "streamAgentChat")
			.mockResolvedValue(undefined);
		const editor = buildStubEditor();
		const { result } = renderHook(() => useInlineAi(editor));

		act(() => result.current.open());
		act(() => result.current.setInstruction("make it shorter"));
		await waitFor(() =>
			expect(result.current.state.instruction).toBe("make it shorter"),
		);
		await act(async () => {
			await result.current.submit();
		});

		expect(streamAgentChat).toHaveBeenCalledWith(
			expect.objectContaining({
				persist: false,
				userText: expect.stringContaining("make it shorter"),
			}),
			expect.anything(),
			expect.anything(),
		);
	});
});
