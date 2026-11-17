// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CompositionEvent, KeyboardEvent } from "react";
import { useImeComposition } from "./useImeComposition";

// Cast helper: hook tests invoke composition handlers without a real event.
const noopCompositionEvent = {} as CompositionEvent<HTMLElement>;

/**
 * Tiny consumer that wires the hook into a real <input> and submits on Enter.
 * The Enter handler must early-return when the hook reports composition is
 * active, locking the IME-safe submission contract from the spec.
 */
function TestInput({ onSubmit }: { onSubmit: (value: string) => void }) {
	const { onCompositionStart, onCompositionEnd, isComposing } = useImeComposition();

	function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key !== "Enter") return;
		if (event.shiftKey) return;
		if (isComposing) return;
		event.preventDefault();
		onSubmit((event.target as HTMLInputElement).value);
	}

	return (
		<input
			data-testid="ime-input"
			onCompositionStart={onCompositionStart}
			onCompositionEnd={onCompositionEnd}
			onKeyDown={handleKeyDown}
		/>
	);
}

/**
 * Consumer using the synchronous ref guard. This is the recommended pattern
 * for keydown handlers because state-based `isComposing` may be stale within
 * the same event tick on Chromium macOS Pinyin / several Android IMEs.
 */
function RefGuardInput({ onSubmit }: { onSubmit: (value: string) => void }) {
	const { onCompositionStart, onCompositionEnd, isComposingRef } = useImeComposition();

	function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key !== "Enter") return;
		if (event.shiftKey) return;
		if (isComposingRef.current) return;
		event.preventDefault();
		onSubmit((event.target as HTMLInputElement).value);
	}

	return (
		<input
			data-testid="ime-input-ref"
			onCompositionStart={onCompositionStart}
			onCompositionEnd={onCompositionEnd}
			onKeyDown={handleKeyDown}
		/>
	);
}

describe("useImeComposition", () => {
	it("starts with isComposing=false", () => {
		const { result } = renderHook(() => useImeComposition());
		expect(result.current.isComposing).toBe(false);
	});

	it("flips isComposing to true after compositionstart fires", () => {
		const { result } = renderHook(() => useImeComposition());
		act(() => {
			result.current.onCompositionStart(noopCompositionEvent);
		});
		expect(result.current.isComposing).toBe(true);
	});

	it("returns isComposing to false after compositionend fires", () => {
		const { result } = renderHook(() => useImeComposition());
		act(() => {
			result.current.onCompositionStart(noopCompositionEvent);
		});
		act(() => {
			result.current.onCompositionEnd(noopCompositionEvent);
		});
		expect(result.current.isComposing).toBe(false);
	});

	it("does NOT call submit when Enter is pressed during composition", async () => {
		const onSubmit = vi.fn();
		const user = userEvent.setup();
		render(<TestInput onSubmit={onSubmit} />);
		const input = screen.getByTestId("ime-input") as HTMLInputElement;

		await user.click(input);
		fireEvent.compositionStart(input);
		await user.type(input, "你好");
		// Enter while composing — must NOT submit
		fireEvent.keyDown(input, { key: "Enter" });

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("calls submit exactly once when Enter is pressed AFTER compositionend", async () => {
		const onSubmit = vi.fn();
		const user = userEvent.setup();
		render(<TestInput onSubmit={onSubmit} />);
		const input = screen.getByTestId("ime-input") as HTMLInputElement;

		await user.click(input);
		fireEvent.compositionStart(input);
		await user.type(input, "你好");
		fireEvent.compositionEnd(input);
		fireEvent.keyDown(input, { key: "Enter" });

		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("never calls submit on Shift+Enter (consumer contract)", async () => {
		const onSubmit = vi.fn();
		const user = userEvent.setup();
		render(<TestInput onSubmit={onSubmit} />);
		const input = screen.getByTestId("ime-input") as HTMLInputElement;

		await user.click(input);
		await user.type(input, "hello");
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

		// Also verify Shift+Enter during composition is ignored
		fireEvent.compositionStart(input);
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
		fireEvent.compositionEnd(input);
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

		expect(onSubmit).not.toHaveBeenCalled();
	});

	// Race-surface tests for must_fix #1.
	//
	// Real-world bug: Chromium macOS Pinyin and several Android IMEs dispatch
	// `compositionend` and `keydown: Enter` within a single event tick, before
	// React has flushed the `setIsComposing(false)` update. A consumer relying
	// on state-based `isComposing` will read `true` and drop the Enter — or
	// worse, fire stale-true on a later tick and drop a legitimate submit.
	//
	// The ref-based guard (`isComposingRef.current`) is updated synchronously
	// inside the composition handlers and is not subject to this race.
	//
	// Note: in jsdom under @testing-library, `fireEvent` wraps each dispatch
	// in its own batched update, which auto-flushes state between events and
	// masks the real race. We therefore exercise the ref-based consumer here
	// (which provably guards correctly) and document the contingency. See
	// the IME spike `RESULTS.md` (macOS Chromium Pinyin contingency) for the
	// hardware-reproduced trace this test models.

	it("ref-based consumer submits exactly once when compositionend + Enter fire in the same tick", () => {
		const onSubmit = vi.fn();
		render(<RefGuardInput onSubmit={onSubmit} />);
		const input = screen.getByTestId("ime-input-ref") as HTMLInputElement;

		fireEvent.compositionStart(input);
		fireEvent.change(input, { target: { value: "你好" } });

		// Single act() block — compositionend and Enter dispatched without an
		// intervening flush. The ref must be `false` synchronously by the time
		// the Enter handler runs.
		act(() => {
			fireEvent.compositionEnd(input);
			fireEvent.keyDown(input, { key: "Enter" });
		});

		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("documents the state-only race: ref guard succeeds where state guard is unsafe in the same tick", () => {
		// This test pairs with the one above. We confirm the ref-based
		// consumer fires exactly once, which is the guaranteed contract.
		//
		// We do NOT assert that the state-based consumer fails here, because
		// `fireEvent` auto-flushes React state between calls in jsdom (the
		// real-hardware race cannot be faithfully reproduced in this
		// environment). What we DO assert is the positive guarantee: the
		// ref-based pattern is the one consumers MUST use for keydown guards.
		const onSubmitRef = vi.fn();
		render(<RefGuardInput onSubmit={onSubmitRef} />);
		const input = screen.getByTestId("ime-input-ref") as HTMLInputElement;

		fireEvent.compositionStart(input);
		fireEvent.change(input, { target: { value: "再见" } });
		act(() => {
			fireEvent.compositionEnd(input);
			fireEvent.keyDown(input, { key: "Enter" });
		});

		expect(onSubmitRef).toHaveBeenCalledTimes(1);
	});

	it("exposes isComposingRef synchronously without waiting for React to flush state", () => {
		const { result } = renderHook(() => useImeComposition());

		// Before any handler runs, ref starts false.
		expect(result.current.isComposingRef.current).toBe(false);

		// Invoke the handler outside act() to bypass React's auto-flush —
		// the ref must update synchronously even though state has not.
		result.current.onCompositionStart(noopCompositionEvent);
		expect(result.current.isComposingRef.current).toBe(true);

		result.current.onCompositionEnd(noopCompositionEvent);
		expect(result.current.isComposingRef.current).toBe(false);
	});
});
