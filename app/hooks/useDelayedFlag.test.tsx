// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedFlag } from "./useDelayedFlag";

describe("useDelayedFlag", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("stays off under 300ms", () => {
		const { result } = renderHook(() => useDelayedFlag(true));
		expect(result.current).toBe(false);
		act(() => {
			vi.advanceTimersByTime(299);
		});
		expect(result.current).toBe(false);
	});

	it("turns on at 300ms", () => {
		const { result } = renderHook(() => useDelayedFlag(true));
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(result.current).toBe(true);
	});

	it("stays on for the 500ms minimum after the wait ends", () => {
		const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active), {
			initialProps: { active: true },
		});
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(result.current).toBe(true);
		rerender({ active: false });
		// Still within the 500ms dwell: no flash off.
		act(() => {
			vi.advanceTimersByTime(499);
		});
		expect(result.current).toBe(true);
		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(result.current).toBe(false);
	});

	it("never turns on when the wait resolves under the delay", () => {
		const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active), {
			initialProps: { active: true },
		});
		rerender({ active: false });
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(result.current).toBe(false);
	});
});
