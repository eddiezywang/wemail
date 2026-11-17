// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * rAF-coalesced event batcher.
 *
 * SSE deltas can arrive 100+ times/second on long replies. Calling React
 * setState that often pegs the main thread and drops frames. This helper
 * buffers events and drains them on the next animation frame, so React
 * sees at most ~60 batched updates per second instead of one per token.
 *
 * Ordering is preserved: events are drained in arrival order. Tool-call
 * lifecycle events (tool_call → tool_result) therefore remain ordered
 * relative to surrounding text deltas.
 *
 * Always call `flush()` (or `dispose()`) on stream end / error / abort
 * so any tail events buffered between the last frame and the terminal
 * signal are delivered synchronously and not dropped.
 */
export interface RafBatcher<T> {
	/** Queue an event for delivery on the next animation frame. */
	push: (event: T) => void;
	/** Synchronously drain the queue and cancel any scheduled frame. */
	flush: () => void;
	/** Drop any pending events without delivering, and cancel the frame. */
	dispose: () => void;
}

type RafFn = (cb: FrameRequestCallback) => number;
type CafFn = (handle: number) => void;

interface BatcherOptions {
	/** Override raf scheduler — defaults to globalThis.requestAnimationFrame. */
	raf?: RafFn;
	/** Override caf — defaults to globalThis.cancelAnimationFrame. */
	caf?: CafFn;
}

function defaultRaf(): RafFn {
	if (typeof requestAnimationFrame === "function") {
		return (cb) => requestAnimationFrame(cb);
	}
	// Non-DOM environments (SSR, node tests) fall back to a 16ms timer.
	return (cb) =>
		setTimeout(() => cb(performance?.now?.() ?? Date.now()), 16) as unknown as number;
}

function defaultCaf(): CafFn {
	if (typeof cancelAnimationFrame === "function") {
		return (h) => cancelAnimationFrame(h);
	}
	return (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>);
}

/**
 * Create a batcher that delivers events in FIFO order, coalesced per
 * animation frame. The `deliver` callback is invoked once per frame
 * with all events queued since the last frame.
 */
export function createRafBatcher<T>(
	deliver: (events: T[]) => void,
	opts: BatcherOptions = {},
): RafBatcher<T> {
	const raf = opts.raf ?? defaultRaf();
	const caf = opts.caf ?? defaultCaf();

	let queue: T[] = [];
	let handle: number | null = null;
	let disposed = false;

	const drain = () => {
		handle = null;
		if (queue.length === 0) return;
		const batch = queue;
		queue = [];
		deliver(batch);
	};

	return {
		push(event) {
			if (disposed) return;
			queue.push(event);
			if (handle === null) {
				handle = raf(drain);
			}
		},
		flush() {
			if (handle !== null) {
				caf(handle);
				handle = null;
			}
			if (queue.length === 0) return;
			const batch = queue;
			queue = [];
			deliver(batch);
		},
		dispose() {
			disposed = true;
			if (handle !== null) {
				caf(handle);
				handle = null;
			}
			queue = [];
		},
	};
}
