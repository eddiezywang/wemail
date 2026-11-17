// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createRafBatcher } from "./streamThrottle";

interface FakeRaf {
	raf: (cb: FrameRequestCallback) => number;
	caf: (handle: number) => void;
	tick: () => void;
	pending: () => number;
}

function makeFakeRaf(): FakeRaf {
	const callbacks = new Map<number, FrameRequestCallback>();
	let next = 1;
	return {
		raf: (cb) => {
			const id = next++;
			callbacks.set(id, cb);
			return id;
		},
		caf: (id) => {
			callbacks.delete(id);
		},
		tick: () => {
			const snapshot = Array.from(callbacks.entries());
			callbacks.clear();
			for (const [, cb] of snapshot) cb(performance.now());
		},
		pending: () => callbacks.size,
	};
}

describe("createRafBatcher", () => {
	it("coalesces multiple pushes into a single frame", () => {
		const fake = makeFakeRaf();
		const deliver = vi.fn<(batch: string[]) => void>();
		const batcher = createRafBatcher<string>(deliver, {
			raf: fake.raf,
			caf: fake.caf,
		});

		batcher.push("a");
		batcher.push("b");
		batcher.push("c");
		expect(deliver).not.toHaveBeenCalled();

		fake.tick();

		expect(deliver).toHaveBeenCalledTimes(1);
		expect(deliver).toHaveBeenCalledWith(["a", "b", "c"]);
	});

	it("preserves arrival order across multiple frames", () => {
		const fake = makeFakeRaf();
		const order: string[] = [];
		const batcher = createRafBatcher<string>(
			(batch) => {
				for (const item of batch) order.push(item);
			},
			{ raf: fake.raf, caf: fake.caf },
		);

		batcher.push("1");
		batcher.push("2");
		fake.tick();
		batcher.push("3");
		batcher.push("4");
		batcher.push("5");
		fake.tick();
		batcher.push("6");
		fake.tick();

		expect(order).toEqual(["1", "2", "3", "4", "5", "6"]);
	});

	it("does not schedule another frame while one is already pending", () => {
		const fake = makeFakeRaf();
		const batcher = createRafBatcher<number>(() => {}, {
			raf: fake.raf,
			caf: fake.caf,
		});

		batcher.push(1);
		batcher.push(2);
		batcher.push(3);
		expect(fake.pending()).toBe(1);
	});

	it("flush delivers queued events synchronously and cancels frame", () => {
		const fake = makeFakeRaf();
		const deliver = vi.fn<(batch: string[]) => void>();
		const batcher = createRafBatcher<string>(deliver, {
			raf: fake.raf,
			caf: fake.caf,
		});

		batcher.push("tail-1");
		batcher.push("tail-2");
		batcher.flush();

		expect(deliver).toHaveBeenCalledTimes(1);
		expect(deliver).toHaveBeenCalledWith(["tail-1", "tail-2"]);
		expect(fake.pending()).toBe(0);

		// Subsequent tick must not re-deliver.
		fake.tick();
		expect(deliver).toHaveBeenCalledTimes(1);
	});

	it("flush is a no-op when queue is empty", () => {
		const fake = makeFakeRaf();
		const deliver = vi.fn<(batch: string[]) => void>();
		const batcher = createRafBatcher<string>(deliver, {
			raf: fake.raf,
			caf: fake.caf,
		});

		batcher.flush();
		expect(deliver).not.toHaveBeenCalled();
	});

	it("dispose drops pending events and ignores subsequent pushes", () => {
		const fake = makeFakeRaf();
		const deliver = vi.fn<(batch: string[]) => void>();
		const batcher = createRafBatcher<string>(deliver, {
			raf: fake.raf,
			caf: fake.caf,
		});

		batcher.push("dropped-1");
		batcher.push("dropped-2");
		batcher.dispose();

		expect(deliver).not.toHaveBeenCalled();
		expect(fake.pending()).toBe(0);

		batcher.push("ignored");
		fake.tick();
		expect(deliver).not.toHaveBeenCalled();
	});

	it("delivers events that arrive after a flushed frame on the next frame", () => {
		const fake = makeFakeRaf();
		const batches: string[][] = [];
		const batcher = createRafBatcher<string>(
			(batch) => batches.push(batch),
			{ raf: fake.raf, caf: fake.caf },
		);

		batcher.push("a");
		fake.tick();
		batcher.push("b");
		batcher.push("c");
		fake.tick();

		expect(batches).toEqual([["a"], ["b", "c"]]);
	});
});
