// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useCallback, useRef, useState } from "react";
import type { CompositionEvent, RefObject } from "react";

/**
 * Composition event handler whose event argument is optional.
 *
 * The standard `React.CompositionEventHandler<T>` requires a `CompositionEvent`
 * argument, but several call sites in this codebase invoke the handler from
 * inside a wrapper that does not forward the event (e.g.,
 * `onCompositionStart={(e) => { ime.onCompositionStart(); ... }}`).
 *
 * Making the event optional preserves both ergonomics:
 * - Spread directly onto an `<input>` / `<textarea>`: a function with an
 *   optional parameter is assignable to React's `CompositionEventHandler`.
 * - Call it bare from a wrapper handler without TS complaining.
 */
type OptionalCompositionHandler<T = HTMLElement> = (
	event?: CompositionEvent<T>,
) => void;

/**
 * IME-safe composition tracking.
 *
 * Returns:
 * - `onCompositionStart` / `onCompositionEnd`: spread onto an <input>/<textarea>.
 * - `isComposing`: React state — use ONLY for rendering (e.g., disable a button).
 * - `isComposingRef`: synchronous ref — use inside keydown handlers because state
 *   may be stale within the same event tick on Chromium macOS Pinyin and several
 *   Android IMEs.
 *
 * Pattern:
 *   const ime = useImeComposition();
 *   <input
 *     onCompositionStart={ime.onCompositionStart}
 *     onCompositionEnd={ime.onCompositionEnd}
 *     onKeyDown={(e) => {
 *       if (e.key === "Enter" && !e.shiftKey && !ime.isComposingRef.current) {
 *         submit();
 *       }
 *     }}
 *   />
 */
export interface UseImeCompositionResult {
	onCompositionStart: OptionalCompositionHandler;
	onCompositionEnd: OptionalCompositionHandler;
	isComposing: boolean;
	isComposingRef: RefObject<boolean>;
}

export function useImeComposition(): UseImeCompositionResult {
	const composingRef = useRef(false);
	const [isComposing, setIsComposing] = useState(false);

	const onCompositionStart = useCallback<OptionalCompositionHandler>(() => {
		composingRef.current = true;
		setIsComposing(true);
	}, []);

	const onCompositionEnd = useCallback<OptionalCompositionHandler>(() => {
		composingRef.current = false;
		setIsComposing(false);
	}, []);

	return {
		onCompositionStart,
		onCompositionEnd,
		isComposing,
		isComposingRef: composingRef,
	};
}
